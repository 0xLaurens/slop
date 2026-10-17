import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { parseUpstream } from './data.ts';
import type { SkillName } from './data.ts';
import { exists, noLinks, readSkillsLock, safeName, skillName } from './lib.ts';

export type ImportRequest =
  | { kind: 'agent'; source: string }
  | { kind: 'local-skill'; source: string }
  | { kind: 'remote-skill'; source: string; name: string };

export async function prepareImport({ repo, request }: { repo: string; request: ImportRequest }) {
  const source = request.kind === 'remote-skill' ? request.source : path.resolve(request.source);
  let name: SkillName;
  if (request.kind === 'remote-skill') {
    parseUpstream({ sourceType: 'github', source });
    name = safeName(request.name);
  } else {
    await noLinks(source);
    if (request.kind === 'agent') {
      if (!(await lstat(source)).isFile() || !source.endsWith('.md')) throw new Error('Choose an existing Markdown (.md) file.');
      name = safeName(path.basename(source, '.md'));
    } else name = await skillName(source);
  }
  const target = request.kind === 'agent' ? `agents/${name}.md` : `skills/${name}`;
  const destination = path.join(repo, '.agents', target);
  await noLinks(destination);
  if (await exists(destination)) throw new Error(`Import collision: ${name} already exists in this repository. Existing files will not be overwritten.`);
  const lockFile = path.join(repo, 'skills-lock.json');
  await noLinks(lockFile);
  if (request.kind !== 'agent' && Object.hasOwn((await readSkillsLock(lockFile)).skills, name)) {
    throw new Error(`Import collision: ${name} already has a skills-lock.json entry. Resolve it manually before importing.`);
  }
  return { request: { ...request, source }, name, target, destination };
}
