import { emitKeypressEvents } from 'node:readline';
import type { Key } from 'node:readline';

export const cleanText = (text: string): string => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');

export interface Choice {
  value: string;
  label: string;
  detail?: string;
  group?: string;
  status?: (checked: boolean) => string;
  disabled?: boolean;
}

export interface SelectionState { cursor?: string; query?: string }
export interface SelectOptions {
  intro?: readonly string[];
  empty?: string;
  search?: boolean;
  showDescriptions?: boolean;
  summary?: (selected: ReadonlySet<string>) => string;
  state?: SelectionState;
  continueLabel?: string;
}

export interface TextOptions {
  initial?: string;
  hint?: string;
  validate?: (value: string) => Promise<void> | void;
  complete?: (value: string) => Promise<string[]>;
  state?: { value?: string };
}

function wrap(text: string, width: number): string[] {
  return cleanText(text).split(/\r?\n/).flatMap((line) => {
    if (!line) return [''];
    const result: string[] = [];
    let rest = [...line];
    while (rest.length > width) {
      const segment = rest.slice(0, width).join('');
      const space = segment.lastIndexOf(' ');
      const length = space > width / 2 ? space : width;
      result.push(rest.slice(0, length).join(''));
      rest = rest.slice(length);
      if (rest[0] === ' ') rest.shift();
    }
    result.push(rest.join(''));
    return result;
  });
}

function fit(text: string, width: number): string {
  const characters = [...cleanText(text)];
  return characters.length > width ? `${characters.slice(0, Math.max(0, width - 1)).join('')}…` : characters.join('');
}

export class Terminal {
  private readonly input: NodeJS.ReadStream;
  private readonly output: NodeJS.WriteStream;
  private handler: ((text: string, key: Key) => void) | undefined;
  private repaint: (() => void) | undefined;
  private busyCancel: (() => void) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private frame = 0;
  private closed = false;
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
    if (this.closed) return;
    this.closed = true;
    this.stopProgress();
    this.input.off('keypress', this.onKey);
    this.output.off('resize', this.onResize);
    process.off('SIGTERM', this.onSignal);
    process.off('SIGINT', this.onSignal);
    this.input.setRawMode(false);
    this.input.pause();
    this.output.write('\x1b[?25h\x1b[?1049l');
  }

  private width(): number { return Math.max(1, (this.output.columns || 80) - 1); }

  private layout(title: string, footer: string, details: readonly string[] = [], intro: readonly string[] = []) {
    const rows = Math.max(4, this.output.rows || 24);
    const width = this.width();
    const head = ['SLOP · Skills & agents', ...wrap(title, width), ...intro.flatMap((line) => wrap(line, width)), ''];
    const hints = wrap(footer, width);
    const tail = ['', ...details.flatMap((line) => wrap(line, width)).slice(0, 3), ...hints];
    // Keep the title and controls usable even in a small terminal.
    while (head.length + tail.length >= rows && head.length > 2) head.pop();
    while (head.length + tail.length >= rows && tail.length > 1) tail.shift();
    return { head, tail, capacity: Math.max(1, rows - head.length - tail.length) };
  }

  private draw(title: string, lines: readonly string[], footer: string, details: readonly string[] = [], intro: readonly string[] = []): void {
    const { head, tail, capacity } = this.layout(title, footer, details, intro);
    const body = lines.slice(0, capacity);
    const rows = [...head, ...body, ...Array<string>(Math.max(0, capacity - body.length)).fill(''), ...tail];
    const width = this.width();
    const color = !('NO_COLOR' in process.env) && Boolean(process.env.TERM) && process.env.TERM !== 'dumb';
    this.output.write(`\x1b[H\x1b[2J${rows.map((line, index) => {
      const text = fit(line, width);
      if (!color) return text;
      const style = text.includes('Permanent deletion') || text.startsWith('Deletes repository') ? '1;31'
        : text.startsWith('›') ? '1;36' : text.startsWith('──') || index === 0 ? '36' : index >= rows.length - tail.length ? '2' : '';
      return style ? `\x1b[${style}m${text}\x1b[0m` : text;
    }).join('\r\n')}`);
  }

  private stopProgress(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.busyCancel = undefined;
  }

  async select(title: string, choices: readonly Choice[], initial: readonly string[] = [], multiple = true,
    options: SelectOptions = {}): Promise<string[] | undefined> {
    this.stopProgress();
    let query = options.state?.query ?? '';
    let searching = false;
    let cursor = Math.max(0, choices.findIndex((choice) => choice.value === options.state?.cursor));
    const selected = new Set(initial.filter((value) => !choices.some((choice) => choice.value === value && choice.disabled)));
    const searchable = options.search ?? multiple;
    const matches = () => choices.filter((choice) => `${choice.label} ${choice.value}`.toLowerCase().includes(query.toLowerCase()));
    let visible = matches();
    cursor = Math.max(0, visible.findIndex((choice) => choice.value === choices[cursor]?.value));
    let step = 1;
    return new Promise((resolve) => {
      const finish = (result: string[] | undefined) => {
        if (options.state) { options.state.cursor = visible[cursor]?.value; options.state.query = query; }
        this.handler = undefined; this.repaint = undefined; resolve(result);
      };
      const render = () => {
        visible = matches();
        cursor = Math.max(0, Math.min(cursor, visible.length - 1));
        const current = visible[cursor];
        const hidden = [...selected].filter((value) => !visible.some((choice) => choice.value === value)).length;
        const summary = options.summary?.(selected) ?? (multiple ? `${selected.size} selected${hidden ? ` · ${hidden} outside filter` : ''}` : '');
        const intro = [...options.intro ?? [], ...searchable ? [`${searching ? 'Search >' : 'Filter:'} ${query || (searching ? '▏' : 'all')}`] : [], ...summary ? [summary] : []];
        if (options.summary && hidden) intro.push(`${hidden} selected outside filter`);
        const footer = searching ? 'Type to filter · Enter done · Esc clear filter'
          : `↑↓ move${multiple ? ` · Space toggle · a select ${query ? 'matches' : 'all'} · n clear ${query ? 'matches' : 'selection'}` : ''}${searchable ? ' · / search' : ''} · Enter ${options.continueLabel ?? (multiple ? 'review' : 'choose')} · Esc back${current?.detail ? ' · d details' : ''} · ? help`;
        const details = options.showDescriptions || (this.output.rows || 24) < 18 ? [] : current?.detail ? current.detail.split('\n').slice(0, 2).map((line) => fit(line, this.width())) : [];
        const capacity = this.layout(title, footer, [...details, ''], intro).capacity;
        const lines: string[] = [];
        const positions: number[] = [];
        let group: string | undefined;
        visible.forEach((choice, index) => {
          if (choice.group && choice.group !== group) { lines.push(`── ${choice.group} ──`); group = choice.group; }
          positions.push(lines.length);
          const checked = selected.has(choice.value);
          lines.push(`${index === cursor ? '›' : ' '} ${multiple ? `[${choice.disabled ? '-' : checked ? 'x' : ' '}] ` : ''}${choice.label}${choice.status ? ` · ${choice.status(checked)}` : ''}`);
          if (options.showDescriptions && choice.detail) lines.push(...wrap(`    ${choice.detail}`, this.width()));
        });
        let start = Math.max(0, (positions[cursor] ?? 0) - capacity + 2);
        if (start && lines[start]?.startsWith('──')) start = Math.max(0, start - 1);
        const body = lines.length ? lines.slice(start, start + capacity) : wrap(query ? `No matches for “${query}”. Press / to change the filter.` : options.empty ?? 'No skills or agents available.', this.width());
        const visiblePositions = positions.map((position, index) => position >= start && position < start + capacity ? index + 1 : 0).filter(Boolean);
        const position = visible.length ? `Showing ${visiblePositions[0] ?? cursor + 1}–${visiblePositions.at(-1) ?? cursor + 1} of ${visible.length}${query ? ` matches (${choices.length} total)` : ''}` : '';
        step = Math.max(1, Math.floor(capacity / (options.showDescriptions ? 3 : 1)));
        this.draw(title, body, footer, [...details, fit(position, this.width())], intro);
      };
      this.repaint = render;
      this.handler = (text, key) => {
        if (key.ctrl && key.name === 'c') return finish(undefined);
        if (searching) {
          if (key.name === 'escape') { query = ''; searching = false; }
          else if (key.name === 'return') searching = false;
          else if (key.name === 'backspace') query = [...query].slice(0, -1).join('');
          else if (text && !key.ctrl && !key.meta) query += cleanText(text).replace(/[\r\n]/g, '');
          cursor = 0; render(); return;
        }
        if (key.name === 'escape') return finish(undefined);
        if (searchable && (text === '/' || key.name === '/')) { searching = true; render(); return; }
        if (key.name === 'up') cursor--;
        if (key.name === 'down') cursor++;
        if (key.name === 'pageup') cursor -= step;
        if (key.name === 'pagedown') cursor += step;
        if (key.name === 'home') cursor = 0;
        if (key.name === 'end') cursor = visible.length - 1;
        if (multiple && key.name === 'space') {
          const value = visible[cursor]?.value;
          if (value && !visible[cursor]?.disabled) { if (selected.has(value)) selected.delete(value); else selected.add(value); }
        }
        if (multiple && key.name === 'a') for (const choice of visible) if (!choice.disabled) selected.add(choice.value);
        if (multiple && key.name === 'n') for (const choice of visible) selected.delete(choice.value);
        const current = visible[cursor];
        if ((key.name === 'd' && current?.detail) || text === '?') {
          const resume = this.handler;
          const help = ['Arrow keys: move between choices', 'Page Up / Page Down: move by a page', 'Home / End: first / last choice',
            ...multiple ? ['Space: toggle the highlighted checkbox', 'a: select all visible matches', 'n: clear all visible matches', 'Selections outside a search filter are retained.'] : [],
            ...searchable ? ['/: edit the search filter', 'Enter while searching: finish editing', 'Esc while searching: clear the filter'] : [],
            'd: inspect the highlighted description, source, and warnings', 'Enter: continue', 'Esc: go back without applying changes'];
          void this.page(text === '?' ? 'Keyboard help' : current?.label ?? 'Details', text === '?' ? help.join('\n') : current?.detail ?? '').then(() => {
            if (this.closed) return;
            this.handler = resume; this.repaint = render; render();
          });
          return;
        }
        if (key.name === 'return') return finish(multiple ? [...selected] : current ? [current.value] : []);
        render();
      };
      render();
    });
  }

  async text(title: string, options: TextOptions = {}): Promise<string | undefined> {
    this.stopProgress();
    let value = options.state?.value ?? options.initial ?? '';
    let warning = '';
    let pending = false;
    let revision = 0;
    return new Promise((resolve) => {
      let active = true;
      const finish = (result: string | undefined) => {
        if (options.state) options.state.value = value;
        active = false; this.handler = undefined; this.repaint = undefined; resolve(result);
      };
      const render = () => this.draw(title, [`> ${[...value].slice(-Math.max(1, this.width() - 3)).join('')}▏`, '', ...wrap(warning, this.width())],
        `Type or paste · Backspace delete${options.complete ? ' · Tab complete path' : ''} · Enter continue · Esc back`, [], options.hint ? [options.hint] : []);
      this.repaint = render;
      this.handler = (text, key) => {
        if (key.name === 'escape' || (key.ctrl && key.name === 'c')) return finish(undefined);
        if (pending) return;
        if (key.name === 'return' || (key.name === 'tab' && options.complete)) {
          pending = true;
          const before = revision;
          const task = key.name === 'tab' ? async () => {
            const matches = await options.complete?.(value) ?? [];
            if (!active || revision !== before) return;
            if (matches.length === 1) value = matches[0] ?? value;
            else if (matches.length > 1) {
              let common = matches[0] ?? '';
              while (common && !matches.every((match) => match.startsWith(common))) common = common.slice(0, -1);
              if (common.length > value.length) value = common;
            }
            warning = matches.length > 1 ? `Matches: ${matches.join(' · ')}` : matches.length ? '' : 'No matching paths.';
          } : async () => { await options.validate?.(value.trim()); if (active && revision === before) finish(value.trim()); };
          void task().catch((error: unknown) => { if (active) warning = error instanceof Error ? error.message : String(error); })
            .finally(() => { pending = false; if (active) render(); });
          return;
        }
        warning = ''; revision++;
        if (key.name === 'backspace') value = [...value].slice(0, -1).join('');
        else if (key.ctrl && key.name === 'u') value = '';
        else if (text && !key.ctrl && !key.meta) value += cleanText(text).replace(/[\r\n]/g, '');
        render();
      };
      render();
    });
  }

  async page(title: string, contents: string): Promise<boolean> {
    this.stopProgress();
    let offset = 0;
    return new Promise((resolve) => {
      const footer = '↑↓ / PgUp PgDn scroll · Home/End · Enter / Esc return';
      const lines = () => wrap(contents, this.width());
      const capacity = () => this.layout(title, footer).capacity;
      const render = () => {
        offset = Math.max(0, Math.min(offset, Math.max(0, lines().length - capacity())));
        this.draw(title, lines().slice(offset), footer);
      };
      this.repaint = render;
      this.handler = (_text, key) => {
        if (['return', 'escape'].includes(key.name ?? '') || (key.ctrl && key.name === 'c')) {
          this.handler = undefined; this.repaint = undefined; resolve(key.name === 'return'); return;
        }
        if (key.name === 'up') offset--;
        if (key.name === 'down') offset++;
        if (key.name === 'pageup') offset -= capacity();
        if (key.name === 'pagedown') offset += capacity();
        if (key.name === 'home') offset = 0;
        if (key.name === 'end') offset = lines().length;
        render();
      };
      render();
    });
  }

  async confirm(title: string, changes: readonly string[], applyLabel = 'Apply changes'): Promise<boolean> {
    this.stopProgress();
    let offset = 0;
    let apply = false;
    return new Promise((resolve) => {
      const finish = (answer: boolean) => { this.handler = undefined; this.repaint = undefined; resolve(answer); };
      const details = () => [`${apply ? '  Back to selection    ›' : '› Back to selection     '} ${applyLabel}`];
      const footer = '↑↓ / PgUp PgDn scroll · ←→ / Tab choose action · Enter confirm · Esc back';
      const lines = () => changes.flatMap((line) => wrap(line, this.width()));
      const capacity = () => this.layout(title, footer, details()).capacity;
      const render = () => {
        offset = Math.max(0, Math.min(offset, Math.max(0, lines().length - capacity())));
        this.draw(title, lines().slice(offset), footer, details());
      };
      this.repaint = render;
      this.handler = (_text, key) => {
        if (key.name === 'escape' || (key.ctrl && key.name === 'c')) return finish(false);
        if (key.name === 'return') return finish(apply);
        if (key.name === 'right') apply = true;
        if (key.name === 'left') apply = false;
        if (key.name === 'tab') apply = !apply;
        if (key.name === 'up') offset--;
        if (key.name === 'down') offset++;
        if (key.name === 'pageup') offset -= capacity();
        if (key.name === 'pagedown') offset += capacity();
        if (key.name === 'home') offset = 0;
        if (key.name === 'end') offset = lines().length;
        render();
      };
      render();
    });
  }

  progress(title: string, lines: readonly string[], cancel?: () => void): void {
    this.busyCancel = cancel;
    this.repaint = () => {
      const footer = cancel ? 'Esc / Ctrl+C requests cancellation at a safe boundary' : 'Finishing changes safely — cancellation is unavailable during this step';
      const heading = `${['⠋', '⠙', '⠹', '⠸'][this.frame % 4]} ${title}`;
      const capacity = this.layout(heading, footer).capacity;
      this.draw(heading, lines.length ? lines.slice(-capacity) : ['Preparing…'], footer);
    };
    if (!this.timer) this.timer = setInterval(() => { this.frame++; if (!this.handler) this.repaint?.(); }, 100);
    this.timer.unref();
    this.repaint();
  }
}
