import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { install } from '../scripts/install.ts';
import { checkDeletionPrerequisites, inventory } from '../scripts/manage.ts';
import type { Item } from '../scripts/manage.ts';
import { completePath, fileChoices, installationReview, installationStatus, installationSummary, validateImport } from '../scripts/tui-model.ts';
import { updateSkills } from '../scripts/update-skills.ts';
import type { UpdateProgress } from '../scripts/update-skills.ts';
import { fixture, makeSkill, stageSkill, tracked, upstream } from './fixtures.ts';

const item: Item = { target: 'skills/test', installed: false, managed: false, edited: false, remote: false, modified: false,
  source: '/repo/test', sourceHash: 'new', installedHash: null };

test('installation status distinguishes keep, install, replace, uninstall, and blocked changes', () => {
  assert.equal(installationStatus(item, true), 'Not installed → Install');
  assert.equal(installationStatus(item, false), 'Not installed → No change');
  const installed = { ...item, installed: true, managed: true, installedHash: 'new' };
  assert.equal(installationStatus(installed, true), 'Installed → Keep');
  assert.equal(installationStatus(installed, false), 'Installed → Uninstall');
  assert.match(installationStatus({ ...installed, sourceHash: 'changed' }, true), /Replace installed copy/);
  assert.match(installationStatus({ ...installed, edited: true }, false), /blocked/);
});

test('live summary agrees with grouped review and explicitly preserves repository files', () => {
  const items = [item, { ...item, target: 'skills/old', managed: true, installed: true, installedHash: 'old' }];
  const selected = new Set(['skills/test']);
  assert.equal(installationSummary(items, selected), '1 install · 0 replace · 1 uninstall · 0 unchanged');
  const review = installationReview(items, selected, '/config');
  assert.ok(review.includes('Repository files: unchanged'));
  assert.ok(review.includes('Destination: /config'));
  assert.ok(review.includes('Install'));
  assert.ok(review.includes('Uninstall globally'));
});

test('choices use short names, type groups, descriptions, and upstream details', async (t) => {
  const { repo, config } = await fixture(t);
  await tracked(repo);
  await writeFile(path.join(repo, '.agents/agents/reviewer.md'), 'Review code');
  await writeFile(path.join(repo, '.agents/instructions/AGENTS.md'), 'Shared guidance');
  const choices = await fileChoices(await inventory(repo, config), 'install', repo);
  assert.deepEqual(choices.map((choice) => choice.group), ['Skills', 'Agents', 'Instructions']);
  assert.equal(choices[0]?.label, 'demo');
  assert.match(choices[0]?.detail ?? '', /A test skill/);
  assert.match(choices[0]?.detail ?? '', /Upstream: https:\/\/github.com\/example\/skills.git/);
  assert.equal(choices[1]?.label, 'reviewer');
  assert.match(choices[2]?.label ?? '', /Shared instructions/);
});

test('path completion supports relative directories, files, and multiple matches', async (t) => {
  const { repo } = await fixture(t);
  await mkdir(path.join(repo, 'imports'));
  await mkdir(path.join(repo, 'imports/skill'));
  await writeFile(path.join(repo, 'imports/reviewer.md'), 'Agent');
  assert.deepEqual(await completePath('./imp', repo), [`./imports${path.sep}`]);
  assert.deepEqual(await completePath(`./imports${path.sep}`, repo), [`./imports${path.sep}reviewer.md`, `./imports${path.sep}skill${path.sep}`]);
});

test('import validation catches missing paths, collisions, and malformed sources before review', async (t) => {
  const { repo, base } = await fixture(t);
  await assert.rejects(validateImport({ kind: 'agent', source: path.join(base, 'missing.md') }, repo));
  await assert.rejects(validateImport({ kind: 'remote-skill', source: '--help', name: 'test' }, repo), /Invalid upstream/);
  const directory = await makeSkill(base);
  assert.equal(await validateImport({ kind: 'local-skill', source: directory }, repo), 'skills/demo');
  await makeSkill(repo);
  await assert.rejects(validateImport({ kind: 'local-skill', source: directory }, repo), /already exists/);
});

test('read-only deletion prerequisites reject dirty work before contacting GitHub', async () => {
  const calls: string[] = [];
  await assert.rejects(checkDeletionPrerequisites('/repo', async (command, args) => {
    calls.push(command);
    return args[0] === 'rev-parse' ? '/repo' : ' M README.MD';
  }), /not clean/);
  assert.deepEqual(calls, ['git', 'git']);
});

test('uninstalled and changed repository sources get accurate action labels', async (t) => {
  const { repo, config } = await fixture(t);
  const source = await makeSkill(repo);
  await install({ repo, config, stageSkill });
  await writeFile(path.join(source, 'new.txt'), 'Changed');
  const choices = await fileChoices(await inventory(repo, config), 'install', repo);
  assert.match(choices[0]?.status?.(true) ?? '', /Replace/);
  assert.match(choices[0]?.status?.(false) ?? '', /Uninstall/);
});

test('update progress reports outcomes and restores cancellation after transactions', async (t) => {
  const { repo } = await fixture(t);
  await tracked(repo, 'first');
  await tracked(repo, 'second');
  const progress: UpdateProgress[] = [];
  const transactions: boolean[] = [];
  const result = await updateSkills({ repo, onProgress: (value) => progress.push(value), onTransaction: (active) => transactions.push(active),
    fetchSkill: async (request) => { if (request.name === 'second') throw new Error('Network failure'); return upstream(request); } });
  assert.deepEqual(result.updated, ['first']);
  assert.deepEqual(result.failures, ['second']);
  assert.deepEqual(transactions, [true, false]);
  assert.deepEqual(progress.map((value) => value.completed), [1, 2]);
  assert.deepEqual(progress.at(-1), { total: 2, completed: 2, updated: 1, unchanged: 0, skipped: 0, failed: 1 });
});
