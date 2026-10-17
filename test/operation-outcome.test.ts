import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { Cancelled, RecoveryRequiredError } from '../scripts/operation-errors.ts';
import { failureOutcome } from '../scripts/operation-outcome.ts';
import { updateSkills, UpdateRunError } from '../scripts/update-skills.ts';
import { fixture, tracked, upstream } from './fixtures.ts';

test('outcome classification uses typed errors, not error-message wording', () => {
  assert.equal(failureOutcome(new Error('Recovery: this text requires recovery')).status, 'Failed');
  assert.equal(failureOutcome(new Cancelled('Stop')).status, 'Cancelled');
  assert.equal(failureOutcome(new RecoveryRequiredError('Unusual wording', { kind: 'skill', transaction: '/journal' }, [])).status, 'Partially completed');
});

test('fatal update recovery retains completed work and identifies the interrupted skill', async (t) => {
  const { repo } = await fixture(t);
  await tracked(repo, 'first');
  await tracked(repo, 'second');
  await tracked(repo, 'third');
  const transaction = path.join(repo, '.slop/update-transaction');
  const rm = fs.rm;
  let cleanups = 0;
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  t.mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => {
    if (args[0] === transaction && ++cleanups === 2) throw new Error('Cannot clean second publication');
    return rm(...args);
  });
  syncBuiltinESMExports();
  const fetched: string[] = [];
  await assert.rejects(updateSkills({ repo, log: () => {}, report: () => {}, fetchSkill: async (request) => {
    fetched.push(request.name);
    return upstream(request);
  } }), (error: unknown) => {
    assert.ok(error instanceof UpdateRunError);
    assert.deepEqual(error.result.updated, ['first']);
    assert.deepEqual(error.result.failures, ['second']);
    assert.deepEqual(error.remaining, ['third']);
    const outcome = failureOutcome(error);
    assert.equal(outcome.status, 'Partially completed');
    assert.match(outcome.summary, /updated: first/);
    assert.match(outcome.summary, /failures: second/);
    assert.match(outcome.summary, /Not processed: third/);
    assert.match(outcome.summary, /Cannot clean second publication/);
    return true;
  });
  assert.deepEqual(fetched, ['first', 'second']);
});

test('cancellation at a staging boundary is skipped work, not a failed update', async (t) => {
  const { repo } = await fixture(t);
  await tracked(repo, 'first');
  await tracked(repo, 'second');
  let cancelled = false;
  const result = await updateSkills({ repo, log: () => {}, report: () => assert.fail('Cancellation is not an error diagnostic'),
    cancelled: () => cancelled, fetchSkill: async () => { cancelled = true; throw new Cancelled('Cancelled before fetch'); } });
  assert.deepEqual(result, { updated: [], unchanged: [], skipped: ['first', 'second'], failures: [] });
});
