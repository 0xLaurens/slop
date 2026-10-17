import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { copy, exists, fingerprint, isMain, json, noLinks, options, repository,
  safeName, skillName, skillsAdd, temporary, warnPendingSkills, withMutex, writeJson } from './lib.ts';

export function configDirectory(override?: string) {
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

function validTarget(target: string) {
  if (target === 'AGENTS.md') return true;
  const parts = target.split('/');
  if (parts.length !== 2) return false;
  try {
    if (parts[0] === 'skills') return safeName(parts[1]) === parts[1];
    if (parts[0] === 'agents' && parts[1].endsWith('.md')) {
      return safeName(parts[1].slice(0, -3)) === parts[1].slice(0, -3);
    }
  } catch { return false; }
  return false;
}

export async function sources(repo: string) {
  const result = new Map();
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
      result.set(target, { source, hash: await fingerprint(source) });
    }
  }
  const instructions = path.join(repo, 'instructions', 'AGENTS.md');
  await noLinks(instructions);
  if (await exists(instructions)) {
    if (!(await lstat(instructions)).isFile()) throw new Error('instructions/AGENTS.md must be a regular file');
    result.set('AGENTS.md', { source: instructions, hash: await fingerprint(instructions) });
  }
  return result;
}

async function readManifest(file: string) {
  if (!await exists(file)) return { version: 1, owner: 'slop', files: {} };
  const manifest = await json(file);
  if (manifest.version !== 1 || manifest.owner !== 'slop' || !manifest.files || Array.isArray(manifest.files)) {
    throw new Error(`Invalid deployment manifest: ${file}`);
  }
  for (const [target, hash] of Object.entries(manifest.files)) {
    if (!validTarget(target) || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error(`Invalid deployment manifest entry: ${target}`);
    }
  }
  return manifest;
}

export async function preflight(config, desired, previous) {
  const conflicts = [];
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
async function deploy(config, desired, previous, state) {
  const transaction = path.join(state, 'transaction');
  if (await exists(transaction)) throw new Error(`Interrupted install: inspect/recover ${transaction} before retrying.`);
  await mkdir(transaction);
  const changed = [...new Set([...desired.keys(), ...Object.keys(previous.files)])];
  const saved = [];
  const installed = [];
  try {
    for (const target of changed) {
      const destination = path.join(config, target);
      if (await exists(destination)) {
        const backup = path.join(transaction, target);
        await mkdir(path.dirname(backup), { recursive: true });
        await rename(destination, backup);
        saved.push(target);
      }
      if (desired.has(target)) {
        installed.push(target);
        await copy(desired.get(target).source, destination);
      }
    }
    const files = {};
    for (const target of desired.keys()) files[target] = await fingerprint(path.join(config, target));
    await writeJson(path.join(state, 'manifest.json'), { version: 1, owner: 'slop', files });
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

type InstallOptions = {
  repo?: string;
  config?: string;
  uninstall?: boolean;
  stageSkill?: (source: string, name: string, workspace: string) => Promise<{ directory: string }>;
};

export async function install({ repo = repository, config, uninstall = false, stageSkill = skillsAdd }: InstallOptions = {}) {
  config = configDirectory(config);
  await noLinks(config);
  const state = path.join(config, '.slop');
  await noLinks(state);
  return withMutex(path.join(repo, '.slop', 'repository.lock'), () => withMutex(path.join(state, 'install.lock'), async () => {
    await noLinks(path.join(state, 'manifest.json'));
    const previous = await readManifest(path.join(state, 'manifest.json'));
    if (!uninstall) await warnPendingSkills(repo);
    const desired = uninstall ? new Map() : await sources(repo);
    await preflight(config, desired, previous);
    return temporary('slop-install-', async (workspace) => {
      // CLI staging is intentionally not global: it avoids hard-coded CLI global
      // paths and keeps its bookkeeping separate from the actual target config.
      let index = 0;
      for (const [target, entry] of desired) {
        if (target.startsWith('skills/')) {
          const staged = await stageSkill(entry.source, target.slice(7), path.join(workspace, String(index++)));
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
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
