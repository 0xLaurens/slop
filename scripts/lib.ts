import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { ParseArgsOptionsConfig } from 'node:util';
import { parse } from 'yaml';
import { hasCode, isRecord, parseSkillsLock } from './data.ts';
import type { SkillName, SkillsLock } from './data.ts';

export const repository = fileURLToPath(new URL('../', import.meta.url));

export async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; }
  catch (error) { if (hasCode(error, 'ENOENT')) return false; throw error; }
}

export async function json(file: string): Promise<unknown> { return JSON.parse(await readFile(file, 'utf8')); }

export async function readSkillsLock(file: string): Promise<SkillsLock> {
  return parseSkillsLock(await json(file));
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

export function options<const T extends ParseArgsOptionsConfig>(definitions: T, args = process.argv.slice(2)) {
  return parseArgs<{ args: string[]; options: T; strict: true; allowPositionals: false }>({
    args, options: definitions, strict: true, allowPositionals: false,
  }).values;
}

export function safeName(name: string): SkillName {
  if (!/^[a-z0-9][a-z0-9_-]{0,99}$/.test(name)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) {
    throw new Error(`Not a portable name: ${name}`);
  }
  return name as SkillName;
}

export async function skillName(directory: string): Promise<SkillName> {
  const contents = await readFile(path.join(directory, 'SKILL.md'), 'utf8');
  const frontmatter = contents.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter?.[1]) throw new Error(`Missing SKILL.md frontmatter: ${directory}`);
  const data: unknown = parse(frontmatter[1]);
  if (!isRecord(data) || typeof data.name !== 'string' || typeof data.description !== 'string' || !data.description.trim()) {
    throw new Error(`SKILL.md requires name and description: ${directory}`);
  }
  return safeName(data.name);
}

// Reject links (including Windows junctions) rather than reading/writing through them.
export async function noLinks(target: string): Promise<void> {
  const absolute = path.resolve(target);
  const { root: base } = path.parse(absolute);
  let current = base;
  for (const part of absolute.slice(base.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Symlink/junction is not supported: ${current}`);
    } catch (error) { if (hasCode(error, 'ENOENT')) return; throw error; }
  }
}

type Entry = { name: string; kind: 'directory' } | { name: string; kind: 'file'; bytes: Buffer };

async function entries(directory: string, relative = '', result: Entry[] = [], upstream = false): Promise<Entry[]> {
  for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    const file = path.join(directory, name);
    if (entry.isSymbolicLink()) throw new Error(`Symlink is not supported: ${file}`);
    if (entry.isDirectory()) {
      if (upstream && ['.git', 'node_modules'].includes(entry.name)) continue;
      if (!upstream) result.push({ name, kind: 'directory' });
      await entries(directory, name, result, upstream);
      continue;
    }
    if (!entry.isFile()) throw new Error(`Unsupported file type: ${file}`);
    result.push({ name, kind: 'file', bytes: await readFile(file) });
  }
  return result;
}

// Matches skills@1.7.2's project-lock computedHash algorithm exactly.
export async function skillHash(directory: string): Promise<string> {
  await noLinks(directory);
  const hash = createHash('sha256');
  for (const file of (await entries(directory, '', [], true)).sort((a, b) => a.name.localeCompare(b.name))) {
    if (file.kind === 'file') hash.update(file.name).update(file.bytes);
  }
  return hash.digest('hex');
}

// Deployment hash also includes empty directories and files omitted by upstream hashing.
export async function fingerprint(target: string): Promise<string | null> {
  await noLinks(target);
  if (!await exists(target)) return null;
  const stat = await lstat(target);
  const hash = createHash('sha256');
  if (stat.isFile()) return hash.update('file\0').update(await readFile(target)).digest('hex');
  if (!stat.isDirectory()) throw new Error(`Unsupported file type: ${target}`);
  hash.update('directory\0');
  for (const entry of (await entries(target)).sort((a, b) => a.name.localeCompare(b.name))) {
    hash.update(JSON.stringify([entry.name, entry.kind]));
    if (entry.kind === 'file') hash.update(createHash('sha256').update(entry.bytes).digest());
  }
  return hash.digest('hex');
}

export async function temporary<T>(prefix: string, action: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(process.env.SLOP_TMPDIR || tmpdir(), prefix));
  try { return await action(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

export async function copy(source: string, destination: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
}

export async function withMutex<T>(file: string, action: () => Promise<T>): Promise<T> {
  await noLinks(file);
  await mkdir(path.dirname(file), { recursive: true });
  try { await mkdir(file); }
  catch (error) {
    if (hasCode(error, 'EEXIST')) throw new Error(`Another operation is running, or a stale lock exists: ${file}`);
    throw error;
  }
  try { return await action(); }
  finally { await rm(file, { recursive: true }); }
}

export function isMain(url: string): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && path.resolve(entrypoint) === fileURLToPath(url);
}
