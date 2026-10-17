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
  entry?: SkillLockEntry;
}

export type SkillName = string & { readonly __brand: 'SkillName' };

export type StageSkill = (options: {
  source: string;
  name: SkillName;
  workspace: string;
  // Remote updates must resolve to this exact path in the fetched repository.
  skillPath?: string;
}) => Promise<StagedSkill>;

// The wire entry retains provenance; operational code only sees this validated model.
export type RemoteUpstream = {
  kind: 'remote';
  repository: string;
  skillPath?: string;
  ref?: string;
};
export type Upstream = { kind: 'local' } | RemoteUpstream;

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
  if (entry.sourceType === 'github' && /^[\w.-]+\/[\w.-]+$/.test(source)) {
    source = `https://github.com/${source.replace(/\.git$/, '')}.git`;
  }
  if (!/^(https:\/\/|ssh:\/\/|git@)/.test(source)) {
    throw new Error('Upstream needs an unambiguous repository URL');
  }
  if (/[\s?#]/.test(source)) throw new Error('Upstream repository must not contain whitespace, a query, or a fragment');
  source = source.replace(/\/$/, '');
  if (source.startsWith('git@')) {
    if (!/^git@[^/:]+:.+$/.test(source)) throw new Error('Invalid upstream SSH repository');
  } else {
    const url = new URL(source);
    if (!url.hostname || url.pathname === '/') throw new Error('Invalid upstream repository URL');
    if (url.hostname === 'github.com' && !/^\/[^/]+\/[^/]+$/.test(url.pathname)) {
      throw new Error('Upstream repository must be a repository root, not a tree or skill URL');
    }
    if (entry.sourceType === 'gitlab' && url.pathname.includes('/-/')) {
      throw new Error('Upstream repository must be a repository root, not a tree or skill URL');
    }
  }
  if (entry.skillPath !== undefined && (entry.skillPath.includes('\\')
      || entry.skillPath.split('/').some((part) => !part || part === '..' || part === '.')
      || entry.skillPath.startsWith('/') || /[?#]/.test(entry.skillPath)
      || !/(^|\/)SKILL\.md$/.test(entry.skillPath))) {
    throw new Error('Invalid upstream skillPath');
  }
  if (entry.ref !== undefined && (!entry.ref || /[\s\x00-\x1f]/.test(entry.ref))) throw new Error('Invalid upstream ref');
  return { kind: 'remote', repository: source, ...entry.skillPath !== undefined && { skillPath: entry.skillPath },
    ...entry.ref !== undefined && { ref: entry.ref } };
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
