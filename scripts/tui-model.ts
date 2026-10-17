import { lstat, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { isRecord, parseUpstream } from './data.ts';
import { exists, noLinks, readSkillsLock, repository, safeName, skillName } from './lib.ts';
import { installationChanges } from './manage.ts';
import type { ImportRequest, Item } from './manage.ts';
import type { Choice } from './terminal.ts';

export function installationStatus(item: Item, checked: boolean): string {
  if (item.edited) return item.managed ? 'Edited globally · blocked' : 'Not managed · conflict';
  if (checked) {
    if (!item.installed) return item.source ? 'Not installed → Install' : 'Source missing · cannot install';
    if (item.source && item.sourceHash !== item.installedHash) return 'Installed → Replace installed copy';
    return 'Installed → Keep';
  }
  if (item.managed) return item.installed ? 'Installed → Uninstall' : 'Missing globally → Clear ownership record';
  return 'Not installed → No change';
}

export function installationSummary(items: readonly Item[], selected: ReadonlySet<string>): string {
  const changes = installationChanges(items, selected);
  const count = (action: string) => changes.filter((change) => change.startsWith(`${action} `)).length;
  return `${count('INSTALL')} install · ${count('REPLACE')} replace · ${count('UNINSTALL')} uninstall · ${items.length - changes.length} unchanged`;
}

export function installationReview(items: readonly Item[], selected: ReadonlySet<string>, config: string): string[] {
  const changes = installationChanges(items, selected);
  return [`Destination: ${config}`, 'Repository files: unchanged', '', installationSummary(items, selected), '',
    ...['INSTALL', 'REPLACE', 'UNINSTALL'].flatMap((action) => {
      const matching = changes.filter((change) => change.startsWith(`${action} `));
      return matching.length ? [`${action === 'UNINSTALL' ? 'Uninstall globally' : action === 'REPLACE' ? 'Replace installed copies' : 'Install'}`, ...matching.map((change) => `  ${change.slice(action.length + 1)}`), ''] : [];
    })];
}

export async function fileChoices(items: readonly Item[], mode: 'install' | 'update' | 'delete', repo = repository): Promise<Choice[]> {
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
      detail: details.join('\n'), status: mode === 'install' ? (checked) => installationStatus(item, checked)
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

export async function validateImport(request: ImportRequest, repo = repository): Promise<string> {
  let name: string;
  if (request.kind === 'remote-skill') {
    parseUpstream({ sourceType: 'github', source: request.source });
    name = safeName(request.name);
  } else {
    await noLinks(request.source);
    if (request.kind === 'agent') {
      if (!(await lstat(request.source)).isFile() || !request.source.endsWith('.md')) throw new Error('Choose an existing Markdown (.md) file.');
      name = safeName(path.basename(request.source, '.md'));
    } else name = await skillName(request.source);
  }
  const target = request.kind === 'agent' ? `agents/${name}.md` : `skills/${name}`;
  await noLinks(path.join(repo, '.agents', target));
  if (await exists(path.join(repo, '.agents', target))) throw new Error(`${name} already exists in this repository. Choose a different source; existing files will not be overwritten.`);
  if (request.kind !== 'agent' && Object.hasOwn((await readSkillsLock(path.join(repo, 'skills-lock.json'))).skills, name)) throw new Error(`${name} already has a skills-lock.json entry. Resolve it manually before importing.`);
  return target;
}
