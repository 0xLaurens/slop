// Compile-time regression tests, checked by `bun run typecheck`, not executed.
import { options, safeName, skillName } from '../scripts/lib.ts';
import type { InstallOptions } from '../scripts/install.ts';
import type { DeploymentManifest } from '../scripts/deployment-state.ts';
import type { SkillName, StageSkill, Upstream, UpstreamEntry } from '../scripts/data.ts';
import type { UpdateResult } from '../scripts/update-skills.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

const args = options({ 'config-dir': { type: 'string' }, uninstall: { type: 'boolean' } }, []);

export type StringOption = Expect<Equal<typeof args['config-dir'], string | undefined>>;
export type BooleanOption = Expect<Equal<typeof args.uninstall, boolean | undefined>>;
export type InstallCallback = Expect<Equal<NonNullable<InstallOptions['stageSkill']>, StageSkill>>;
export type ValidatedName = Expect<Equal<ReturnType<typeof safeName>, SkillName>>;
export type FrontmatterName = Expect<Equal<Awaited<ReturnType<typeof skillName>>, SkillName>>;
export type StageName = Expect<Equal<Parameters<StageSkill>[0]['name'], SkillName>>;
export type RemoteRepository = Expect<Equal<Extract<Upstream, { kind: 'remote' }>['repository'], string>>;

// @ts-expect-error Unknown flags must not silently become any.
args.typo;
// @ts-expect-error Source types are a closed set, not arbitrary strings.
const invalidSource: UpstreamEntry = { source: 'owner/repo', sourceType: 'typo' };
// @ts-expect-error Staging callbacks must return a directory, not an arbitrary object.
const invalidStage: StageSkill = async () => ({ path: '/staged' });
// @ts-expect-error Only the supported manifest format can be written.
const invalidManifest: DeploymentManifest = { version: 2, owner: 'slop', files: {} };
// @ts-expect-error Update summaries contain skill names, not numbers.
const invalidResult: UpdateResult = { updated: [123], skipped: [], failures: [] };
// @ts-expect-error Arbitrary strings have not passed portable-name validation.
const invalidName: SkillName = '../escape';
// @ts-expect-error Staging requires a validated name, not a workspace or source string.
const invalidStageOptions: Parameters<StageSkill>[0] = { source: '/source', name: '/workspace', workspace: 'demo' };
// @ts-expect-error Remote upstreams always have a validated repository.
const missingRemoteSource: Upstream = { kind: 'remote' };
// @ts-expect-error Local upstreams cannot carry remote-source operational state.
const invalidLocal: Upstream = { kind: 'local', repository: 'https://github.com/example/skills.git' };
