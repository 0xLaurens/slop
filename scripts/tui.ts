import { closeSync, openSync, writeSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { errorMessage } from './data.ts';
import type { StageSkill } from './data.ts';
import { configDirectory, install } from './install.ts';
import { isMain, noLinks, options, repository, safeName, skillName } from './lib.ts';
import { assertInventory, deleteWithPullRequest, importContent, installationChanges, inventory } from './manage.ts';
import type { ImportRequest, Item } from './manage.ts';
import { createSkillsAdd } from './skills-cli.ts';
import { Terminal } from './terminal.ts';
import { updateSkills } from './update-skills.ts';

interface Operation {
  log: (message: string) => void;
  stage: StageSkill;
  cancelled: () => boolean;
  check: () => void;
}

async function operation(ui: Terminal, title: string, action: (operation: Operation) => Promise<string>): Promise<void> {
  const logs = path.join(repository, '.slop', 'logs');
  await noLinks(logs);
  await mkdir(logs, { recursive: true });
  const logFile = path.join(logs, `${Date.now()}-${randomUUID()}.log`);
  const fd = openSync(logFile, 'wx', 0o600);
  const lines: string[] = [];
  let cancelled = false;
  const cancel = () => { cancelled = true; lines.push('Cancellation requested; waiting for a safe boundary…'); ui.progress(title, lines, cancel); };
  const check = () => { if (cancelled) throw new Error('Cancelled at a safe boundary. Completed work, if any, is retained.'); };
  const log = (message: string) => {
    writeSync(fd, `${message}\n`);
    lines.push(...message.split('\n'));
    if (lines.length > 100) lines.splice(0, lines.length - 100);
    ui.progress(title, lines, cancel);
  };
  // Upstream presentations belong in diagnostics, never in the TUI renderer.
  const fetch = createSkillsAdd((message) => { writeSync(fd, message); });
  const stage: StageSkill = async (request) => { check(); log(`Staging ${request.name}…`); return fetch(request); };
  ui.progress(title, lines, cancel);
  let outcome: string;
  try {
    outcome = await action({ log, stage, cancelled: () => cancelled, check });
    writeSync(fd, `\n${outcome}\n`);
  } catch (error) {
    outcome = errorMessage(error);
    writeSync(fd, `\nFAILED: ${outcome}\n`);
  } finally { closeSync(fd); }
  await ui.page(`${title} — result`, `${outcome}\n\nDiagnostics: ${logFile}`);
}

function itemChoices(items: readonly Item[]) {
  return items.map((item) => ({ value: item.target,
    label: `${item.target} · ${item.installed ? item.managed ? 'installed' : 'unmanaged conflict' : 'not installed'}${item.edited ? ' · EDITED/CONFLICT' : ''}${!item.source ? ' · source missing' : ''}`,
    detail: `${item.source ?? 'No repository source'}${item.target.startsWith('skills/') ? ` · ${item.remote ? 'upstream' : 'local-only'}${item.modified ? ' · locally modified' : ''}` : ''}` }));
}

async function manageInstallation(ui: Terminal, config: string): Promise<void> {
  const items = await inventory(repository, config);
  const selected = await ui.select('Choose skills, agents, and instructions to keep installed', itemChoices(items),
    items.filter((item) => item.installed && item.managed).map((item) => item.target));
  if (!selected) return;
  const changes = installationChanges(items, new Set(selected));
  if (!changes.length) { await ui.page('Installed skills and agents', 'No changes selected.'); return; }
  if (!await ui.confirm('Review installation changes', changes)) return;
  await operation(ui, 'Applying installation changes', async ({ stage, log, check }) => {
    check();
    await install({ config, selected, stageSkill: stage, log, guard: () => assertInventory(repository, config, items), beforeApply: check });
    return `Applied:\n${changes.join('\n')}`;
  });
}

async function update(ui: Terminal, config: string): Promise<void> {
  const items = (await inventory(repository, config)).filter((item) => item.source && item.target.startsWith('skills/') && item.remote);
  const selected = await ui.select('Choose skills to update (unchecked = keep current version)', itemChoices(items));
  if (!selected?.length) return;
  if (!await ui.confirm('Review skill updates — repository files only', selected.map((target) => `CHECK/UPDATE ${target}`))) return;
  await operation(ui, 'Updating skills', async ({ stage, log, cancelled }) => {
    const result = await updateSkills({ selected: selected.map((target) => target.slice(7)), interactive: true,
      fetchSkill: stage, log, report: (value) => log(JSON.stringify(value)), cancelled, ask: async (name) => {
        if (cancelled()) return false;
        const answer = await ui.select(`${name}: locally modified — replace with upstream?`, [
          { value: 'keep', label: 'Keep local version (default)' },
          { value: 'replace', label: 'Replace with upstream (backup first)' },
        ], [], false);
        log(`${name}: ${answer?.[0] === 'replace' ? 'Replace' : 'Keep'}`);
        return answer?.[0] === 'replace';
      } });
    return `${result.updated.length} updated, ${result.unchanged.length} unchanged, ${result.skipped.length} kept/skipped, ${result.failures.length} failed.\n${JSON.stringify(result, null, 2)}\n\nReview git diff, then use Install / uninstall to install the updates globally.`;
  });
}

async function add(ui: Terminal): Promise<void> {
  const kind = (await ui.select('Add skills or agents — choose a source', [
    { value: 'remote-skill', label: 'Import skill from Git repository' },
    { value: 'local-skill', label: 'Import skill from local folder' },
    { value: 'agent', label: 'Import agent from Markdown file' },
  ], [], false))?.[0];
  if (!kind) return;
  const source = await ui.text(kind === 'remote-skill' ? 'Repository URL or GitHub owner/repository' : 'Absolute or repository-relative source path');
  if (!source) return;
  let request: ImportRequest;
  if (kind === 'remote-skill') {
    const name = await ui.text('Exact skill name to import');
    if (!name) return;
    request = { kind, source, name: safeName(name) };
  } else if (kind === 'local-skill' || kind === 'agent') {
    request = { kind, source: path.resolve(repository, source) };
  } else return;
  const name = request.kind === 'remote-skill' ? request.name : request.kind === 'local-skill'
    ? await skillName(request.source) : safeName(path.basename(request.source, '.md'));
  const target = request.kind === 'agent' ? `agents/${name}.md` : `skills/${name}`;
  if (!await ui.confirm('Review addition — repository files only', [`IMPORT ${source}`, `ADD .agents/${target}`, 'Existing content will not be overwritten.', 'No global installation, commit, or PR will happen.'])) return;
  await operation(ui, 'Importing repository files', async ({ stage, check }) => {
    check();
    const imported = await importContent(repository, request, stage, check);
    return `Imported ${imported}.\nReview git diff, then use Install / uninstall to install it globally.`;
  });
}

async function remove(ui: Terminal, config: string): Promise<void> {
  const expected = await inventory(repository, config);
  const items = expected.filter((item) => item.source && item.target !== 'AGENTS.md');
  const targets = await ui.select('Choose skills and agents to delete permanently', itemChoices(items));
  if (!targets?.length) return;
  if (!await ui.confirm('Review deletion, global uninstall, and pull request', [...targets.map((target) => `DELETE SOURCE + UNINSTALL ${target}`),
    'Remove corresponding skills-lock.json entries.', 'Create one branch, commit, push, and PR for this batch.',
    'Requires clean Git state, latest default-branch commit, and authenticated GitHub tooling.',
    'Remain on the deletion branch. Global removal happens immediately, not after PR approval.'])) return;
  await operation(ui, 'Deleting repository files and creating pull request', async ({ log, check }) => {
    check();
    const url = await deleteWithPullRequest({ repo: repository, config, targets, expected, log, check });
    return `Deletion completed. PR: ${url}\nRemaining on the deletion branch; review with git status.`;
  });
}

export async function main(): Promise<void> {
  const args = options({ 'config-dir': { type: 'string' }, help: { type: 'boolean' } });
  if (args.help) {
    console.log('npm run tui -- [--config-dir PATH]\nInteractive management of repository sources and global OpenCode files.');
    return;
  }
  const ui = new Terminal();
  try {
    const config = configDirectory(args['config-dir']);
    while (true) {
      const action = (await ui.select(`OpenCode target: ${config}`, [
        { value: 'install', label: 'Install / uninstall', detail: 'Choose skills, agents, and instructions to install globally. Uncheck to uninstall.' },
        { value: 'update', label: 'Update skills', detail: 'Fetch upstream updates into this repository. Global copies stay unchanged.' },
        { value: 'import', label: 'Add skills or agents', detail: 'Import into this repository from Git or local files. Nothing is installed globally.' },
        { value: 'delete', label: 'Permanently delete skills or agents', detail: 'Delete repository sources, uninstall global copies, and open one pull request.' },
        { value: 'exit', label: 'Exit' },
      ], [], false))?.[0];
      if (!action || action === 'exit') break;
      try {
        if (action === 'install') await manageInstallation(ui, config);
        if (action === 'update') await update(ui, config);
        if (action === 'import') await add(ui);
        if (action === 'delete') await remove(ui, config);
      } catch (error) { await ui.page('Cannot continue — no automatic override', errorMessage(error)); }
    }
  } finally { ui.close(); }
}

if (isMain(import.meta.url)) {
  try { await main(); }
  catch (error) { console.error(errorMessage(error)); process.exitCode = 1; }
}
