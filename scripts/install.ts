import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { diagnostic, errorMessage, isRecord } from './data.ts';
import type { StageSkill } from './data.ts';
import { copy, exists, fingerprint, isMain, json, noLinks, options, repository,
  safeName, skillName, temporary, warnPendingSkills, withMutex, writeJson } from './lib.ts';
import { skillsAdd } from './skills-cli.ts';
import { assertNoPendingUpdate } from './update-transaction.ts';

export interface DeploymentManifest {
  version: 1;
  owner: 'slop';
  files: Record<string, string>;
}

export interface DeploymentSource {
  source: string;
}

export type DeploymentSources = Map<string, DeploymentSource>;

export function configDirectory(override?: string): string {
  if (override) return path.resolve(override);
  // Fixed command only: Windows needs a shell to support npm's opencode.cmd shim.
  const result = process.platform === 'win32'
    ? spawnSync('opencode debug paths config', { shell: true, encoding: 'utf8' })
    : spawnSync('opencode', ['debug', 'paths', 'config'], { encoding: 'utf8' });
  const directory = result.stdout?.trim();
  if (result.error || result.status !== 0 || !directory || !path.isAbsolute(directory) || /[\r\n]/.test(directory)) {
    throw new Error('Cannot discover OpenCode config directory. Install OpenCode V2 or pass --config-dir <absolute-path>.');
  }
  return path.resolve(directory);
}

function validTarget(target: string): boolean {
  if (target === 'AGENTS.md') return true;
  const [kind, name, extra] = target.split('/');
  if (!name || extra !== undefined) return false;
  try {
    if (kind === 'skills') return safeName(name) === name;
    if (kind === 'agents' && name.endsWith('.md')) {
      return safeName(name.slice(0, -3)) === name.slice(0, -3);
    }
  } catch { return false; }
  return false;
}

export async function sources(repo: string): Promise<DeploymentSources> {
  const result: DeploymentSources = new Map();
  for (const kind of ['agents', 'skills']) {
    const directory = path.join(repo, kind);
    await noLinks(directory);
    if (!await exists(directory)) continue;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.gitkeep') continue;
      const source = path.join(directory, entry.name);
      await noLinks(source);
      if (kind === 'agents') {
        if (!entry.isFile() || !entry.name.endsWith('.md')) throw new Error(`Expected agents/<name>.md: ${source}`);
        safeName(entry.name.slice(0, -3));
      } else {
        if (!entry.isDirectory()) throw new Error(`Expected skills/<name>/SKILL.md: ${source}`);
        if (await skillName(source) !== entry.name) throw new Error(`Skill directory must match its frontmatter name: ${source}`);
      }
      const target = `${kind}/${entry.name}`;
      await fingerprint(source); // Validate the entire tree, including nested links.
      result.set(target, { source });
    }
  }
  const instructions = path.join(repo, 'instructions', 'AGENTS.md');
  await noLinks(instructions);
  if (await exists(instructions)) {
    if (!(await lstat(instructions)).isFile()) throw new Error('instructions/AGENTS.md must be a regular file');
    result.set('AGENTS.md', { source: instructions });
  }
  return result;
}

async function readManifest(file: string): Promise<DeploymentManifest> {
  if (!await exists(file)) return { version: 1, owner: 'slop', files: {} };
  const manifest = await json(file);
  if (!isRecord(manifest) || manifest.version !== 1 || manifest.owner !== 'slop' || !isRecord(manifest.files)) {
    throw new Error(`Invalid deployment manifest: ${file}`);
  }
  const files: DeploymentManifest['files'] = {};
  for (const [target, hash] of Object.entries(manifest.files)) {
    if (!validTarget(target) || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error(`Invalid deployment manifest entry: ${target}`);
    }
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
  if (conflicts.length) throw new Error(`No installed files changed. Resolve these conflicts first:\n${conflicts.join('\n')}`);
}

// Move old entries aside, deploy, then publish the manifest. Roll back normal
// filesystem errors. A process/power failure may require manual recovery.
async function deploy(config: string, desired: ReadonlyMap<string, DeploymentSource>, previous: DeploymentManifest, state: string): Promise<void> {
  const transaction = path.join(state, 'transaction');
  if (await exists(transaction)) throw new Error(`Interrupted install: inspect/recover ${transaction} before retrying.`);
  await mkdir(transaction);
  const changed = [...new Set([...desired.keys(), ...Object.keys(previous.files)])];
  const saved: string[] = [];
  const installed: string[] = [];
  try {
    for (const target of changed) {
      const destination = path.join(config, target);
      if (await exists(destination)) {
        const backup = path.join(transaction, target);
        await mkdir(path.dirname(backup), { recursive: true });
        await rename(destination, backup);
        saved.push(target);
      }
      const entry = desired.get(target);
      if (entry) {
        installed.push(target);
        await copy(entry.source, destination);
      }
    }
    const files: DeploymentManifest['files'] = {};
    for (const target of desired.keys()) {
      const hash = await fingerprint(path.join(config, target));
      if (hash === null) throw new Error(`Installed target disappeared: ${target}`);
      files[target] = hash;
    }
    const manifest: DeploymentManifest = { version: 1, owner: 'slop', files };
    await writeJson(path.join(state, 'manifest.json'), manifest);
  } catch (error) {
    try {
      for (const target of installed.reverse()) await rm(path.join(config, target), { recursive: true, force: true });
      for (const target of saved.reverse()) {
        await mkdir(path.dirname(path.join(config, target)), { recursive: true });
        await rename(path.join(transaction, target), path.join(config, target));
      }
    } catch (rollback) {
      throw new AggregateError([error, rollback], `Install and rollback failed; recover files from ${transaction}`);
    }
    await rm(transaction, { recursive: true });
    throw error;
  }
  await rm(transaction, { recursive: true });
}

export type InstallOptions = {
  repo?: string;
  config?: string;
  uninstall?: boolean;
  stageSkill?: StageSkill;
};

export async function install({ repo = repository, config: override, uninstall = false, stageSkill = skillsAdd }: InstallOptions = {}): Promise<void> {
  const config = configDirectory(override);
  await noLinks(config);
  const state = path.join(config, '.slop');
  await noLinks(state);
  return withMutex(path.join(repo, '.slop', 'repository.lock'), () => withMutex(path.join(state, 'install.lock'), async () => {
    await assertNoPendingUpdate(repo);
    await noLinks(path.join(state, 'manifest.json'));
    const previous = await readManifest(path.join(state, 'manifest.json'));
    if (!uninstall) await warnPendingSkills(repo);
    const desired: DeploymentSources = uninstall ? new Map() : await sources(repo);
    await preflight(config, desired, previous);
    return temporary('slop-install-', async (workspace) => {
      // CLI staging is intentionally not global: it avoids hard-coded CLI global
      // paths and keeps its bookkeeping separate from the actual target config.
      let index = 0;
      for (const [target, entry] of desired) {
        if (target.startsWith('skills/')) {
          const staged = await stageSkill({ source: entry.source, name: safeName(target.slice(7)),
            workspace: path.join(workspace, String(index++)) });
          entry.source = staged.directory;
        } else {
          const staged = path.join(workspace, 'files', target);
          await copy(entry.source, staged);
          entry.source = staged;
        }
      }
      await preflight(config, desired, previous);
      await deploy(config, desired, previous, state);
      console.log(`${uninstall ? 'Uninstalled managed files from' : 'Installed repository files into'} ${config}`);
    });
  }));
}

if (isMain(import.meta.url)) {
  try {
    const args = options({ 'config-dir': { type: 'string' }, uninstall: { type: 'boolean' }, help: { type: 'boolean' } });
    if (args.help) console.log('npm run install:global -- [--config-dir PATH] [--uninstall]\nConflicts abort before any installed files change.');
    else await install({ config: args['config-dir'], uninstall: args.uninstall });
  } catch (error) {
    diagnostic({ level: 'error', event: 'install.failed', message: errorMessage(error), context: { repo: repository } });
    process.exitCode = 1;
  }
}
