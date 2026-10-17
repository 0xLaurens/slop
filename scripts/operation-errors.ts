export class Cancelled extends Error {}

export type Recovery =
  | { kind: 'skill'; transaction: string }
  | { kind: 'deployment'; transaction: string }
  | { kind: 'deletion'; branch: string; uninstalled: boolean; committed: boolean; pushed: boolean };

export class RecoveryRequiredError extends AggregateError {
  readonly recovery: Recovery;

  constructor(message: string, recovery: Recovery, errors: unknown[]) {
    super(errors, message);
    this.recovery = recovery;
  }
}
