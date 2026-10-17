import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { Terminal } from '../scripts/terminal.ts';

function terminal(t: TestContext) {
  let raw = false;
  let screen = '';
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: (value: boolean) => { raw = value; } });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
  output.on('data', (chunk: Buffer) => { screen += chunk.toString(); });
  const ui = new Terminal(input as unknown as NodeJS.ReadStream, output as unknown as NodeJS.WriteStream);
  t.after(() => ui.close());
  const key = (name: string, text = '', ctrl = false) => input.emit('keypress', text, { name, ctrl, meta: false, shift: false });
  return { ui, key, input, output, raw: () => raw, screen: () => screen };
}

const choices = [{ value: 'first', label: 'First' }, { value: 'second', label: 'Second' }];

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
  await setImmediate();
  key('return');
  assert.equal(await defaultCancel, false);
  const apply = ui.confirm('Delete?', ['DELETE first']);
  key('return');
  await setImmediate();
  key('down'); key('return');
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
