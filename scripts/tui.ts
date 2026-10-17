import { closeSync, openSync, writeSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { errorMessage, parseUpstream } from './data.ts';
import type { StageSkill } from './data.ts';
import { configDirectory, install } from './install.ts';
import { isMain, noLinks, options, repository } from './lib.ts';
import { assertInventory, checkDeletionPrerequisites, deleteWithPullRequest, importContent, installationChanges, inventory } from './manage.ts';
import type { ImportRequest } from './manage.ts';
import { createSkillsAdd } from './skills-cli.ts';
import { Terminal } from './terminal.ts';
import type { SelectionState } from './terminal.ts';
import { completePath, fileChoices, installationReview, installationSummary, resolveImportPath, validateImport } from './tui-model.ts';
import { updateSkills } from './update-skills.ts';

interface Operation {
  log: (message: string) => void;
  diagnostic: (message: string) => void;
  stage: StageSkill;
  cancelled: () => boolean;
  check: () => void;
  atomic: (active?: boolean) => void;
}
interface Outcome { status: 'Completed' | 'Cancelled' | 'Partially completed' | 'Failed'; summary: string }

class Cancelled extends Error {}

async function operation(ui: Terminal, title: string, action: (operation: Operation) => Promise<Outcome>, totalSkills = 0): Promise<void> {
  const logs = path.join(repository, '.slop', 'logs');
  await noLinks(logs);
  await mkdir(logs, { recursive: true });
  const logFile = path.join(logs, `${Date.now()}-${randomUUID()}.log`);
  const fd = openSync(logFile, 'wx', 0o600);
  const lines: string[] = ['Preparing…'];
  let cancelled = false;
  let atomic = false;
  let staged = 0;
  const redraw = () => ui.progress(title, lines, atomic || cancelled ? undefined : cancel);
  const cancel = () => {
    if (cancelled || atomic) return;
    cancelled = true;
    lines.push('Cancellation requested. Waiting for the current step to finish safely…');
    redraw();
  };
  const check = () => { if (cancelled) throw new Cancelled('Cancelled before the next file transaction. Completed work, if any, is retained.'); };
  const diagnostic = (message: string) => { writeSync(fd, `${message}\n`); };
  const log = (message: string) => {
    diagnostic(message);
    lines.push(...message.split('\n'));
    if (lines.length > 100) lines.splice(0, lines.length - 100);
    redraw();
  };
  const setAtomic = (active = true) => {
    if (active) check();
    atomic = active;
    redraw();
  };
  const fetch = createSkillsAdd(diagnostic);
  const stage: StageSkill = async (request) => {
    check();
    log(`Fetching ${request.name} · ${++staged}${totalSkills ? ` of ${totalSkills}` : ''}`);
    const result = await fetch(request);
    log(`Fetched ${request.name} · ${staged}${totalSkills ? ` of ${totalSkills}` : ''} prepared`);
    return result;
  };
  redraw();
  let outcome: Outcome;
  try {
    outcome = await action({ log, diagnostic, stage, cancelled: () => cancelled, check, atomic: setAtomic });
    diagnostic(`${outcome.status}\n${outcome.summary}`);
  } catch (error) {
    const message = errorMessage(error);
    outcome = { status: error instanceof Cancelled ? 'Cancelled' : message.includes('Recovery:') || message.includes('requires recovery') ? 'Partially completed' : 'Failed', summary: message };
    diagnostic(`${outcome.status}: ${message}`);
  } finally { closeSync(fd); }
  while (true) {
    const answer = (await ui.select(`${title} — ${outcome.status}`, [
      { value: 'back', label: 'Back to main menu' },
      { value: 'details', label: 'View full results' },
      { value: 'logs', label: 'View diagnostics', detail: logFile },
    ], [], false, { intro: outcome.summary.split('\n').filter(Boolean).slice(0, 4), continueLabel: 'choose' }))?.[0];
    if (!answer || answer === 'back') return;
    await ui.page(answer === 'logs' ? 'Diagnostics' : outcome.status,
      answer === 'logs' ? `${logFile}\n\n${await readFile(logFile, 'utf8')}` : outcome.summary);
  }
}

async function manageInstallation(ui: Terminal, config: string): Promise<void> {
  const items = await inventory(repository, config);
  const choices = await fileChoices(items, 'install');
  let selected = items.filter((item) => item.installed && item.managed).map((item) => item.target);
  const state: SelectionState = {};
  while (true) {
    const answer = await ui.select('Install / uninstall', choices, selected, true, {
      state, intro: ['Checked = installed after applying changes. Repository files will not be deleted.', `Global destination: ${config}`],
      summary: (selection) => installationSummary(items, selection),
      empty: 'No skills, agents, or shared instructions available. Use Add skills or agents first.',
    });
    if (!answer) return;
    selected = answer;
    const changes = installationChanges(items, new Set(selected));
    if (!changes.length) { await ui.page('No installation changes', 'Your selections match the current installation. Toggle a checkbox to install or uninstall.'); continue; }
    if (!await ui.confirm('Review installation changes', installationReview(items, new Set(selected), config), 'Apply installation changes')) continue;
    await operation(ui, 'Applying installation changes', async ({ stage, log, check, atomic }) => {
      check();
      await install({ config, selected, stageSkill: stage, log, guard: () => assertInventory(repository, config, items), beforeApply: () => atomic() });
      return { status: 'Completed', summary: `${installationSummary(items, new Set(selected))}\nRepository files were not deleted.\n\n${changes.join('\n')}` };
    }, selected.filter((target) => target.startsWith('skills/') && items.some((item) => item.target === target && item.source)).length);
    return;
  }
}

async function update(ui: Terminal, config: string): Promise<void> {
  const items = (await inventory(repository, config)).filter((item) => item.source && item.target.startsWith('skills/') && item.remote);
  const choices = await fileChoices(items, 'update');
  let selected: string[] = [];
  const state: SelectionState = {};
  while (true) {
    const answer = await ui.select('Update skills from upstream', choices, selected, true, {
      state, intro: ['Updates repository copies only. Global installation stays unchanged.', 'Unchecked = keep the current repository version.'],
      empty: 'No upstream-backed skills to update. Local-only skills cannot be updated from upstream.',
    });
    if (!answer || !choices.length) return;
    selected = answer;
    if (!selected.length) { await ui.page('No skills selected', 'Select skills with Space, or press Esc to return without updating.'); continue; }
    if (!await ui.confirm('Review skill updates', ['Repository files: may change', 'Global installation: unchanged', '',
      ...selected.map((target) => `Check for updates: ${target}`), '', 'Locally modified skills will ask Keep / Replace. Replacement creates a backup.'], 'Update selected skills')) continue;
    await operation(ui, 'Updating skills', async ({ stage, log, diagnostic, cancelled, atomic }) => {
      const result = await updateSkills({ selected: selected.map((target) => target.slice(7)), interactive: true,
        fetchSkill: stage, log, onTransaction: atomic, cancelled,
        onProgress: (progress) => log(`${progress.completed} of ${progress.total} processed · ${progress.updated} updated · ${progress.unchanged} unchanged · ${progress.skipped} kept/skipped · ${progress.failed} failed · ${progress.total - progress.completed} remaining`),
        report: (value) => { diagnostic(JSON.stringify(value)); log(`${value.context.skill ?? 'Skill'}: ${value.message}`); },
        ask: async (name) => {
          if (cancelled()) return false;
          const answer = await ui.select(`${name}: repository copy has local modifications`, [
            { value: 'keep', label: 'Keep current version', detail: 'Do not change this skill or its upstream baseline.' },
            { value: 'replace', label: 'Replace with upstream', detail: 'Save a backup first, then replace the repository copy.' },
          ], [], false, { showDescriptions: true });
          log(`${name}: ${answer?.[0] === 'replace' ? 'Replace' : 'Keep'}`);
          return answer?.[0] === 'replace';
        } });
      const status = result.failures.length ? result.updated.length ? 'Partially completed' : 'Failed'
        : cancelled() ? result.updated.length ? 'Partially completed' : 'Cancelled' : 'Completed';
      return { status, summary: `${result.updated.length} updated · ${result.unchanged.length} unchanged · ${result.skipped.length} kept/skipped · ${result.failures.length} failed\nGlobal installation is unchanged.\nReview git diff, then use Install / uninstall to install updates globally.\n\n${Object.entries(result).map(([label, names]) => `${label}: ${names.length ? names.join(', ') : 'none'}`).join('\n')}` };
    }, selected.length);
    return;
  }
}

async function add(ui: Terminal): Promise<void> {
  const kindState: SelectionState = {};
  const fields = new Map<string, { source: { value?: string }; name: { value?: string } }>();
  while (true) {
    const kind = (await ui.select('Add skills or agents', [
      { value: 'remote-skill', label: 'Import skill from Git repository', detail: 'Provide a repository URL or GitHub owner/repository and the skill name.' },
      { value: 'local-skill', label: 'Import skill from local folder', detail: 'Choose a folder containing SKILL.md.' },
      { value: 'agent', label: 'Import agent from Markdown file', detail: 'Choose an existing agent .md file.' },
    ], [], false, { state: kindState, intro: ['Adds repository files only. Nothing is installed globally.'], showDescriptions: true }))?.[0];
    if (kind !== 'remote-skill' && kind !== 'local-skill' && kind !== 'agent') return;
    const saved = fields.get(kind) ?? { source: {}, name: {} };
    fields.set(kind, saved);
    let step: 'source' | 'name' | 'review' = 'source';
    let source = saved.source.value ?? '';
    let request: ImportRequest | undefined;
    while (true) {
      if (step === 'source') {
        const answer = await ui.text(kind === 'remote-skill' ? 'Git repository URL or GitHub owner/repository' : kind === 'agent' ? 'Path to agent Markdown file' : 'Path to skill folder', {
          state: saved.source,
          hint: kind === 'remote-skill' ? 'Example: owner/skills or https://github.com/owner/skills.git'
            : `Example: ${kind === 'agent' ? './imports/reviewer.md' : './imports/my-skill'} · Relative paths start at ${repository}`,
          ...kind !== 'remote-skill' ? { complete: completePath } : {},
          validate: async (value) => {
            if (!value) throw new Error('Enter a source to continue.');
            if (kind === 'remote-skill') parseUpstream({ sourceType: 'github', source: value });
            else await validateImport({ kind, source: resolveImportPath(value) });
          },
        });
        if (answer === undefined) break;
        source = answer;
        step = kind === 'remote-skill' ? 'name' : 'review';
      }
      if (step === 'name') {
        const name = await ui.text('Skill name', { state: saved.name, hint: 'Example: tdd · Use the exact name declared in SKILL.md.',
          validate: async (value) => { await validateImport({ kind: 'remote-skill', source, name: value }); } });
        if (name === undefined) { step = 'source'; continue; }
        request = { kind: 'remote-skill', source, name };
        step = 'review';
      }
      if (step === 'review') {
        if (kind !== 'remote-skill') request = { kind, source: resolveImportPath(source) };
        if (!request) throw new Error('Missing import details');
        const target = await validateImport(request);
        if (!await ui.confirm('Review import', [`Source: ${request.source}`, `Destination: ${path.join(repository, '.agents', target)}`,
          'Global installation: unchanged', 'Existing repository files: never overwritten', 'No automatic commit or PR.'], kind === 'agent' ? 'Import agent' : 'Import skill')) {
          step = kind === 'remote-skill' ? 'name' : 'source'; continue;
        }
        const importRequest = request;
        await operation(ui, 'Importing repository files', async ({ stage, check, atomic }) => {
          check();
          const imported = await importContent(repository, importRequest, stage, () => atomic());
          return { status: 'Completed', summary: `Imported ${imported}.\nGlobal installation is unchanged.\nReview git diff, then use Install / uninstall to install it globally.` };
        }, kind === 'remote-skill' ? 1 : 0);
        return;
      }
    }
  }
}

async function remove(ui: Terminal, config: string): Promise<void> {
  let cancelled = false;
  ui.progress('Checking deletion requirements', ['Checking clean Git state, GitHub authentication, push access, and latest default branch…'], () => {
    cancelled = true;
    ui.progress('Checking deletion requirements', ['Cancellation requested. Waiting for the current prerequisite check to finish safely…']);
  });
  await checkDeletionPrerequisites(repository);
  if (cancelled) return;
  const expected = await inventory(repository, config);
  const items = expected.filter((item) => item.source && item.target !== 'AGENTS.md');
  const choices = await fileChoices(items, 'delete');
  let selected: string[] = [];
  const state: SelectionState = {};
  while (true) {
    const targets = await ui.select('Permanently delete skills or agents', choices, selected, true, {
      state, intro: ['Deletes repository files AND uninstalls global copies immediately.', 'Creates one commit and PR. Removal does not wait for PR approval.'],
      summary: (selection) => `${selection.size} selected for permanent deletion`,
      empty: 'No repository skills or agents available to delete. Shared instructions cannot be deleted here.',
    });
    if (!targets || !choices.length) return;
    selected = targets;
    if (!targets.length) { await ui.page('No skills or agents selected', 'Select sources with Space, or press Esc to return without deleting.'); continue; }
    if (!await ui.confirm('Review permanent deletion', ['Repository files: permanently deleted', `Global copies: uninstalled from ${config}`, '',
      ...targets.map((target) => `DELETE ${target}`), '', 'Remove corresponding skills-lock.json entries.',
      'Create one branch, commit, push, and pull request for this batch.', 'Remain on the deletion branch. Removal happens now, not after PR approval.'], 'Delete permanently and create PR')) continue;
    await operation(ui, 'Deleting sources and creating pull request', async ({ log, check, atomic }) => {
      check();
      const url = await deleteWithPullRequest({ repo: repository, config, targets, expected, log, check, beginChanges: () => atomic() });
      return { status: 'Completed', summary: `Permanently deleted ${targets.length} repository source${targets.length === 1 ? '' : 's'}.\nManaged global copies were uninstalled.\nPR: ${url}\nRemaining on the deletion branch; review with git status.` };
    });
    return;
  }
}

export async function main(): Promise<void> {
  const args = options({ 'config-dir': { type: 'string' }, help: { type: 'boolean' } });
  if (args.help) {
    console.log('npm run tui -- [--config-dir PATH]\nInteractive management of repository sources and global OpenCode files.');
    return;
  }
  const ui = new Terminal();
  const menuState: SelectionState = {};
  try {
    const config = configDirectory(args['config-dir']);
    while (true) {
      const action = (await ui.select('Main menu', [
        { value: 'install', label: 'Install / uninstall', detail: 'Choose what is installed globally in OpenCode.', group: 'Global installation' },
        { value: 'update', label: 'Update skills from upstream', detail: 'Update repository copies; global installation stays unchanged.', group: 'Repository maintenance' },
        { value: 'import', label: 'Add skills or agents', detail: 'Import files into this repository without installing them globally.', group: 'Repository maintenance' },
        { value: 'delete', label: 'Permanently delete skills or agents', detail: 'Delete repository files, uninstall globally, and create a PR.', group: 'Permanent deletion' },
        { value: 'exit', label: 'Exit', group: 'Session' },
      ], [], false, { state: menuState, showDescriptions: true, intro: [`OpenCode global destination: ${config}`] }))?.[0];
      if (!action || action === 'exit') break;
      try {
        if (action === 'install') await manageInstallation(ui, config);
        if (action === 'update') await update(ui, config);
        if (action === 'import') await add(ui);
        if (action === 'delete') await remove(ui, config);
      } catch (error) { await ui.page('Cannot continue — resolve before retrying', errorMessage(error)); }
    }
  } finally { ui.close(); }
}

if (isMain(import.meta.url)) {
  try { await main(); }
  catch (error) { console.error(errorMessage(error)); process.exitCode = 1; }
}
