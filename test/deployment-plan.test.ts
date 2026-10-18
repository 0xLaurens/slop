import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { deploymentPlan, inventory } from '../scripts/deployment-plan.ts';
import { install } from '../scripts/install.ts';
import { exists, fingerprint } from '../scripts/lib.ts';
import { installationReview, installationSummary } from '../scripts/tui-model.ts';
import { fixture, makeSkill, stageSkill } from './fixtures.ts';

test('reviewed installation rejects repository edits during staging without changing deployment', async (t) => {
  const { repo, config } = await fixture(t);
  const source = await makeSkill(repo);
  await install({ repo, config, stageSkill });
  await writeFile(path.join(source, 'reviewed.txt'), 'Reviewed change');
  const before = await fingerprint(config);
  const plan = deploymentPlan({ repo, config, items: await inventory(repo, config), selected: new Set(['skills/demo']) });
  assert.equal(installationSummary(plan), '0 install · 1 replace · 0 uninstall · 0 unchanged');
  assert.ok(installationReview(plan).sections.some((section) => section.title === 'Replace installed copies · 1'));
  await assert.rejects(install({ repo, plan, stageSkill: async (request) => {
    await writeFile(path.join(source, 'unreviewed.txt'), 'Unreviewed change');
    return stageSkill(request);
  } }), /changed after review/);
  assert.equal(await fingerprint(config), before);
});

test('reviewed installation rejects a staging adapter that returns different contents', async (t) => {
  const { repo, config } = await fixture(t);
  await makeSkill(repo);
  const plan = deploymentPlan({ repo, config, items: await inventory(repo, config), selected: new Set(['skills/demo']) });
  await assert.rejects(install({ repo, plan, stageSkill: async (request) => {
    const staged = await stageSkill(request);
    await writeFile(path.join(staged.directory, 'unreviewed.txt'), 'Unexpected staging output');
    return staged;
  } }), /staged contents differ/);
  assert.equal(await exists(path.join(config, 'skills/demo')), false);
  assert.equal(await exists(path.join(config, '.slop/manifest.json')), false);
});

test('a reviewed plan cannot be applied to another repository or destination', async (t) => {
  const { repo, config } = await fixture(t);
  await makeSkill(repo);
  const plan = deploymentPlan({ repo, config, items: await inventory(repo, config), selected: new Set(['skills/demo']) });
  await assert.rejects(install({ repo, config: `${config}-other`, plan, stageSkill }), /must match/);
  await assert.rejects(install({ repo: `${repo}-other`, plan, stageSkill }), /must match/);
});
