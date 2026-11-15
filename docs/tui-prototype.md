# OpenTUI design prototype (throwaway)

**Question:** which layout and component interactions should replace Slop's custom TUI?

This is an interactive design comparison, not the migration. The current
`bun run tui` command is unchanged. All prototype content is deterministic fake
data; actions never invoke the production backend, write files, run Git, install
items, or access the network. Installing dependencies does require network access.

## Run

Using the project's Bun version, in an interactive terminal:

```sh
bun install --frozen-lockfile
bun run tui:prototype
```

Start on a particular design:

```sh
bun run tui:prototype --variant=split
bun run tui:prototype --variant=guided
```

The default is `guided`. Implementation: `scripts/tui-prototype.ts`.
Uses pinned `@opentui/core`, with no React/Solid or build step.

## Compare

| Key | Action |
| --- | --- |
| F2 | Cycle designs, preserving current screen and data |
| F3 | Cycle menu, selection, input, review, progress, results, help |
| F4 | Cycle normal, empty, error fixtures |
| F5 | Reset fixtures and return to the main menu |
| F8 | Inspect full in-memory state |
| d / F9 | Open details or diagnostics; use F9 while editing text |
| F1 | Keyboard help |
| Ctrl+C | Exit |

- **Compact:** single-column task list, inline context, compact item details.
- **Split-pane:** tasks/items on the left and contextual details on the right.
- **Guided (preferred, simplified):** one task at a time, a short title, essential
  controls and focused-action hints. No step tracker, summary rail, explanatory
  paragraphs or permanent debug/switcher bars. Counts, errors and destructive
  warnings remain visible; descriptions, paths and diagnostics open on demand.
  F1 lists prototype controls; F8 exposes full state.

Target sizes are **80×24** and **120×40**. Side panes collapse below 100 columns;
below 80 columns or 24 rows the prototype asks for a larger terminal.

Tab/Shift+Tab move focus. Arrows navigate the focused list, source-type control,
or scroll area. Space toggles checkboxes; Enter activates the focused action;
Esc goes back. Confirmation starts on **Back**. Text inputs use OpenTUI's native
editing/paste support. In selection, `/` focuses search and `a`/`n` select/clear
visible eligible items; filtering retains hidden selections and reports counts.
In Guided, press `d` (or F9) for details and Esc to return to the same control.
In the other variants, Tab to the details pane to scroll descriptions and warnings.

Progress is simulated, including an atomic phase. Cancellation during that phase
is queued until its safe boundary. Help/state inspection pauses the simulation;
return and choose Restart to run it again.

## Suggested review

1. At 120×40, compare all designs on the selection screen with F2.
2. Inspect the long-name conflict and Unicode fixtures; open details and scroll.
3. Search for `research`: existing selections become hidden but remain counted.
4. Review selections: verify Back is initially focused and content scrolls
   independently of the action buttons.
5. Try input editing and paste; F4 Error demonstrates validation feedback.
6. Watch progress complete, cancel it, and inspect partial results with F4 Error.
7. Resize to 80×24 and repeat; shrink further to see the explicit minimum-size state.

Judge information hierarchy, spacing, control appearance, focus visibility,
navigation consistency, and narrow-terminal usability. Choose a design or mix
specific parts of the alternatives before authorizing production migration.

## Boundaries

This prototype intentionally rebuilds screens simply. It is not production
architecture and should not be promoted wholesale. Input sources, validation,
diagnostics and results are synthetic; real path completion, backend safety,
transaction recovery and publication integration remain future migration work.
No committed prototype test suite is added. Native-renderer smoke checks can
validate layout and interactions but cannot prove terminal-emulator behavior;
manual Linux/Windows checks are still needed.

Review verdict so far: **Guided is preferred, but its initial presentation was too
information-dense.** The revised Guided keeps only essential information, with
details on demand. This is still a prototype, not approval to migrate production.
Keep it separate until the revised design is reviewed, then decide how to archive
it. Nothing is committed or published by this task.
