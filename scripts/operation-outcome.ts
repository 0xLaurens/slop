import { errorMessage } from './data.ts';
import { Cancelled, RecoveryRequiredError } from './operation-errors.ts';
import { UpdateRunError } from './update-skills.ts';
import type { UpdateResult } from './update-skills.ts';

export interface Outcome {
  status: 'Completed' | 'Cancelled' | 'Partially completed' | 'Failed';
  summary: string;
}

export function updateSummary(result: UpdateResult): string {
  return `${result.updated.length} updated · ${result.unchanged.length} unchanged · ${result.skipped.length} kept/skipped · ${result.failures.length} failed\nGlobal installation is unchanged.\nReview git diff, then use Install / uninstall to install updates globally.\n\n${Object.entries(result).map(([label, names]) => `${label}: ${names.length ? names.join(', ') : 'none'}`).join('\n')}`;
}

export function failureOutcome(error: unknown): Outcome {
  if (error instanceof UpdateRunError) return { status: 'Partially completed',
    summary: `${updateSummary(error.result)}\nNot processed: ${error.remaining.length ? error.remaining.join(', ') : 'none'}\n\n${error.message}` };
  return { status: error instanceof Cancelled ? 'Cancelled' : error instanceof RecoveryRequiredError ? 'Partially completed' : 'Failed', summary: errorMessage(error) };
}
