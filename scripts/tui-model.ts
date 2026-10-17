import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { isRecord, parseUpstream } from './data.ts';
import { noLinks, readSkillsLock, repository } from './lib.ts';
import { deploymentAction } from './deployment-plan.ts';
import type { DeploymentAction, DeploymentPlan, Item } from './deployment-plan.ts';
import type { Choice } from './terminal.ts';

export function installationStatus(action: DeploymentAction): string {
  switch (action.kind) {
    case 'install': return 'Not installed → Install';
    case 'replace': return 'Installed → Replace installed copy';
    case 'keep': return 'Installed → Keep';
    case 'uninstall': return action.missing ? 'Missing globally → Clear ownership record' : 'Installed → Uninstall';
    case 'none': return 'Not installed → No change';
    case 'blocked': return `${action.reason} · blocked`;
    default: { const exhaustive: never = action; return exhaustive; }
  }
}

export function installationSummary(plan: DeploymentPlan): string {
  const count = (kind: DeploymentPlan['actions'][number]['kind']) => plan.actions.filter((action) => action.kind === kind).length;
  const blocked = count('blocked');
  return `${count('install')} install · ${count('replace')} replace · ${count('uninstall')} uninstall · ${count('keep') + count('none')} unchanged${blocked ? ` · ${blocked} blocked` : ''}`;
}

export function installationReview(plan: DeploymentPlan): string[] {
  const groups = [
    { kind: 'install', label: 'Install' }, { kind: 'replace', label: 'Replace installed copies' },
    { kind: 'uninstall', label: 'Uninstall globally' }, { kind: 'blocked', label: 'Blocked — resolve before applying' },
  ];
  return [`Destination: ${plan.config}`, 'Repository files: unchanged', '', installationSummary(plan), '',
    ...groups.flatMap(({ kind, label }) => {
      const matching = plan.actions.filter((action) => action.kind === kind);
      return matching.length ? [label, ...matching.map((action) => `  ${action.target}${action.kind === 'uninstall' && action.missing ? ' (clear missing entry)' : action.kind === 'blocked' ? `: ${action.reason}` : ''}`), ''] : [];
    })];
}

type FileChoicesRequest = { items: readonly Item[]; repo?: string } &
  ({ mode: 'install'; config: string } | { mode: 'update' | 'delete' });

export async function fileChoices(request: FileChoicesRequest): Promise<Choice[]> {
  const { items, mode, repo = repository } = request;
  const lock = await readSkillsLock(path.join(repo, 'skills-lock.json'));
  const result: Choice[] = [];
  for (const item of items) {
    const skill = item.target.startsWith('skills/');
    const agent = item.target.startsWith('agents/');
    const name = skill ? item.target.slice(7) : agent ? item.target.slice(7, -3) : 'Shared instructions (AGENTS.md)';
    let description = '';
    if (item.source) {
      const text = await readFile(skill ? path.join(item.source, 'SKILL.md') : item.source, 'utf8');
      const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
      if (frontmatter) {
        try { const metadata: unknown = parse(frontmatter); if (isRecord(metadata) && typeof metadata.description === 'string') description = metadata.description; }
        catch { /* Agent frontmatter is optional; source validation is handled by the backend. */ }
      }
    }
    const entry = skill && Object.hasOwn(lock.skills, name) ? lock.skills[name] : undefined;
    const origin = entry ? parseUpstream(entry) : undefined;
    const details = [description, item.source ?? 'Repository source missing',
      ...skill ? [origin?.kind === 'remote' ? `Upstream: ${origin.repository}` : 'Local-only skill — no upstream updates'] : [],
      ...item.modified ? ['Repository copy has local modifications'] : [],
      ...item.edited ? ['Global copy is edited or unrelated; changes are blocked until resolved manually'] : []].filter(Boolean);
    result.push({ value: item.target, label: name, group: skill ? 'Skills' : agent ? 'Agents' : 'Instructions',
      disabled: mode === 'install' && !item.source && !item.installed,
      detail: details.join('\n'), status: request.mode === 'install' ? (checked) => installationStatus(deploymentAction({ item, checked, config: request.config }))
        : mode === 'update' ? (checked) => `${item.modified ? 'Locally modified · ' : ''}${checked ? 'Check for updates' : 'Keep current version'}`
          : (checked) => checked ? `Delete permanently${item.installed ? ' + uninstall globally' : ''}` : 'Keep repository source' });
  }
  const order = ['Skills', 'Agents', 'Instructions'];
  return result.sort((a, b) => order.indexOf(a.group ?? '') - order.indexOf(b.group ?? '') || a.label.localeCompare(b.label));
}

export function resolveImportPath(value: string, base = repository): string {
  return path.resolve(base, value === '~' ? homedir() : value.startsWith(`~${path.sep}`) || value.startsWith('~/') ? path.join(homedir(), value.slice(2)) : value);
}

export async function completePath(value: string, base = repository): Promise<string[]> {
  const resolved = resolveImportPath(value, base);
  const endsWithSeparator = value.endsWith(path.sep) || value.endsWith('/');
  const directory = endsWithSeparator || !value ? resolved : path.dirname(resolved);
  const prefix = endsWithSeparator || !value ? '' : path.basename(resolved);
  await noLinks(directory);
  const matches = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => !entry.isSymbolicLink() && (entry.isFile() || entry.isDirectory()) && entry.name.startsWith(prefix));
  const typedDirectory = endsWithSeparator ? value : value.slice(0, Math.max(0, value.length - prefix.length));
  return matches.sort((a, b) => a.name.localeCompare(b.name)).map((entry) => `${typedDirectory}${entry.name}${entry.isDirectory() ? path.sep : ''}`);
}
