import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { errorMessage } from './data.ts';
import type { SkillName, SkillsLock } from './data.ts';
import { copy, exists, fingerprint, noLinks, writeJson } from './lib.ts';

export class UpdateRecoveryError extends AggregateError {
  constructor(transaction: string, errors: unknown[]) {
    super(errors, `Update requires recovery from ${transaction}: ${errors.map(errorMessage).join('; ')}`);
  }
}

export async function assertNoPendingUpdate(repo: string): Promise<void> {
  const transaction = path.join(repo, '.slop', 'update-transaction');
  await noLinks(transaction);
  if (await exists(transaction)) {
    throw new UpdateRecoveryError(transaction, [new Error('Interrupted update; inspect journal.json and recover before retrying')]);
  }
}

export type LockSnapshot = { lock: SkillsLock; fingerprint: string };

type CommitUpdate = {
  repo: string;
  name: SkillName;
  before: string;
  snapshot: LockSnapshot;
  nextLock: SkillsLock;
  replacement?: string;
};

// One skill and its baseline form a transaction. Prepare everything before moving
// live files. The journal and both locks survive interruption; successful updates
// retain the original skill in backups. This is recoverable, not power-loss atomic.
export async function commitUpdate({ repo, name, before, snapshot, nextLock, replacement }: CommitUpdate): Promise<LockSnapshot> {
  await assertNoPendingUpdate(repo);
  const transaction = path.join(repo, '.slop', 'update-transaction');
  const current = path.join(repo, 'skills', name);
  const lockFile = path.join(repo, 'skills-lock.json');
  const prepared = path.join(transaction, 'replacement');
  const oldLock = path.join(transaction, 'previous-lock.json');
  const nextLockFile = path.join(transaction, 'next-lock.json');
  const publishLock = path.join(transaction, 'publish-lock.json');
  const backup = path.join(repo, '.slop', 'backups', `${name}-${Date.now()}-${randomUUID()}`);
  await noLinks(backup);
  await mkdir(transaction);
  let saved = false;
  let installed = false;
  let published = false;
  let committed: LockSnapshot;
  try {
    await copy(lockFile, oldLock);
    await writeJson(nextLockFile, nextLock);
    await copy(nextLockFile, publishLock);
    const lockAfter = await fingerprint(publishLock);
    if (lockAfter === null) throw new Error('Prepared skills-lock.json disappeared');
    if (replacement !== undefined) await copy(replacement, prepared);
    const skillAfter = replacement === undefined ? before : await fingerprint(prepared);
    if (skillAfter === null) throw new Error('Prepared skill disappeared');
    const journal = { version: 1, name, backup: replacement === undefined ? null : path.relative(repo, backup),
      skillBefore: before, skillAfter, lockBefore: snapshot.fingerprint, lockAfter };
    await writeJson(path.join(transaction, 'journal.json'), { ...journal, phase: 'prepared' });
    // Recheck after preparation too: copying a large tree takes time.
    if (await fingerprint(current) !== before) throw new Error('Changed while updating; retry after saving edits');
    if (await fingerprint(lockFile) !== snapshot.fingerprint) throw new Error('skills-lock.json changed during update');
    if (replacement !== undefined) {
      await mkdir(path.dirname(backup), { recursive: true });
      await rename(current, backup);
      saved = true;
      await rename(prepared, current);
      installed = true;
    }
    // Publish the prepared bytes with one syscall. Derive the expected snapshot
    // from those bytes, not a later read that might include an editor's changes.
    await rename(publishLock, lockFile);
    published = true;
    await writeJson(path.join(transaction, 'journal.json'), { ...journal, phase: 'committed' });
    committed = { lock: nextLock, fingerprint: lockAfter };
  } catch (error) {
    try {
      if (published) {
        const restoreLock = path.join(transaction, 'restore-lock.json');
        await copy(oldLock, restoreLock);
        await rename(restoreLock, lockFile);
      }
      if (installed) await rm(current, { recursive: true });
      if (saved) await rename(backup, current);
      await rm(transaction, { recursive: true });
    } catch (rollback) {
      throw new UpdateRecoveryError(transaction, [error, rollback]);
    }
    throw error;
  }
  // Cleanup failure must not roll back an already committed update or allow the
  // next skill to proceed with unresolved transaction state.
  try { await rm(transaction, { recursive: true }); }
  catch (error) { throw new UpdateRecoveryError(transaction, [error]); }
  return committed;
}
