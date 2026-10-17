import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hasCode } from '../scripts/data.ts';
import { install } from '../scripts/install.ts';
import { readManifest } from '../scripts/deployment-state.ts';
import { exists, fingerprint, readSkillsLock } from '../scripts/lib.ts';
import { deleteWithPullRequest, importContent } from '../scripts/manage.ts';
import { assertInventory, deploymentChanges, deploymentPlan, inventory } from '../scripts/deployment-plan.ts';
import { run } from '../scripts/process.ts';
import type { Run } from '../scripts/process.ts';
import { cleanText } from '../scripts/terminal.ts';
import { updateSkills } from '../scripts/update-skills.ts';
import { fixture, makeSkill, stageSkill, tracked, upstream } from './fixtures.ts';

test('selection installs only checked items, then uninstalls deselected items', async (t) => {
  const { repo, config } = await fixture(t);
  await makeSkill(repo, 'first');
  await makeSkill(repo, 'second');
  await install({ repo, config, selected: ['skills/first'], stageSkill });
  assert.equal(await exists(path.join(config, 'skills/first')), true);
  assert.equal(await exists(path.join(config, 'skills/second')), false);
  await install({ repo, config, selected: ['skills/second'], stageSkill });
  assert.equal(await exists(path.join(config, 'skills/first')), false);
  assert.equal(await exists(path.join(config, 'skills/second')), true);
  assert.deepEqual(Object.keys((await readManifest(path.join(config, '.slop/manifest.json'))).files), ['skills/second']);
});

test('inventory reflects actual state and plans installs, replacements, and removals', async (t) => {
  const { repo, config } = await fixture(t);
  await tracked(repo, 'first');
  await makeSkill(repo, 'second');
  await install({ repo, config, selected: ['skills/first'], stageSkill });
  let items = await inventory(repo, config);
  assert.deepEqual(deploymentChanges(deploymentPlan({ repo, config, items, selected: new Set(['skills/first']) })), []);
  assert.deepEqual(deploymentChanges(deploymentPlan({ repo, config, items, selected: new Set(['skills/second']) })), ['UNINSTALL skills/first', 'INSTALL skills/second']);
  await writeFile(path.join(repo, '.agents/skills/first/new.txt'), 'Repository change');
  items = await inventory(repo, config);
  assert.deepEqual(deploymentChanges(deploymentPlan({ repo, config, items, selected: new Set(['skills/first']) })), ['REPLACE skills/first']);
  assert.equal(items[0]?.modified, true);
  assert.equal(items[1]?.remote, false);
});

test('a missing source can be retained without fetching or deleting its installed copy', async (t) => {
  const { repo, config } = await fixture(t);
  await makeSkill(repo);
  await install({ repo, config, stageSkill });
  await rm(path.join(repo, '.agents/skills/demo'), { recursive: true });
  const before = await fingerprint(path.join(config, 'skills/demo'));
  await install({ repo, config, selected: ['skills/demo'], stageSkill: () => assert.fail('Do not restage missing sources') });
  assert.equal(await fingerprint(path.join(config, 'skills/demo')), before);
});

test('unknown selections and changed review snapshots cannot modify deployment', async (t) => {
  const { repo, config } = await fixture(t);
  const directory = await makeSkill(repo);
  const expected = await inventory(repo, config);
  await assert.rejects(install({ repo, config, selected: ['skills/unknown'], stageSkill }), /Unknown selection/);
  await writeFile(path.join(directory, 'changed.txt'), 'Changed after review');
  await assert.rejects(install({ repo, config, selected: ['skills/demo'], stageSkill,
    guard: () => assertInventory(repo, config, expected) }), /changed after review/);
  assert.equal(await exists(path.join(config, 'skills/demo')), false);
});

test('cancelling after staging leaves the existing deployment unchanged', async (t) => {
  const { repo, config } = await fixture(t);
  await makeSkill(repo);
  await install({ repo, config, stageSkill });
  const before = await fingerprint(path.join(config, 'skills/demo'));
  await writeFile(path.join(repo, '.agents/skills/demo/new.txt'), 'New source');
  await assert.rejects(install({ repo, config, stageSkill, beforeApply: () => { throw new Error('Cancelled'); } }), /Cancelled/);
  assert.equal(await fingerprint(path.join(config, 'skills/demo')), before);
});

test('import local skills and agents without deployment; reject collisions', async (t) => {
  const { repo, config, base } = await fixture(t);
  const source = await makeSkill(base, 'imported');
  assert.equal(await importContent(repo, { kind: 'local-skill', source }), 'skills/imported');
  const lock = await readSkillsLock(path.join(repo, 'skills-lock.json'));
  assert.equal(lock.skills.imported?.sourceType, 'local');
  assert.equal(await exists(config), false);
  await assert.rejects(importContent(repo, { kind: 'local-skill', source }), /collision/);
  const agent = path.join(base, 'review.md');
  await writeFile(agent, 'Review carefully');
  assert.equal(await importContent(repo, { kind: 'agent', source: agent }), 'agents/review.md');
  assert.equal(await readFile(path.join(repo, '.agents/agents/review.md'), 'utf8'), 'Review carefully');
  await assert.rejects(importContent(repo, { kind: 'agent', source: agent }), /collision/);
});

test('remote imports retain upstream provenance and reject ambiguous sources', async (t) => {
  const { repo } = await fixture(t);
  await importContent(repo, { kind: 'remote-skill', source: 'example/skills', name: 'demo' }, upstream);
  const entry = (await readSkillsLock(path.join(repo, 'skills-lock.json'))).skills.demo;
  assert.equal(entry?.source, 'https://github.com/example/skills.git');
  assert.equal(entry?.sourceType, 'git');
  await assert.rejects(importContent(repo, { kind: 'remote-skill', source: '--help', name: 'other' }, upstream), /Invalid upstream/);
});

test('cancelled imports publish neither source nor lock entry', async (t) => {
  const { repo, base } = await fixture(t);
  const source = await makeSkill(base);
  const before = await readFile(path.join(repo, 'skills-lock.json'), 'utf8');
  await assert.rejects(importContent(repo, { kind: 'local-skill', source }, stageSkill,
    () => { throw new Error('Cancelled'); }), /Cancelled/);
  assert.equal(await exists(path.join(repo, '.agents/skills/demo')), false);
  assert.equal(await readFile(path.join(repo, 'skills-lock.json'), 'utf8'), before);
});

test('imports reject nested symlinks', async (t) => {
  const { repo, base } = await fixture(t);
  const source = await makeSkill(base);
  const outside = path.join(base, 'outside.txt');
  await writeFile(outside, 'Unrelated');
  try { await symlink(outside, path.join(source, 'link.txt')); }
  catch (error) { if (hasCode(error, 'EPERM')) return t.skip('Symlink permission unavailable'); throw error; }
  await assert.rejects(importContent(repo, { kind: 'local-skill', source }), /Symlink/);
  assert.equal(await exists(path.join(repo, '.agents/skills/demo')), false);
});

test('selective updates leave unchecked skills and deployed copies alone', async (t) => {
  const { repo, config } = await fixture(t);
  await tracked(repo, 'first');
  await tracked(repo, 'second');
  await install({ repo, config, stageSkill });
  const before = await fingerprint(path.join(repo, '.agents/skills/second'));
  const global = await fingerprint(path.join(config, 'skills'));
  const result = await updateSkills({ repo, selected: ['first'], fetchSkill: upstream });
  assert.deepEqual(result.updated, ['first']);
  assert.equal(await fingerprint(path.join(repo, '.agents/skills/second')), before);
  assert.equal(await fingerprint(path.join(config, 'skills')), global);
});

test('cancellation during update fetch keeps the current skill and lock', async (t) => {
  const { repo } = await fixture(t);
  const directory = await tracked(repo);
  const before = await fingerprint(directory);
  const baseline = await readFile(path.join(repo, 'skills-lock.json'), 'utf8');
  let cancelled = false;
  const result = await updateSkills({ repo, cancelled: () => cancelled, fetchSkill: async (request) => {
    const fetched = await upstream(request); cancelled = true; return fetched;
  } });
  assert.deepEqual(result.skipped, ['demo']);
  assert.equal(await fingerprint(directory), before);
  assert.equal(await readFile(path.join(repo, 'skills-lock.json'), 'utf8'), baseline);
});

async function deletionFixture(t: TestContext) {
  const files = await fixture(t);
  const { repo, config } = files;
  await tracked(repo, 'first');
  await tracked(repo, 'second');
  await install({ repo, config, stageSkill });
  await writeFile(path.join(repo, '.gitignore'), '.slop/\n');
  await run('git', ['init', '-b', 'main'], repo);
  await run('git', ['config', 'user.email', 'test@example.com'], repo);
  await run('git', ['config', 'user.name', 'Test'], repo);
  await run('git', ['add', '.'], repo);
  await run('git', ['commit', '-m', 'fixture'], repo);
  const head = await run('git', ['rev-parse', 'HEAD'], repo);
  const calls: { command: string; args: readonly string[] }[] = [];
  const execute: Run = async (command, args, cwd) => {
    calls.push({ command, args });
    if (command === 'gh') {
      if (args[0] === 'repo') return JSON.stringify({ defaultBranchRef: { name: 'main' }, viewerPermission: 'WRITE' });
      return args[0] === 'pr' ? 'https://github.com/example/slop/pull/1' : '';
    }
    if (args[0] === 'remote') return 'git@github.com:example/slop.git';
    if (args[0] === 'fetch' || args[0] === 'push') return '';
    if (args[0] === 'rev-parse' && args[1] === 'FETCH_HEAD') return head;
    return run(command, args, cwd);
  };
  return { ...files, execute, calls, head };
}

test('batch deletion makes one real commit and one PR request, remaining on the deletion branch', async (t) => {
  const { repo, config, execute, calls } = await deletionFixture(t);
  const expected = await inventory(repo, config);
  const url = await deleteWithPullRequest({ repo, config, targets: ['skills/first', 'skills/second'], expected, execute });
  assert.equal(url, 'https://github.com/example/slop/pull/1');
  assert.equal(await exists(path.join(repo, '.agents/skills/first')), false);
  assert.equal(await exists(path.join(config, 'skills/first')), false);
  assert.equal(await exists(path.join(config, 'skills/second')), false);
  assert.deepEqual((await readSkillsLock(path.join(repo, 'skills-lock.json'))).skills, {});
  assert.equal(calls.filter((call) => call.command === 'gh' && call.args[0] === 'pr').length, 1);
  assert.equal(calls.filter((call) => call.args[0] === 'commit').length, 1);
  assert.match(await run('git', ['branch', '--show-current'], repo), /^slop\/delete-/);
  assert.equal(await run('git', ['status', '--porcelain'], repo), '');
  assert.match(await run('git', ['show', '--stat', '--oneline', 'HEAD'], repo), /skills-lock.json/);
});

test('deletion preserves other deployed copies without installing their repository updates', async (t) => {
  const { repo, config, execute } = await deletionFixture(t);
  const globalBefore = await fingerprint(path.join(config, 'skills/second'));
  await writeFile(path.join(repo, '.agents/skills/second/new.txt'), 'Not deployed');
  await run('git', ['add', '.'], repo);
  await run('git', ['commit', '-m', 'new source'], repo);
  const head = await run('git', ['rev-parse', 'HEAD'], repo);
  const adapter: Run = (command, args, cwd) => args[0] === 'rev-parse' && args[1] === 'FETCH_HEAD'
    ? Promise.resolve(head) : execute(command, args, cwd);
  await deleteWithPullRequest({ repo, config, targets: ['skills/first'], execute: adapter });
  assert.equal(await fingerprint(path.join(config, 'skills/second')), globalBefore);
});

test('dirty Git state blocks deletion without stashing, branching, or committing', async (t) => {
  const { repo, config, execute, calls } = await deletionFixture(t);
  await writeFile(path.join(repo, 'user-work.txt'), 'Uncommitted');
  await assert.rejects(deleteWithPullRequest({ repo, config, targets: ['skills/first'], execute }), /not clean/);
  assert.equal(await exists(path.join(repo, '.agents/skills/first')), true);
  assert.equal(await exists(path.join(config, 'skills/first')), true);
  assert.equal(calls.some((call) => ['switch', 'commit', 'stash'].includes(call.args[0] ?? '')), false);
});

test('missing GitHub tooling or auth blocks deletion before local changes', async (t) => {
  const { repo, config, execute } = await deletionFixture(t);
  const adapter: Run = (command, args, cwd) => command === 'gh' ? Promise.reject(new Error('Install gh and authenticate')) : execute(command, args, cwd);
  await assert.rejects(deleteWithPullRequest({ repo, config, targets: ['skills/first'], execute: adapter }), /Install gh/);
  assert.equal(await exists(path.join(repo, '.agents/skills/first')), true);
  assert.equal(await exists(path.join(config, 'skills/first')), true);
  assert.equal(await run('git', ['branch', '--show-current'], repo), 'main');
});

test('edited global copies block deletion and explain manual resolution', async (t) => {
  const { repo, config, execute } = await deletionFixture(t);
  await writeFile(path.join(config, 'skills/first/user.txt'), 'Preserve me');
  await assert.rejects(deleteWithPullRequest({ repo, config, targets: ['skills/first'], execute }), /Back up edited copies/);
  assert.equal(await exists(path.join(repo, '.agents/skills/first')), true);
  assert.equal(await readFile(path.join(config, 'skills/first/user.txt'), 'utf8'), 'Preserve me');
});

test('unowned global copies block source deletion rather than silently leaving an uninstall conflict', async (t) => {
  const { repo, config, execute } = await deletionFixture(t);
  // Simulate lost ownership without touching the installed copy.
  const manifestFile = path.join(config, '.slop/manifest.json');
  const manifest = await readManifest(manifestFile);
  delete manifest.files['skills/first'];
  await writeFile(manifestFile, JSON.stringify(manifest));
  await assert.rejects(deleteWithPullRequest({ repo, config, targets: ['skills/first'], execute }), /unrelated existing/);
  assert.equal(await exists(path.join(repo, '.agents/skills/first')), true);
  assert.equal(await exists(path.join(config, 'skills/first')), true);
});

test('push failure preserves completed deletion and commit with retry guidance', async (t) => {
  const { repo, config, execute } = await deletionFixture(t);
  const adapter: Run = (command, args, cwd) => args[0] === 'push' && !args.includes('--dry-run')
    ? Promise.reject(new Error('Network offline')) : execute(command, args, cwd);
  await assert.rejects(deleteWithPullRequest({ repo, config, targets: ['skills/first'], execute: adapter }),
    /Global uninstall: completed; commit: created; push: not completed[\s\S]*git push --set-upstream/);
  assert.equal(await exists(path.join(repo, '.agents/skills/first')), false);
  assert.equal(await exists(path.join(config, 'skills/first')), false);
  assert.match(await run('git', ['branch', '--show-current'], repo), /^slop\/delete-/);
  assert.equal(await run('git', ['status', '--porcelain'], repo), '');
});

test('failed PR creation never reports success and keeps the pushed branch', async (t) => {
  const { repo, config, execute } = await deletionFixture(t);
  const adapter: Run = (command, args, cwd) => command === 'gh' && args[0] === 'pr'
    ? Promise.reject(new Error('PR service unavailable')) : execute(command, args, cwd);
  await assert.rejects(deleteWithPullRequest({ repo, config, targets: ['skills/first'], execute: adapter }),
    /push: completed[\s\S]*Check for an existing PR/);
});

test('deletion rejects unrelated branch history and cancellation before mutations', async (t) => {
  const { repo, config, execute } = await deletionFixture(t);
  const adapter: Run = (command, args, cwd) => args[0] === 'rev-parse' && args[1] === 'FETCH_HEAD'
    ? Promise.resolve('a different commit') : execute(command, args, cwd);
  await assert.rejects(deleteWithPullRequest({ repo, config, targets: ['skills/first'], execute: adapter }), /unrelated commits/);
  await assert.rejects(deleteWithPullRequest({ repo, config, targets: ['skills/first'], execute,
    check: () => { throw new Error('Cancelled'); } }), /Cancelled/);
  assert.equal(await exists(path.join(repo, '.agents/skills/first')), true);
  assert.equal(await exists(path.join(config, 'skills/first')), true);
  assert.equal(await run('git', ['branch', '--show-current'], repo), 'main');
});

test('terminal text cannot inject escape commands', () => {
  assert.equal(cleanText('\x1b[2Jhello\x1b[31m world\x07\x1b]evil'), 'hello world]evil');
});

test('TUI help works without a terminal; noninteractive launch gives useful guidance', () => {
  const script = fileURLToPath(new URL('../scripts/tui.ts', import.meta.url));
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /npm run tui/);
  const launch = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(launch.status, 1);
  assert.match(launch.stderr, /requires an interactive terminal/);
});
