import type { Key } from 'node:readline';

interface Screen {
  render: () => void;
  key: (text: string, key: Key) => void;
  cancel: () => void;
  fail: (error: unknown) => void;
}

type ActiveScreen =
  | { kind: 'idle' | 'closed' }
  | { kind: 'interactive'; stack: Screen[] }
  | { kind: 'progress'; render: () => void; cancel?: () => void; timer: ReturnType<typeof setInterval> };

// Owns completion, nested pages, animation, and shutdown independently of widgets.
export class ScreenHost {
  private active: ActiveScreen = { kind: 'idle' };
  private shuttingDown = false;

  get shutdownRequested(): boolean { return this.shuttingDown; }

  key(text: string, key: Key): void {
    if (this.active.kind === 'interactive') {
      const screen = this.active.stack.at(-1);
      try { screen?.key(text, key); }
      catch (error) { screen?.fail(error); }
    }
    else if (this.active.kind === 'progress' && (key.name === 'escape' || (key.ctrl && key.name === 'c'))) this.active.cancel?.();
  }

  render(): void {
    if (this.active.kind === 'interactive') {
      const screen = this.active.stack.at(-1);
      try { screen?.render(); }
      catch (error) { screen?.fail(error); }
    }
    else if (this.active.kind === 'progress') this.active.render();
  }

  fail(error: unknown): void {
    if (this.active.kind === 'interactive') this.active.stack.at(-1)?.fail(error);
  }

  open<T>(cancelled: T, create: (finish: (result: T) => void, active: () => boolean) => Omit<Screen, 'cancel' | 'fail'>): Promise<T> {
    if (this.active.kind === 'closed' || this.shuttingDown) return Promise.resolve(cancelled);
    if (this.active.kind === 'progress') clearInterval(this.active.timer);
    const stack = this.active.kind === 'interactive' ? this.active.stack : [];
    this.active = { kind: 'interactive', stack };
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const finish = (result: T) => {
        if (finished) return;
        finished = true;
        const index = stack.indexOf(screen);
        if (index !== -1) stack.splice(index, 1);
        resolve(result);
        if (this.active.kind !== 'closed' && !this.shuttingDown) {
          if (!stack.length) this.active = { kind: 'idle' };
          this.render();
        }
      };
      const fail = (error: unknown) => { reject(error); finish(cancelled); };
      const screen: Screen = { ...create(finish, () => !finished && stack.at(-1) === screen && this.active.kind !== 'closed'), cancel: () => finish(cancelled), fail };
      stack.push(screen);
      try { screen.render(); }
      catch (error) { fail(error); }
    });
  }

  progress(render: () => void, cancel?: () => void): void {
    if (this.active.kind === 'closed') return;
    if (this.active.kind === 'interactive') throw new Error('Cannot replace an unfinished interactive screen with progress.');
    if (this.active.kind === 'progress') clearInterval(this.active.timer);
    const timer = setInterval(render, 100);
    timer.unref();
    this.active = { kind: 'progress', render, cancel, timer };
    render();
    if (this.shuttingDown) cancel?.();
  }

  requestShutdown(): void {
    this.shuttingDown = true;
    if (this.active.kind === 'interactive') {
      for (const screen of [...this.active.stack].reverse()) screen.cancel();
      this.active = { kind: 'idle' };
    } else if (this.active.kind === 'progress') this.active.cancel?.();
  }

  close(): void {
    const previous = this.active;
    this.active = { kind: 'closed' };
    if (previous.kind === 'progress') clearInterval(previous.timer);
    else if (previous.kind === 'interactive') for (const screen of [...previous.stack].reverse()) screen.cancel();
  }
}
