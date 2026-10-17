import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { errorMessage, parseUpstream } from './data.ts';
import type { SkillLockEntry, StageSkill } from './data.ts';
import { applyDeployment, deploymentSession, preflight, readManifest, sources } from './install.ts';
import type { DeploymentSources } from './install.ts';
import { copy, exists, fingerprint, noLinks, readSkillsLock, safeName, skillHash, skillName,
  temporary, withMutex, writeJson } from './lib.ts';
import { run } from './process.ts';
import type { Run } from './process.ts';
import { skillsAdd, upstreamSource } from './skills-cli.ts';
import { assertNoPendingUpdate } from './update-transaction.ts';

export interface Item {
  target: string;
  source?: string;
  installed: boolean;
  managed: boolean;
  edited: boolean;
  remote: boolean;
  modified: boolean;
  sourceHash: string | null;
  installedHash: string | null;
}

export async function inventory(repo: string, config: string): Promise<Item[]> {
  await noLinks(path.join(config, '.slop', 'manifest.json'));
  const manifest = await readManifest(path.join(config, '.slop', 'manifest.json'));
  const available = await sources(repo);
  const lock = await readSkillsLock(path.join(repo, 'skills-lock.json'));
  const result: Item[] = [];
  for (const target of [...new Set([...available.keys(), ...Object.keys(manifest.files)])].sort()) {
    const source = available.get(target)?.source;
    const managed = Object.hasOwn(manifest.files, target);
    const current = await fingerprint(path.join(config, target));
    const name = target.startsWith('skills/') ? target.slice(7) : '';
    const entry = Object.hasOwn(lock.skills, name) ? lock.skills[name] : undefined;
    result.push({ target, source, managed, installed: current !== null,
      edited: current !== null && (!managed || current !== manifest.files[target]),
      remote: Boolean(entry && parseUpstream(entry).kind === 'remote'),
      modified: Boolean(source && entry && await skillHash(source) !== entry.computedHash),
      sourceHash: source ? await fingerprint(source) : null, installedHash: current });
  }
  return result;
}

export function installationChanges(items: readonly Item[], selected: ReadonlySet<string>): string[] {
  const changes: string[] = [];
  for (const item of items) {
    if (selected.has(item.target)) {
      if (!item.installed) changes.push(`INSTALL ${item.target}`);
      else if (item.source && item.sourceHash !== item.installedHash) changes.push(`REPLACE ${item.target}`);
    } else if (item.managed) changes.push(`UNINSTALL ${item.target}${item.installed ? '' : ' (clear missing entry)'}`);
  }
  return changes;
}

export async function assertInventory(repo: string, config: string, expected: readonly Item[]): Promise<void> {
  if (JSON.stringify(await inventory(repo, config)) !== JSON.stringify(expected)) {
    throw new Error('Files or installation state changed after review. Return to the menu and review a fresh plan.');
  }
}

export type ImportRequest =
  | { kind: 'agent'; source: string }
  | { kind: 'local-skill'; source: string }
  | { kind: 'remote-skill'; source: string; name: string };

export async function importContent(repo: string, request: ImportRequest, stage: StageSkill = skillsAdd,
  check: () => void = () => {}): Promise<string> {
  return withMutex(path.join(repo, '.slop', 'repository.lock'), async () => {
    await assertNoPendingUpdate(repo);
    return temporary('slop-import-', async (workspace) => {
      let source: string;
      let name: string;
      let entry: SkillLockEntry | undefined;
      if (request.kind === 'remote-skill') {
        name = safeName(request.name);
        const upstream = parseUpstream({ sourceType: 'github', source: request.source });
        if (upstream.kind !== 'remote') throw new Error('Expected a remote repository');
        const staged = await stage({ source: upstreamSource(upstream), name: safeName(name), workspace });
        source = staged.directory;
        if (await skillName(source) !== name) throw new Error('Imported skill name differs');
        entry = { ...staged.entry, sourceType: staged.entry?.sourceType ?? 'git',
          source: staged.entry?.source ?? upstream.repository, computedHash: await skillHash(source) };
        if (parseUpstream(entry).kind !== 'remote') throw new Error('Remote import did not provide remote provenance');
      } else {
        source = path.resolve(request.source);
        await noLinks(source);
        if (request.kind === 'agent') {
          if (!(await lstat(source)).isFile() || !source.endsWith('.md')) throw new Error('Select a regular agent Markdown (.md) file');
          name = safeName(path.basename(source, '.md'));
        } else name = await skillName(source);
      }
      const target = request.kind === 'agent' ? `agents/${name}.md` : `skills/${name}`;
      const destination = path.join(repo, '.agents', target);
      await noLinks(destination);
      if (await exists(destination)) throw new Error(`Import collision: ${target} already exists. Nothing overwritten.`);
      const before = await fingerprint(source);
      if (before === null) throw new Error('Import source disappeared');
      const staged = path.join(workspace, 'validated');
      await copy(source, staged);
      if (await fingerprint(staged) !== before || await fingerprint(source) !== before) throw new Error('Import source changed while copying');
      const lockFile = path.join(repo, 'skills-lock.json');
      await noLinks(lockFile);
      const lock = await readSkillsLock(lockFile);
      if (request.kind !== 'agent' && Object.hasOwn(lock.skills, name)) throw new Error(`Import collision: lock entry ${name} already exists`);
      if (entry) entry.computedHash = await skillHash(staged);
      await mkdir(path.dirname(destination), { recursive: true });
      // Stage on the destination filesystem so publishing is an atomic rename.
      const publish = path.join(path.dirname(destination), `.import-${randomUUID()}`);
      try {
        await copy(staged, publish);
        check();
        if (await exists(destination)) throw new Error(`Import collision: ${target} appeared during import`);
        await rename(publish, destination);
        try {
          if (request.kind !== 'agent') await writeJson(lockFile, { ...lock, skills: { ...lock.skills,
            [name]: entry ?? { sourceType: 'local', source: request.source, computedHash: await skillHash(destination) } } });
        } catch (error) {
          await rm(destination, { recursive: true, force: true });
          throw error;
        }
      } finally { await rm(publish, { recursive: true, force: true }); }
      return target;
    });
  });
}

export interface DeletionOptions {
  repo: string;
  config: string;
  targets: readonly string[];
  expected?: readonly Item[];
  execute?: Run;
  log?: (message: string) => void;
  check?: () => void;
  beginChanges?: () => void;
}

export async function checkDeletionPrerequisites(repo: string, execute: Run = run) {
  const git = (...args: string[]) => execute('git', args, repo);
  const gh = (...args: string[]) => execute('gh', args, repo);
  if (path.resolve(await git('rev-parse', '--show-toplevel')) !== path.resolve(repo)) throw new Error('Repository must be the Git working-tree root');
  if (await git('status', '--porcelain', '--untracked-files=all')) throw new Error('Working tree is not clean. Commit or resolve your changes manually before deleting. Nothing changed.');
  const startingBranch = await git('symbolic-ref', '--quiet', 'HEAD');
  await git('var', 'GIT_AUTHOR_IDENT');
  await git('var', 'GIT_COMMITTER_IDENT');
  const remote = await git('remote', 'get-url', 'origin');
  const match = remote.match(/^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?$/);
  if (!match?.[1]) throw new Error('Deletion PRs require a GitHub origin remote');
  const repository = match[1];
  await gh('auth', 'status', '--hostname', 'github.com');
  const details: unknown = JSON.parse(await gh('repo', 'view', repository, '--json', 'defaultBranchRef,viewerPermission'));
  if (typeof details !== 'object' || details === null || !('defaultBranchRef' in details) || !('viewerPermission' in details)) throw new Error('Cannot discover GitHub repository permissions');
  const branchRef = details.defaultBranchRef;
  if (typeof branchRef !== 'object' || branchRef === null || !('name' in branchRef) || typeof branchRef.name !== 'string') throw new Error('Cannot discover default branch');
  if (!['ADMIN', 'MAINTAIN', 'WRITE'].includes(String(details.viewerPermission))) throw new Error('Push permission is required for deletion PRs');
  const base = branchRef.name;
  await git('fetch', 'origin', base);
  const head = await git('rev-parse', 'HEAD');
  const baseHead = await git('rev-parse', 'FETCH_HEAD');
  if (head !== baseHead) throw new Error(`Start from the latest origin/${base} commit to avoid including unrelated commits in the deletion PR. Switch/update manually; nothing deleted.`);
  const branch = `slop/delete-${randomUUID()}`;
  await git('push', '--dry-run', 'origin', `HEAD:refs/heads/${branch}`);
  return { startingBranch, repository, base, head, branch };
}

export async function deleteWithPullRequest({ repo, config, targets, expected, execute = run, log = () => {}, check = () => {}, beginChanges = () => {} }: DeletionOptions): Promise<string> {
  if (!targets.length) throw new Error('No deletion targets selected');
  return deploymentSession(repo, config, async (previous) => {
    if (expected) await assertInventory(repo, config, expected);
    const available = await sources(repo);
    const unique = [...new Set(targets)];
    const paths = unique.map((target) => {
      const source = available.get(target)?.source;
      if (!source || target === 'AGENTS.md') throw new Error(`Only repository skills and agents can be permanently deleted: ${target}`);
      return path.relative(repo, source).split(path.sep).join('/');
    });
    const sourceHashes = new Map<string, string | null>();
    for (const file of paths) sourceHashes.set(file, await fingerprint(path.join(repo, file)));
    log(`Deletion batch:\n${unique.map((target) => `DELETE SOURCE + UNINSTALL ${target}`).join('\n')}`);
    const desired: DeploymentSources = new Map();
    for (const target of Object.keys(previous.files)) {
      if (!unique.includes(target) && await exists(path.join(config, target))) desired.set(target, { source: path.join(config, target), retained: true });
    }
    const checked = new Map(desired);
    for (const target of unique) {
      const source = available.get(target);
      if (source) checked.set(target, source);
    }
    // Include deletion targets in conflict checks even if they are not owned.
    await preflight(config, checked, previous);
    await preflight(config, desired, previous);
    if (await exists(path.join(config, '.slop', 'transaction'))) throw new Error('Interrupted deployment needs manual recovery before deletion');
    const git = (...args: string[]) => execute('git', args, repo);
    const gh = (...args: string[]) => execute('gh', args, repo);
    const { startingBranch, repository, base, head, branch } = await checkDeletionPrerequisites(repo, execute);
    for (const file of paths) if (!await git('ls-files', '--', file)) throw new Error(`Source is not tracked by Git: ${file}`);
    const lockFile = path.join(repo, 'skills-lock.json');
    await noLinks(lockFile);
    const lockHash = await fingerprint(lockFile);
    const lock = await readSkillsLock(lockFile);
    const skills = { ...lock.skills };
    for (const target of unique) if (target.startsWith('skills/')) delete skills[target.slice(7)];
    const lockChanged = JSON.stringify(skills) !== JSON.stringify(lock.skills);
    if (lockChanged && !await git('ls-files', '--', 'skills-lock.json')) throw new Error('skills-lock.json must be tracked');
    if (expected) await assertInventory(repo, config, expected);
    if (await git('status', '--porcelain', '--untracked-files=all')) throw new Error('Working tree changed during preflight; nothing deleted');
    if (await git('rev-parse', 'HEAD') !== head || await git('symbolic-ref', '--quiet', 'HEAD') !== startingBranch) throw new Error('Git branch changed during preflight; nothing deleted');
    await preflight(config, desired, previous);
    await preflight(config, checked, previous);
    check();
    beginChanges();
    await git('switch', '-c', branch);
    log(`Created branch ${branch}`);
    let uninstalled = false;
    let committed = false;
    let pushed = false;
    const title = `chore(agents): permanently delete ${unique.length} skill/agent source${unique.length === 1 ? '' : 's'}`;
    const body = `Remove repository sources and their skill lock entries.\n\n${unique.map((target) => `- ${target}`).join('\n')}\n\nManaged global copies were uninstalled locally. Unrelated files were preserved.`;
    try {
      await applyDeployment(config, desired, previous);
      uninstalled = true;
      log('Global uninstall complete');
      for (const [file, hash] of sourceHashes) {
        if (await fingerprint(path.join(repo, file)) !== hash) throw new Error(`Source changed during deletion; preserving it: ${file}`);
      }
      if (await fingerprint(lockFile) !== lockHash) throw new Error('skills-lock.json changed during deletion; preserving it');
      for (const target of unique) {
        const source = available.get(target)?.source;
        if (!source) throw new Error(`Source disappeared: ${target}`);
        await rm(source, { recursive: true });
      }
      if (lockChanged) await writeJson(lockFile, { ...lock, skills });
      const commitPaths = [...paths, ...lockChanged ? ['skills-lock.json'] : []];
      await git('add', '--', ...commitPaths);
      // Detect unrelated staging rather than accidentally committing someone else's work.
      const staged = (await git('diff', '--cached', '--name-only')).split('\n').filter(Boolean);
      if (staged.some((file) => !commitPaths.some((allowed) => file === allowed || file.startsWith(`${allowed}/`)))) throw new Error('Unrelated staged changes appeared; refusing to commit');
      await git('commit', '-m', title, '--', ...commitPaths);
      committed = true;
      log(`Committed deletion on ${branch}`);
      await git('push', '--set-upstream', 'origin', branch);
      pushed = true;
      log(`Pushed ${branch}`);
      const url = await gh('pr', 'create', '--repo', repository, '--base', base, '--head', branch, '--title', title, '--body', body);
      log(`PR created: ${url}\nRemaining on ${branch}`);
      return url;
    } catch (error) {
      throw new Error(`${errorMessage(error)}\nRecovery: remaining on ${branch}. Global uninstall: ${uninstalled ? 'completed' : 'not completed'}; commit: ${committed ? 'created' : 'not created'}; push: ${pushed ? 'completed' : 'not completed'}.\nReview git status and git diff first. ${committed ? '' : 'Finish only the reviewed source deletions and lock entries, then commit them. '}${pushed ? '' : `Retry: git push --set-upstream origin ${branch}. `}Check for an existing PR with gh pr list --head ${branch} before retrying gh pr create --repo ${repository} --base ${base} --head ${branch}. No automatic rollback or branch switch was attempted.`);
    }
  });
}
