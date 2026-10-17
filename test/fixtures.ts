import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import type { StageSkill } from '../scripts/data.ts';
import { readSkillsLock, skillHash, writeJson } from '../scripts/lib.ts';

export async function fixture(t: TestContext) {
  const base = await mkdtemp(path.join(process.env.SLOP_TMPDIR || tmpdir(), 'slop-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repo = path.join(base, 'source repo');
  const config = path.join(base, 'user config');
  for (const kind of ['agents', 'skills', 'instructions']) await mkdir(path.join(repo, kind), { recursive: true });
  await writeJson(path.join(repo, 'skills-lock.json'), { version: 1, skills: {} });
  return { base, repo, config };
}

export async function makeSkill(repo: string, name = 'demo', content = 'Original instructions') {
  const directory = path.join(repo, 'skills', name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: A test skill\n---\n${content}\n`);
  return directory;
}

export async function tracked(repo: string, name = 'demo') {
  const directory = await makeSkill(repo, name);
  const lock = await readSkillsLock(path.join(repo, 'skills-lock.json'));
  lock.skills[name] = { source: 'example/skills', sourceType: 'github', skillPath: `skills/${name}/SKILL.md`, computedHash: await skillHash(directory) };
  await writeJson(path.join(repo, 'skills-lock.json'), lock);
  return directory;
}

export const stageSkill: StageSkill = async ({ source, name, workspace }) => {
  const directory = path.join(workspace, 'staged', name);
  await mkdir(path.dirname(directory), { recursive: true });
  await cp(source, directory, { recursive: true });
  return { directory };
};

export const upstream: StageSkill = async ({ name, workspace }) => {
  const directory = await makeSkill(workspace, name, 'Updated upstream instructions');
  return { directory };
};
