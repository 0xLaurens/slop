import { emitKeypressEvents } from 'node:readline';
import type { Key } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { ScreenHost } from './terminal-screen.ts';
import { cleanText, displayWidth, fit, graphemeSlice, removeLastGrapheme, tail, visibleStart, wrap } from './terminal-text.ts';

export { cleanText } from './terminal-text.ts';

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

export interface ReviewContent {
  summary: string;
  context: readonly string[];
  sections: readonly { title: string; items: readonly string[] }[];
}

interface ReviewRow { text: string; style?: 'muted' | 'heading' | 'focused' }

type TerminalInput = Readable & { isTTY?: boolean; isRaw?: boolean; setRawMode: (enabled: boolean) => unknown };
type TerminalOutput = Writable & { isTTY?: boolean; columns?: number; rows?: number };

export class Terminal {
  private readonly input: TerminalInput;
  private readonly output: TerminalOutput;
  private readonly screens = new ScreenHost();
  private readonly wasRaw: boolean;
  private frame = 0;
  private closed = false;
  private readonly onKey = (text: string, key: Key) => {
    this.screens.key(text, key);
  };
  private readonly onResize = () => this.screens.render();
  private readonly onSignal = () => this.screens.requestShutdown();

  get shutdownRequested(): boolean { return this.screens.shutdownRequested; }

  constructor(input: TerminalInput = process.stdin, output: TerminalOutput = process.stdout) {
    this.input = input;
    this.output = output;
    this.wasRaw = input.isRaw ?? false;
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
    this.screens.close();
    this.input.off('keypress', this.onKey);
    this.output.off('resize', this.onResize);
    process.off('SIGTERM', this.onSignal);
    process.off('SIGINT', this.onSignal);
    this.input.setRawMode(this.wasRaw);
    this.input.pause();
    this.output.write('\x1b[?25h\x1b[?1049l');
  }

  private width(): number { return Math.max(1, (this.output.columns || 80) - 1); }

  private layout(title: string, footer: string, details: readonly string[] = [], intro: readonly string[] = [], indent = '') {
    const rows = Math.max(1, this.output.rows || 24);
    const width = this.width();
    const introLines = intro.flatMap((line) => wrap(`${indent}${line}`, width));
    const head = [`${indent}SLOP · Skills & agents`, ...wrap(`${indent}${title}`, width), ...introLines, ''];
    const hints = wrap(footer, width);
    const tail = ['', ...details.flatMap((line) => wrap(line, width)).slice(0, 3), ...hints];
    while (head.length + tail.length >= rows && head.length > 2) head.pop();
    while (head.length + tail.length >= rows && tail.length > 1) tail.shift();
    while (head.length + tail.length >= rows && head.length) head.pop();
    while (head.length + tail.length >= rows && tail.length) tail.shift();
    return { head, tail, capacity: Math.max(1, rows - head.length - tail.length) };
  }

  private draw(title: string, lines: readonly string[], footer: string, details: readonly string[] = [], intro: readonly string[] = [], inlineRows: ReadonlyMap<string, { start: number; length: number; selected: boolean }> = new Map(), indent = '', compact = false): void {
    const { head, tail, capacity } = this.layout(title, footer, details, intro, indent);
    const body = lines.slice(0, capacity);
    const rows = [...head, ...body, ...Array<string>(compact ? 0 : Math.max(0, capacity - body.length)).fill(''), ...tail];
    const width = this.width();
    const color = !('NO_COLOR' in process.env) && Boolean(process.env.TERM) && process.env.TERM !== 'dumb';
    this.output.write(`\x1b[H\x1b[2J${rows.map((line, index) => {
      const text = fit(line, width);
      if (!color) return text;
      const titleStart = 1;
      const titleEnd = titleStart + wrap(`${indent}${title}`, width).length;
      const style = index >= rows.length - tail.length || index === 0 ? '2'
        : index >= titleStart && index < titleEnd ? '1' : '';
      const inline = inlineRows.get(line);
      if (inline !== undefined) {
        const prefix = fit(line, width);
        const start = Math.min(displayWidth(prefix), inline.start);
        const end = Math.min(displayWidth(prefix), start + inline.length);
        const labelStyle = '1';
        return `${graphemeSlice(prefix, 0, start)}\x1b[${labelStyle}m${graphemeSlice(prefix, start, end)}\x1b[0m\x1b[2m${graphemeSlice(prefix, end)}\x1b[0m`;
      }
      return style ? `\x1b[${style}m${text}\x1b[0m` : text;
    }).join('\r\n')}`);
  }

  private drawReview(rows: readonly ReviewRow[]): void {
    const width = this.width();
    const color = !('NO_COLOR' in process.env) && Boolean(process.env.TERM) && process.env.TERM !== 'dumb';
    const styles = { muted: '2', heading: '1', focused: '1;7' };
    const bounded = rows.slice(0, Math.max(1, this.output.rows || 24)).map(({ text, style }) => {
      const line = fit(text, width);
      return color && style && line.trim() ? `\x1b[${styles[style]}m${line}\x1b[0m` : line;
    });
    this.output.write(`\x1b[H\x1b[2J${bounded.join('\r\n')}`);
  }

  async select(title: string, choices: readonly Choice[], initial: readonly string[] = [], multiple = true,
    options: SelectOptions = {}): Promise<string[] | undefined> {
    let query = options.state?.query ?? '';
    let searching = false;
    let cursor = Math.max(0, choices.findIndex((choice) => choice.value === options.state?.cursor));
    const selected = new Set(initial.filter((value) => !choices.some((choice) => choice.value === value && choice.disabled)));
    const searchable = options.search ?? multiple;
    const matches = () => choices.filter((choice) => `${choice.label} ${choice.value}`.toLowerCase().includes(query.toLowerCase()));
    let visible = matches();
    cursor = Math.max(0, visible.findIndex((choice) => choice.value === choices[cursor]?.value));
    let step = 1;
    let start = 0;
    return this.screens.open<string[] | undefined>(undefined, (complete) => {
      const finish = (result: string[] | undefined) => {
        if (options.state) { options.state.cursor = visible[cursor]?.value; options.state.query = query; }
        complete(result);
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
        const indent = multiple ? '      ' : '  ';
        const capacity = this.layout(title, footer, [...details, ''], intro, indent).capacity;
        const lines: string[] = [];
        const inlineRows = new Map<string, { start: number; length: number; selected: boolean }>();
        const positions: number[] = [];
        let group: string | undefined;
        visible.forEach((choice, index) => {
          if (choice.group && choice.group !== group) {
            if (group !== undefined) lines.push('');
            lines.push(`${multiple ? '      ' : '  '}${choice.group}`);
            group = choice.group;
          }
          positions.push(lines.length);
          const checked = selected.has(choice.value);
          const row = `${index === cursor ? '›' : ' '} ${multiple ? `[${choice.disabled ? '-' : checked ? 'x' : ' '}] ` : ''}${choice.label}${choice.status ? ` · ${choice.status(checked)}` : ''}`;
          if (options.showDescriptions) {
            const width = this.width();
            const prefix = fit(row, width);
            const separator = ' | ';
            const room = width - displayWidth(prefix) - displayWidth(separator);
            const description = choice.detail && room > 0 ? fit(choice.detail.replace(/\s+/g, ' '), room) : '';
            const inline = description ? `${prefix}${separator}${description}` : prefix;
            lines.push(inline);
            const labelStart = 2 + displayWidth(multiple ? `[${choice.disabled ? '-' : checked ? 'x' : ' '}] ` : '');
            inlineRows.set(inline, { start: labelStart, length: displayWidth(choice.label), selected: index === cursor });
          } else lines.push(row);
        });
        start = visibleStart({ position: positions[cursor] ?? 0, capacity, previous: start });
        const body = lines.length ? lines.slice(start, start + capacity) : wrap(query ? `No matches for “${query}”. Press / to change the filter.` : options.empty ?? 'No skills or agents available.', this.width());
        const visiblePositions = positions.map((position, index) => position >= start && position < start + capacity ? index + 1 : 0).filter(Boolean);
        const position = visible.length ? `Showing ${visiblePositions[0] ?? cursor + 1}–${visiblePositions.at(-1) ?? cursor + 1} of ${visible.length}${query ? ` matches (${choices.length} total)` : ''}` : '';
        step = Math.max(1, Math.floor(capacity));
         this.draw(title, body, footer, [...details, fit(position, this.width())], intro, inlineRows, indent);
      };
      const handle = (text: string, key: Key) => {
        if (key.ctrl && key.name === 'c') return finish(undefined);
        if (searching) {
          if (key.name === 'escape') { query = ''; searching = false; }
          else if (key.name === 'return') searching = false;
          else if (key.name === 'backspace') query = removeLastGrapheme(query);
          else if (text && !key.ctrl && !key.meta) query += cleanText(text).replace(/[\r\n]/g, '');
          cursor = 0; render(); return;
        }
        if (key.name === 'escape') return finish(undefined);
        if (searchable && (text === '/' || key.name === '/')) { searching = true; render(); return; }
        if (key.name === 'up') cursor = cursor > 0 ? cursor - 1 : visible.length - 1;
        if (key.name === 'down') cursor = cursor < visible.length - 1 ? cursor + 1 : 0;
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
          const help = ['Arrow keys: move between choices', 'Page Up / Page Down: move by a page', 'Home / End: first / last choice',
            ...multiple ? ['Space: toggle the highlighted checkbox', 'a: select all visible matches', 'n: clear all visible matches', 'Selections outside a search filter are retained.'] : [],
            ...searchable ? ['/: edit the search filter', 'Enter while searching: finish editing', 'Esc while searching: clear the filter'] : [],
            'd: inspect the highlighted description, source, and warnings', 'Enter: continue', 'Esc: go back without applying changes'];
          void this.page(text === '?' ? 'Keyboard help' : current?.label ?? 'Details', text === '?' ? help.join('\n') : current?.detail ?? '')
            .catch((error: unknown) => this.screens.fail(error));
          return;
        }
        if (key.name === 'return') return finish(multiple ? [...selected] : current ? [current.value] : []);
        render();
      };
      return { render, key: handle };
    });
  }

  async text(title: string, options: TextOptions = {}): Promise<string | undefined> {
    let value = options.state?.value ?? options.initial ?? '';
    let warning = '';
    let pending = false;
    return this.screens.open<string | undefined>(undefined, (complete, active) => {
      const finish = (result: string | undefined) => {
        if (options.state) options.state.value = value;
        complete(result);
      };
      const render = () => this.draw(title, [`> ${tail(value, Math.max(0, this.width() - 3))}▏`, '', ...wrap(warning, this.width())],
        `Type or paste · Backspace delete${options.complete ? ' · Tab complete path' : ''} · Enter continue · Esc back`, [], options.hint ? [options.hint] : []);
      const handle = (text: string, key: Key) => {
        if (key.name === 'escape' || (key.ctrl && key.name === 'c')) return finish(undefined);
        if (pending) return;
        if (key.name === 'return' || (key.name === 'tab' && options.complete)) {
          pending = true;
          const task = key.name === 'tab' ? async () => {
            const matches = await options.complete?.(value) ?? [];
            if (!active()) return;
            if (matches.length === 1) value = matches[0] ?? value;
            else if (matches.length > 1) {
              let common = matches[0] ?? '';
              while (common && !matches.every((match) => match.startsWith(common))) common = removeLastGrapheme(common);
              if (common.length > value.length) value = common;
            }
            warning = matches.length > 1 ? `Matches: ${matches.join(' · ')}` : matches.length ? '' : 'No matching paths.';
          } : async () => { await options.validate?.(value.trim()); if (active()) finish(value.trim()); };
          void task().catch((error: unknown) => { if (active()) warning = error instanceof Error ? error.message : String(error); })
            .finally(() => { pending = false; if (active()) render(); });
          return;
        }
        warning = '';
        if (key.name === 'backspace') value = removeLastGrapheme(value);
        else if (key.ctrl && key.name === 'u') value = '';
        else if (text && !key.ctrl && !key.meta) value += cleanText(text).replace(/[\r\n]/g, '');
        render();
      };
      return { render, key: handle };
    });
  }

  async page(title: string, contents: string): Promise<boolean> {
    let offset = 0;
    return this.screens.open(false, (finish) => {
      const footer = '↑↓ / PgUp PgDn scroll · Home/End · Enter / Esc return';
      const lines = () => wrap(contents, this.width());
      const capacity = () => this.layout(title, footer).capacity;
      const render = () => {
        offset = Math.max(0, Math.min(offset, Math.max(0, lines().length - capacity())));
        this.draw(title, lines().slice(offset), footer);
      };
      const handle = (_text: string, key: Key) => {
        if (['return', 'escape'].includes(key.name ?? '') || (key.ctrl && key.name === 'c')) {
          finish(key.name === 'return'); return;
        }
        if (key.name === 'up') offset--;
        if (key.name === 'down') offset++;
        if (key.name === 'pageup') offset -= capacity();
        if (key.name === 'pagedown') offset += capacity();
        if (key.name === 'home') offset = 0;
        if (key.name === 'end') offset = lines().length;
        render();
      };
      return { render, key: handle };
    });
  }

  async confirm(title: string, changes: readonly string[] | ReviewContent, applyLabel = 'Apply changes'): Promise<boolean> {
    let offset = 0;
    let apply = false;
    return this.screens.open(false, (finish) => {
      const action = (label: string, focused: boolean) => {
        const width = Math.max(1, this.width() - 2);
        const lines: string[] = [];
        let line = '';
        for (const word of cleanText(label).split(/\s+/)) {
          if (line && displayWidth(`${line} ${word}`) > width) { lines.push(line); line = ''; }
          line = line ? `${line} ${word}` : word;
        }
        if (line) lines.push(line);
        return lines.flatMap((text) => wrap(text, width)).map((text, index): ReviewRow => ({
          text: `${index === 0 && focused ? '› ' : '  '}${text}`,
          style: focused ? 'focused' : undefined,
        }));
      };
      const actions = () => [...action('Back to selection', !apply), ...action(applyLabel, apply)];
      const structured = !Array.isArray(changes) ? changes as ReviewContent : undefined;
      const row = (text: string, style?: ReviewRow['style']): ReviewRow => ({ text, style });
      const lines = () => {
        if (structured) return [
          ...structured.context.flatMap((line) => wrap(line, this.width()).map((text) => row(text, 'muted'))),
          row(''),
          ...structured.sections.flatMap((section, index) => [
            ...index ? [row('')] : [],
            ...wrap(section.title, this.width()).map((text) => row(text, 'heading')),
            ...section.items.flatMap((item) => wrap(item, Math.max(1, this.width() - 2)).map((text) => row(`  ${text}`))),
          ]),
        ];
        const content = [...changes as readonly string[]];
        while (content.at(-1)?.trim() === '') content.pop();
        return content.flatMap((line) => wrap(line, this.width()).map((text) => row(text)));
      };
      const enterHint = () => this.output.rows && this.output.rows <= 10
        ? `Enter → ${apply ? 'Apply' : 'Back'}`
        : `Enter: ${apply ? applyLabel : 'Back to selection'}`;
      const layout = () => {
        const rows = Math.max(1, this.output.rows || 24);
        const content = lines();
        const buttons = actions();
        const enter = wrap(enterHint(), this.width()).map((text) => row(text, 'muted'));
        const compact = rows <= 10;
        const head = [row('SLOP · Skills & agents', 'muted'), ...wrap(title, this.width()).map((text) => row(text, 'heading')), row(''),
          ...structured ? [...wrap(structured.summary, this.width()).map((text) => row(text, 'heading')), row('')] : []];
        const hintsFor = (scrollable: boolean) => (compact ? ['↑↓ choose', 'Pg↑↓ Home/End Esc']
          : wrap(`↑↓ choose · ${scrollable ? 'PgUp/PgDn Home/End scroll · ' : ''}Esc cancel`, this.width()))
          .map((text) => row(text, 'muted'));
        // Spend space on separation only when a change row can remain visible.
        const room = rows - head.length - buttons.length - enter.length - hintsFor(false).length;
        const spacing = !compact && room >= 3 ? [row('')] : [];
        const scrollable = content.length > room - spacing.length * 2;
        const hints = hintsFor(scrollable);
        const tail = [...spacing, ...buttons, ...spacing, ...enter, ...hints];
        while (head.length + tail.length + 1 > rows && head.length) head.pop();
        return { head, tail, content, capacity: Math.max(0, rows - head.length - tail.length) };
      };
      const capacity = () => layout().capacity;
      const render = () => {
        const { head, tail, content, capacity } = layout();
        offset = Math.max(0, Math.min(offset, Math.max(0, content.length - capacity)));
        const visible = content.slice(offset, offset + capacity);
        this.drawReview([...head, ...visible, ...tail]);
      };
      const handle = (_text: string, key: Key) => {
        if (key.name === 'escape' || (key.ctrl && key.name === 'c')) return finish(false);
        if (key.name === 'return') return finish(apply);
        if (key.name === 'right') apply = true;
        if (key.name === 'left') apply = false;
        if (key.name === 'tab') apply = !apply;
        if (key.name === 'up' || key.name === 'down') apply = !apply;
        if (key.name === 'pageup') offset -= capacity();
        if (key.name === 'pagedown') offset += capacity();
        if (key.name === 'home') offset = 0;
        if (key.name === 'end') offset = Math.max(0, lines().length - capacity());
        render();
      };
      return { render, key: handle };
    });
  }

  progress(title: string, lines: readonly string[], cancel?: () => void): void {
    this.screens.progress(() => {
      this.frame++;
      const footer = cancel ? 'Esc / Ctrl+C requests cancellation at a safe boundary' : 'Finishing changes safely — cancellation is unavailable during this step';
      const heading = `${['⠋', '⠙', '⠹', '⠸'][this.frame % 4]} ${title}`;
      const capacity = this.layout(heading, footer).capacity;
      this.draw(heading, lines.length ? lines.slice(-capacity) : ['Preparing…'], footer);
    }, cancel);
  }
}
