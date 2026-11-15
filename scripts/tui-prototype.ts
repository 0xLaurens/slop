/**
 * THROWAWAY: compare compact, split-pane and guided OpenTUI designs.
 * Run: bun run tui:prototype [--variant=compact|split|guided]
 * All data and operations are simulated. Never import production operations here.
 */
import {
  BoxRenderable, InputRenderable, ScrollBoxRenderable, TextRenderable,
  createCliRenderer,
  type BoxOptions, type CliRenderer, type KeyEvent,
} from "@opentui/core";
import { pathToFileURL } from "node:url";

const variants = ["compact", "split", "guided"] as const;
type Variant = typeof variants[number];
const screens = ["menu", "select", "input", "confirm", "progress", "results", "help"] as const;
type Screen = typeof screens[number] | "state" | "details";
type Scenario = "normal" | "empty" | "error";
type Operation = "Install / uninstall" | "Update skills" | "Import" | "Delete permanently";
const operations: Operation[] = ["Install / uninstall", "Update skills", "Import", "Delete permanently"];
const c = { bg: "#111820", panel: "#18232e", text: "#dce5ed", dim: "#9aaebf", line: "#405467", accent: "#77d9cc", warn: "#ffd084", red: "#ff9393" };
const fixtures = [
  { id: "a", name: "code-review", kind: "Skill", status: "Installed", detail: "Review changes for correctness and maintainability.\nSource: github:example/toolkit\nTarget: ~/.config/opencode/skills/code-review" },
  { id: "b", name: "research", kind: "Skill", status: "Available", detail: "Investigate a topic with primary sources.\nSource: github:example/toolkit\nTarget: ~/.config/opencode/skills/research" },
  { id: "c", name: "日本語ドキュメント 🐇", kind: "Skill", status: "Available", detail: "Unicode fixture: 日本語 / café / 👩🏽‍💻.\nCheck alignment, wrapping and focus highlighting.\nSource: github:example/international" },
  { id: "d", name: "deployment-safety-review-with-an-intentionally-long-name", kind: "Agent", status: "Blocked", detail: "CONFLICT: destination belongs to another installation.\nThis item cannot be selected; no overwrite is allowed.\nTarget: C:/Users/Example User/AppData/Roaming/opencode/agents/deployment-safety-review-with-an-intentionally-long-name.md" },
  { id: "e", name: "frontend-design", kind: "Skill", status: "Modified", detail: "Local edits detected. Updates must preserve or back up edits.\nSource: github:example/design\nTarget: ~/.config/opencode/skills/frontend-design" },
  { id: "f", name: "shared-instructions", kind: "Instructions", status: "Installed", detail: "Shared working rules.\nNot eligible for permanent repository deletion.\nTarget: ~/.config/opencode/AGENTS.md" },
  ...Array.from({ length: 12 }, (_, i) => ({ id: `s${i + 1}`, name: `sample-skill-${String(i + 1).padStart(2, "0")}`, kind: "Skill", status: "Available", detail: `Scrolling fixture ${i + 1} of 12.\nSource: github:example/toolkit\nNo real files will be changed.` })),
];
const operationDetails = [
  "Choose the desired global installation.\nRepository source files remain untouched.",
  "Update upstream skills in this repository.\nGlobal installation is a separate action.",
  "Import a skill or agent into this repository.\nExisting names are never overwritten.",
  "Delete repository items and their managed global copies.\nThe real workflow also creates a branch, commit and PR.\nThis prototype only simulates those steps.",
];
const scopes: Record<Operation, string> = {
  "Install / uninstall": "Global config only · repository kept",
  "Update skills": "Repository only · global config unchanged",
  Import: "Repository only · never overwrite existing names",
  "Delete permanently": "Repository + managed global copies + publication",
};

export function mountPrototype(renderer: CliRenderer, initialVariant: Variant = "guided") {
  let variant = initialVariant;
  let screen: Screen = "menu";
  let previous: Screen = "menu";
  let previousFocus = "list";
  let scenario: Scenario = "normal";
  let operation: Operation = operations[0]!;
  let menuIndex = 0;
  let cursor = 0;
  let filter = "";
  let source = "./examples/skills/my-skill";
  let sourceKind = 0;
  let selected = new Set(["a", "c"]);
  let focus = "list";
  let focusOrder: string[] = [];
  let notice = "";
  let phase = 0;
  let running = false;
  let cancelled = false;
  let cancelRequested = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let view: BoxRenderable | undefined;
  let input: InputRenderable | undefined;
  let scroll: ScrollBoxRenderable | undefined;
  let refresh: (() => void) | undefined;
  let stateText: TextRenderable | undefined;
  let id = 0;

  const rows = () => scenario === "empty" ? [] : fixtures.filter(item =>
    (operation !== "Delete permanently" || item.kind !== "Instructions") &&
    item.name.toLowerCase().includes(filter.toLowerCase()));
  const blocked = (item: typeof fixtures[number]) => item.status === "Blocked";
  const hidden = () => [...selected].filter(key => !rows().some(item => item.id === key)).length;
  const fullState = () => ({ variant, screen, scenario, operation, focus, cursor, filter, selected: [...selected], hidden: hidden(), sourceKind: ["Git repository", "Local skill folder", "Local agent file"][sourceKind], source, phase, running, cancelled, cancelRequested, notice });
  const updateState = () => {
    if (stateText) stateText.content = `STATE ${screen} · ${focus} · ${scenario} · selected=[${[...selected].join(",")}] hidden=${hidden()}\nfilter=${JSON.stringify(filter)} · phase=${phase} · running=${running} · F8 full state`;
  };
  const box = (parent: BoxRenderable, options: BoxOptions = {}) => {
    const result = new BoxRenderable(renderer, { id: `p-${id++}`, flexDirection: "column", ...options });
    parent.add(result);
    return result;
  };
  const text = (parent: BoxRenderable, content: string, color = c.text, height?: number) => {
    const result = new TextRenderable(renderer, { id: `p-${id++}`, content, fg: color, wrapMode: "word", flexShrink: 0, ...(height ? { height } : {}) });
    parent.add(result);
    return result;
  };
  const panel = (parent: BoxRenderable, title: string, active = false, options: BoxOptions = {}) => box(parent, {
    border: true, borderStyle: "rounded", title: ` ${active ? "▶ " : ""}${title} `,
    titleColor: active ? c.accent : c.dim, borderColor: active ? c.accent : c.line,
    paddingX: 1, minHeight: 3, minWidth: 0, ...options,
  });
  const button = (parent: BoxRenderable, label: string, key: string, danger = false) => {
    const active = focus === key;
    const frame = box(parent, { border: true, borderStyle: "rounded", borderColor: active ? c.accent : c.line, backgroundColor: active ? c.line : c.bg, height: 3, paddingX: 1, flexShrink: 0 });
    text(frame, `${active ? "▶ " : "  "}${label}`, danger ? c.red : c.text, 1);
  };
  const buttons = (parent: BoxRenderable, primary: string, danger = false) => {
    const bar = box(parent, { flexDirection: "row", gap: 2, height: 3, flexShrink: 0 });
    button(bar, "Back", "back");
    button(bar, primary, "primary", danger);
  };
  const makeInput = (parent: BoxRenderable, key: string, value: string, placeholder: string, changed: (value: string) => void) => {
    const frame = key === "search" && variant === "guided"
      ? box(parent, { flexDirection: "row", height: 1, flexShrink: 0, backgroundColor: c.panel })
      : panel(parent, key === "search" ? "Search" : "Source", focus === key, { height: 3, flexShrink: 0 });
    if (key === "search" && variant === "guided") text(frame, `${focus === key ? "▶" : " "} Search: `, c.accent, 1);
    input = new InputRenderable(renderer, { id: `p-${id++}`, value, placeholder, flexGrow: 1, textColor: c.text, backgroundColor: c.bg, focusedBackgroundColor: c.panel });
    frame.add(input);
    input.on("input", (value: string) => { changed(value); updateState(); });
    if (focus === key) input.focus();
  };
  const makeScroll = (parent: BoxRenderable, title: string, key = "content") => {
    const frame = panel(parent, title, focus === key, { flexGrow: 1, flexShrink: 1, minHeight: 3 });
    scroll = new ScrollBoxRenderable(renderer, { id: `p-${id++}`, flexGrow: 1, scrollX: false, scrollY: true, contentOptions: { paddingRight: 1 } });
    frame.add(scroll);
    return scroll;
  };

  function stopTimer() { if (timer) clearInterval(timer); timer = undefined; }
  function go(next: Screen, nextFocus?: string) {
    if (screen === "progress" && next !== "progress") { stopTimer(); running = false; }
    screen = next;
    notice = "";
    focus = nextFocus ?? (next === "menu" || next === "select" ? "list" : next === "input" ? "source" : next === "confirm" ? "back" : next === "results" && variant === "guided" ? "primary" : "content");
    draw();
  }
  function start() {
    stopTimer();
    phase = 0; cancelled = false; cancelRequested = false; running = true;
    go("progress", "cancel");
    timer = setInterval(() => {
      phase++;
      if (cancelRequested && phase >= 3) { cancelled = true; stopTimer(); running = false; go("results"); }
      else if (phase >= 4) { stopTimer(); running = false; go("results"); }
      else draw();
    }, 900);
  }
  const isOverlay = () => screen === "help" || screen === "state" || screen === "details";
  function overlay(next: "help" | "state" | "details") {
    if (screen === next) { go(previous, previousFocus); return; }
    if (!isOverlay()) { previous = screen; previousFocus = focus; }
    // Pause the simulated clock while inspecting help/state.
    if (screen === "progress") { stopTimer(); running = false; }
    screen = next; focus = "content"; draw();
  }

  function mainMenu(parent: BoxRenderable, wide: boolean) {
    const minimal = variant === "guided";
    focusOrder = minimal ? ["list"] : ["list", "primary"];
    const main = box(parent, { flexGrow: minimal ? 0 : 1, flexDirection: variant === "split" && wide ? "row" : "column", gap: 1, minHeight: 0 });
    const list = panel(main, "Tasks", focus === "list", { flexGrow: minimal ? 0 : 1, ...(minimal ? { height: 10 } : {}) });
    operations.forEach((label, i) => {
      const row = box(list, { backgroundColor: menuIndex === i ? c.line : c.bg, paddingX: 1, height: variant === "guided" ? 2 : 1, flexShrink: 0 });
      text(row, `${menuIndex === i ? "▶" : " "} ${label}`, menuIndex === i ? c.accent : c.text, 1);
    });
    if (minimal) return;
    const detail = variant === "compact" ? list : panel(main, "Task details", false, { ...(wide && variant === "split" ? { width: "48%" } : { height: 5 }), flexShrink: 0 });
    text(detail, operationDetails[menuIndex]!, c.dim);
    const bar = box(parent, { flexDirection: "row", height: 3, flexShrink: 0 });
    button(bar, "Open task", "primary");
  }

  function selection(parent: BoxRenderable, wide: boolean) {
    const minimal = variant === "guided";
    focusOrder = minimal ? ["search", "list", "back", "primary"] : ["search", "list", "details", "back", "primary"];
    let list: BoxRenderable;
    const main = box(parent, { flexGrow: minimal ? 0 : 1, minHeight: 0, gap: 1, flexDirection: variant === "split" && wide ? "row" : "column" });
    const left = box(main, { flexGrow: 1, minHeight: 0, ...(variant === "split" && wide ? { width: "55%" } : {}) });
    makeInput(left, "search", filter, "Filter by name…", value => { filter = value; cursor = 0; refresh?.(); });
    const sideBySide = variant === "split" && wide;
    const capacity = minimal ? Math.min(10, renderer.height - 10) : Math.max(1, renderer.height - 15 - (sideBySide ? 0 : (variant === "split" ? 6 : 5)));
    list = panel(left, minimal ? "Items" : "Items · Space toggles", focus === "list", { flexGrow: minimal ? 0 : 1, minHeight: 3, height: capacity + 2 });
    const details = minimal ? undefined : panel(main, "Item details", focus === "details", {
      ...(variant === "split" && wide ? { width: "43%", flexGrow: 1 } : { height: variant === "split" ? 5 : 4 }),
      flexShrink: 0,
    });
    const detailScroll = minimal ? undefined : new ScrollBoxRenderable(renderer, { id: `p-${id++}`, flexGrow: 1, scrollX: false });
    if (detailScroll && details) details.add(detailScroll);
    if (focus === "details") scroll = detailScroll;
    const summary = text(parent, "", c.warn, 1);
    refresh = () => {
      for (const child of list.getChildren()) child.destroyRecursively();
      for (const child of detailScroll?.getChildren() ?? []) child.destroyRecursively();
      const visible = rows();
      cursor = Math.max(0, Math.min(cursor, visible.length - 1));
      const first = Math.max(0, Math.min(cursor - Math.floor(capacity / 2), visible.length - capacity));
      if (!visible.length) text(list, scenario === "empty" ? "No items available in this fixture." : "No matches. Clear or change the search.", c.dim);
      visible.slice(first, first + capacity).forEach((item, offset) => {
        const active = first + offset === cursor;
        const row = box(list, { height: 1, flexShrink: 0, flexDirection: "row", backgroundColor: active ? c.line : c.bg });
        text(row, `${active ? "▶" : " "} ${blocked(item) ? "[!]" : selected.has(item.id) ? "[x]" : "[ ]"} `, active ? c.accent : c.dim, 1);
        const name = new TextRenderable(renderer, { id: `p-${id++}`, content: item.name, fg: c.text, height: 1, flexGrow: 1, flexShrink: 1, minWidth: 0, wrapMode: "none" });
        row.add(name);
        text(row, ` ${item.status}`, blocked(item) ? c.red : c.dim, 1);
      });
      const item = visible[cursor];
      if (detailScroll) text(detailScroll, item ? `${item.name}\n${item.kind} · ${item.status}\n${item.detail}` : "Nothing selected for inspection.", item && blocked(item) ? c.warn : c.dim);
      summary.content = minimal
        ? `${selected.size} selected${hidden() ? ` · ${hidden()} hidden` : ""}${scenario === "error" ? " · Source unavailable" : ""}${item && blocked(item) ? " · Blocked: destination owned by another installation" : ""}`
        : `${selected.size} selected · ${hidden()} hidden by filter · ${visible.length} matches${scenario === "error" ? " · fixture: source unavailable" : ""}`;
      updateState();
    };
    refresh();
    buttons(parent, minimal ? "Review" : "Review changes");
  }

  function form(parent: BoxRenderable) {
    focusOrder = ["kind", "source", "back", "primary"];
    const minimal = variant === "guided";
    const frame = panel(parent, minimal ? "Source type" : "Import source", focus === "kind", { flexShrink: 0, height: 3 });
    text(frame, `${focus === "kind" ? "▶ " : ""}${["Git repository", "Local skill folder", "Local agent file"][sourceKind]}${minimal ? "" : " · arrows change type"}`, c.accent, 1);
    makeInput(parent, "source", source, "Repository URL or local path", value => { source = value; notice = ""; });
    if (minimal) { buttons(parent, "Review"); return; }
    const help = makeScroll(parent, "Input guidance");
    text(help, "Native input: edit with Left/Right, Home/End, Delete and paste.\n\nExamples (fixtures only):\n  example/toolkit#research\n  ./examples/skills/my-skill\n  C:/Users/Example User/projects/a-very-long-directory-name/skills/my-skill\n\nTab moves between controls. Enter on Source moves to Review.\nNo filesystem lookups or network requests are performed.", c.dim);
    buttons(parent, "Review import");
  }

  function confirmation(parent: BoxRenderable) {
    focusOrder = ["content", "back", "primary"];
    text(parent, scopes[operation], c.warn, 1);
    if (variant === "guided" && operation === "Delete permanently") text(parent, "Permanent deletion · removes files and global copies; publishes a PR.", c.red, 1);
    const body = makeScroll(parent, variant === "guided" ? "Changes" : "Review changes");
    const chosen = fixtures.filter(item => selected.has(item.id));
    if (variant === "guided") {
      text(body, operation === "Import" ? `Import: ${source}\nExisting names are never overwritten.` : chosen.map(item => `• ${item.name}${item.status === "Modified" ? " · local edits protected" : ""}`).join("\n") || "No changes.");
      buttons(parent, operation === "Delete permanently" ? "Simulate deletion" : "Simulate apply", operation === "Delete permanently");
      return;
    }
    text(body, operation === "Import" ? `SIMULATED IMPORT\nSource: ${source}\nDestination: repository fixture\nExisting names will never be overwritten.` : `${operation.toUpperCase()} · ${chosen.length} selected\n\n${chosen.map(item => `• ${item.name}\n  ${item.status} → simulated change`).join("\n\n") || "No changes selected."}`);
    text(body, `\n${operation === "Delete permanently" ? "DESTRUCTIVE IN THE REAL APP: files, lock entries and managed global copies are removed; branch/commit/PR publication follows.\n" : ""}This prototype does not execute any changes.\nBack is selected by default. Tab to the explicit action to continue.`, c.warn);
    buttons(parent, operation === "Delete permanently" ? "Simulate deletion" : "Simulate apply", operation === "Delete permanently");
  }

  function progress(parent: BoxRenderable) {
    focusOrder = variant === "guided" ? ["cancel"] : ["content", "cancel"];
    const messages = ["Resolving fixture sources", "Preparing simulated changes", "Applying atomic step · cancellation unavailable", "Collecting results"];
    const completed = Math.min(4, phase);
    text(parent, `${"━".repeat(completed * 5)}${"─".repeat((4 - completed) * 5)} ${completed}/4 · ${running ? "Running" : "Paused"}`, c.accent, 1);
    if (variant === "guided") text(parent, messages[phase] ?? "Complete", phase === 2 ? c.warn : c.dim, 1);
    else {
      const body = makeScroll(parent, "Simulated activity");
      text(body, messages.slice(0, phase + 1).map((message, i) => `${i < phase ? "✓" : "›"} ${message}`).join("\n\n"));
      text(body, "\nNo subprocesses, file writes, network calls or publication.\nAll progress is deterministic and simulated.", c.dim);
    }
    const bar = box(parent, { flexDirection: "row", height: 3, flexShrink: 0 });
    button(bar, phase === 2 ? "Cancel after atomic step" : running ? "Cancel simulation" : "Restart simulation", "cancel");
  }

  function results(parent: BoxRenderable) {
    focusOrder = variant === "guided" ? ["primary"] : ["content", "back", "primary"];
    const partial = scenario === "error";
    text(parent, cancelled ? "Cancelled safely · no real changes" : partial ? "Partial result · fixture failure" : "Completed · simulated changes only", partial ? c.warn : c.accent, 1);
    if (variant === "guided") {
      if (partial && !cancelled) text(parent, "1 completed · 1 failed · remaining skipped\nSource unavailable. Retry the operation.", c.warn, 2);
      const bar = box(parent, { flexDirection: "row", height: 3, flexShrink: 0 });
      button(bar, "Main menu", "primary");
      return;
    }
    const body = makeScroll(parent, "Results and diagnostics");
    text(body, cancelled ? "The simulation was cancelled at a safe boundary.\nNothing on disk was modified." : partial ? "✓ First fixture completed.\n! Second fixture failed: upstream source unavailable.\n− Remaining fixtures skipped.\n\nRecovery: retry the simulated operation. Real changes would be reported separately from publication failures." : "✓ All eligible fixture changes completed.\n✓ Existing-name and ownership protections preserved.\n✓ No real files or global configuration changed.");
    text(body, "\nDiagnostics (synthetic):\n[resolve] fixture source accepted\n[plan] operation scoped explicitly\n[apply] in-memory simulation only\n[finish] no log file written\n\nRepository updates and imports do not automatically install globally.\nReal operation logs and recovery remain outside this prototype.", c.dim);
    buttons(parent, "Main menu");
  }

  function help(parent: BoxRenderable) {
    focusOrder = ["content", "back"];
    const body = makeScroll(parent, screen === "state" ? "Full prototype state" : screen === "details" ? "Details" : "Keyboard help");
    if (screen === "details") {
      const item = rows()[cursor];
      text(body, previous === "select" ? item ? `${item.name}\n${item.kind} · ${item.status}\n\n${item.detail}` : "No item to inspect."
        : previous === "menu" ? operationDetails[menuIndex]!
        : previous === "input" ? "Git: example/toolkit#research\nLocal folder: ./examples/skills/my-skill\nLocal agent: ./examples/agents/my-agent.md\n\nNative editing and paste supported. No real path completion."
        : previous === "results" ? "Diagnostics (synthetic)\n[resolve] fixture source accepted\n[plan] explicit scope\n[apply] in-memory simulation only\n[finish] no log file written"
        : previous === "progress" ? `Phase ${phase}/4\nCancellation is queued during the atomic step.\nAll activity is simulated.`
        : scopes[operation], c.dim);
      const bar = box(parent, { flexDirection: "row", height: 3, flexShrink: 0 });
      button(bar, "Back", "back");
      return;
    }
    text(body, screen === "state" ? JSON.stringify(fullState(), null, 2) : "NAVIGATION\nTab / Shift+Tab  Move between controls\nArrows  Navigate the focused list or scroll area\nSpace  Toggle a checkbox\nEnter  Activate the focused action\nEsc  Close help or go back\nCtrl+C  Exit prototype\n\nPROTOTYPE CONTROLS\nF2  Cycle Compact / Split-pane / Guided\nF3  Cycle component screens\nF4  Cycle Normal / Empty / Error fixtures\nF5  Reset state and selections\nF8  Inspect full state\nF1  Help\n\nLISTS\n/  Focus search\na / n  Select / clear visible eligible items\nHidden selections remain selected and are counted.\nBlocked items cannot be selected.\n\nINPUT\nNative cursor editing and paste; no real path completion.\n\nSAFETY\nAll operations are fake. Confirmations default to Back.\n80×24 minimum; split panes collapse below 100 columns.\nProgress pauses when inspecting help or full state.", c.dim);
    if (screen === "help") text(body, "\nDETAILS\nd  Open item/task details or result diagnostics (outside text inputs)\nF9  Open details from any control\nEsc  Return to the same control\n\nGuided shows essential information only. Prototype controls and full\nstate remain available through function keys, without permanent bars.", c.dim);
    const bar = box(parent, { flexDirection: "row", height: 3, flexShrink: 0 });
    button(bar, "Back", "back");
  }

  function draw() {
    refresh = undefined; input = undefined; scroll = undefined; stateText = undefined;
    view?.destroyRecursively();
    id = 0;
    const width = renderer.width;
    const height = renderer.height;
    view = new BoxRenderable(renderer, { id: "prototype", width: "100%", height: "100%", backgroundColor: c.bg, flexDirection: "column", paddingX: width >= 80 ? 1 : 0 });
    renderer.root.add(view);
    if (width < 80 || height < 24) {
      text(view, `Terminal too small: ${width}×${height}.\nResize to at least 80×24.\nCtrl+C exits.`, c.warn);
      return;
    }
    const minimal = variant === "guided";
    const titles: Record<Screen, string> = { menu: "Slop", select: operation, input: "Import", confirm: "Review", progress: "Applying", results: "Result", help: "Help", state: "State", details: "Details" };
    text(view, minimal ? `${titles[screen]} · prototype` : `SLOP  /  ${variant === "compact" ? "Compact" : "Split-pane"}  /  ${screen.toUpperCase()}     PROTOTYPE · FAKE DATA`, c.accent, 1);
    if (!minimal) text(view, screen === "menu" ? "Manage skills, agents and shared instructions" : `${operation} · ${scopes[operation]}`, c.dim, 1);
    const wide = width >= 100;
    const host = box(view, { flexGrow: 1, flexShrink: 1, minHeight: 0, flexDirection: "row", gap: 1 });
    const content = box(host, { flexGrow: 1, flexShrink: 1, minWidth: 0, minHeight: 0, flexDirection: "column" });
    if (screen === "menu") mainMenu(content, wide);
    else if (screen === "select") selection(content, wide);
    else if (screen === "input") form(content);
    else if (screen === "confirm") confirmation(content);
    else if (screen === "progress") progress(content);
    else if (screen === "results") results(content);
    else help(content);
    if (minimal) {
      if (notice) text(view, notice, c.warn, 1);
      const hint = screen === "results" ? "Enter main menu · d diagnostics" : focus === "list" ? screen === "select" ? "Space select · / search · d details" : "Enter open · d details" : focus === "kind" ? "←→ type" : focus === "search" ? "Enter items" : focus === "source" ? "Enter continue · F9 details" : focus === "content" ? "↑↓ scroll" : "Enter activate";
      text(view, `${hint} · Tab focus · F1 help`, c.dim, 1);
    } else {
      text(view, notice || (screen === "select" ? "Tab focus · ↑↓ items · Space toggle · / search · a/n visible · F1 help" : "Tab focus · Arrows navigate/scroll · Enter activate · Esc back · F1 help"), notice ? c.warn : c.dim, 1);
      text(view, `◀ F2 Design: ${variant} ▶   F3 Component   F4 Fixture: ${scenario}   F5 Reset`, c.accent, 1);
      stateText = text(view, "", c.dim, 2);
    }
    updateState();
  }

  function activate() {
    if (focus === "back") { if (isOverlay()) go(previous, previousFocus); else go(screen === "confirm" ? operation === "Import" ? "input" : "select" : "menu"); return; }
    if (screen === "menu") {
      operation = operations[menuIndex]!;
      if (operation === "Delete permanently") for (const item of fixtures) if (item.kind === "Instructions") selected.delete(item.id);
      go(operation === "Import" ? "input" : "select");
    }
    else if (screen === "select" && focus === "primary") {
      if (!selected.size || scenario === "empty") { notice = "Select at least one eligible item before reviewing."; draw(); }
      else go("confirm");
    } else if (screen === "input") {
      if (focus === "source") { focus = "primary"; draw(); }
      else if (focus === "primary") {
        if (!source.trim() || scenario === "error") { notice = !source.trim() ? "Source is required." : "Fixture validation failed: source unavailable. Switch F4 to Normal to continue."; draw(); }
        else go("confirm");
      }
    } else if (screen === "confirm" && focus === "primary") start();
    else if (screen === "progress" && focus === "cancel") {
      if (!running) start();
      else if (phase === 2) { cancelRequested = true; notice = "Cancellation requested; waiting for the atomic step to finish."; draw(); }
      else { cancelled = true; stopTimer(); running = false; go("results"); }
    } else if (screen === "results" && focus === "primary") go("menu");
  }

  function onKey(key: KeyEvent) {
    if (key.ctrl && key.name === "c") { key.preventDefault(); stopTimer(); renderer.destroy(); return; }
    if (key.name === "f1") { key.preventDefault(); overlay("help"); return; }
    if (key.name === "f8") { key.preventDefault(); overlay("state"); return; }
    if (key.name === "f9") { key.preventDefault(); overlay("details"); return; }
    if (key.name === "f2") {
      key.preventDefault(); variant = variants[(variants.indexOf(variant) + 1) % variants.length]!;
      if (variant === "guided") {
        if (screen === "results") focus = "primary";
        else if (focus === "details" || (screen === "menu" && focus === "primary")) focus = "list";
        else if (screen === "progress" && focus === "content") focus = "cancel";
      }
      draw(); return;
    }
    if (key.name === "f3") {
      key.preventDefault();
      const index = screens.indexOf(screen as typeof screens[number]);
      const next = screens[(index + 1) % screens.length]!;
      if (next === "input") operation = "Import";
      if (next === "select" && operation === "Import") operation = operations[0]!;
      if (next === "progress") start(); else go(next);
      return;
    }
    if (key.name === "f4") { key.preventDefault(); scenario = scenario === "normal" ? "empty" : scenario === "empty" ? "error" : "normal"; cursor = 0; draw(); return; }
    if (key.name === "f5") {
      key.preventDefault(); stopTimer(); running = false; phase = 0; cancelled = false; cancelRequested = false;
      selected = new Set(["a", "c"]); filter = ""; cursor = 0; scenario = "normal"; source = "./examples/skills/my-skill"; sourceKind = 0; menuIndex = 0; operation = operations[0]!; go("menu"); return;
    }
    if (renderer.width < 80 || renderer.height < 24) { key.preventDefault(); return; }
    if (key.name === "tab") {
      key.preventDefault();
      const index = focusOrder.indexOf(focus);
      focus = focusOrder[(index + (key.shift ? -1 : 1) + focusOrder.length) % focusOrder.length]!;
      draw(); return;
    }
    if (key.name === "escape") {
      key.preventDefault();
      if (screen === "progress" && running) { focus = "cancel"; activate(); }
      else if (isOverlay()) go(previous, previousFocus);
      else if (screen !== "menu") go(screen === "confirm" ? operation === "Import" ? "input" : "select" : "menu");
      return;
    }
    // Leave editing, including Left/Right/Home/End and paste, to OpenTUI.
    if ((focus === "source" || focus === "search") && input) {
      if (key.name === "return") { key.preventDefault(); focus = focus === "search" ? "list" : "primary"; draw(); }
      return;
    }
    if (key.name === "d" && !isOverlay()) { key.preventDefault(); overlay("details"); return; }
    if (key.name === "return") { key.preventDefault(); activate(); return; }
    if ((focus === "content" || focus === "details") && scroll) {
      const amount = key.name === "up" ? -1 : key.name === "down" ? 1 : key.name === "pageup" ? -6 : key.name === "pagedown" ? 6 : 0;
      if (amount) { key.preventDefault(); scroll.scrollBy(amount); return; }
      if (key.name === "home" || key.name === "end") { key.preventDefault(); scroll.scrollTo(key.name === "home" ? 0 : scroll.scrollHeight); return; }
    }
    if (screen === "input" && focus === "kind" && ["left", "right", "up", "down"].includes(key.name)) {
      key.preventDefault(); sourceKind = (sourceKind + (["left", "up"].includes(key.name) ? 2 : 1)) % 3; draw(); return;
    }
    if (screen === "menu" && focus === "list" && ["up", "down"].includes(key.name)) {
      key.preventDefault(); menuIndex = (menuIndex + (key.name === "up" ? 3 : 1)) % 4; draw(); return;
    }
    if (screen === "select") {
      if (key.sequence === "/") { key.preventDefault(); focus = "search"; draw(); return; }
      if (focus !== "list") return;
      const visible = rows();
      const delta = key.name === "up" ? -1 : key.name === "down" ? 1 : key.name === "pageup" ? -5 : key.name === "pagedown" ? 5 : 0;
      if (delta || key.name === "home" || key.name === "end") {
        key.preventDefault(); cursor = key.name === "home" ? 0 : key.name === "end" ? visible.length - 1 : Math.max(0, Math.min(visible.length - 1, cursor + delta)); refresh?.();
      } else if (key.name === "space" || key.sequence === " ") {
        key.preventDefault(); const item = visible[cursor];
        if (item && !blocked(item)) { if (selected.has(item.id)) selected.delete(item.id); else selected.add(item.id); }
        else if (item) { notice = "Blocked: this destination is not owned by this installation."; draw(); }
        refresh?.();
      } else if (key.name === "a" || key.name === "n") {
        key.preventDefault(); for (const item of visible) if (!blocked(item)) { if (key.name === "a") selected.add(item.id); else selected.delete(item.id); } refresh?.();
      }
    }
  }
  renderer.keyInput.on("keypress", onKey);
  renderer.on("resize", draw);
  renderer.on("destroy", stopTimer);
  draw();
  return { state: fullState, dispose: () => { stopTimer(); renderer.keyInput.off("keypress", onKey); renderer.off("resize", draw); renderer.off("destroy", stopTimer); view?.destroyRecursively(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const requested = process.argv.find(arg => arg.startsWith("--variant="))?.split("=")[1] ?? "guided";
  if (!variants.includes(requested as Variant)) throw new Error("Use --variant=compact, --variant=split, or --variant=guided");
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Run the prototype in an interactive terminal.");
  const renderer = await createCliRenderer({ exitOnCtrlC: true, useMouse: false, backgroundColor: c.bg, screenMode: "alternate-screen" });
  mountPrototype(renderer, requested as Variant);
}
