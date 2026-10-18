import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { exists, fingerprint, json, readSkillsLock, writeJson } from '../scripts/lib.ts';
import { install } from '../scripts/install.ts';
import { updateSkills, UpdateRunError } from '../scripts/update-skills.ts';
import { SkillRecoveryError } from '../scripts/skill-transaction.ts';
import { fixture, makeSkill, tracked, upstream } from './fixtures.ts';

// Named builtin imports must be refreshed after installing AND restoring mocks.
// Faults target real filesystem operations, not a separate test-only commit path.
function mockFilesystem(t: TestContext) {
  t.after(() => { t.mock.restoreAll(); });
}

test('failed baseline-only publication cannot leak into a later successful update', async (t) => {
  const { repo } = await fixture(t);
  const first = await tracked(repo, 'first');
  await tracked(repo, 'second');
  const lockFile = path.join(repo, 'skills-lock.json');
  const previous = await readSkillsLock(lockFile);
  await fs.appendFile(path.join(first, 'SKILL.md'), 'Local edit also present upstream\n');
  const rename = fs.rename;
  let fail = true;
  mockFilesystem(t);
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (args[1] === lockFile && fail) { fail = false; throw new Error('Lock publication failed'); }
    return rename(...args);
  });
  const result = await updateSkills({ repo, interactive: true, ask: async () => true,
    fetchSkill: async (options) => {
      if (options.name !== 'first') return upstream(options);
      const directory = path.join(options.workspace, 'staged');
      await fs.cp(first, directory, { recursive: true });
      return { directory };
    } });
  assert.deepEqual(result.failures, ['first']);
  assert.deepEqual(result.updated, ['second']);
  const final = await readSkillsLock(lockFile);
  assert.deepEqual(final.skills.first, previous.skills.first);
  assert.notDeepEqual(final.skills.second, previous.skills.second);
  assert.equal(await exists(path.join(repo, '.slop', 'update-transaction')), false);
});

test('publication failure restores the original skill and exact lock bytes', async (t) => {
  const { repo } = await fixture(t);
  const current = await tracked(repo);
  const before = await fingerprint(current);
  const lockFile = path.join(repo, 'skills-lock.json');
  const previous = await fs.readFile(lockFile, 'utf8');
  const rename = fs.rename;
  mockFilesystem(t);
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (args[1] === lockFile) throw new Error('Lock publication failed');
    return rename(...args);
  });
  const result = await updateSkills({ repo, fetchSkill: upstream });
  assert.deepEqual(result.failures, ['demo']);
  assert.equal(await fingerprint(current), before);
  assert.equal(await fs.readFile(lockFile, 'utf8'), previous);
  assert.equal(await exists(path.join(repo, '.slop', 'update-transaction')), false);
  assert.deepEqual(await fs.readdir(path.join(repo, '.slop', 'backups')), []);
});

test('partially failed preparation never moves the live skill', async (t) => {
  const { repo } = await fixture(t);
  const current = await tracked(repo);
  const before = await fingerprint(current);
  const lockFile = path.join(repo, 'skills-lock.json');
  const previous = await fingerprint(lockFile);
  const cp = fs.cp;
  const rename = fs.rename;
  mockFilesystem(t);
  const moves = t.mock.method(fs, 'rename', rename);
  t.mock.method(fs, 'cp', async (...args: Parameters<typeof fs.cp>) => {
    if (args[1] === path.join(repo, '.slop', 'update-transaction', 'replacement')) {
      await fs.mkdir(args[1], { recursive: true });
      await fs.writeFile(path.join(args[1].toString(), 'partial'), 'Incomplete');
      throw new Error('Replacement copy failed');
    }
    return cp(...args);
  });
  const result = await updateSkills({ repo, fetchSkill: upstream });
  assert.deepEqual(result.failures, ['demo']);
  assert.equal(await fingerprint(current), before);
  assert.equal(await fingerprint(lockFile), previous);
  assert.equal(moves.mock.calls.some((call) => call.arguments[0] === current), false);
  assert.equal(await exists(path.join(repo, '.slop', 'update-transaction')), false);
});

test('failed replacement rename after backup restores the original directory', async (t) => {
  const { repo } = await fixture(t);
  const current = await tracked(repo);
  const before = await fingerprint(current);
  const lockFile = path.join(repo, 'skills-lock.json');
  const previous = await fingerprint(lockFile);
  const rename = fs.rename;
  mockFilesystem(t);
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (args[0] === path.join(repo, '.slop', 'update-transaction', 'replacement')) throw new Error('Replacement rename failed');
    return rename(...args);
  });
  assert.deepEqual((await updateSkills({ repo, fetchSkill: upstream })).failures, ['demo']);
  assert.equal(await fingerprint(current), before);
  assert.equal(await fingerprint(lockFile), previous);
  assert.equal(await exists(path.join(repo, '.slop', 'update-transaction')), false);
});

test('rollback failure preserves both errors and recovery files, and stops later skills', async (t) => {
  const { repo, config } = await fixture(t);
  const current = await tracked(repo, 'first');
  await tracked(repo, 'second');
  const before = await fingerprint(current);
  const lockFile = path.join(repo, 'skills-lock.json');
  const previous = await fs.readFile(lockFile, 'utf8');
  const rename = fs.rename;
  mockFilesystem(t);
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (args[1] === lockFile) throw new Error('Lock publication failed');
    if (args[1] === current && args[0].toString().includes(`${path.sep}backups${path.sep}`)) throw new Error('Restore failed');
    return rename(...args);
  });
  const fetched: string[] = [];
  await assert.rejects(updateSkills({ repo, fetchSkill: async (options) => {
    fetched.push(options.name);
    return upstream(options);
  } }), (error: unknown) => {
    assert.ok(error instanceof UpdateRunError);
    assert.ok(error.cause instanceof SkillRecoveryError);
    assert.deepEqual(error.cause.errors.map((value: Error) => value.message), ['Lock publication failed', 'Restore failed']);
    assert.match(error.message, /Lock publication failed; Restore failed/);
    return true;
  });
  assert.deepEqual(fetched, ['first']);
  const transaction = path.join(repo, '.slop', 'update-transaction');
  const journal = await json(path.join(transaction, 'journal.json'));
  assert.ok(typeof journal === 'object' && journal !== null && 'backup' in journal && typeof journal.backup === 'string');
  assert.equal(await fingerprint(path.join(repo, journal.backup)), before);
  assert.equal(await fs.readFile(path.join(transaction, 'previous-lock.json'), 'utf8'), previous);
  await assert.rejects(updateSkills({ repo }), /Interrupted update/);
  await assert.rejects(install({ repo, config }), /Interrupted update/);
});

test('failure after lock publication rolls back both skill content and baseline', async (t) => {
  const { repo } = await fixture(t);
  const current = await tracked(repo);
  const before = await fingerprint(current);
  const lockFile = path.join(repo, 'skills-lock.json');
  const previous = await fs.readFile(lockFile, 'utf8');
  const rename = fs.rename;
  const journalFile = path.join(repo, '.slop', 'update-transaction', 'journal.json');
  let publications = 0;
  mockFilesystem(t);
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (args[1] === journalFile && ++publications === 2) throw new Error('Commit marker failed');
    return rename(...args);
  });
  assert.deepEqual((await updateSkills({ repo, fetchSkill: upstream })).failures, ['demo']);
  assert.equal(await fingerprint(current), before);
  assert.equal(await fs.readFile(lockFile, 'utf8'), previous);
  assert.equal(await exists(path.join(repo, '.slop', 'update-transaction')), false);
});

test('process interruption after backup blocks discovery and leaves usable recovery data', async (t) => {
  const { repo, config } = await fixture(t);
  const current = await tracked(repo);
  const before = await fingerprint(current);
  const lockFile = path.join(repo, 'skills-lock.json');
  const previous = await fs.readFile(lockFile, 'utf8');
  const transaction = path.join(repo, '.slop', 'update-transaction');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import { updateSkills } from ${JSON.stringify(new URL('../scripts/update-skills.ts', import.meta.url).href)};
    const rename = fs.rename;
    const current = ${JSON.stringify(current)};
    fs.rename = async (...args) => {
      await rename(...args);
      if (args[0] === current) process.exit(73);
    };
    await updateSkills({ repo: ${JSON.stringify(repo)}, fetchSkill: async ({ name, workspace }) => {
      const directory = path.join(workspace, name);
      await fs.mkdir(directory);
      await fs.writeFile(path.join(directory, 'SKILL.md'), '---\\nname: ' + name + '\\ndescription: Test\\n---\\nupdated\\n');
      return { directory };
    } });
  `], { encoding: 'utf8', env: { ...process.env, SLOP_TMPDIR: path.join(repo, '.slop') } });
  assert.equal(child.status, 73, child.stderr);
  assert.equal(await exists(current), false);
  // A real crash leaves the mutex as well as the journal. Remove only the stale
  // mutex, as documented, to verify the transaction independently blocks retries.
  await fs.rm(path.join(repo, '.slop', 'repository.lock'), { recursive: true });
  await assert.rejects(updateSkills({ repo, fetchSkill: () => assert.fail('Must not fetch') }), /Interrupted update/);
  await assert.rejects(install({ repo, config }), /Interrupted update/);
  const journal = await json(path.join(transaction, 'journal.json'));
  assert.ok(typeof journal === 'object' && journal !== null && 'backup' in journal && typeof journal.backup === 'string');
  assert.equal(await fingerprint(path.join(repo, journal.backup)), before);
  assert.equal(await fs.readFile(path.join(transaction, 'previous-lock.json'), 'utf8'), previous);
  // Exercise the documented manual rollback, then ensure normal operation resumes.
  await fs.rename(path.join(repo, journal.backup), current);
  await fs.copyFile(path.join(transaction, 'previous-lock.json'), lockFile);
  await fs.rm(transaction, { recursive: true });
  assert.deepEqual((await updateSkills({ repo, fetchSkill: upstream })).updated, ['demo']);
});

test('unchanged results include repository-owned, local-source, and up-to-date skills', async (t) => {
  const { repo } = await fixture(t);
  await makeSkill(repo, 'owned');
  await tracked(repo, 'local');
  await tracked(repo, 'current');
  const lockFile = path.join(repo, 'skills-lock.json');
  const lock = await readSkillsLock(lockFile);
  assert.ok(lock.skills.local);
  lock.skills.local.sourceType = 'local';
  await writeJson(lockFile, lock);
  const result = await updateSkills({ repo, fetchSkill: async ({ name, workspace, source, skillPath }) => {
    assert.equal(name, 'current');
    assert.equal(source, 'https://github.com/example/skills.git');
    assert.equal(skillPath, 'skills/current/SKILL.md');
    const directory = path.join(workspace, name);
    await fs.cp(path.join(repo, '.agents', 'skills', name), directory, { recursive: true });
    return { directory };
  } });
  assert.deepEqual(result, { updated: [], unchanged: ['current', 'local', 'owned'], skipped: [], failures: [] });
  assert.equal(await exists(path.join(repo, '.slop', 'update-transaction')), false);
});

test('accepted baseline-only updates publish through the same commit path without replacing content', async (t) => {
  const { repo } = await fixture(t);
  const current = await tracked(repo);
  const lockFile = path.join(repo, 'skills-lock.json');
  const previous = await readSkillsLock(lockFile);
  await fs.appendFile(path.join(current, 'SKILL.md'), 'Change also present upstream\n');
  const before = await fingerprint(current);
  const result = await updateSkills({ repo, interactive: true, ask: async () => true,
    fetchSkill: async ({ workspace }) => {
      const directory = path.join(workspace, 'staged');
      await fs.cp(current, directory, { recursive: true });
      return { directory };
    } });
  assert.deepEqual(result.unchanged, ['demo']);
  assert.equal(await fingerprint(current), before);
  assert.notDeepEqual((await readSkillsLock(lockFile)).skills.demo, previous.skills.demo);
  assert.equal(await exists(path.join(repo, '.slop', 'backups')), false);
  assert.equal(await exists(path.join(repo, '.slop', 'update-transaction')), false);
});

test('post-commit cleanup failure leaves committed recovery state and stops further updates', async (t) => {
  const { repo } = await fixture(t);
  const current = await tracked(repo, 'first');
  await tracked(repo, 'second');
  const before = await fingerprint(current);
  const transaction = path.join(repo, '.slop', 'update-transaction');
  const rm = fs.rm;
  mockFilesystem(t);
  t.mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => {
    if (args[0] === transaction) throw new Error('Transaction cleanup failed');
    return rm(...args);
  });
  const fetched: string[] = [];
  await assert.rejects(updateSkills({ repo, fetchSkill: async (options) => {
    fetched.push(options.name);
    return upstream(options);
  } }), /Transaction cleanup failed/);
  assert.deepEqual(fetched, ['first']);
  assert.notEqual(await fingerprint(current), before);
  const journal = await json(path.join(transaction, 'journal.json'));
  assert.ok(typeof journal === 'object' && journal !== null && 'phase' in journal);
  assert.equal(journal.phase, 'committed');
  assert.deepEqual(await json(path.join(repo, 'skills-lock.json')), await json(path.join(transaction, 'next-lock.json')));
  await assert.rejects(updateSkills({ repo }), /Interrupted update/);
});

test('edits made while preparing a replacement are preserved', async (t) => {
  const { repo } = await fixture(t);
  const current = await tracked(repo);
  const cp = fs.cp;
  const transaction = path.join(repo, '.slop', 'update-transaction');
  mockFilesystem(t);
  t.mock.method(fs, 'cp', async (...args: Parameters<typeof fs.cp>) => {
    await cp(...args);
    if (args[1] === path.join(transaction, 'replacement')) await fs.writeFile(path.join(current, 'editor.txt'), 'New edit');
  });
  assert.deepEqual((await updateSkills({ repo, fetchSkill: upstream })).failures, ['demo']);
  assert.equal(await fs.readFile(path.join(current, 'editor.txt'), 'utf8'), 'New edit');
  assert.equal(await exists(transaction), false);
});

test('lock edits immediately after publication are not adopted as our expected snapshot', async (t) => {
  const { repo } = await fixture(t);
  await tracked(repo, 'first');
  await tracked(repo, 'second');
  const lockFile = path.join(repo, 'skills-lock.json');
  const previous = await readSkillsLock(lockFile);
  const rename = fs.rename;
  mockFilesystem(t);
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    await rename(...args);
    if (args[1] === lockFile && args[0] === path.join(repo, '.slop', 'update-transaction', 'publish-lock.json')) {
      const edited = await readSkillsLock(lockFile);
      edited.editorMetadata = 'Preserve this';
      await fs.writeFile(lockFile, JSON.stringify(edited));
    }
  });
  const result = await updateSkills({ repo, fetchSkill: upstream });
  assert.deepEqual(result.updated, ['first']);
  assert.deepEqual(result.failures, ['second']);
  const final = await readSkillsLock(lockFile);
  assert.equal(final.editorMetadata, 'Preserve this');
  assert.deepEqual(final.skills.second, previous.skills.second);
});

test('rollback after publication retains the previous lock if restoring the skill fails', async (t) => {
  const { repo } = await fixture(t);
  const current = await tracked(repo);
  const lockFile = path.join(repo, 'skills-lock.json');
  const previous = await fs.readFile(lockFile, 'utf8');
  const transaction = path.join(repo, '.slop', 'update-transaction');
  const rename = fs.rename;
  const rm = fs.rm;
  let markers = 0;
  mockFilesystem(t);
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (args[1] === path.join(transaction, 'journal.json') && ++markers === 2) throw new Error('Commit marker failed');
    return rename(...args);
  });
  t.mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => {
    if (args[0] === current) throw new Error('Cannot remove replacement');
    return rm(...args);
  });
  await assert.rejects(updateSkills({ repo, fetchSkill: upstream }), /Commit marker failed; Cannot remove replacement/);
  assert.equal(await fs.readFile(lockFile, 'utf8'), previous);
  assert.equal(await fs.readFile(path.join(transaction, 'previous-lock.json'), 'utf8'), previous);
});
