import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { prepareImport } from '../scripts/import-plan.ts';
import { install } from '../scripts/install.ts';
import { exists, fingerprint, json, readSkillsLock } from '../scripts/lib.ts';
import { importContent } from '../scripts/manage.ts';
import { SkillRecoveryError } from '../scripts/skill-transaction.ts';
import { updateSkills } from '../scripts/update-skills.ts';
import { fixture, makeSkill, upstream } from './fixtures.ts';

test('failed import lock publication rolls back the new skill and preserves exact lock bytes', async (t) => {
  const { repo, base } = await fixture(t);
  const source = await makeSkill(base);
  const lockFile = path.join(repo, 'skills-lock.json');
  const previous = await fs.readFile(lockFile, 'utf8');
  const rename = fs.rename;
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (args[1] === lockFile) throw new Error('Lock publication failed');
    return rename(...args);
  });
  syncBuiltinESMExports();
  await assert.rejects(importContent(repo, { kind: 'local-skill', source }), /Lock publication failed/);
  assert.equal(await exists(path.join(repo, '.agents/skills/demo')), false);
  assert.equal(await fs.readFile(lockFile, 'utf8'), previous);
  assert.equal(await exists(path.join(repo, '.slop/update-transaction')), false);
});

test('failed import rollback retains the journal and typed recovery information', async (t) => {
  const { repo, base } = await fixture(t);
  const source = await makeSkill(base);
  const destination = path.join(repo, '.agents/skills/demo');
  const rename = fs.rename;
  const rm = fs.rm;
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (args[1] === path.join(repo, 'skills-lock.json')) throw new Error('Lock publication failed');
    return rename(...args);
  });
  t.mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => {
    if (args[0] === destination) throw new Error('Cannot remove import');
    return rm(...args);
  });
  syncBuiltinESMExports();
  await assert.rejects(importContent(repo, { kind: 'local-skill', source }), (error: unknown) => {
    assert.ok(error instanceof SkillRecoveryError);
    assert.equal(error.recovery.kind, 'skill');
    assert.match(error.message, /Lock publication failed; Cannot remove import/);
    return true;
  });
  const journal = await json(path.join(repo, '.slop/update-transaction/journal.json'));
  assert.ok(typeof journal === 'object' && journal !== null && 'kind' in journal && 'skillBefore' in journal);
  assert.equal(journal.kind, 'create');
  assert.equal(journal.skillBefore, null);
});

test('an interrupted remote import keeps recoverable provenance and blocks all further mutations', async (t) => {
  const { repo, config } = await fixture(t);
  const destination = path.join(repo, '.agents/skills/demo');
  const lockFile = path.join(repo, 'skills-lock.json');
  const before = await fingerprint(lockFile);
  const transaction = path.join(repo, '.slop/update-transaction');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    import { importContent } from ${JSON.stringify(new URL('../scripts/manage.ts', import.meta.url).href)};
    const rename = fs.rename;
    fs.rename = async (...args) => {
      await rename(...args);
      if (args[1] === ${JSON.stringify(destination)}) process.exit(73);
    };
    syncBuiltinESMExports();
    await importContent(${JSON.stringify(repo)}, {kind: 'remote-skill', source: 'example/skills', name: 'demo'}, async ({workspace}) => {
      const directory = path.join(workspace, 'demo');
      await fs.mkdir(directory);
      await fs.writeFile(path.join(directory, 'SKILL.md'), '---\\nname: demo\\ndescription: Imported\\n---\\nInstructions\\n');
      return {directory};
    });
  `], { encoding: 'utf8', env: { ...process.env, SLOP_TMPDIR: path.join(repo, '.slop') } });
  assert.equal(child.status, 73, child.stderr);
  assert.equal(await exists(destination), true);
  assert.equal(await fingerprint(lockFile), before);
  const next = await readSkillsLock(path.join(transaction, 'next-lock.json'));
  assert.equal(next.skills.demo?.source, 'https://github.com/example/skills.git');
  assert.equal(await fingerprint(path.join(transaction, 'previous-lock.json')), before);
  // A real interruption leaves the mutex too; remove only this fixture's stale lock.
  await fs.rm(path.join(repo, '.slop/repository.lock'), { recursive: true });
  await assert.rejects(install({ repo, config }), /Interrupted update\/import/);
  await assert.rejects(updateSkills({ repo }), /Interrupted update\/import/);
  await assert.rejects(importContent(repo, { kind: 'remote-skill', source: 'example/skills', name: 'other' }, upstream), /Interrupted update\/import/);
});

test('backend preparation and publication share name and collision validation', async (t) => {
  const { repo, base } = await fixture(t);
  const source = await makeSkill(base);
  const request = { kind: 'local-skill', source } satisfies Parameters<typeof prepareImport>[0]['request'];
  const candidate = await prepareImport({ repo, request });
  assert.equal(candidate.target, 'skills/demo');
  assert.equal(candidate.destination, path.join(repo, '.agents/skills/demo'));
  await makeSkill(repo);
  await assert.rejects(importContent(repo, request), /Import collision/);
  assert.equal(await exists(path.join(repo, '.slop/update-transaction')), false);
});
