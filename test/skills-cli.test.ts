import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { parseUpstream } from '../scripts/data.ts';
import type { UpstreamEntry } from '../scripts/data.ts';
import { safeName } from '../scripts/lib.ts';
import { skillsAdd, upstreamSource } from '../scripts/skills-cli.ts';
import { fixture, makeSkill } from './fixtures.ts';

test('upstream sources preserve repository and refs in the actual pinned CLI parser', async () => {
  // skills@1.7.2 has no public parser export. Evaluate only its pure parsing
  // section, without running the CLI or reimplementing its URL rules in tests.
  const cli = await readFile(new URL('../node_modules/skills/dist/cli.mjs', import.meta.url), 'utf8');
  const start = cli.indexOf('const DEFAULT_GITHUB_HOST =');
  const end = cli.indexOf('const CSI_RE =', start);
  assert.ok(start >= 0 && end > start, 'Pinned CLI parser layout changed; revisit this compatibility test');
  const parse = runInNewContext(`${cli.slice(start, end)}\nparseSource`, {
    URL, isAbsolute: path.isAbsolute, resolve: path.resolve, process: { env: {} },
  });
  const entries: UpstreamEntry[] = [
    { sourceType: 'github', source: 'example/skills' },
    { sourceType: 'github', source: 'example/skills', sourceUrl: 'https://github.com/example/skills' },
    { sourceType: 'gitlab', source: 'group/skills', sourceUrl: 'https://gitlab.com/group/subgroup/skills' },
    { sourceType: 'gitlab', source: 'group/skills', sourceUrl: 'https://gitlab.company.test/group/skills.git' },
    { sourceType: 'git', source: 'https://example.com/skills.git' },
    { sourceType: 'git', source: 'ssh://git@example.com/skills.git' },
    { sourceType: 'git', source: 'git@example.com:group/skills.git' },
  ];
  for (const entry of entries) {
    for (const ref of [undefined, 'main', 'feature/nested', 'release@v2']) {
      const upstream = parseUpstream({ ...entry, skillPath: 'nested/demo/SKILL.md', ...ref && { ref } });
      assert.equal(upstream.kind, 'remote');
      if (upstream.kind !== 'remote') assert.fail('Expected remote upstream');
      const parsed = parse(upstreamSource(upstream));
      const expectedUrl = upstream.repository.startsWith('https://github.com/') || upstream.repository.startsWith('https://gitlab.com/')
        ? `${upstream.repository.replace(/\.git$/, '')}.git` : upstream.repository;
      assert.equal(parsed.url, expectedUrl);
      assert.equal(parsed.ref, ref);
      assert.equal(parsed.subpath, undefined);
      assert.equal(upstream.skillPath, 'nested/demo/SKILL.md');
    }
  }
});

test('upstream boundaries reject ambiguous repositories and invalid paths for every remote type', () => {
  assert.throws(() => parseUpstream({ sourceType: 'gitlab', source: 'owner/repo' }), /unambiguous/);
  for (const sourceType of ['github', 'gitlab', 'git'] as const) {
    for (const skillPath of ['../SKILL.md', '/SKILL.md', 'demo//SKILL.md', 'demo/./SKILL.md', 'demo\\SKILL.md', 'demo/OTHER.md', '']) {
      assert.throws(() => parseUpstream({ sourceType, source: 'https://example.com/skills.git', skillPath }), /Invalid upstream skillPath/);
    }
    for (const source of ['--help', 'https://example.com/skills.git#main', 'https://example.com/skills.git?ref=main', 'https://example.com/skills repo']) {
      assert.throws(() => parseUpstream({ sourceType, source }));
    }
  }
  assert.throws(() => parseUpstream({ sourceType: 'github', source: 'https://github.com/owner/repo/tree/main' }), /repository root/);
  assert.throws(() => parseUpstream({ sourceType: 'gitlab', source: 'https://gitlab.com/group/repo/-/tree/main' }), /repository root/);
  assert.throws(() => parseUpstream({ sourceType: 'git', source: 'git@missing-path' }), /SSH repository/);
  assert.throws(() => upstreamSource({ kind: 'remote', repository: 'https://example.com/skills', ref: 'main' }), /needs a .git repository URL/);
});

test('actual pinned CLI verifies the selected skill path before accepting remote content', async (t) => {
  const { repo, base } = await fixture(t);
  await makeSkill(repo);
  execFileSync('git', ['init', '--quiet', repo]);
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Fixture']);
  const source = pathToFileURL(repo).href;
  const name = safeName('demo');
  const staged = await skillsAdd({ source, name, skillPath: '.agents/skills/demo/SKILL.md', workspace: path.join(base, 'accepted') });
  assert.match(await readFile(path.join(staged.directory, 'SKILL.md'), 'utf8'), /Original instructions/);
  await assert.rejects(skillsAdd({ source, name, skillPath: 'another/demo/SKILL.md', workspace: path.join(base, 'rejected') }), /Upstream skill path changed/);
});
