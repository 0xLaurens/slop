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

## Repository layout

```text
agents/<name>.md              → <config>/agents/<name>.md
skills/<name>/SKILL.md        → <config>/skills/<name>/SKILL.md
instructions/AGENTS.md       → <config>/AGENTS.md
skills-lock.json                original skill sources and upstream hashes
scripts/install.ts              installation and removal
scripts/update-skills.ts        upstream updates with local-change checks
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

**Do not use bare `npx skills update` on this checkout:** it bypasses the wrapper's
local-edit checks and targets the CLI's standard `.agents/skills` layout rather
than this repository's `skills/` sources. The pinned CLI's `check` command is
also an update alias, not a read-only check.

### Add a third-party skill using the CLI

From this repository, use the pinned executable via npm:

```sh
npm exec -- skills add owner/repository --skill skill-name --agent opencode --copy --yes
```

The CLI writes its provenance to `skills-lock.json` and initially places the
skill under `.agents/skills/skill-name`. **Move that entire folder to
`skills/skill-name`**, then commit it alongside the lockfile. For example:

```sh
# Linux
mv .agents/skills/skill-name skills/skill-name
```

```powershell
# Windows PowerShell
Move-Item .agents/skills/skill-name skills/skill-name
```

The wrapper manages `skills/` only; it does not move or modify other files
remaining under `.agents/skills/`. To add an entirely original skill, create
`skills/<name>/SKILL.md` directly; it needs no upstream lock entry.

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
They include a real local CLI installation, hash compatibility, per-skill update
choices, backups, conflict protection, pruning, and uninstall. GitHub Actions runs
type checks and the suite on Linux and Windows. Remote upstream access is required for real
updates, but not for the test suite.
