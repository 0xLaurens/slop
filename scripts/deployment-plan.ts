import path from 'node:path';
import { parseUpstream } from './data.ts';
import { assertNoConflicts, readManifest, sources } from './deployment-state.ts';
import type { DeploymentSource, DeploymentSources } from './deployment-state.ts';
import { fingerprint, noLinks, readSkillsLock, skillHash } from './lib.ts';

export interface Item {
  target: string;
  source?: string;
  installed: boolean;
  managed: boolean;
  edited: boolean;
  remote: boolean;
  modified: boolean;
  sourceHash: string | null;
  installedHash: string | null;
}

export async function inventory(repo: string, config: string): Promise<Item[]> {
  await noLinks(path.join(config, '.slop', 'manifest.json'));
  const manifest = await readManifest(path.join(config, '.slop', 'manifest.json'));
  const available = await sources(repo);
  const lock = await readSkillsLock(path.join(repo, 'skills-lock.json'));
  const result: Item[] = [];
  for (const target of [...new Set([...available.keys(), ...Object.keys(manifest.files)])].sort()) {
    const source = available.get(target)?.source;
    const managed = Object.hasOwn(manifest.files, target);
    const current = await fingerprint(path.join(config, target));
    const name = target.startsWith('skills/') ? target.slice(7) : '';
    const entry = Object.hasOwn(lock.skills, name) ? lock.skills[name] : undefined;
    result.push({ target, source, managed, installed: current !== null,
      edited: current !== null && (!managed || current !== manifest.files[target]),
      remote: Boolean(entry && parseUpstream(entry).kind === 'remote'),
      modified: Boolean(source && entry && await skillHash(source) !== entry.computedHash),
      sourceHash: source ? await fingerprint(source) : null, installedHash: current });
  }
  return result;
}

export async function assertInventory(repo: string, config: string, expected: readonly Item[]): Promise<void> {
  if (JSON.stringify(await inventory(repo, config)) !== JSON.stringify(expected)) {
    throw new Error('Files or installation state changed after review. Return to the menu and review a fresh plan.');
  }
}

type DeploymentInput = DeploymentSource & { target: string; hash: string };
export type DeploymentAction =
  | (DeploymentInput & { kind: 'install' | 'replace' | 'keep' })
  | { kind: 'uninstall'; target: string; missing: boolean }
  | { kind: 'none'; target: string }
  | { kind: 'blocked'; target: string; reason: string };

export interface DeploymentPlan {
  repo: string;
  config: string;
  expected: readonly Item[];
  actions: readonly DeploymentAction[];
}

export function deploymentAction({ item, checked, config }: { item: Item; checked: boolean; config: string }): DeploymentAction {
  const { target } = item;
  if (item.edited && (item.managed || checked)) return { kind: 'blocked', target,
    reason: item.managed ? 'installed copy was edited' : 'unrelated existing file/directory' };
  if (!checked) return item.managed ? { kind: 'uninstall', target, missing: !item.installed } : { kind: 'none', target };
  const source = item.source ?? (item.installed ? path.join(config, target) : undefined);
  const hash = item.source ? item.sourceHash : item.installedHash;
  if (!source || hash === null) return { kind: 'blocked', target, reason: 'Repository source and installed copy are missing' };
  return { kind: !item.installed ? 'install' : item.source && item.sourceHash !== item.installedHash ? 'replace' : 'keep',
    target, source, hash, origin: item.source ? 'repository' : 'installed' };
}

export function deploymentPlan({ repo, config, items, selected }: {
  repo: string; config: string; items: readonly Item[]; selected: ReadonlySet<string>;
}): DeploymentPlan {
  for (const target of selected) if (!items.some((item) => item.target === target)) throw new Error(`Unknown selection: ${target}`);
  const actions = items.map((item) => deploymentAction({ item, checked: selected.has(item.target), config }));
  return { repo, config, expected: items, actions };
}

export function deploymentSources(plan: DeploymentPlan): DeploymentSources {
  assertNoConflicts(plan.actions.flatMap((action) => action.kind === 'blocked' ? [`${action.target}: ${action.reason}`] : []));
  const desired: DeploymentSources = new Map();
  for (const action of plan.actions) {
    if ('source' in action) desired.set(action.target, { source: action.source, origin: action.origin });
  }
  return desired;
}

export async function validateDeployment(plan: DeploymentPlan, staged: ReadonlyMap<string, DeploymentSource>): Promise<void> {
  await assertInventory(plan.repo, plan.config, plan.expected);
  for (const action of plan.actions) {
    if (!('source' in action)) continue;
    const input = staged.get(action.target);
    if (!input || await fingerprint(input.source) !== action.hash) throw new Error(`${action.target}: staged contents differ from the reviewed source. Review a fresh plan.`);
  }
}

export function deploymentChanges(plan: DeploymentPlan): string[] {
  return plan.actions.flatMap((action) => {
    switch (action.kind) {
      case 'install': return [`INSTALL ${action.target}`];
      case 'replace': return [`REPLACE ${action.target}`];
      case 'uninstall': return [`UNINSTALL ${action.target}${action.missing ? ' (clear missing entry)' : ''}`];
      case 'blocked': return [`BLOCKED ${action.target}: ${action.reason}`];
      case 'keep': case 'none': return [];
      default: { const exhaustive: never = action; return exhaustive; }
    }
  });
}
