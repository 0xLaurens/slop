import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { diagnostic, errorMessage, parseUpstream } from './data.ts';
import type { Diagnostic, SkillName, StageSkill } from './data.ts';
import { fingerprint, isMain, readSkillsLock, noLinks, options, repository,
  safeName, skillHash, skillName, temporary, withMutex } from './lib.ts';
import { skillsAdd, upstreamSource } from './skills-cli.ts';
import { assertNoPendingUpdate, commitUpdate, UpdateRecoveryError } from './update-transaction.ts';
import type { LockSnapshot } from './update-transaction.ts';

async function confirm(name: string): Promise<boolean> {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await input.question(`${name}: local changes detected. [K]eep or [R]eplace with upstream (backup first)? [K] `);
    return ['r', 'replace'].includes(answer.trim().toLowerCase());
  } finally { input.close(); }
}

export type UpdateOptions = {
  repo?: string;
  only?: string;
  interactive?: boolean;
  ask?: (name: string) => Promise<boolean>;
  fetchSkill?: StageSkill;
  selected?: readonly string[];
  log?: (message: string) => void;
  cancelled?: () => boolean;
  report?: (value: Diagnostic) => void;
  onTransaction?: (active: boolean) => void;
  onProgress?: (progress: UpdateProgress) => void;
};

export interface UpdateProgress {
  total: number;
  completed: number;
  updated: number;
  unchanged: number;
  skipped: number;
  failed: number;
}

export interface UpdateResult {
  updated: string[];
  unchanged: string[];
  skipped: string[];
  failures: string[];
}

type SkillOutcome = { status: 'updated' | 'unchanged' | 'skipped'; snapshot: LockSnapshot };
type SkillContext = {
  repo: string;
  interactive: boolean;
  ask: (name: string) => Promise<boolean>;
  fetchSkill: StageSkill;
  log: (message: string) => void;
  report: (value: Diagnostic) => void;
  cancelled: () => boolean;
  onTransaction: (active: boolean) => void;
};

async function updateSkill(name: SkillName, snapshot: LockSnapshot, context: SkillContext): Promise<SkillOutcome> {
  const { repo, interactive, ask, fetchSkill, log, report, cancelled, onTransaction } = context;
  const current = path.join(repo, '.agents', 'skills', name);
  const lockFile = path.join(repo, 'skills-lock.json');
  await noLinks(current);
  if (await skillName(current) !== name) throw new Error('Directory and skill name differ');
  const before = await fingerprint(current);
  if (before === null) throw new Error('Skill disappeared during update');
  const entry = Object.hasOwn(snapshot.lock.skills, name) ? snapshot.lock.skills[name] : undefined;
  const upstream = entry ? parseUpstream(entry) : { kind: 'local' } as const;
  if (!entry || upstream.kind === 'local') {
    log(`${name}: no remote upstream; unchanged.`);
    return { status: 'unchanged', snapshot };
  }
  const localHash = await skillHash(current);
  const modified = localHash !== entry.computedHash;
  if (modified) {
    report({ level: 'warn', event: 'skill.modified', message: 'Contents differ from the skills-lock.json baseline.',
      context: { repo, skill: name, lockFile } });
  }
  if (modified && (!interactive || !await ask(name))) {
    log(`${name}: kept local version${interactive ? '' : ' (noninteractive run)'}.`);
    return { status: 'skipped', snapshot };
  }
  return temporary('slop-update-', async (workspace) => {
    const staged = await fetchSkill({ source: upstreamSource(upstream), name, workspace, skillPath: upstream.skillPath });
    if (cancelled()) return { status: 'skipped', snapshot };
    if (await skillName(staged.directory) !== name) throw new Error(`Upstream skill name changed: ${name}`);
    await fingerprint(staged.directory); // Validate files excluded by the upstream hash too.
    const upstreamHash = await skillHash(staged.directory);
    if (await fingerprint(current) !== before) throw new Error('Changed while updating; retry after saving edits');
    if (await fingerprint(lockFile) !== snapshot.fingerprint) throw new Error('skills-lock.json changed during update');
    const changed = upstreamHash !== localHash;
    // Build the candidate without mutating the last successfully published lock.
    if (changed || upstreamHash !== entry.computedHash) {
      if (cancelled()) return { status: 'skipped', snapshot };
      const nextLock = { ...snapshot.lock,
        skills: { ...snapshot.lock.skills, [name]: { ...entry, computedHash: upstreamHash } } };
      onTransaction(true);
      try {
        snapshot = await commitUpdate({ repo, name, before, snapshot, nextLock,
          ...changed && { replacement: staged.directory } });
      } finally { onTransaction(false); }
    }
    log(`${name}: ${changed ? 'updated; previous copy saved under .slop/backups/.' : 'already up to date.'}`);
    return { status: changed ? 'updated' : 'unchanged', snapshot };
  });
}

export async function updateSkills({ repo = repository, only, interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  ask = confirm, fetchSkill = skillsAdd, selected: selections, log = console.log, cancelled = () => false,
  report = diagnostic, onTransaction = () => {}, onProgress = () => {} }: UpdateOptions = {}): Promise<UpdateResult> {
  const selected = only === undefined ? undefined : safeName(only);
  const lockFile = path.join(repo, 'skills-lock.json');
  const result: UpdateResult = { updated: [], unchanged: [], skipped: [], failures: [] };
  return withMutex(path.join(repo, '.slop', 'repository.lock'), async () => {
    await assertNoPendingUpdate(repo);
    await noLinks(lockFile);
    const before = await fingerprint(lockFile);
    const lock = await readSkillsLock(lockFile);
    if (before === null || await fingerprint(lockFile) !== before) throw new Error('skills-lock.json changed while reading');
    let snapshot: LockSnapshot = { lock, fingerprint: before };
    const directory = path.join(repo, '.agents', 'skills');
    await noLinks(directory);
    const names = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.name !== '.gitkeep').map((entry) => safeName(entry.name));
    if (selected && !names.includes(selected)) throw new Error(`Unknown skill: ${selected}`);
    const selection = selections?.map(safeName);
    for (const name of selection ?? []) if (!names.includes(name)) throw new Error(`Unknown skill: ${name}`);
    const selectedNames = names.filter((name) => (!selected || name === selected) && (!selection || selection.includes(name))).sort();
    const progress = () => onProgress({ total: selectedNames.length,
      completed: result.updated.length + result.unchanged.length + result.skipped.length + result.failures.length,
      updated: result.updated.length, unchanged: result.unchanged.length, skipped: result.skipped.length, failed: result.failures.length });
    for (const name of selectedNames) {
      if (cancelled()) { result.skipped.push(name); progress(); continue; }
      log(`Checking ${name}…`);
      try {
        const outcome = await updateSkill(name, snapshot, { repo, interactive, ask, fetchSkill, log, report, cancelled, onTransaction });
        snapshot = outcome.snapshot;
        result[outcome.status].push(name);
      } catch (error) {
        report({ level: 'error', event: 'skill.update.failed', message: errorMessage(error), context: { repo, skill: name, lockFile } });
        if (error instanceof UpdateRecoveryError) throw error;
        await assertNoPendingUpdate(repo);
        result.failures.push(name);
      }
      progress();
    }
    log(`Skills: ${result.updated.length} updated, ${result.unchanged.length} unchanged, ${result.skipped.length} kept/skipped, ${result.failures.length} failed.`);
    return result;
  });
}

async function main(): Promise<void> {
  const args = options({ skill: { type: 'string' }, 'non-interactive': { type: 'boolean' }, help: { type: 'boolean' } });
  if (args.help) {
    console.log('npm run skills:update -- [--skill NAME] [--non-interactive]\nModified skills require individual interactive confirmation; default is Keep.');
    return;
  }
  const result = await updateSkills({ only: args.skill, interactive: !args['non-interactive'] && Boolean(process.stdin.isTTY && process.stdout.isTTY) });
  if (result.skipped.length || result.failures.length) process.exitCode = 1;
}

if (isMain(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    diagnostic({ level: 'error', event: 'skills.update.failed', message: errorMessage(error), context: { repo: repository } });
    process.exitCode = 1;
  }
}
