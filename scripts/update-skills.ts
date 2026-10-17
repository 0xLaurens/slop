import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { copy, fingerprint, isMain, json, noLinks, options, repository,
  safeName, skillHash, skillName, skillsAdd, temporary, warnPendingSkills, withMutex, writeJson } from './lib.ts';

type UpstreamEntry = {
  sourceType: string;
  source: string;
  sourceUrl?: string;
  skillPath?: string;
  ref?: string;
};

export function upstreamSource(entry: UpstreamEntry) {
  if (['local', 'node_modules'].includes(entry.sourceType)) return null;
  if (!['github', 'gitlab', 'git'].includes(entry.sourceType)) {
    throw new Error(`Unsupported upstream type: ${entry.sourceType}`);
  }
  let source = entry.sourceUrl || entry.source;
  if (typeof source !== 'string' || !source || source.startsWith('-')) throw new Error('Invalid upstream source');
  if (entry.sourceType === 'github' && /^[\w.-]+\/[\w.-]+$/.test(source)) {
    // owner/repo/folder#ref is understood by the pinned skills CLI.
  } else if (!/^(https:\/\/|ssh:\/\/|git@)/.test(source)) {
    throw new Error('Upstream needs an unambiguous repository URL');
  }
  if (entry.skillPath && (entry.sourceType === 'github' || entry.sourceType === 'gitlab')) {
    if (typeof entry.skillPath !== 'string' || entry.skillPath.includes('\\')
        || entry.skillPath.split('/').some((part) => part === '..' || part === '.')
        || entry.skillPath.startsWith('/') || /[?#]/.test(entry.skillPath)
        || !/(^|\/)SKILL\.md$/.test(entry.skillPath)) throw new Error('Invalid upstream skillPath');
    const folder = entry.skillPath.replace(/(^|\/)SKILL\.md$/, '');
    // Match the CLI's update-source behavior; generic .git/SSH URLs cannot carry subpaths.
    if (!source.endsWith('.git') && !source.startsWith('git@') && !source.startsWith('ssh://')) {
      if (folder) source = `${source.replace(/\/$/, '')}/${folder}`;
    }
  }
  if (entry.ref) source += `#${entry.ref}`;
  return source;
}

async function confirm(name: string) {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await input.question(`${name}: local changes detected. [K]eep or [R]eplace with upstream (backup first)? [K] `);
    return ['r', 'replace'].includes(answer.trim().toLowerCase());
  } finally { input.close(); }
}

type UpdateOptions = {
  repo?: string;
  only?: string;
  interactive?: boolean;
  ask?: (name: string) => Promise<boolean>;
  fetchSkill?: (source: string, name: string, workspace: string) => Promise<{ directory: string }>;
};

export async function updateSkills({ repo = repository, only, interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  ask = confirm, fetchSkill = skillsAdd }: UpdateOptions = {}) {
  if (only) safeName(only);
  const lockFile = path.join(repo, 'skills-lock.json');
  await noLinks(lockFile);
  const result: { updated: string[]; skipped: string[]; failures: string[] } = { updated: [], skipped: [], failures: [] };
  return withMutex(path.join(repo, '.slop', 'repository.lock'), async () => {
    const lock = await json(lockFile);
    let lockFingerprint = await fingerprint(lockFile);
    if (lock.version !== 1 || !lock.skills || Array.isArray(lock.skills)) throw new Error('Invalid skills-lock.json');
    await warnPendingSkills(repo);
    const directory = path.join(repo, 'skills');
    await noLinks(directory);
    const names = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.name !== '.gitkeep').map((entry) => safeName(entry.name));
    if (only && !names.includes(only)) throw new Error(`Unknown skill: ${only}`);
    for (const name of names.filter((name) => !only || name === only).sort()) {
      try {
        const current = path.join(directory, name);
        await noLinks(current);
        if (await skillName(current) !== name) throw new Error('Directory and skill name differ');
        const before = await fingerprint(current);
        const entry = lock.skills[name];
        if (!entry) { console.log(`${name}: repository-owned skill, no upstream recorded; unchanged.`); continue; }
        const source = upstreamSource(entry);
        if (!source) { console.log(`${name}: no remote upstream; unchanged.`); continue; }
        const localHash = await skillHash(current);
        const dirty = localHash !== entry.computedHash;
        if (dirty) {
          console.warn(`${name}: contents differ from the skills-lock.json baseline.`);
          if (!interactive || !await ask(name)) {
            result.skipped.push(name);
            console.log(`${name}: kept local version${interactive ? '' : ' (noninteractive run)'}.`);
            continue;
          }
        }
        await temporary('slop-update-', async (workspace) => {
          const staged = await fetchSkill(source, name, workspace);
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
          const previousEntry = lock.skills[name];
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
        console.error(`${name}: ${error.message}`);
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
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
