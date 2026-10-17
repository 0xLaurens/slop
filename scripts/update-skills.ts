import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { diagnostic, errorMessage, parseUpstream } from './data.ts';
import type { StageSkill, UpstreamEntry } from './data.ts';
import { copy, fingerprint, isMain, readSkillsLock, noLinks, options, repository,
  safeName, skillHash, skillName, skillsAdd, temporary, warnPendingSkills, withMutex, writeJson } from './lib.ts';

export function upstreamSource(entry: UpstreamEntry): string | null {
  const upstream = parseUpstream(entry);
  return upstream.kind === 'remote' ? upstream.source : null;
}

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
  skipped: string[];
  failures: string[];
}

export async function updateSkills({ repo = repository, only, interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  ask = confirm, fetchSkill = skillsAdd }: UpdateOptions = {}): Promise<UpdateResult> {
  const selected = only === undefined ? undefined : safeName(only);
  const lockFile = path.join(repo, 'skills-lock.json');
  await noLinks(lockFile);
  const result: UpdateResult = { updated: [], skipped: [], failures: [] };
  return withMutex(path.join(repo, '.slop', 'repository.lock'), async () => {
    const lock = await readSkillsLock(lockFile);
    let lockFingerprint = await fingerprint(lockFile);
    await warnPendingSkills(repo);
    const directory = path.join(repo, 'skills');
    await noLinks(directory);
    const names = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.name !== '.gitkeep').map((entry) => safeName(entry.name));
    if (selected && !names.includes(selected)) throw new Error(`Unknown skill: ${selected}`);
    for (const name of names.filter((name) => !selected || name === selected).sort()) {
      try {
        const current = path.join(directory, name);
        await noLinks(current);
        if (await skillName(current) !== name) throw new Error('Directory and skill name differ');
        const before = await fingerprint(current);
        const entry = Object.hasOwn(lock.skills, name) ? lock.skills[name] : undefined;
        if (!entry) { console.log(`${name}: repository-owned skill, no upstream recorded; unchanged.`); continue; }
        const upstream = parseUpstream(entry);
        if (upstream.kind === 'local') { console.log(`${name}: no remote upstream; unchanged.`); continue; }
        const localHash = await skillHash(current);
        const dirty = localHash !== entry.computedHash;
        if (dirty) {
          diagnostic({ level: 'warn', event: 'skill.modified', message: 'Contents differ from the skills-lock.json baseline.',
            context: { repo, skill: name, lockFile } });
          if (!interactive || !await ask(name)) {
            result.skipped.push(name);
            console.log(`${name}: kept local version${interactive ? '' : ' (noninteractive run)'}.`);
            continue;
          }
        }
        await temporary('slop-update-', async (workspace) => {
          const staged = await fetchSkill({ source: upstream.source, name, workspace });
          const upstreamHash = await skillHash(staged.directory);
          // Recheck after network I/O or a prompt so a concurrent editor is not overwritten.
          if (await fingerprint(current) !== before) throw new Error('Changed while updating; retry after saving edits');
          if (await fingerprint(lockFile) !== lockFingerprint) throw new Error('skills-lock.json changed during update');
          if (upstreamHash === localHash) {
            if (dirty) {
              lock.skills[name] = { ...entry, computedHash: upstreamHash };
              await writeJson(lockFile, lock);
              lockFingerprint = await fingerprint(lockFile);
            }
            console.log(`${name}: already up to date.`);
            return;
          }
          const backup = path.join(repo, '.slop', 'backups', `${name}-${Date.now()}-${randomUUID()}`);
          await noLinks(backup);
          await mkdir(path.dirname(backup), { recursive: true });
          await rename(current, backup);
          const previousEntry = entry;
          try {
            await copy(staged.directory, current);
            // Retain the original source/ref/path rather than staging/local provenance.
            lock.skills[name] = { ...previousEntry, computedHash: upstreamHash };
            await writeJson(lockFile, lock);
          } catch (error) {
            lock.skills[name] = previousEntry;
            await rm(current, { recursive: true, force: true });
            await rename(backup, current);
            throw error;
          }
          lockFingerprint = await fingerprint(lockFile);
          result.updated.push(name);
          console.log(`${name}: updated. Previous copy saved to ${backup}`);
        });
      } catch (error) {
        result.failures.push(name);
        diagnostic({ level: 'error', event: 'skill.update.failed', message: errorMessage(error), context: { repo, skill: name, lockFile } });
      }
    }
    console.log(`Skills: ${result.updated.length} updated, ${result.skipped.length} kept/skipped, ${result.failures.length} failed.`);
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
