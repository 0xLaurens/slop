import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { diagnostic, errorMessage } from './data.ts';
import type { StageSkill } from './data.ts';
import { copy, exists, fingerprint, isMain, noLinks, options, repository,
  safeName, temporary, withMutex, writeJson } from './lib.ts';
import { deploymentPlan, deploymentSources, inventory, validateDeployment } from './deployment-plan.ts';
import type { DeploymentPlan } from './deployment-plan.ts';
import { preflight, readManifest } from './deployment-state.ts';
import type { DeploymentManifest, DeploymentSource, DeploymentSources } from './deployment-state.ts';
import { skillsAdd } from './skills-cli.ts';
import { assertNoPendingPublication } from './skill-transaction.ts';
import { RecoveryRequiredError } from './operation-errors.ts';

export function configDirectory(override?: string): string {
  if (override) return path.resolve(override);
  // Fixed command only: Windows needs a shell to support Bun's opencode.cmd shim.
  const result = process.platform === 'win32'
    ? spawnSync('opencode debug paths config', { shell: true, encoding: 'utf8' })
    : spawnSync('opencode', ['debug', 'paths', 'config'], { encoding: 'utf8' });
  const directory = result.stdout?.trim();
  if (result.error || result.status !== 0 || !directory || !path.isAbsolute(directory) || /[\r\n]/.test(directory)) {
    throw new Error('Cannot discover OpenCode config directory. Install OpenCode V2 or pass --config-dir <absolute-path>.');
  }
  return path.resolve(directory);
}

// Move old entries aside, deploy, then publish the manifest. Roll back normal
// filesystem errors. A process/power failure may require manual recovery.
async function deploy(config: string, desired: ReadonlyMap<string, DeploymentSource>, previous: DeploymentManifest, state: string): Promise<void> {
  const transaction = path.join(state, 'transaction');
  if (await exists(transaction)) throw new RecoveryRequiredError(`Interrupted install: inspect/recover ${transaction} before retrying.`,
    { kind: 'deployment', transaction }, []);
  await fs.mkdir(transaction);
  const changed = [...new Set([...desired.keys(), ...Object.keys(previous.files)])];
  const saved: string[] = [];
  const installed: string[] = [];
  try {
    for (const target of changed) {
      const destination = path.join(config, target);
      if (await exists(destination)) {
        const backup = path.join(transaction, target);
        await fs.mkdir(path.dirname(backup), { recursive: true });
        await fs.rename(destination, backup);
        saved.push(target);
      }
      const entry = desired.get(target);
      if (!entry) continue;
      installed.push(target);
      await copy(entry.source, destination);
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
      for (const target of installed.reverse()) await fs.rm(path.join(config, target), { recursive: true, force: true });
      for (const target of saved.reverse()) {
        await fs.mkdir(path.dirname(path.join(config, target)), { recursive: true });
        await fs.rename(path.join(transaction, target), path.join(config, target));
      }
      await fs.rm(transaction, { recursive: true });
    } catch (rollback) {
      throw new RecoveryRequiredError(`Install and rollback failed; recover files from ${transaction}`,
        { kind: 'deployment', transaction }, [error, rollback]);
    }
    throw error;
  }
  try { await fs.rm(transaction, { recursive: true }); }
  catch (error) { throw new RecoveryRequiredError(`Installation completed; recover transaction cleanup at ${transaction}`,
    { kind: 'deployment', transaction }, [error]); }
}

// CLI staging is intentionally not global: it avoids hard-coded CLI global
// paths and keeps its bookkeeping separate from the actual target config.
async function stageSources(desired: DeploymentSources, workspace: string, stageSkill: StageSkill): Promise<void> {
  let index = 0;
  for (const [target, entry] of desired) {
    if (target.startsWith('skills/') && entry.origin === 'repository') {
      const staged = await stageSkill({ source: entry.source, name: safeName(target.slice(7)),
        workspace: path.join(workspace, String(index++)) });
      entry.source = staged.directory;
      continue;
    }
    const staged = path.join(workspace, 'files', target);
    await copy(entry.source, staged);
    entry.source = staged;
  }
}

export type InstallOptions = {
  repo?: string;
  config?: string;
  uninstall?: boolean;
  stageSkill?: StageSkill;
  selected?: readonly string[];
  log?: (message: string) => void;
  guard?: () => Promise<void>;
  beforeApply?: () => void;
  plan?: DeploymentPlan;
};

export async function deploymentSession<T>(repo: string, config: string, action: (previous: DeploymentManifest) => Promise<T>): Promise<T> {
  await noLinks(config);
  const state = path.join(config, '.slop');
  await noLinks(state);
  return withMutex(path.join(repo, '.slop', 'repository.lock'), () => withMutex(path.join(state, 'install.lock'), async () => {
    await assertNoPendingPublication(repo);
    await noLinks(path.join(state, 'manifest.json'));
    const previous = await readManifest(path.join(state, 'manifest.json'));
    return action(previous);
  }));
}

// Caller holds both repository and destination locks via deploymentSession.
export async function applyDeployment({ config, desired, previous, stageSkill = skillsAdd,
  beforeApply = () => {}, validate = async () => {} }: {
  config: string; desired: DeploymentSources; previous: DeploymentManifest; stageSkill?: StageSkill;
  beforeApply?: () => void; validate?: () => Promise<void>;
}): Promise<void> {
  await preflight(config, desired, previous);
  return temporary('slop-install-', async (workspace) => {
    await stageSources(desired, workspace, stageSkill);
    await preflight(config, desired, previous);
    await validate();
    beforeApply();
    await deploy(config, desired, previous, path.join(config, '.slop'));
  });
}

export async function install({ repo = repository, config: override, uninstall = false, stageSkill = skillsAdd,
  selected, log = console.log, guard, beforeApply, plan: reviewed }: InstallOptions = {}): Promise<void> {
  const config = configDirectory(override ?? reviewed?.config);
  if (reviewed && (path.resolve(reviewed.repo) !== path.resolve(repo) || config !== path.resolve(reviewed.config) || selected || uninstall)) {
    throw new Error('A reviewed plan must match the repository and destination and cannot be combined with another selection.');
  }
  return deploymentSession(repo, config, async (previous) => {
    await guard?.();
    const items = reviewed?.expected ?? await inventory(repo, config);
    const plan = reviewed ?? deploymentPlan({ repo, config, items,
      selected: new Set(uninstall ? [] : selected ?? items.filter((item) => item.source).map((item) => item.target)) });
    const desired = deploymentSources(plan);
    await validateDeployment(plan, desired);
    await applyDeployment({ config, desired, previous, stageSkill, beforeApply, validate: async () => {
      await guard?.();
      await validateDeployment(plan, desired);
    } });
    log(`${uninstall ? 'Uninstalled managed files from' : 'Installed selected repository files into'} ${config}`);
  });
}

async function main(): Promise<void> {
  const args = options({ 'config-dir': { type: 'string' }, uninstall: { type: 'boolean' }, help: { type: 'boolean' } });
  if (args.help) {
    console.log('bun run install:global [--config-dir PATH] [--uninstall]\nConflicts abort before any installed files change.');
    return;
  }
  await install({ config: args['config-dir'], uninstall: args.uninstall });
}

if (isMain(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    diagnostic({ level: 'error', event: 'install.failed', message: errorMessage(error), context: { repo: repository } });
    process.exitCode = 1;
  }
}
