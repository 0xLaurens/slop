import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RemoteUpstream, StageSkill } from './data.ts';
import { fingerprint, readSkillsLock, skillName } from './lib.ts';

const cli = fileURLToPath(new URL('../node_modules/skills/bin/cli.mjs', import.meta.url));

// Fetch the repository root, not a URL with a folder bolted onto it. The pinned
// CLI interprets those URLs differently across hosts. Check the selected path
// against its project lock after staging instead of silently accepting a match
// by name from another directory. Fragment values are decoded by skills@1.7.2.
export function upstreamSource(upstream: RemoteUpstream): string {
  if (upstream.ref && !upstream.repository.endsWith('.git') && !upstream.repository.startsWith('git@')) {
    const host = new URL(upstream.repository).hostname;
    if (host !== 'github.com' && host !== 'gitlab.com') {
      throw new Error('The pinned skills CLI needs a .git repository URL to preserve refs for this host');
    }
  }
  return upstream.ref ? `${upstream.repository}#${encodeURIComponent(upstream.ref)}` : upstream.repository;
}

// The isolated home/project keeps CLI bookkeeping out of the user's config.
export function createSkillsAdd(log: (message: string) => void = () => {}): StageSkill {
  return async ({ source, name, workspace, skillPath }) => {
    const home = path.join(workspace, 'home');
    const cwd = path.join(workspace, 'project');
    await Promise.all([mkdir(home, { recursive: true }), mkdir(cwd, { recursive: true })]);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, 'add', source, '--agent', 'opencode',
        '--skill', name, '--copy', '--yes', ...(path.isAbsolute(source) ? [] : ['--full-depth'])], {
        cwd, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, HOME: home, USERPROFILE: home,
          XDG_CONFIG_HOME: path.join(home, '.config'), XDG_STATE_HOME: path.join(home, '.state'),
          DISABLE_TELEMETRY: '1' },
      });
      let tail = '';
      let logError: unknown;
      const output = (chunk: Buffer) => {
        const text = chunk.toString();
        tail = (tail + text).slice(-8192);
        try { log(text); } catch (error) { logError = error; }
      };
      child.stdout.on('data', output);
      child.stderr.on('data', output);
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (logError) reject(logError);
        else if (code === 0) resolve();
        else reject(new Error(`skills add failed (${code ?? signal})\n${tail}`));
      });
    });
    const directory = path.join(cwd, '.agents', 'skills', name);
    if (await skillName(directory) !== name) throw new Error(`Upstream skill name changed: ${name}`);
    await fingerprint(directory);
    const lock = await readSkillsLock(path.join(cwd, 'skills-lock.json'));
    const selected = Object.hasOwn(lock.skills, name) ? lock.skills[name] : undefined;
    if (skillPath !== undefined && selected?.skillPath !== skillPath) {
      throw new Error(`Upstream skill path changed: expected ${skillPath}, received ${selected?.skillPath ?? 'no path'}`);
    }
    return { directory, ...selected && { entry: selected } };
  };
}

export const skillsAdd: StageSkill = createSkillsAdd();
