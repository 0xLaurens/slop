import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';

export const repository = fileURLToPath(new URL('../', import.meta.url));
const cli = fileURLToPath(new URL('../node_modules/skills/bin/cli.mjs', import.meta.url));

export async function exists(file: string) {
  try { await lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function json(file: string) { return JSON.parse(await readFile(file, 'utf8')); }

export async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

export function options(definitions, args = process.argv.slice(2)) {
  return parseArgs({ args, options: definitions, allowPositionals: false }).values;
}

export function safeName(name: string) {
  if (!/^[a-z0-9][a-z0-9_-]{0,99}$/.test(name)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) {
    throw new Error(`Not a portable name: ${name}`);
  }
  return name;
}

export async function skillName(directory: string) {
  const contents = await readFile(path.join(directory, 'SKILL.md'), 'utf8');
  const frontmatter = contents.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) throw new Error(`Missing SKILL.md frontmatter: ${directory}`);
  const data = parse(frontmatter[1]);
  if (typeof data?.name !== 'string' || typeof data.description !== 'string' || !data.description.trim()) {
    throw new Error(`SKILL.md requires name and description: ${directory}`);
  }
  return safeName(data.name);
}

// Reject links (including Windows junctions) rather than reading/writing through them.
export async function noLinks(target: string) {
  const absolute = path.resolve(target);
  const { root: base } = path.parse(absolute);
  let current = base;
  for (const part of absolute.slice(base.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Symlink/junction is not supported: ${current}`);
    } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  }
}

type Entry = { name: string; directory?: boolean; bytes?: Buffer };

async function entries(directory: string, relative = '', result: Entry[] = [], upstream = false) {
  for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    const file = path.join(directory, name);
    if (entry.isSymbolicLink()) throw new Error(`Symlink is not supported: ${file}`);
    if (entry.isDirectory()) {
      if (upstream && ['.git', 'node_modules'].includes(entry.name)) continue;
      if (!upstream) result.push({ name, directory: true });
      await entries(directory, name, result, upstream);
    } else if (entry.isFile()) result.push({ name, bytes: await readFile(file) });
    else throw new Error(`Unsupported file type: ${file}`);
  }
  return result;
}

// Matches skills@1.7.2's project-lock computedHash algorithm exactly.
export async function skillHash(directory: string) {
  await noLinks(directory);
  const hash = createHash('sha256');
  for (const file of (await entries(directory, '', [], true)).sort((a, b) => a.name.localeCompare(b.name))) {
    hash.update(file.name);
    hash.update(file.bytes);
  }
  return hash.digest('hex');
}

// Deployment hash also includes empty directories and files omitted by upstream hashing.
export async function fingerprint(target: string) {
  await noLinks(target);
  if (!await exists(target)) return null;
  const stat = await lstat(target);
  const hash = createHash('sha256');
  if (stat.isFile()) hash.update('file\0').update(await readFile(target));
  else if (stat.isDirectory()) {
    hash.update('directory\0');
    for (const entry of (await entries(target)).sort((a, b) => a.name.localeCompare(b.name))) {
      hash.update(JSON.stringify([entry.name, entry.directory ? 'directory' : 'file']));
      if (entry.bytes) hash.update(createHash('sha256').update(entry.bytes).digest());
    }
  } else throw new Error(`Unsupported file type: ${target}`);
  return hash.digest('hex');
}

export async function temporary<T>(prefix: string, action: (directory: string) => Promise<T>) {
  const directory = await mkdtemp(path.join(process.env.SLOP_TMPDIR || tmpdir(), prefix));
  try { return await action(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

// Always run the pinned CLI with an isolated home and cwd. It never touches the
// user's global skills or CLI tracking/preferences before our conflict checks.
export async function skillsAdd(source: string, name: string, workspace: string) {
  const home = path.join(workspace, 'home');
  const cwd = path.join(workspace, 'project');
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const result = spawnSync(process.execPath, [cli, 'add', source, '--agent', 'opencode',
    '--skill', name, '--copy', '--yes', ...(path.isAbsolute(source) ? [] : ['--full-depth'])], {
    cwd, stdio: 'inherit',
    env: { ...process.env, HOME: home, USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_STATE_HOME: path.join(home, '.state'),
      DISABLE_TELEMETRY: '1' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`skills add failed (${result.status ?? result.signal})`);
  const directory = path.join(cwd, '.agents', 'skills', name);
  if (await skillName(directory) !== name) throw new Error(`Upstream skill name changed: ${name}`);
  await fingerprint(directory);
  return { directory, lock: await json(path.join(cwd, 'skills-lock.json')) };
}

export async function copy(source: string, destination: string) {
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
}

export async function warnPendingSkills(repo: string) {
  const directory = path.join(repo, '.agents', 'skills');
  await noLinks(directory);
  if (!await exists(directory)) return;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && await exists(path.join(directory, entry.name, 'SKILL.md'))) {
      console.warn(`Not managed: .agents/skills/${entry.name}. Move it to skills/${entry.name} to include it.`);
    }
  }
}

export async function withMutex<T>(file: string, action: () => Promise<T>) {
  await noLinks(file);
  await mkdir(path.dirname(file), { recursive: true });
  try { await mkdir(file); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Another operation is running, or a stale lock exists: ${file}`);
    throw error;
  }
  try { return await action(); }
  finally { await rm(file, { recursive: true }); }
}

export function isMain(url: string) {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(url);
}
