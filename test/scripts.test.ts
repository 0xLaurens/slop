import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { exists, fingerprint, json, safeName, skillHash, writeJson } from '../scripts/lib.ts';
import { install, sources } from '../scripts/install.ts';
import { updateSkills, upstreamSource } from '../scripts/update-skills.ts';

async function fixture(t: TestContext) {
  const base = await mkdtemp(path.join(tmpdir(), 'slop-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repo = path.join(base, 'source repo');
  const config = path.join(base, 'user config');
  for (const kind of ['agents', 'skills', 'instructions']) await mkdir(path.join(repo, kind), { recursive: true });
  await writeJson(path.join(repo, 'skills-lock.json'), { version: 1, skills: {} });
  return { base, repo, config };
}

async function makeSkill(repo: string, name = 'demo', content = 'Original instructions') {
  const directory = path.join(repo, 'skills', name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: A test skill\n---\n${content}\n`);
  return directory;
}

async function tracked(repo: string, name = 'demo') {
  const directory = await makeSkill(repo, name);
  const lock = await json(path.join(repo, 'skills-lock.json'));
  lock.skills[name] = { source: 'example/skills', sourceType: 'github', skillPath: `skills/${name}/SKILL.md`, computedHash: await skillHash(directory) };
  await writeJson(path.join(repo, 'skills-lock.json'), lock);
  return directory;
}

async function stageSkill(source: string, name: string, workspace: string) {
  const directory = path.join(workspace, 'staged', name);
  await mkdir(path.dirname(directory), { recursive: true });
  await cp(source, directory, { recursive: true });
  return { directory };
}

async function upstream(repo: string, name: string, workspace: string) {
  const directory = await makeSkill(workspace, name, 'Updated upstream instructions');
  return { directory };
}

test('project hash matches the upstream algorithm and ignores empty directories', async (t) => {
  const { repo } = await fixture(t);
  const directory = await makeSkill(repo);
  const bytes = await readFile(path.join(directory, 'SKILL.md'));
  const expected = createHash('sha256').update('SKILL.md').update(bytes).digest('hex');
  assert.equal(await skillHash(directory), expected);
  await mkdir(path.join(directory, 'empty'));
  assert.equal(await skillHash(directory), expected);
  const before = await fingerprint(directory);
  await mkdir(path.join(directory, 'another-empty'));
  assert.notEqual(await fingerprint(directory), before);
});

test('hash includes nested paths and raw bytes with the CLI sorting order', async (t) => {
  const { repo } = await fixture(t);
  const directory = await makeSkill(repo);
  await mkdir(path.join(directory, 'scripts'));
  await writeFile(path.join(directory, 'scripts', 'a.bin'), Buffer.from([0, 255, 13, 10]));
  const hash = createHash('sha256');
  for (const file of ['SKILL.md', 'scripts/a.bin'].sort((a, b) => a.localeCompare(b))) {
    hash.update(file).update(await readFile(path.join(directory, file)));
  }
  assert.equal(await skillHash(directory), hash.digest('hex'));
});

test('portable names reject traversal and Windows reserved names', () => {
  for (const name of ['../oops', 'CON', 'con', 'nul', 'lpt1', 'a/b', 'A', 'a.b', 'with space']) {
    assert.throws(() => safeName(name));
  }
  assert.equal(safeName('my-skill_2'), 'my-skill_2');
});

test('install all three types, update, prune, and preserve unrelated files', async (t) => {
  const { repo, config } = await fixture(t);
  await makeSkill(repo);
  await writeFile(path.join(repo, 'agents', 'review.md'), 'Review agent');
  await writeFile(path.join(repo, 'instructions', 'AGENTS.md'), 'Shared instructions');
  await mkdir(path.join(config, 'agents'), { recursive: true });
  await writeFile(path.join(config, 'agents', 'unrelated.md'), 'Do not touch');
  await install({ repo, config, stageSkill });
  assert.equal(await readFile(path.join(config, 'AGENTS.md'), 'utf8'), 'Shared instructions');
  assert.equal(await readFile(path.join(config, 'agents', 'review.md'), 'utf8'), 'Review agent');
  assert.equal(await fingerprint(path.join(config, 'skills', 'demo')), await fingerprint(path.join(repo, 'skills', 'demo')));
  await writeFile(path.join(repo, 'agents', 'review.md'), 'New agent');
  await rm(path.join(repo, 'skills', 'demo'), { recursive: true });
  await install({ repo, config, stageSkill });
  assert.equal(await exists(path.join(config, 'skills', 'demo')), false);
  assert.equal(await readFile(path.join(config, 'agents', 'review.md'), 'utf8'), 'New agent');
  assert.equal(await readFile(path.join(config, 'agents', 'unrelated.md'), 'utf8'), 'Do not touch');
  await install({ repo, config, uninstall: true });
  assert.equal(await exists(path.join(config, 'AGENTS.md')), false);
  assert.equal(await exists(path.join(config, 'agents', 'review.md')), false);
  assert.equal(await exists(path.join(config, 'agents', 'unrelated.md')), true);
});

test('unrelated global instructions abort before skills CLI staging', async (t) => {
  const { repo, config } = await fixture(t);
  await makeSkill(repo);
  await writeFile(path.join(repo, 'instructions', 'AGENTS.md'), 'Repo instructions');
  await mkdir(config);
  await writeFile(path.join(config, 'AGENTS.md'), 'Existing instructions');
  await assert.rejects(install({ repo, config, stageSkill: () => assert.fail('Must not stage') }), /unrelated/);
  assert.equal(await exists(path.join(config, 'skills', 'demo')), false);
  assert.equal(await readFile(path.join(config, 'AGENTS.md'), 'utf8'), 'Existing instructions');
});

test('unrelated skill directory is not adopted even if its contents match', async (t) => {
  const { repo, config } = await fixture(t);
  const source = await makeSkill(repo);
  await mkdir(path.join(config, 'skills'), { recursive: true });
  await cp(source, path.join(config, 'skills', 'demo'), { recursive: true });
  await assert.rejects(install({ repo, config, stageSkill }), /unrelated/);
});

test('edited installed file blocks every update and uninstall', async (t) => {
  const { repo, config } = await fixture(t);
  await makeSkill(repo);
  await writeFile(path.join(repo, 'agents', 'review.md'), 'Original agent');
  await install({ repo, config, stageSkill });
  await writeFile(path.join(config, 'skills', 'demo', 'local.txt'), 'User edit');
  await writeFile(path.join(repo, 'agents', 'review.md'), 'New agent');
  await assert.rejects(install({ repo, config, stageSkill }), /edited/);
  await assert.rejects(install({ repo, config, uninstall: true }), /edited/);
  assert.equal(await readFile(path.join(config, 'agents', 'review.md'), 'utf8'), 'Original agent');
});

test('edited stale files are preserved rather than pruned', async (t) => {
  const { repo, config } = await fixture(t);
  await writeFile(path.join(repo, 'agents', 'review.md'), 'Original agent');
  await install({ repo, config, stageSkill });
  await rm(path.join(repo, 'agents', 'review.md'));
  await writeFile(path.join(config, 'agents', 'review.md'), 'User edit');
  await assert.rejects(install({ repo, config, stageSkill }), /edited/);
  assert.equal(await readFile(path.join(config, 'agents', 'review.md'), 'utf8'), 'User edit');
});

test('staging failure leaves existing deployment unchanged', async (t) => {
  const { repo, config } = await fixture(t);
  await makeSkill(repo);
  await install({ repo, config, stageSkill });
  const before = await fingerprint(path.join(config, 'skills'));
  await assert.rejects(install({ repo, config, stageSkill: async () => { throw new Error('Network failure'); } }), /Network failure/);
  assert.equal(await fingerprint(path.join(config, 'skills')), before);
});

test('second preflight catches edits during staging', async (t) => {
  const { repo, config } = await fixture(t);
  await makeSkill(repo);
  await install({ repo, config, stageSkill });
  await assert.rejects(install({ repo, config, stageSkill: async (...args) => {
    await writeFile(path.join(config, 'skills', 'demo', 'local.txt'), 'Concurrent edit');
    return stageSkill(...args);
  } }), /edited/);
  assert.equal(await readFile(path.join(config, 'skills', 'demo', 'local.txt'), 'utf8'), 'Concurrent edit');
});

test('deployment failure restores earlier files and the previous manifest', async (t) => {
  const { repo, config, base } = await fixture(t);
  await makeSkill(repo);
  await writeFile(path.join(repo, 'agents', 'review.md'), 'Original agent');
  await install({ repo, config, stageSkill });
  const manifest = await readFile(path.join(config, '.slop', 'manifest.json'), 'utf8');
  const skillBefore = await fingerprint(path.join(config, 'skills', 'demo'));
  await writeFile(path.join(repo, 'agents', 'review.md'), 'Updated agent');
  await assert.rejects(install({ repo, config, stageSkill: async () => ({ directory: path.join(base, 'missing-staged-directory') }) }), /ENOENT/);
  assert.equal(await readFile(path.join(config, 'agents', 'review.md'), 'utf8'), 'Original agent');
  assert.equal(await fingerprint(path.join(config, 'skills', 'demo')), skillBefore);
  assert.equal(await readFile(path.join(config, '.slop', 'manifest.json'), 'utf8'), manifest);
  assert.equal(await exists(path.join(config, '.slop', 'transaction')), false);
});

test('repository mutex prevents concurrent update/install operations', async (t) => {
  const { repo, config } = await fixture(t);
  await mkdir(path.join(repo, '.slop', 'repository.lock'), { recursive: true });
  await assert.rejects(install({ repo, config }), /Another operation/);
  await assert.rejects(updateSkills({ repo }), /Another operation/);
});

test('global instructions must be a regular file', async (t) => {
  const { repo } = await fixture(t);
  await mkdir(path.join(repo, 'instructions', 'AGENTS.md'));
  await assert.rejects(sources(repo), /regular file/);
});

test('manifest traversal is rejected without removing external files', async (t) => {
  const { base, repo, config } = await fixture(t);
  await writeFile(path.join(base, 'outside'), 'Safe');
  await writeJson(path.join(config, '.slop', 'manifest.json'), { version: 1, owner: 'slop', files: { '../../outside': 'a'.repeat(64) } });
  await assert.rejects(install({ repo, config, uninstall: true }), /Invalid deployment manifest/);
  assert.equal(await readFile(path.join(base, 'outside'), 'utf8'), 'Safe');
});

test('malformed manifest is not silently reset', async (t) => {
  const { repo, config } = await fixture(t);
  await mkdir(path.join(config, '.slop'), { recursive: true });
  await writeFile(path.join(config, '.slop', 'manifest.json'), '{bad');
  await assert.rejects(install({ repo, config }), SyntaxError);
});

test('interrupted deployment refuses to discard recovery files', async (t) => {
  const { repo, config } = await fixture(t);
  await mkdir(path.join(config, '.slop', 'transaction'), { recursive: true });
  await writeFile(path.join(config, '.slop', 'transaction', 'recovery'), 'Old data');
  await assert.rejects(install({ repo, config }), /Interrupted install/);
  assert.equal(await readFile(path.join(config, '.slop', 'transaction', 'recovery'), 'utf8'), 'Old data');
});

test('skill frontmatter must match its directory', async (t) => {
  const { repo } = await fixture(t);
  const directory = await makeSkill(repo);
  await writeFile(path.join(directory, 'SKILL.md'), '---\nname: different\ndescription: Test\n---\n');
  await assert.rejects(sources(repo), /must match/);
});

test('upstream source preserves folder and ref without switching hosts', () => {
  assert.equal(upstreamSource({ sourceType: 'github', source: 'mattpocock/skills', skillPath: 'skills/productivity/grilling/SKILL.md', ref: 'main' }), 'mattpocock/skills/skills/productivity/grilling#main');
  assert.equal(upstreamSource({ sourceType: 'git', source: 'https://example.com/skills.git', ref: 'v1' }), 'https://example.com/skills.git#v1');
  assert.equal(upstreamSource({ sourceType: 'local', source: './skills' }), null);
  assert.throws(() => upstreamSource({ sourceType: 'gitlab', source: 'owner/repo' }), /unambiguous/);
  assert.throws(() => upstreamSource({ sourceType: 'github', source: 'owner/repo', skillPath: '../SKILL.md' }), /Invalid/);
});

test('clean skills update from upstream and advance only their baseline hash', async (t) => {
  const { repo } = await fixture(t);
  await tracked(repo);
  const previous = (await json(path.join(repo, 'skills-lock.json'))).skills.demo;
  const result = await updateSkills({ repo, fetchSkill: upstream });
  assert.deepEqual(result.updated, ['demo']);
  const entry = (await json(path.join(repo, 'skills-lock.json'))).skills.demo;
  assert.deepEqual({ ...entry, computedHash: previous.computedHash }, previous);
  assert.equal(entry.computedHash, await skillHash(path.join(repo, 'skills', 'demo')));
});

test('noninteractive dirty skills are skipped without fetching or changing baseline', async (t) => {
  const { repo } = await fixture(t);
  const directory = await tracked(repo);
  const before = await readFile(path.join(repo, 'skills-lock.json'), 'utf8');
  await writeFile(path.join(directory, 'local.txt'), 'Local customization');
  const result = await updateSkills({ repo, interactive: false, fetchSkill: () => assert.fail('Must not fetch') });
  assert.deepEqual(result.skipped, ['demo']);
  assert.equal(await readFile(path.join(repo, 'skills-lock.json'), 'utf8'), before);
  assert.equal(await readFile(path.join(directory, 'local.txt'), 'utf8'), 'Local customization');
});

test('per-skill Keep leaves customized contents and baseline unchanged', async (t) => {
  const { repo } = await fixture(t);
  const directory = await tracked(repo);
  await writeFile(path.join(directory, 'local.txt'), 'Local customization');
  const before = await fingerprint(directory);
  let asked = 0;
  const result = await updateSkills({ repo, interactive: true, ask: async (name) => { assert.equal(name, 'demo'); asked++; return false; }, fetchSkill: upstream });
  assert.equal(asked, 1);
  assert.deepEqual(result.skipped, ['demo']);
  assert.equal(await fingerprint(directory), before);
});

test('per-skill Replace backs up customizations before updating', async (t) => {
  const { repo } = await fixture(t);
  const directory = await tracked(repo);
  await writeFile(path.join(directory, 'local.txt'), 'Local customization');
  const before = await fingerprint(directory);
  const result = await updateSkills({ repo, interactive: true, ask: async () => true, fetchSkill: upstream });
  assert.deepEqual(result.updated, ['demo']);
  const backups = await readdir(path.join(repo, '.slop', 'backups'));
  assert.equal(backups.length, 1);
  assert.equal(await fingerprint(path.join(repo, '.slop', 'backups', backups[0])), before);
  assert.equal(await exists(path.join(directory, 'local.txt')), false);
});

test('a skipped modified skill does not block clean skills', async (t) => {
  const { repo } = await fixture(t);
  const directory = await tracked(repo, 'first');
  await tracked(repo, 'second');
  await writeFile(path.join(directory, 'local.txt'), 'Edit');
  const result = await updateSkills({ repo, interactive: false, fetchSkill: upstream });
  assert.deepEqual(result.skipped, ['first']);
  assert.deepEqual(result.updated, ['second']);
});

test('failed fetch leaves both repository copy and lock intact', async (t) => {
  const { repo } = await fixture(t);
  const directory = await tracked(repo);
  const before = await fingerprint(directory);
  const beforeLock = await fingerprint(path.join(repo, 'skills-lock.json'));
  const result = await updateSkills({ repo, fetchSkill: async () => { throw new Error('Network down'); } });
  assert.deepEqual(result.failures, ['demo']);
  assert.equal(await fingerprint(directory), before);
  assert.equal(await fingerprint(path.join(repo, 'skills-lock.json')), beforeLock);
});

test('repository edits during upstream fetch are not overwritten', async (t) => {
  const { repo } = await fixture(t);
  const directory = await tracked(repo);
  const result = await updateSkills({ repo, fetchSkill: async (...args) => {
    await writeFile(path.join(directory, 'concurrent.txt'), 'New edit');
    return upstream(...args);
  } });
  assert.deepEqual(result.failures, ['demo']);
  assert.equal(await readFile(path.join(directory, 'concurrent.txt'), 'utf8'), 'New edit');
});

test('own skills without upstream are left unchanged', async (t) => {
  const { repo } = await fixture(t);
  await makeSkill(repo);
  const result = await updateSkills({ repo, fetchSkill: () => assert.fail('Must not fetch') });
  assert.deepEqual(result, { updated: [], skipped: [], failures: [] });
});

test('unknown --skill is an error', async (t) => {
  const { repo } = await fixture(t);
  await assert.rejects(updateSkills({ repo, only: 'missing' }), /Unknown skill/);
});

test('actual pinned CLI stages a local skill without touching global config', async (t) => {
  const { repo, config, base } = await fixture(t);
  await makeSkill(repo);
  await install({ repo, config });
  assert.match(await readFile(path.join(config, 'skills', 'demo', 'SKILL.md'), 'utf8'), /Original instructions/);
  assert.equal(await exists(path.join(base, '.agents')), false);
});

test('symlinked deployment directory is rejected', async (t) => {
  const { repo, config, base } = await fixture(t);
  await makeSkill(repo);
  const external = path.join(base, 'external');
  await mkdir(external);
  await mkdir(config);
  try { await symlink(external, path.join(config, 'skills'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') return t.skip('Symlink permission unavailable'); throw error; }
  await assert.rejects(install({ repo, config, stageSkill }), /Symlink/);
  assert.deepEqual(await readdir(external), []);
});

test('repository symlinks are rejected rather than followed', async (t) => {
  const { repo, base } = await fixture(t);
  const directory = await makeSkill(repo);
  const external = path.join(base, 'external.txt');
  await writeFile(external, 'External data');
  try { await symlink(external, path.join(directory, 'link.txt')); }
  catch (error) { if (error.code === 'EPERM') return t.skip('Symlink permission unavailable'); throw error; }
  await assert.rejects(skillHash(directory), /Symlink/);
});
