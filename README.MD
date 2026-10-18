# Slop

Slop is my personal repo for keeping track of my agents and skills.

## Install globally

You need Bun 1.4.3, Git, and OpenCode V2. Linux and native
Windows are supported. On Windows, use PowerShell or Command Prompt. Treat WSL
as a separate Linux installation.

After you clone the repository, run these commands:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run install:global
```

After you pull changes, run `bun run install:global` again. If `bun.lock`
changed, run `bun install --frozen-lockfile --ignore-scripts` first.

The installer gets your user config directory from `opencode debug paths config`.
It does not require administrator access or change project configurations.
To choose a directory yourself, pass `--config-dir`:

```sh
bun run install:global --config-dir "/path/to/opencode"
```

On Windows, use the path reported by your OpenCode installation:

```powershell
bun run install:global --config-dir "C:\Users\you\.config\opencode"
```

You can also use `--config-dir` to test installation in a temporary directory.

## Choose what to install

Start the terminal interface:

```sh
bun run tui
```

To use a different config directory, run `bun run tui --config-dir "/path/to/opencode"`.

1. Open **Install / uninstall**.
2. Use the arrow keys to choose a skill, agent, or shared instructions.
3. Press **Space** to select or deselect the item.
4. Press **Enter** to review the changes.
5. Choose the apply button and press **Enter** to confirm.

Deselecting an installed item proposes its removal. Checkboxes reflect the
managed copies in your global config directory, not saved preferences.

To remove all managed global copies, clear the search filter and press **n** in
**Install / uninstall**. Review the removals before you confirm.

See the [terminal interface reference](docs/reference.md#terminal-interface) for
keyboard controls, cancellation behavior, and diagnostics.

## Update skills

Use the repository's update command, not bare `npx skills update` or `skills check`.
Both upstream commands bypass the wrapper's local-edit checks and backups.
The pinned CLI's `check` command is an update alias, not a read-only check.

```sh
bun run skills:update
```

For each locally modified skill, choose one action:

- **Keep** leaves the skill and its lock entry unchanged. This is the default.
- **Replace** fetches the upstream version and saves your previous copy under
  `.slop/backups/`. It does not merge changes.

Clean skills update without a prompt. To update one skill, use `--skill`:

```sh
bun run skills:update --skill grilling
```

For automation, use `--non-interactive`. Modified skills are skipped:

```sh
bun run skills:update --non-interactive
```

Updates change this repository, not your global installation. Review the diff
and commit the skill files with `skills-lock.json`. Then install the changes:

```sh
git diff
bun run install:global
```

You can also select updates in the terminal interface. See
[skill update behavior](docs/reference.md#skill-updates) for supported sources,
backups, and exit status.

## Add a skill or agent

Use the terminal interface to import an upstream skill, a local skill folder,
or a local agent Markdown file. Review the resolved source and destination before
you confirm. Imports never overwrite an existing name.

To add a third-party skill from the command line, run the pinned CLI from this
repository:

```sh
bun node_modules/skills/bin/cli.mjs add owner/repository --skill skill-name --agent opencode --copy --yes
```

Commit `.agents/skills/skill-name` with the root `skills-lock.json`.

To write an original skill, create `.agents/skills/<name>/SKILL.md`. Add `name`
and `description` YAML frontmatter. The directory name must match `name`.
An original skill needs no upstream lock entry.

To add an agent, create `.agents/agents/<name>.md`. To add shared instructions,
create `.agents/instructions/AGENTS.md`.

Review `git diff`, then run `bun run install:global` or use **Install / uninstall**
to deploy your changes. See [source requirements](docs/reference.md#source-requirements)
for naming and file restrictions.

## Delete repository sources

Permanent deletion removes the selected repository skills and agents, their skill
lock entries, and their managed global copies immediately. PR approval does not
delay removal. Shared instructions cannot be deleted through this action.

1. Check the [deletion requirements](docs/reference.md#permanent-deletion).
2. Open the permanent deletion action in the terminal interface.
3. Select the sources to delete.
4. Review the changes and confirm deletion.

The tool creates one branch, commit, push, and PR for the selection. It leaves
you on the new `slop/delete-…` branch. If a push or PR fails, follow the recovery
steps in the results. Check for an existing PR before you retry PR creation.

## Uninstall global copies

To remove all managed, unchanged installations, run this command:

```sh
bun run uninstall:global
```

To choose the config directory, add `--config-dir "/path/to/opencode"`.
Uninstall keeps unrelated files, OpenCode settings, and repository sources.

If edited files or an interrupted operation block a change, follow
[Recover blocked operations](docs/recovery.md).

## Run checks

Run the type check and test suite:

```sh
bun run typecheck
bun test
```

Tests use temporary repositories and config directories, not your live
installation. They do not require remote upstream access or open real PRs.
See the [development reference](docs/reference.md#development) for runtime
details and test coverage.
