import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { diagnostic, errorMessage, hasCode, parseSkillsLock, parseUpstream } from '../scripts/data.ts';
import { exists, fingerprint, json, options, readSkillsLock, safeName, skillHash, writeJson } from '../scripts/lib.ts';
import { install, sources } from '../scripts/install.ts';
import { updateSkills } from '../scripts/update-skills.ts';
import { fixture, makeSkill, stageSkill, tracked, upstream } from './fixtures.ts';

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

test('JSON stays unknown until a skills lock is validated', async (t) => {
  const { repo } = await fixture(t);
  const file = path.join(repo, 'skills-lock.json');
  await writeJson(file, null);
  assert.equal(await json(file), null);
  await assert.rejects(readSkillsLock(file), /Invalid skills-lock.json/);
});

test('skills lock validation rejects malformed documents and entries', () => {
  const entry = { source: 'example/skills', sourceType: 'github', computedHash: 'a'.repeat(64) };
  const invalidDocuments: unknown[] = [null, [], {}, { version: 2, skills: {} },
    { version: 1, skills: [] }, { version: 1, skills: 'invalid' }];
  for (const document of invalidDocuments) {
    assert.throws(() => parseSkillsLock(document), /Invalid skills-lock.json/);
  }
  const invalidEntries: unknown[] = [null, [], 'invalid', {},
    { ...entry, source: 42 }, { ...entry, source: '' },
    { ...entry, sourceType: 'unsupported' }, { ...entry, computedHash: 'invalid' },
    { ...entry, sourceUrl: 42 }, { ...entry, skillPath: [] }, { ...entry, ref: null }];
  for (const invalid of invalidEntries) {
    assert.throws(() => parseSkillsLock({ version: 1, skills: { demo: invalid } }), /Invalid skills-lock.json entry: demo/);
  }
});

test('skills lock validation preserves additional provenance metadata', () => {
  const document = { version: 1, metadata: { custom: true }, skills: {
    demo: { source: 'example/skills', sourceType: 'github', computedHash: 'a'.repeat(64),
      sourceUrl: 'https://github.com/example/skills', skillPath: 'SKILL.md', ref: 'main', custom: { retained: true } },
  } };
  assert.deepEqual(parseSkillsLock(document), document);
});

test('CLI options distinguish strings and booleans and reject invalid arguments', () => {
  const definitions = { config: { type: 'string' }, uninstall: { type: 'boolean' } } as const;
  const args = options(definitions, ['--config', '/config', '--uninstall']);
  assert.equal(args.config, '/config');
  assert.equal(args.uninstall, true);
  assert.equal(options(definitions, []).config, undefined);
  assert.throws(() => options(definitions, ['--unknown']));
  assert.throws(() => options(definitions, ['--config']));
});

test('unknown thrown values and filesystem errors are narrowed safely', () => {
  assert.equal(errorMessage(new Error('failure')), 'failure');
  assert.equal(errorMessage('failure'), 'failure');
  assert.equal(errorMessage(null), 'null');
  assert.equal(hasCode(Object.assign(new Error('missing'), { code: 'ENOENT' }), 'ENOENT'), true);
  for (const value of [null, undefined, 'ENOENT', {}, { code: 'EPERM' }]) {
    assert.equal(hasCode(value, 'ENOENT'), false);
  }
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

test('manifest validation rejects non-object documents and file maps', async (t) => {
  const { repo, config } = await fixture(t);
  for (const manifest of [null, [], { version: 1, owner: 'slop', files: [] },
    { version: 1, owner: 'slop', files: 'invalid' }, { version: 1, owner: 'slop', files: { 'AGENTS.md': null } }]) {
    await writeJson(path.join(config, '.slop', 'manifest.json'), manifest);
    await assert.rejects(install({ repo, config }), /Invalid deployment manifest/);
  }
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

test('upstream parsing separates validated remote sources from local provenance', () => {
  for (const sourceType of ['local', 'node_modules'] as const) {
    assert.deepEqual(parseUpstream({ sourceType, source: './skills', ref: 'unused' }), { kind: 'local' });
  }
  assert.deepEqual(parseUpstream({ sourceType: 'github', source: 'example/skills',
    skillPath: 'skills/demo/SKILL.md', ref: 'main' }),
  { kind: 'remote', repository: 'https://github.com/example/skills.git', skillPath: 'skills/demo/SKILL.md', ref: 'main' });
  assert.deepEqual(parseUpstream({ sourceType: 'gitlab', source: 'https://gitlab.com/example/skills',
    skillPath: 'demo/SKILL.md' }), { kind: 'remote', repository: 'https://gitlab.com/example/skills', skillPath: 'demo/SKILL.md' });
  assert.deepEqual(parseUpstream({ sourceType: 'git', source: 'https://example.com/skills.git' }),
    { kind: 'remote', repository: 'https://example.com/skills.git' });
  for (const source of ['', '--help', 'ambiguous']) {
    assert.throws(() => parseUpstream({ sourceType: 'git', source }));
  }
});

test('structured diagnostics retain event, message, and identifying context', (t) => {
  const write = t.mock.method(process.stderr, 'write', () => true);
  const value = { level: 'error', event: 'skill.update.failed', message: 'Network down',
    context: { repo: '/repo', skill: 'demo' } } satisfies Parameters<typeof diagnostic>[0];
  diagnostic(value);
  assert.equal(write.mock.callCount(), 1);
  assert.equal(write.mock.calls[0]?.arguments[0], `${JSON.stringify(value)}\n`);
});

test('clean skills update from upstream and advance only their baseline hash', async (t) => {
  const { repo } = await fixture(t);
  await tracked(repo);
  const previous = (await readSkillsLock(path.join(repo, 'skills-lock.json'))).skills.demo;
  assert.ok(previous);
  const result = await updateSkills({ repo, fetchSkill: upstream });
  assert.deepEqual(result.updated, ['demo']);
  const entry = (await readSkillsLock(path.join(repo, 'skills-lock.json'))).skills.demo;
  assert.ok(entry);
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
  const backup = backups[0];
  assert.ok(backup);
  assert.equal(await fingerprint(path.join(repo, '.slop', 'backups', backup)), before);
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
  assert.deepEqual(result, { updated: [], unchanged: ['demo'], skipped: [], failures: [] });
});

test('inherited lock properties are not treated as upstream entries', async (t) => {
  const { repo } = await fixture(t);
  const directory = await makeSkill(repo, 'constructor');
  const before = await fingerprint(directory);
  const result = await updateSkills({ repo, fetchSkill: () => assert.fail('Must not fetch') });
  assert.deepEqual(result, { updated: [], unchanged: ['constructor'], skipped: [], failures: [] });
  assert.equal(await fingerprint(directory), before);
});

test('an own constructor lock entry can still update normally', async (t) => {
  const { repo } = await fixture(t);
  await tracked(repo, 'constructor');
  const result = await updateSkills({ repo, fetchSkill: upstream });
  assert.deepEqual(result, { updated: ['constructor'], unchanged: [], skipped: [], failures: [] });
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
  catch (error) { if (hasCode(error, 'EPERM')) return t.skip('Symlink permission unavailable'); throw error; }
  await assert.rejects(install({ repo, config, stageSkill }), /Symlink/);
  assert.deepEqual(await readdir(external), []);
});

test('repository symlinks are rejected rather than followed', async (t) => {
  const { repo, base } = await fixture(t);
  const directory = await makeSkill(repo);
  const external = path.join(base, 'external.txt');
  await writeFile(external, 'External data');
  try { await symlink(external, path.join(directory, 'link.txt')); }
  catch (error) { if (hasCode(error, 'EPERM')) return t.skip('Symlink permission unavailable'); throw error; }
  await assert.rejects(skillHash(directory), /Symlink/);
});
