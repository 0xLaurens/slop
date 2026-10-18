# Repository reference

## Repository paths

The installer maps these sources to your OpenCode config directory:

| Repository source | Installed path |
| --- | --- |
| `.agents/agents/<name>.md` | `<config>/agents/<name>.md` |
| `.agents/skills/<name>/SKILL.md` | `<config>/skills/<name>/SKILL.md` |
| `.agents/instructions/AGENTS.md` | `<config>/AGENTS.md` |

These files define sources and management commands:

| Path | Purpose |
| --- | --- |
| `skills-lock.json` | Original skill sources and upstream hashes |
| `scripts/install.ts` | Installation and removal |
| `scripts/update-skills.ts` | Upstream updates with local-change checks |
| `scripts/tui.ts` | Terminal interface entry point |
| `scripts/manage.ts` | Inventory, imports, and permanent deletion with PR creation |

## Source requirements

Agent files and shared instructions are optional. Skills require `name` and
`description` YAML frontmatter. Each skill's directory name must match `name`.
Names accept lowercase letters, digits, hyphens, and underscores. Windows
reserved names are rejected. The tool rejects symlinks, junctions, and special
files rather than following them.

## Terminal interface

The main menu separates global installation, repository maintenance, and
permanent deletion. Each action describes its scope before selection.
Skills, agents, and shared instructions have separate headings.

### Keyboard controls

| Key | Action |
| --- | --- |
| Arrow keys | Move between items |
| **Space** | Toggle a checkbox |
| **Enter** | Review changes or confirm the selected button |
| **Esc** | Go back |
| **Page Up**, **Page Down**, **Home**, **End** | Navigate longer lists |
| **/** | Search by name |
| **Enter** while editing a search | Finish editing the filter |
| **Esc** while editing a search | Clear the filter |
| **a** | Select all visible matches |
| **n** | Clear visible matches |
| **d** | Show the highlighted skill or agent's description and source |
| **?** | Open keyboard help without losing selections |
| **Up**, **Down** on review | Choose the back or apply action |
| **Page Up**, **Page Down**, **Home**, **End** on review | Scroll review changes |
| **Left**, **Right**, **Tab** on review | Action-selection aliases |
| **Tab** in an import path prompt | Complete a local path |

Selections outside the filter remain selected and contribute to the count.
Installation checkboxes reflect managed copies present in the global target.
Selections are not saved between workflows or sessions. Uninstalled items start
unchecked. Pending actions use **Keep**, **Install**, **Replace**, and **Uninstall**
labels, with counts that change as selections change.

Review and confirmation share a screen. Back and apply appear directly beneath
visible changes, and Enter names the selected action. Back is the default;
Up/Down selects an action. Page Up/Down, Home, and End scroll changes without
approving them. Esc cancels.
Returning preserves the choices, filter, and focused row for that workflow.

### Imports and updates

Imports accept upstream repository URLs, GitHub `owner/repository` with an exact
skill name, local skill folders, and local agent Markdown files. Existing names
are never overwritten. Prompts show examples and validate input without clearing
the text. Returning to a prompt preserves its previous input. Review shows the
resolved source and destination.

Updates offer remote-backed skills and per-skill **Keep** or **Replace** choices
for local changes. Local-only skills have no upstream-update action. Imports
and updates affect only the repository. Neither action commits changes or opens PRs.

### Results and cancellation

The interface captures upstream CLI output instead of letting it take over the
terminal. Progress shows the current skill and counts. Results distinguish
**Completed**, **Cancelled**, **Partially completed**, and **Failed**.
**View full results** and **View diagnostics** show details.

Each operation records diagnostics under `.slop/logs/`. Git ignores these local
logs. Logs may contain source paths and upstream output.

During work, **Esc** or **Ctrl+C** requests cancellation at a safe boundary.
An active fetch finishes before the tool checks for cancellation. File
transactions cannot be interrupted. The interface states when cancellation is
unavailable. Completed updates remain applied. Once permanent deletion begins,
its uninstall, commit, and PR sequence finishes or reports recovery steps.

The layout adjusts to terminal size. Colors supplement text labels. `NO_COLOR=1`
disables color output. No action depends on color alone.

## Installation safety

The installer uses Vercel's `skills@1.7.2` CLI, pinned in `package-lock.json`,
to stage skills in an isolated temporary home and project. It then deploys copies
to OpenCode's config directory. It does not run a direct global `skills add`,
change other agents' installations, or depend on the CLI's global path assumptions.
It does not assume that Windows config lives under `%APPDATA%`.

`<config>/.slop/manifest.json` records deployment ownership and hashes.
`skills-lock.json` separately records upstream sources and hashes.

The installer checks all targets for conflicts before changing installed files.
Unrelated files are not adopted or overwritten, even when their contents match.
Edited installed files block the whole operation. An unrelated global `AGENTS.md`
blocks installation of shared instructions. The installer does not append to it.
There is no force-delete option.

Renamed or deleted sources remove previous installed copies only when those
copies are unchanged and owned by the installer. Normal deployment errors roll
back moved files. An interrupted process or power failure may require manual
recovery from `<config>/.slop/transaction`.

A stale `install.lock` or repository `.slop/repository.lock` blocks retries.
A pending update transaction also blocks installation, even if the interrupted
update left a skill missing. The deployment manifest retains ownership information.

Recovery steps are in [Recover blocked operations](recovery.md).

## Skill updates

`npm run skills:update` reads the original source, optional ref, and skill path
from `skills-lock.json`. It fetches through the pinned skills CLI. GitHub, GitLab,
and unambiguous Git repository sources are supported. Skills without lock entries,
local sources, and npm-installed sources are skipped.

The wrapper passes repository URLs and refs separately from the expected skill
path. The CLI discovers skills from the repository root. Its recorded selection
must match the original path before the wrapper accepts an update. A moved or
ambiguous skill fails rather than updating from a different folder.

Before each update, the wrapper hashes the local folder with the CLI's
project-lock algorithm. A mismatch with `computedHash` triggers the local-change
prompt. **Keep** leaves both the skill and lock entry unchanged. **Replace** saves
the previous directory under `.slop/backups/` before replacement. No merge occurs.

Clean skills update without prompting. Their previous copies are backed up too.
Backups are local, ignored by Git, and never pruned automatically. Updates retain
the original source information. Only accepted upstream content advances the
baseline hash.

Without an interactive terminal, modified skills are skipped while clean skills
continue to update. Skips or failures produce exit status 1 and a summary.
Completed updates remain applied. The summary counts unchanged skills, including
repository-owned skills, local skills, and remote skills that are already current.

Updates prepare replacements before moving live files. Each skill and baseline
change is journaled under `.slop/update-transaction`. Normal errors roll back both
changes. A failed rollback stops the run. The journal supports manual recovery,
but does not make multi-file updates atomic during power loss.

## Permanent deletion

Deletion removes selected repository skills and agents, their skill-lock entries,
and their managed global copies before PR approval. Shared instructions are
excluded. Git and GitHub checks run before selection and again before deletion.
Ownership, edited-file, and recovery checks run before any file changes.

Deletion requires all of the following:

- A clean Git working tree with no uncommitted changes or untracked, nonignored files.
- `HEAD` at the latest `origin` default-branch commit.
- A GitHub `origin` remote.
- Git author and committer identity, plus push access.
- An installed GitHub CLI authenticated with `gh auth login`.
- Unchanged, owned global copies and no pending recovery transaction.

Fork-only and non-GitHub PR workflows are unsupported. The tool does not stash,
discard, or include unrelated work. The default-branch check prevents unrelated
branch commits from entering the PR.

Deletion creates one branch, commit, push, and PR for the entire selection. It
leaves the checkout on `slop/delete-…`. If pushing or PR creation fails, the branch
and any completed commit remain. Results and logs describe completed work and
retry steps. No automatic rollback or branch switch occurs.

## Development

Scripts run TypeScript directly in Node through native type stripping. There is
no build step, loader, or transpiler. Only erasable TypeScript syntax is supported.
Node does not type-check. `npm run typecheck` checks scripts and tests in strict
mode without emitting files. Runtime validation checks JSON and YAML before use
as typed application data. The terminal interface adds no UI dependencies.

Tests use temporary repositories and config directories. Coverage includes local
CLI installation and Git fetching, URL-parser and hash compatibility, update
choices, backups, conflict protection, pruning, uninstall, publication failures,
rollback failures, and interrupted-update recovery.

Terminal interface tests cover keyboard selection, review, cancellation, selective
deployment, imports, and deletion with real temporary Git branches and commits.
Tests simulate GitHub and push calls. They never open real PRs or change live
global files. Remote upstream access is required for real updates, not tests.
GitHub Actions runs type checks and tests on Linux and Windows.
