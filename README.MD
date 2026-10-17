# Slop

Slop is my personal repo for keeping track of my agents and skills.

## Setup

Requires **Node.js 22.20+**, npm, Git, and OpenCode V2. Works with native Linux
and Windows (PowerShell or Command Prompt). Treat WSL as a separate Linux setup.

Scripts run TypeScript directly in Node using native type stripping—no build step,
loader, or transpiler. Use only erasable TypeScript syntax; Node does not type-check.
Run `npm run typecheck` for strict, no-emit checking of scripts and tests. JSON/YAML
is validated at runtime before being used as typed application data.

After cloning this repository:

```sh
npm ci --ignore-scripts
npm run install:global
```

After pulling repository changes, run `npm run install:global` again. If
`package-lock.json` changed, run `npm ci --ignore-scripts` first.

The installer asks OpenCode for its effective user config directory with
`opencode debug paths config`. It does not assume `%APPDATA%`, require admin,
or change project configurations. To select the directory explicitly:

```sh
npm run install:global -- --config-dir "/path/to/opencode"
```

PowerShell/Command Prompt example:

```powershell
npm run install:global -- --config-dir "C:\Users\you\.config\opencode"
```

Use the actual path reported by your OpenCode installation. This override is
also useful for testing against a temporary directory.

## Terminal interface

```sh
npm run tui
# Optional: npm run tui -- --config-dir "/path/to/opencode"
```

The full-screen interface manages global installation, repository skill updates,
skill/agent imports, global uninstall, and permanent source deletion. Existing
script commands remain available for automation. No additional UI dependencies
or build step are required.

- The main menu distinguishes global installation, repository maintenance, and
  permanent deletion. Descriptions explain each action's scope before you choose.
- **Arrow keys** navigate, **Space** toggles a checkbox, **Enter** reviews changes,
  and **Esc** goes back. **Page Up/Down** and **Home/End** navigate longer lists.
  Skills, agents, and shared instructions have separate headings and short names.
- **/** searches by name. Enter finishes editing the filter; Esc while editing
  clears it. **a** selects all visible matches; **n** clears visible matches only.
  Selections outside the filter are retained and counted. **d** opens full details
  for the highlighted skill/agent, including its description and source. **?**
  opens the complete keyboard help without losing your selections.
- Installation checkboxes reflect managed copies actually present in the global
  target. Selections are **not saved between workflows or sessions**. Uninstalled
  skills/agents start unchecked. Pending actions (Keep, Install, Replace, Uninstall)
  and live change counts update as you toggle.
  Deselecting an installed item proposes uninstalling it; shared instructions
  are selectable alongside skills and agents.
  To uninstall all managed global copies, press **n** in **Install / uninstall**,
  with no search filter active, then continue and review the removals.
- Review and confirmation share one screen: changes stay visible while you use
  **Left/Right** or **Tab** to choose **Back to selection** or the action-specific
  apply button. Enter confirms; the default is Back. Esc returns to selection
  with the current choices, filter, and focused row intact. This is temporary
  navigation state, not a saved installation preference.
- Edited or unrelated global files block changes. The warning explains how to
  back up and resolve the conflict manually; there is no force-delete option.
- Updates let you select remote-backed skills, with Keep/Replace choices for
  local modifications and backups before replacement. Imports accept upstream
  repository URLs (or GitHub `owner/repository` plus an exact skill name), local
  skill folders, and local agent Markdown files. Existing names are never
  overwritten. Local-only skills have no upstream-update action.
- Import prompts show examples, validate inline without losing your text, and
  support **Tab** completion for local paths. Going back preserves previous input.
  The review shows the resolved source and destination before adding files.
- Imports and updates affect this repository only. Review `git diff`, then use
  **Install / uninstall** to explicitly deploy the desired skills, agents, and instructions.
- Upstream CLI output is captured rather than repeatedly taking over the
  terminal. Animated progress names the current skill and shows counts. Results
  explicitly distinguish Completed, Cancelled, Partially completed, and Failed;
  **View full results** and **View diagnostics** provide optional detail.
  Each operation records diagnostics under `.slop/logs/`. Logs are local and ignored by Git; they may contain source
  paths and upstream output, so review them before sharing.
- During work, Esc/Ctrl+C requests cancellation at a safe boundary. Fetches
  finish before cancellation is checked; active file transactions are not
  interrupted and explicitly show that cancellation is unavailable. Completed updates remain applied. Once permanent deletion
  begins, its uninstall/commit/PR sequence finishes or reports recovery steps.
- Layout reflows on resize, and subtle colors supplement text labels. Set
  `NO_COLOR=1` for uncolored output; no action relies on color alone.

### Permanently delete sources and open a PR

This action deletes selected repository skills/agents, removes their skill-lock
entries, and uninstalls their managed global copies **immediately**. It then
creates one branch, commit, push, and PR for the entire selection. PR approval
does not gate local removal. Shared instructions cannot be source-deleted here.

Git/GitHub requirements are checked before selection and rechecked before deletion.
Ownership, edited-file, and recovery checks still run before any file changes:

- A clean Git working tree, with no uncommitted or untracked nonignored files.
- HEAD at the latest origin default-branch commit, so unrelated branch commits
  cannot accidentally enter the PR. Switch/update your checkout manually first.
- A GitHub `origin` remote, Git author/committer identity, push access, and
  installed/authenticated **GitHub CLI** (`gh auth login`). Fork-only and
  non-GitHub PR workflows are not supported.
- Unchanged, owned global copies and no pending recovery transaction.

The tool does not stash, discard, or include unrelated work. It leaves you on the
new `slop/delete-…` branch. If pushing or opening the PR fails after local changes,
the branch and any completed commit are preserved, and results/logs explain
what completed and how to retry. Check for an existing PR before retrying PR
creation. No automatic rollback or silent branch switch happens. Imports and
updates do not automatically commit or create PRs.

## Repository layout

```text
.agents/agents/<name>.md      → <config>/agents/<name>.md
.agents/skills/<name>/SKILL.md → <config>/skills/<name>/SKILL.md
.agents/instructions/AGENTS.md → <config>/AGENTS.md
skills-lock.json                original skill sources and upstream hashes
scripts/install.ts              installation and removal
scripts/update-skills.ts        upstream updates with local-change checks
scripts/tui.ts                  interactive management entry point
scripts/manage.ts               inventory, imports, and deletion/PR workflow
```

Agent files and global `AGENTS.md` are optional: add your own content when
needed. Skills require `name` and `description` YAML frontmatter, and their
directory must match `name`. Names use lowercase letters, digits, hyphens, and
underscores; Windows reserved names are rejected. Symlinks/junctions and special
files are rejected rather than followed.

Vercel's **`skills@1.7.2`** CLI is pinned in `package-lock.json`. The installer
uses it to stage skill copies in an isolated temporary home/project, then safely
deploys them to OpenCode's config directory. It does not run a direct global
`skills add`, modify other agents' installations, or rely on the CLI's global
path assumptions. Deployment ownership/hashes are stored separately in
`<config>/.slop/manifest.json`; these are not duplicate upstream tracking.

## Update skills from their original authors

```sh
npm run skills:update
```

This reads the original source, optional ref, and skill path from
`skills-lock.json` and fetches through the pinned skills CLI. GitHub, GitLab,
and unambiguous Git repository sources are supported. Repository-owned skills
without a lock entry, local sources, and npm-installed sources are left alone.
Repository URLs and refs are passed separately from the expected skill path:
the CLI discovers skills from the repository root, and its recorded selection
must match the original path before an update is accepted. A moved or ambiguous
skill fails safely rather than updating from a different folder.

Before updating, it recomputes the local folder hash using the CLI's project-lock
algorithm. If it differs from the recorded `computedHash`, you choose **per skill**:

- **Keep** (default): leave the skill and its lock entry unchanged.
- **Replace**: fetch upstream and replace your version, saving the previous
  directory under `.slop/backups/` first. No merging is attempted.

Clean skills update without prompting. Upstream provenance is preserved; only
accepted upstream content advances its baseline hash. Previous copies of clean
updates are backed up too. Backups are local, ignored by Git, and not pruned
automatically. Review updates with `git diff` and commit the skill files together
with `skills-lock.json`. Updating does **not** install anything globally:

```sh
npm run skills:update
git diff
npm run install:global
```

Options:

```sh
npm run skills:update -- --skill grilling
npm run skills:update -- --non-interactive
```

Without an interactive terminal, modified skills are skipped. Other clean skills
still update. Skips or failures produce exit status 1 and a summary; successful
updates already completed are retained. The existing customized `grilling` skill
will initially trigger the local-change warning.
The summary also counts unchanged skills, including repository-owned/local skills
and remote skills that are already current.

**Do not use bare `npx skills update` on this checkout:** although it targets the
same `.agents/skills/` directory, it bypasses the wrapper's local-edit checks and
backups. The pinned CLI's `check` command is
also an update alias, not a read-only check.

### Add a third-party skill using the CLI

From this repository, use the pinned executable via npm:

```sh
npm exec -- skills add owner/repository --skill skill-name --agent opencode --copy --yes
```

The CLI writes its provenance to the root `skills-lock.json` and places the
skill under `.agents/skills/skill-name`, the same directory the installer and
updater manage. Commit that folder alongside the lockfile—no move is needed.
To add an entirely original skill, create `.agents/skills/<name>/SKILL.md`
directly; it needs no upstream lock entry.

## Installation safety and removal

- Conflicts are checked across **all** targets before installed files change.
- Existing unrelated files, even identical ones, are not adopted or overwritten.
- Edited installed files block the entire operation. Make intended edits in
  this repository instead. To resolve a conflict, back up/move the destination
  outside OpenCode's discovery paths yourself, then rerun.
- Renamed/deleted source entries remove their previous installed copies only
  when those copies are unchanged and owned by this installer.
- Existing unrelated global `AGENTS.md` blocks installation of your shared
  instructions. Consolidate its contents deliberately; nothing is appended.
- Normal deployment errors roll back moved files. Interrupted processes/power
  failures may require manual recovery from `<config>/.slop/transaction`.
  A stale `install.lock` or repository `.slop/repository.lock` blocks retries;
  remove it only after verifying no operation is running and inspecting recovery
  files. Keep the deployment manifest: deleting it loses ownership information.
- Skill updates prepare replacements before moving live files and journal each
  skill/baseline commit under `<repo>/.slop/update-transaction`. Normal errors roll
  back both; failed rollback stops the run. A pending transaction blocks updates
  and installation, including when an interrupted update left a skill missing.

### Recover an interrupted skill update

First verify no installer/updater is running. Inspect `.slop/update-transaction/`:

- `journal.json` identifies the skill, original backup path, and commit phase.
- `previous-lock.json` and `next-lock.json` record the baseline before/after.
- `replacement/`, if present, contains the prepared new skill.

For a `prepared` transaction, restore the original skill from the journal's
backup path (if it was moved), and restore `skills-lock.json` from
`previous-lock.json`. Preserve any partial/new content or newer editor changes
outside the managed paths before restoring. For `committed`, verify the skill
matches its new baseline and the lock matches `next-lock.json`; retain the backup.
Only then remove `update-transaction` and any stale `repository.lock` and retry.
If the journal is missing or incomplete, inspect the current skill, lock, and
backups before proceeding: preparation or cleanup may have been interrupted.
This journal supports manual recovery; it does not make multi-file updates
power-loss atomic.

### Uninstall

Remove only managed, unchanged installations:

```sh
npm run uninstall:global
# Optional: npm run uninstall:global -- --config-dir "/path/to/opencode"
```

Unrelated files, OpenCode settings, and repository sources are retained.

## Tests

```sh
npm run typecheck
npm test
```

Tests use temporary repositories/config directories, not your live installation.
They include real local CLI installation/Git fetching, pinned URL-parser compatibility,
hash compatibility, per-skill update choices, backups, conflict protection, pruning,
uninstall, publication/rollback failures, and interrupted-update recovery. GitHub Actions runs
type checks and the suite on Linux and Windows. Remote upstream access is required for real
updates, but not for the test suite.
The TUI tests cover keyboard selection, review/cancellation, selective deployment,
imports, and deletion with real temporary Git branches/commits. GitHub/push calls
are simulated: tests never open a real PR or change your live global files.
