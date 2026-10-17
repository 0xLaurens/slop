import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { diagnostic, errorMessage, parseUpstream } from './data.ts';
import type { SkillName, StageSkill } from './data.ts';
import { fingerprint, isMain, readSkillsLock, noLinks, options, repository,
  safeName, skillHash, skillName, temporary, warnPendingSkills, withMutex } from './lib.ts';
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
};

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
};

async function updateSkill(name: SkillName, snapshot: LockSnapshot, context: SkillContext): Promise<SkillOutcome> {
  const { repo, interactive, ask, fetchSkill } = context;
  const current = path.join(repo, 'skills', name);
  const lockFile = path.join(repo, 'skills-lock.json');
  await noLinks(current);
  if (await skillName(current) !== name) throw new Error('Directory and skill name differ');
  const before = await fingerprint(current);
  if (before === null) throw new Error('Skill disappeared during update');
  const entry = Object.hasOwn(snapshot.lock.skills, name) ? snapshot.lock.skills[name] : undefined;
  const upstream = entry ? parseUpstream(entry) : { kind: 'local' } as const;
  if (!entry || upstream.kind === 'local') {
    console.log(`${name}: no remote upstream; unchanged.`);
    return { status: 'unchanged', snapshot };
  }
  const localHash = await skillHash(current);
  if (localHash !== entry.computedHash) {
    diagnostic({ level: 'warn', event: 'skill.modified', message: 'Contents differ from the skills-lock.json baseline.',
      context: { repo, skill: name, lockFile } });
    if (!interactive || !await ask(name)) {
      console.log(`${name}: kept local version${interactive ? '' : ' (noninteractive run)'}.`);
      return { status: 'skipped', snapshot };
    }
  }
  return temporary('slop-update-', async (workspace) => {
    const staged = await fetchSkill({ source: upstreamSource(upstream), name, workspace, skillPath: upstream.skillPath });
    if (await skillName(staged.directory) !== name) throw new Error(`Upstream skill name changed: ${name}`);
    await fingerprint(staged.directory); // Validate files excluded by the upstream hash too.
    const upstreamHash = await skillHash(staged.directory);
    if (await fingerprint(current) !== before) throw new Error('Changed while updating; retry after saving edits');
    if (await fingerprint(lockFile) !== snapshot.fingerprint) throw new Error('skills-lock.json changed during update');
    const changed = upstreamHash !== localHash;
    // Build the candidate without mutating the last successfully published lock.
    if (changed || upstreamHash !== entry.computedHash) {
      const nextLock = { ...snapshot.lock,
        skills: { ...snapshot.lock.skills, [name]: { ...entry, computedHash: upstreamHash } } };
      snapshot = await commitUpdate({ repo, name, before, snapshot, nextLock,
        ...changed && { replacement: staged.directory } });
    }
    console.log(`${name}: ${changed ? 'updated; previous copy saved under .slop/backups/.' : 'already up to date.'}`);
    return { status: changed ? 'updated' : 'unchanged', snapshot };
  });
}

export async function updateSkills({ repo = repository, only, interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  ask = confirm, fetchSkill = skillsAdd }: UpdateOptions = {}): Promise<UpdateResult> {
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
    await warnPendingSkills(repo);
    const directory = path.join(repo, 'skills');
    await noLinks(directory);
    const names = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.name !== '.gitkeep').map((entry) => safeName(entry.name));
    if (selected && !names.includes(selected)) throw new Error(`Unknown skill: ${selected}`);
    for (const name of names.filter((name) => !selected || name === selected).sort()) {
      try {
        const outcome = await updateSkill(name, snapshot, { repo, interactive, ask, fetchSkill });
        snapshot = outcome.snapshot;
        result[outcome.status].push(name);
      } catch (error) {
        diagnostic({ level: 'error', event: 'skill.update.failed', message: errorMessage(error), context: { repo, skill: name, lockFile } });
        if (error instanceof UpdateRecoveryError) throw error;
        await assertNoPendingUpdate(repo);
        result.failures.push(name);
      }
    }
    console.log(`Skills: ${result.updated.length} updated, ${result.unchanged.length} unchanged, ${result.skipped.length} kept/skipped, ${result.failures.length} failed.`);
    return result;
  });
}

if (isMain(import.meta.url)) {
  try {
    const args = options({ skill: { type: 'string' }, 'non-interactive': { type: 'boolean' }, help: { type: 'boolean' } });
    if (args.help) console.log('npm run skills:update -- [--skill NAME] [--non-interactive]\nModified skills require individual interactive confirmation; default is Keep.');
    else {
      const result = await updateSkills({ only: args.skill, interactive: !args['non-interactive'] && Boolean(process.stdin.isTTY && process.stdout.isTTY) });
      if (result.skipped.length || result.failures.length) process.exitCode = 1;
    }
  } catch (error) {
    diagnostic({ level: 'error', event: 'skills.update.failed', message: errorMessage(error), context: { repo: repository } });
    process.exitCode = 1;
  }
}
