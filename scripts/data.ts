// Parsed JSON/YAML is untrusted until it has passed a runtime check.
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type SourceType = 'github' | 'gitlab' | 'git' | 'local' | 'node_modules';

export interface UpstreamEntry {
  sourceType: SourceType;
  source: string;
  sourceUrl?: string;
  skillPath?: string;
  ref?: string;
}

export interface SkillLockEntry extends UpstreamEntry {
  computedHash: string;
  // Preserve additional upstream metadata when updating the baseline.
  [key: string]: unknown;
}

export interface SkillsLock {
  version: 1;
  skills: Record<string, SkillLockEntry>;
  [key: string]: unknown;
}

export interface StagedSkill {
  directory: string;
}

export type SkillName = string & { readonly __brand: 'SkillName' };

export type StageSkill = (options: {
  source: string;
  name: SkillName;
  workspace: string;
}) => Promise<StagedSkill>;

// The wire entry retains provenance; operational code only sees this validated model.
export type Upstream = { kind: 'local' } | { kind: 'remote'; source: string };

export function parseUpstream(entry: UpstreamEntry): Upstream {
  switch (entry.sourceType) {
    case 'local':
    case 'node_modules':
      return { kind: 'local' };
    case 'github':
    case 'gitlab':
    case 'git':
      break;
    default: {
      const _exhaustive: never = entry.sourceType;
      throw new Error(`Unsupported upstream type: ${_exhaustive}`);
    }
  }
  let source = entry.sourceUrl || entry.source;
  if (!source || source.startsWith('-')) throw new Error('Invalid upstream source');
  if (!(entry.sourceType === 'github' && /^[\w.-]+\/[\w.-]+$/.test(source))
      && !/^(https:\/\/|ssh:\/\/|git@)/.test(source)) {
    throw new Error('Upstream needs an unambiguous repository URL');
  }
  if (entry.skillPath && (entry.sourceType === 'github' || entry.sourceType === 'gitlab')) {
    if (entry.skillPath.includes('\\')
        || entry.skillPath.split('/').some((part) => part === '..' || part === '.')
        || entry.skillPath.startsWith('/') || /[?#]/.test(entry.skillPath)
        || !/(^|\/)SKILL\.md$/.test(entry.skillPath)) throw new Error('Invalid upstream skillPath');
    const folder = entry.skillPath.replace(/(^|\/)SKILL\.md$/, '');
    // Generic .git/SSH URLs cannot carry subpaths in the pinned CLI.
    if (folder && !source.endsWith('.git') && !source.startsWith('git@') && !source.startsWith('ssh://')) {
      source = `${source.replace(/\/$/, '')}/${folder}`;
    }
  }
  if (entry.ref) source += `#${entry.ref}`;
  return { kind: 'remote', source };
}

export type Diagnostic = {
  level: 'warn' | 'error';
  event: string;
  message: string;
  context: Readonly<Record<string, string>>;
};

export function diagnostic(value: Diagnostic): void {
  process.stderr.write(`${JSON.stringify(value)}\n`);
}

function isSourceType(value: unknown): value is SourceType {
  return value === 'github' || value === 'gitlab' || value === 'git'
    || value === 'local' || value === 'node_modules';
}

function isSkillLockEntry(value: unknown): value is SkillLockEntry {
  return isRecord(value) && isSourceType(value.sourceType)
    && typeof value.source === 'string' && value.source.length > 0
    && typeof value.computedHash === 'string' && /^[a-f0-9]{64}$/.test(value.computedHash)
    && ['sourceUrl', 'skillPath', 'ref'].every((key) => value[key] === undefined || typeof value[key] === 'string');
}

function assertSkillsLock(value: unknown): asserts value is SkillsLock {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.skills)) {
    throw new Error('Invalid skills-lock.json');
  }
  for (const [name, entry] of Object.entries(value.skills)) {
    if (!isSkillLockEntry(entry)) throw new Error(`Invalid skills-lock.json entry: ${name}`);
  }
}

export function parseSkillsLock(value: unknown): SkillsLock {
  assertSkillsLock(value);
  return value;
}
