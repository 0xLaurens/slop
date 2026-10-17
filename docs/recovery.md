# Recover blocked operations

## Resolve an installed-file conflict

If an installed file contains changes you want to keep, preserve those changes
before you retry installation or removal. There is no force-delete option.

1. Back up the conflicting destination outside OpenCode's discovery paths.
2. Make the intended source changes in this repository.
3. Move the conflicting destination outside OpenCode's discovery paths.
4. Run the installation or removal command again.

If an unrelated global `AGENTS.md` blocks shared instructions, combine the content
deliberately before you retry. The installer does not append instructions for you.

## Inspect an interrupted deployment

Before changing recovery files or removing locks, verify that no installation
or update operation is running.

1. Inspect `<config>/.slop/transaction` for interrupted deployment state.
2. Preserve any files you need before you restore or move managed files.
3. Resolve the interrupted transaction before you remove stale locks and retry.

Keep `<config>/.slop/manifest.json`. Deleting the manifest loses deployment
ownership information. A stale `install.lock` or repository `.slop/repository.lock`
blocks retries.

## Recover an interrupted skill update

Before restoring files, verify that no installer or updater is running. Preserve
partial replacements and newer editor changes outside the managed paths.

1. Inspect `.slop/update-transaction/journal.json` for the skill, original backup
   path, and commit phase.
2. Compare `previous-lock.json` and `next-lock.json` in the transaction directory.
3. Inspect `replacement/` if that directory exists. It contains the prepared skill.

If the transaction phase is `prepared`, restore the original skill from the
journal's backup path if the updater moved it. Then restore `skills-lock.json`
from `previous-lock.json`.

If the phase is `committed`, verify that the skill matches its new baseline.
Verify that `skills-lock.json` matches `next-lock.json`. Keep the backup.

If the journal is missing or incomplete, inspect the current skill, lock file,
and backups before proceeding. Preparation or cleanup may have been interrupted.

Only after you resolve the transaction, remove `.slop/update-transaction` and any
stale `.slop/repository.lock`. Then retry the operation.
