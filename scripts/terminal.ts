import { emitKeypressEvents } from 'node:readline';
import type { Key } from 'node:readline';

export const cleanText = (text: string): string => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');

export interface Choice { value: string; label: string; detail?: string }

export class Terminal {
  private readonly input: NodeJS.ReadStream;
  private readonly output: NodeJS.WriteStream;
  private handler: ((text: string, key: Key) => void) | undefined;
  private repaint: (() => void) | undefined;
  private busyCancel: (() => void) | undefined;
  private readonly onKey = (text: string, key: Key) => {
    if (!this.handler && (key.name === 'escape' || (key.ctrl && key.name === 'c'))) this.busyCancel?.();
    else this.handler?.(text, key);
  };
  private readonly onResize = () => this.repaint?.();
  private readonly onSignal = () => {
    if (this.handler) this.handler('', { name: 'escape', ctrl: false, meta: false, shift: false });
    else this.busyCancel?.();
  };

  constructor(input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stdout) {
    this.input = input;
    this.output = output;
    if (!input.isTTY || !output.isTTY) throw new Error('The TUI requires an interactive terminal. Use the existing script commands for automation.');
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    input.on('keypress', this.onKey);
    output.on('resize', this.onResize);
    process.on('SIGTERM', this.onSignal);
    process.on('SIGINT', this.onSignal);
    output.write('\x1b[?1049h\x1b[?25l');
  }

  close(): void {
    this.input.off('keypress', this.onKey);
    this.output.off('resize', this.onResize);
    process.off('SIGTERM', this.onSignal);
    process.off('SIGINT', this.onSignal);
    this.input.setRawMode(false);
    this.input.pause();
    this.output.write('\x1b[?25h\x1b[?1049l');
  }

  private height(): number { return Math.max(1, (this.output.rows || 24) - 8); }

  private draw(title: string, lines: string[], footer: string, detail = ''): void {
    const width = Math.max(1, (this.output.columns || 80) - 1);
    const rows = ['SLOP · Agent files', title, '', ...lines, '', detail, footer];
    this.output.write(`\x1b[H\x1b[2J${rows.map((line) => cleanText(line).replace(/\r?\n/g, ' ').slice(0, width)).join('\r\n')}`);
  }

  async select(title: string, choices: readonly Choice[], initial: readonly string[] = [], multiple = true): Promise<string[] | undefined> {
    let cursor = 0;
    const selected = new Set(initial);
    return new Promise((resolve) => {
      const finish = (result: string[] | undefined) => { this.handler = undefined; this.repaint = undefined; resolve(result); };
      const render = () => {
        const start = Math.max(0, cursor - this.height() + 1);
        const lines = choices.slice(start, start + this.height()).map((item, index) =>
          `${start + index === cursor ? '›' : ' '} ${multiple ? `[${selected.has(item.value) ? 'x' : ' '}] ` : ''}${item.label}`);
        if (!lines.length) lines.push('(No items available)');
        this.draw(title, lines, `↑↓ navigate · ${multiple ? 'Space toggle · a all · n none · ' : ''}Enter continue · Esc back`, choices[cursor]?.detail ?? '');
      };
      this.repaint = render;
      this.handler = (_text, key) => {
        if (key.name === 'escape' || (key.ctrl && key.name === 'c')) return finish(undefined);
        if (key.name === 'up') cursor = Math.max(0, cursor - 1);
        if (key.name === 'down') cursor = Math.min(Math.max(0, choices.length - 1), cursor + 1);
        if (multiple && key.name === 'space') {
          const value = choices[cursor]?.value;
          if (value) { if (selected.has(value)) selected.delete(value); else selected.add(value); }
        }
        if (multiple && key.name === 'a') for (const item of choices) selected.add(item.value);
        if (multiple && key.name === 'n') selected.clear();
        const current = choices[cursor];
        if (key.name === 'return') return finish(multiple ? [...selected] : current ? [current.value] : []);
        render();
      };
      render();
    });
  }

  async text(title: string): Promise<string | undefined> {
    let value = '';
    return new Promise((resolve) => {
      const finish = (result: string | undefined) => { this.handler = undefined; this.repaint = undefined; resolve(result); };
      const render = () => this.draw(title, [`> ${value.slice(-Math.max(1, (this.output.columns || 80) - 4))}▏`], 'Type or paste · Backspace delete · Enter continue · Esc back');
      this.repaint = render;
      this.handler = (text, key) => {
        if (key.name === 'escape' || (key.ctrl && key.name === 'c')) return finish(undefined);
        if (key.name === 'return') return finish(value.trim());
        if (key.name === 'backspace') value = [...value].slice(0, -1).join('');
        else if (key.ctrl && key.name === 'u') value = '';
        else if (text && !key.ctrl && !key.meta) value += cleanText(text).replace(/[\r\n]/g, '');
        render();
      };
      render();
    });
  }

  async page(title: string, contents: string): Promise<boolean> {
    const width = Math.max(1, (this.output.columns || 80) - 2);
    const lines = cleanText(contents).split(/\r?\n/).flatMap((line) => {
      const parts: string[] = [];
      for (let i = 0; i < line.length; i += width) parts.push(line.slice(i, i + width));
      return parts.length ? parts : [''];
    });
    let offset = 0;
    return new Promise((resolve) => {
      const render = () => this.draw(title, lines.slice(offset, offset + this.height()), '↑↓ / PgUp PgDn scroll · Enter / Esc return');
      this.repaint = render;
      this.handler = (_text, key) => {
        if (['return', 'escape'].includes(key.name ?? '') || (key.ctrl && key.name === 'c')) {
          this.handler = undefined; this.repaint = undefined; resolve(key.name === 'return'); return;
        }
        if (key.name === 'up') offset--;
        if (key.name === 'down') offset++;
        if (key.name === 'pageup') offset -= this.height();
        if (key.name === 'pagedown') offset += this.height();
        offset = Math.max(0, Math.min(offset, Math.max(0, lines.length - this.height())));
        render();
      };
      render();
    });
  }

  async confirm(title: string, changes: readonly string[]): Promise<boolean> {
    if (!await this.page(title, changes.join('\n'))) return false;
    return (await this.select('Apply the reviewed changes?', [
      { value: 'cancel', label: 'Cancel — make no changes' },
      { value: 'apply', label: 'Apply changes' },
    ], [], false))?.[0] === 'apply';
  }

  progress(title: string, lines: readonly string[], cancel: () => void): void {
    this.busyCancel = cancel;
    this.repaint = () => this.draw(title, lines.slice(-this.height()), 'Esc / Ctrl+C requests cancellation at a safe boundary');
    this.repaint();
  }
}
