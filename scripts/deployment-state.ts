import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isRecord } from './data.ts';
import { exists, fingerprint, json, noLinks, safeName, skillName } from './lib.ts';

export interface DeploymentManifest {
  version: 1;
  owner: 'slop';
  files: Record<string, string>;
}

export interface DeploymentSource {
  source: string;
  origin: 'repository' | 'installed';
}

export type DeploymentSources = Map<string, DeploymentSource>;

function validTarget(target: string): boolean {
  if (target === 'AGENTS.md') return true;
  const [kind, name, extra] = target.split('/');
  if (!name || extra !== undefined) return false;
  try {
    if (kind === 'skills') return safeName(name) === name;
    if (kind === 'agents' && name.endsWith('.md')) return safeName(name.slice(0, -3)) === name.slice(0, -3);
  } catch { return false; }
  return false;
}

export async function sources(repo: string): Promise<DeploymentSources> {
  const result: DeploymentSources = new Map();
  for (const kind of ['agents', 'skills']) {
    const directory = path.join(repo, '.agents', kind);
    await noLinks(directory);
    if (!await exists(directory)) continue;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.gitkeep') continue;
      const source = path.join(directory, entry.name);
      await noLinks(source);
      if (kind === 'agents') {
        if (!entry.isFile() || !entry.name.endsWith('.md')) throw new Error(`Expected .agents/agents/<name>.md: ${source}`);
        safeName(entry.name.slice(0, -3));
      } else {
        if (!entry.isDirectory()) throw new Error(`Expected .agents/skills/<name>/SKILL.md: ${source}`);
        if (await skillName(source) !== entry.name) throw new Error(`Skill directory must match its frontmatter name: ${source}`);
      }
      await fingerprint(source);
      result.set(`${kind}/${entry.name}`, { source, origin: 'repository' });
    }
  }
  const instructions = path.join(repo, '.agents', 'instructions', 'AGENTS.md');
  await noLinks(instructions);
  if (!await exists(instructions)) return result;
  if (!(await lstat(instructions)).isFile()) throw new Error('.agents/instructions/AGENTS.md must be a regular file');
  result.set('AGENTS.md', { source: instructions, origin: 'repository' });
  return result;
}

export async function readManifest(file: string): Promise<DeploymentManifest> {
  if (!await exists(file)) return { version: 1, owner: 'slop', files: {} };
  const manifest = await json(file);
  if (!isRecord(manifest) || manifest.version !== 1 || manifest.owner !== 'slop' || !isRecord(manifest.files)) {
    throw new Error(`Invalid deployment manifest: ${file}`);
  }
  const files: DeploymentManifest['files'] = {};
  for (const [target, hash] of Object.entries(manifest.files)) {
    if (!validTarget(target) || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new Error(`Invalid deployment manifest entry: ${target}`);
    files[target] = hash;
  }
  return { version: 1, owner: 'slop', files };
}

export async function preflight(config: string, desired: ReadonlyMap<string, DeploymentSource>, previous: DeploymentManifest): Promise<void> {
  const conflicts: string[] = [];
  for (const target of new Set([...desired.keys(), ...Object.keys(previous.files)])) {
    if (!validTarget(target)) throw new Error(`Invalid install target: ${target}`);
    const current = await fingerprint(path.join(config, target));
    const managed = Object.hasOwn(previous.files, target);
    if (current !== null && !managed) conflicts.push(`${target}: unrelated existing file/directory`);
    else if (current !== null && current !== previous.files[target]) conflicts.push(`${target}: installed copy was edited`);
  }
  assertNoConflicts(conflicts);
}

export function assertNoConflicts(conflicts: readonly string[]): void {
  if (conflicts.length) throw new Error(`No installed files changed. Resolve these conflicts first:\n${conflicts.join('\n')}\nBack up edited copies outside the target directory, then restore the original deployed contents or manually remove the conflicting copy. Move unrelated files outside the target directory. Retry after reviewing your backup; ownership metadata must not be edited to bypass protection.`);
}
