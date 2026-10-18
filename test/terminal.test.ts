import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { cleanText, Terminal } from '../scripts/terminal.ts';
import { fit, removeLastGrapheme, tail, wrap } from '../scripts/terminal-text.ts';

function terminal(t: TestContext) {
  let raw = false;
  let screen = '';
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: (value: boolean) => { raw = value; } });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
  output.on('data', (chunk: Buffer) => { screen += chunk.toString(); });
  const ui = new Terminal(input, output);
  t.after(() => ui.close());
  const key = (name: string, text = '', ctrl = false) => input.emit('keypress', text, { name, ctrl, meta: false, shift: false });
  return { ui, key, input, output, raw: () => raw, screen: () => screen };
}

const choices = [{ value: 'first', label: 'First' }, { value: 'second', label: 'Second' }];

test('arrow navigation wraps from first to last and last to first', async (t) => {
  const { ui, key } = terminal(t);
  const up = ui.select('Menu', choices, [], false);
  key('up'); key('return');
  assert.deepEqual(await up, ['second']);
  const down = ui.select('Menu', choices, [], false);
  key('down'); key('down'); key('return');
  assert.deepEqual(await down, ['first']);
});

test('group headings align with single and multiple choice labels and navigation skips headings', async (t) => {
  const items = [
    { value: 'first', label: 'First', group: 'Group A' },
    { value: 'second', label: 'Second', group: 'Group B' },
  ];
  const single = terminal(t);
  const singleSelection = single.ui.select('Single', items, [], false);
  assert.match(cleanText(single.screen()), /  SLOP · Skills & agents\s+  Single/);
  assert.match(cleanText(single.screen()), /  Group A\s+› First/);
  assert.match(cleanText(single.screen()), /  Group A\s+› First\s+\s+  Group B\s+  Second/);
  assert.doesNotMatch(cleanText(single.screen()), /──/);
  single.key('down'); single.key('return');
  assert.deepEqual(await singleSelection, ['second']);

  const multiple = terminal(t);
  const multipleSelection = multiple.ui.select('Multiple', items);
  assert.match(cleanText(multiple.screen()), /      SLOP · Skills & agents\s+      Multiple/);
  assert.match(cleanText(multiple.screen()), /      Group A\s+› \[ \] First/);
  assert.match(cleanText(multiple.screen()), /      Group A\s+› \[ \] First\s+\s+      Group B\s+  \[ \] Second/);
  assert.doesNotMatch(cleanText(multiple.screen()), /──/);
  multiple.key('down'); multiple.key('space'); multiple.key('return');
  assert.deepEqual(await multipleSelection, ['second']);
});

test('permanent deletion and warning text use neutral terminal styling', async (t) => {
  const previous = process.env.NO_COLOR;
  const oldTerm = process.env.TERM;
  delete process.env.NO_COLOR;
  process.env.TERM = 'xterm';
  t.after(() => { if (previous === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = previous; if (oldTerm === undefined) delete process.env.TERM; else process.env.TERM = oldTerm; });
  const { ui, key, screen } = terminal(t);
  const confirmation = ui.confirm('Permanent deletion', ['Deletes repository permanently', 'Warning: this cannot be undone.']);
  const frame = screen().split('\x1b[2J').at(-1) ?? '';
  assert.doesNotMatch(frame, /\x1b\[\d*;?31m|\x1b\[\d*;?36m/);
  assert.match(cleanText(frame), /Permanent deletion/);
  key('escape'); await confirmation;
});

test('arrow navigation wraps within filtered choices', async (t) => {
  const { ui, key } = terminal(t);
  const selection = ui.select('Filtered', [...choices, { value: 'third', label: 'Third' }]);
  key('/', '/'); key('i', 'ir'); key('return');
  key('up'); key('space'); key('down'); key('space'); key('return');
  assert.deepEqual(await selection, ['third', 'first']);
});

test('arrow navigation handles empty and single-choice lists', async (t) => {
  const { ui, key } = terminal(t);
  for (const items of [[], choices.slice(0, 1)]) {
    const selection = ui.select('Menu', items, [], false);
    key('up'); key('down'); key('return');
    assert.deepEqual(await selection, items.map((choice) => choice.value));
  }
});

test('arrow/Space/Enter edits selection without persisting preferences', async (t) => {
  const { ui, key } = terminal(t);
  const selection = ui.select('Selection', choices, ['first']);
  key('space'); key('down'); key('space'); key('return');
  assert.deepEqual(await selection, ['second']);
  const next = ui.select('Fresh selection', choices);
  key('return');
  assert.deepEqual(await next, []);
});

test('select all, select none, and Escape work', async (t) => {
  const { ui, key } = terminal(t);
  const all = ui.select('All', choices);
  key('a'); key('return');
  assert.deepEqual(await all, ['first', 'second']);
  const none = ui.select('None', choices, ['first', 'second']);
  key('n'); key('return');
  assert.deepEqual(await none, []);
  const cancel = ui.select('Cancel', choices);
  key('escape');
  assert.equal(await cancel, undefined);
});

test('review defaults to cancellation and Escape backs out immediately', async (t) => {
  const { ui, key } = terminal(t);
  const escaped = ui.confirm('Delete?', ['DELETE first']);
  key('escape');
  assert.equal(await escaped, false);
  const defaultCancel = ui.confirm('Delete?', ['DELETE first']);
  key('return');
  assert.equal(await defaultCancel, false);
  const apply = ui.confirm('Delete?', ['DELETE first']);
  key('right'); key('return');
  assert.equal(await apply, true);
});

test('text input supports editing and cancellation', async (t) => {
  const { ui, key } = terminal(t);
  const text = ui.text('Path');
  key('x', 'source-x'); key('backspace'); key('a', 'a'); key('return');
  assert.equal(await text, 'source-a');
  const cancelled = ui.text('Path');
  key('c', '', true);
  assert.equal(await cancelled, undefined);
});

test('progress cancellation requests a safe stop and terminal closes cleanly', (t) => {
  const { ui, key, raw, screen, output } = terminal(t);
  let cancelled = false;
  ui.progress('Installing', ['Staging…'], () => { cancelled = true; });
  assert.equal(raw(), true);
  output.emit('resize');
  key('c', '', true);
  assert.equal(cancelled, true);
  ui.close();
  assert.equal(raw(), false);
  assert.match(screen(), /\x1b\[\?1049l/);
});

test('search filters names; bulk actions affect matches only and preserve hidden selections', async (t) => {
  const { ui, key, screen } = terminal(t);
  const selected = ui.select('Skills', choices, ['first']);
  key('/', '/'); key('s', 'second'); key('return');
  assert.match(screen(), /1 selected · 1 outside filter/);
  key('a'); key('return');
  assert.deepEqual(await selected, ['first', 'second']);
  const cleared = ui.select('Skills', choices, ['first', 'second']);
  key('/', '/'); key('s', 'second'); key('return'); key('n'); key('return');
  assert.deepEqual(await cleared, ['first']);
});

test('Escape clears search before leaving selection', async (t) => {
  const { ui, key, screen } = terminal(t);
  const selected = ui.select('Skills', choices);
  key('/', '/'); key('x', 'missing');
  assert.match(screen(), /No matches for/);
  key('escape');
  key('space'); key('return');
  assert.deepEqual(await selected, ['first']);
});

test('selection state retains filter and focused row during review navigation', async (t) => {
  const { ui, key } = terminal(t);
  const state = {};
  const first = ui.select('Skills', choices, [], true, { state });
  key('/', '/'); key('s', 'second'); key('return'); key('space'); key('return');
  const selection = await first;
  assert.deepEqual(selection, ['second']);
  const review = ui.confirm('Review', ['Install second'], 'Install selected skills');
  key('escape'); assert.equal(await review, false);
  const back = ui.select('Skills', choices, selection, true, { state });
  key('space'); key('return');
  assert.deepEqual(await back, []);
  assert.deepEqual(state, { cursor: 'second', query: 'second' });
});

test('Home/End and page navigation work on grouped lists', async (t) => {
  const { ui, key, screen } = terminal(t);
  const many = Array.from({ length: 30 }, (_, index) => ({ value: String(index), label: `Skill ${index}`, group: index < 15 ? 'Skills' : 'Agents' }));
  const selected = ui.select('Grouped', many);
  key('end'); key('space');
  assert.match(screen(), /of 30/);
  key('home'); key('space'); key('pagedown'); key('pageup'); key('return');
  assert.deepEqual(await selected, ['29', '0']);
});

test('live statuses and summaries update immediately when toggling', async (t) => {
  const { ui, key, screen } = terminal(t);
  const selected = ui.select('Install', [{ value: 'new', label: 'New skill', group: 'Skills', status: (checked) => checked ? 'Install' : 'No change' }], [], true,
    { summary: (selection) => `${selection.size} install`, intro: ['Repository files will not be deleted.'] });
  key('space');
  assert.match(screen(), /New skill · Install/);
  assert.match(screen(), /1 install/);
  key('return'); await selected;
});

test('review keeps changes visible while selecting an action; arrows scroll rather than approving', async (t) => {
  const { ui, key, screen } = terminal(t);
  const review = ui.confirm('Review changes', ['Uninstall globally', '  tdd'], 'Apply installation changes');
  key('right');
  const frame = screen().split('\x1b[2J').at(-1) ?? '';
  assert.match(frame, /Uninstall globally/);
  assert.match(frame, /Apply installation changes/);
  key('left'); key('down'); key('return');
  assert.equal(await review, false);
});

test('input validation keeps the value and shows errors inline', async (t) => {
  const { ui, key, screen } = terminal(t);
  const text = ui.text('Skill name', { hint: 'Example: tdd', validate: (value) => { if (value !== 'tdd') throw new Error('Use tdd'); } });
  key('x', 'bad'); key('return');
  await setImmediate();
  assert.match(screen(), /Use tdd/);
  assert.match(screen(), /> bad/);
  key('u', '', true); key('t', 'tdd'); key('return');
  assert.equal(await text, 'tdd');
});

test('Tab completes paths and input state survives going back', async (t) => {
  const { ui, key } = terminal(t);
  const state: { value?: string } = {};
  const text = ui.text('Path', { state, complete: async (value) => [`${value}/skill/`] });
  key('p', './imports'); key('tab');
  await setImmediate();
  key('escape'); assert.equal(await text, undefined);
  assert.equal(state.value, './imports/skill/');
  const back = ui.text('Path', { state });
  key('return'); assert.equal(await back, './imports/skill/');
});

test('late async validation cannot close a different screen', async (t) => {
  const { ui, key } = terminal(t);
  let finish: (() => void) | undefined;
  const text = ui.text('Path', { validate: () => new Promise<void>((resolve) => { finish = resolve; }) });
  key('p', 'path'); key('return'); key('escape');
  assert.equal(await text, undefined);
  const next = ui.select('Next', choices);
  finish?.(); await setImmediate();
  key('space'); key('return');
  assert.deepEqual(await next, ['first']);
});

test('atomic progress does not advertise or accept cancellation', (t) => {
  const { ui, key, screen } = terminal(t);
  let cancelled = false;
  ui.progress('Fetching', [], () => { cancelled = true; });
  ui.progress('Committing', []);
  key('escape');
  assert.equal(cancelled, false);
  const frame = screen().split('\x1b[2J').at(-1) ?? '';
  assert.match(frame, /cancellation is unavailable/);
  assert.match(frame, /Preparing/);
});

test('small terminals stay within viewport bounds and pages rewrap on resize', async (t) => {
  const { ui, key, output, screen } = terminal(t);
  output.columns = 40; output.rows = 12;
  const page = ui.page('Long results', 'A fairly long explanation of the selected action. '.repeat(10));
  key('end');
  let frame = screen().split('\x1b[2J').at(-1) ?? '';
  assert.ok(frame.split('\r\n').length <= 12);
  assert.ok(frame.split('\r\n').every((line) => [...cleanText(line)].length < 40));
  output.columns = 60; output.emit('resize');
  key('home'); key('return');
  assert.equal(await page, true);
  frame = screen().split('\x1b[2J').at(-1) ?? '';
  assert.match(frame, /explanation/);
});

test('details can be inspected without losing the current selection', async (t) => {
  const { ui, key, screen } = terminal(t);
  const selected = ui.select('Install', [{ value: 'skill', label: 'A skill', detail: 'Description\nSource path\nUpstream URL\nWarning' }]);
  key('space'); key('d');
  assert.match(screen(), /Upstream URL/);
  key('return'); await setImmediate();
  key('return');
  assert.deepEqual(await selected, ['skill']);
});

test('bulk selection does not select missing sources that cannot be installed', async (t) => {
  const { ui, key } = terminal(t);
  const selected = ui.select('Install', [{ value: 'missing', label: 'Missing source', disabled: true }, ...choices]);
  key('space'); key('a'); key('return');
  assert.deepEqual(await selected, ['first', 'second']);
});

test('long details cannot hide the list position indicator', async (t) => {
  const { ui, key, screen } = terminal(t);
  const selected = ui.select('Install', [{ value: 'skill', label: 'Skill', detail: 'Long description '.repeat(30) + '\n/path\n/upstream\nwarning' }]);
  const frame = screen().split('\x1b[2J').at(-1) ?? '';
  assert.match(frame, /Showing 1–1 of 1/);
  key('escape'); await selected;
});

test('keyboard help returns to the same selection', async (t) => {
  const { ui, key, screen } = terminal(t);
  const selected = ui.select('Skills', choices, ['first']);
  key('?', '?');
  assert.match(screen(), /Keyboard help/);
  key('return'); await setImmediate();
  key('return');
  assert.deepEqual(await selected, ['first']);
});

test('one-row list viewports keep the focused choice visible through navigation and resize', async (t) => {
  const { ui, key, output, screen } = terminal(t);
  output.rows = 6;
  const selection = ui.select('Choose', choices);
  const frame = () => cleanText(screen().split('\x1b[2J').at(-1) ?? '');
  assert.match(frame(), /› \[ \] First/);
  key('down');
  assert.match(frame(), /› \[ \] Second/);
  key('space');
  output.rows = 1; output.emit('resize');
  assert.equal(frame().split('\r\n').length, 1);
  assert.match(frame(), /› \[x\] Second/);
  key('home');
  assert.match(frame(), /› \[ \] First/);
  key('return');
  assert.deepEqual(await selection, ['second']);
});

test('inline descriptions keep selection styling on the label and work without color', async (t) => {
  const previous = process.env.NO_COLOR;
  process.env.NO_COLOR = '';
  t.after(() => { if (previous === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = previous; });
  const { ui, key, output, screen } = terminal(t);
  output.columns = 80; output.rows = 12;
  const selection = ui.select('Choose', [{ value: 'first', label: 'Install / uninstall', detail: 'Choose what is installed globally in OpenCode.' },
    { value: 'next', label: 'Next item', detail: 'Another description.' }], [], false, { showDescriptions: true });
  const frame = () => cleanText(screen().split('\x1b[2J').at(-1) ?? '');
  assert.match(frame(), /› Install \/ uninstall \| Choose what is installed globally/);
  assert.doesNotMatch(screen(), /\x1b\[\d+m/);
  key('down');
  assert.match(frame(), /› Next item \| Another description/);
  key('return');
  assert.deepEqual(await selection, ['next']);
});

test('inline styling uses neutral bold selected labels, not color accents', async (t) => {
  const previous = process.env.NO_COLOR;
  const oldTerm = process.env.TERM;
  delete process.env.NO_COLOR;
  process.env.TERM = 'xterm';
  t.after(() => { if (previous === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = previous; if (oldTerm === undefined) delete process.env.TERM; else process.env.TERM = oldTerm; });
  const { ui, key, screen } = terminal(t);
  const selection = ui.select('Choose', [{ value: 'first', label: 'A | B 中文', detail: 'safe description' }, { value: 'second', label: 'Other', detail: 'neutral' }], [], false, { showDescriptions: true });
  const frame = () => screen().split('\x1b[2J').at(-1) ?? '';
  assert.match(frame(), /› \x1b\[1mA \| B 中文\x1b\[0m\x1b\[2m \| safe description/);
  assert.match(frame(), /\x1b\[1mOther\x1b\[0m\x1b\[2m \| neutral/);
  key('down');
  assert.match(frame(), /› \x1b\[1mOther\x1b\[0m\x1b\[2m \| neutral/);
  assert.match(frame(), /\x1b\[1mA \| B 中文\x1b\[0m\x1b\[2m \| safe description/);
  key('d'); await setImmediate(); assert.match(frame(), /neutral/); assert.doesNotMatch(frame(), /safe description/);
  key('return'); await setImmediate();
  assert.match(frame(), /› \x1b\[1mOther\x1b\[0m\x1b\[2m \| neutral/);
  key('escape'); await selection;
});

test('inline menu narrow Unicode rows stay within width and dumb terminals emit no color', async (t) => {
  const oldTerm = process.env.TERM; process.env.TERM = 'dumb';
  t.after(() => { if (oldTerm === undefined) delete process.env.TERM; else process.env.TERM = oldTerm; });
  const { ui, key, output, screen } = terminal(t); output.columns = 2;
  const selection = ui.select('Choose', [{ value: 'x', label: '👨‍👩‍👧‍👦中文', detail: 'description' }], [], false, { showDescriptions: true });
  assert.doesNotMatch(screen(), /\x1b\[\d+m/);
  assert.ok(screen().split('\r\n').every((line) => [...cleanText(line)].length <= 1));
  key('escape'); await selection;
});

test('inline multiple-choice styling leaves checked prefix neutral and bolds selected label', async (t) => {
  const oldTerm = process.env.TERM; const oldColor = process.env.NO_COLOR;
  process.env.TERM = 'xterm'; delete process.env.NO_COLOR;
  t.after(() => { if (oldTerm === undefined) delete process.env.TERM; else process.env.TERM = oldTerm; if (oldColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = oldColor; });
  const { ui, key, screen } = terminal(t);
  const selection = ui.select('Choose', [{ value: 'item', label: 'Selected label', detail: 'Description' }], ['item'], true, { showDescriptions: true });
  const frame = screen().split('\x1b[2J').at(-1) ?? '';
  assert.match(frame, /› \[x\] \x1b\[1mSelected label\x1b\[0m\x1b\[2m \| Description/);
  key('escape'); await selection;
});

test('terminal text geometry approximates width while preserving graphemes', () => {
  assert.equal(fit('中文测试', 3), '中文…');
  assert.equal(fit('👨‍👩‍👧‍👦abc', 3), '👨‍👩‍👧‍👦a…');
  assert.deepEqual(wrap('中文测试', 2), ['中文', '测试']);
  assert.deepEqual(wrap('👨‍👩‍👧‍👦👨‍👩‍👧‍👦', 1), ['👨‍👩‍👧‍👦', '👨‍👩‍👧‍👦']);
  assert.deepEqual(wrap('e\u0301e\u0301', 1), ['e\u0301', 'e\u0301']);
  assert.deepEqual(wrap('中', 1), ['中']);
  assert.equal(removeLastGrapheme('hello👨‍👩‍👧‍👦'), 'hello');
  assert.equal(tail('abc中文', 3), 'c中文');
});

test('Unicode pages and text input preserve graphemes after resizing', async (t) => {
  const { ui, key, output, screen } = terminal(t);
  output.columns = 12; output.rows = 8;
  const page = ui.page('中文👨‍👩‍👧‍👦', '中文测试👨‍👩‍👧‍👦e\u0301\t'.repeat(20));
  const frame = () => cleanText(screen().split('\x1b[2J').at(-1) ?? '');
  const assertBounds = () => {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    assert.ok(frame().split('\n').every((line) => [...segmenter.segment(line)].length < output.columns));
    assert.ok(frame().split('\n').length <= output.rows);
  };
  assertBounds();
  output.columns = 5; output.emit('resize'); key('end');
  assertBounds(); key('return'); await page;
  output.columns = 12;
  const text = ui.text('Path');
  key('x', '中文测试👨‍👩‍👧‍👦');
  assert.match(frame(), /▏/); assertBounds();
  key('backspace'); key('return');
  assert.equal(await text, '中文测试');
});

test('close settles every suspended screen and refuses new screens without repainting', async (t) => {
  const { ui, key, screen } = terminal(t);
  const selection = ui.select('Skills', choices);
  key('?', '?');
  const nested = ui.page('Nested page', 'Details');
  ui.close();
  const closedScreen = screen();
  assert.equal(await selection, undefined);
  assert.equal(await nested, false);
  assert.equal(await ui.text('Closed'), undefined);
  ui.progress('Closed', []);
  assert.equal(screen(), closedScreen);
});

test('signals request shutdown rather than merely backing out of a nested screen', async (t) => {
  const { ui, key } = terminal(t);
  const selection = ui.select('Skills', choices);
  key('?', '?');
  process.emit('SIGTERM', 'SIGTERM');
  assert.equal(ui.shutdownRequested, true);
  assert.equal(await selection, undefined);
  assert.equal(await ui.select('Do not reopen', choices), undefined);
});

test('shutdown during an atomic operation waits for the next cancellable boundary', async (t) => {
  const { ui, raw } = terminal(t);
  let cancelled = false;
  ui.progress('Atomic publication', []);
  process.emit('SIGTERM', 'SIGTERM');
  assert.equal(ui.shutdownRequested, true);
  assert.equal(raw(), true);
  ui.progress('Next safe boundary', [], () => { cancelled = true; });
  assert.equal(cancelled, true);
  ui.close();
  assert.equal(raw(), false);
});

test('late validation after close cannot repaint or finish another screen', async (t) => {
  const { ui, key, screen } = terminal(t);
  let resolveValidation: (() => void) | undefined;
  const text = ui.text('Path', { validate: () => new Promise<void>((resolve) => { resolveValidation = resolve; }) });
  key('x', 'path'); key('return'); ui.close();
  const closedScreen = screen();
  assert.equal(await text, undefined);
  resolveValidation?.(); await setImmediate();
  assert.equal(screen(), closedScreen);
});

test('actual input bytes drive selection without synthetic keypress events', async (t) => {
  const { ui, input } = terminal(t);
  const selection = ui.select('Skills', choices);
  input.write('\x1b[B \r');
  assert.deepEqual(await selection, ['second']);
});

test('screen rendering errors reject their owner and leave the terminal reusable', async (t) => {
  const { ui, key } = terminal(t);
  await assert.rejects(ui.select('Broken', choices, [], true, { summary: () => { throw new Error('Cannot build summary'); } }), /Cannot build summary/);
  const next = ui.select('Next', choices);
  key('space'); key('return');
  assert.deepEqual(await next, ['first']);
});
