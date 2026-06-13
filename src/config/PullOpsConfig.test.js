import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { loadPullOpsConfig } from './PullOpsConfig.js';

test('loadPullOpsConfig returns defaults when no config file exists', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pullops-config-defaults-'));

  const config = await loadPullOpsConfig({ cwd });

  assert.equal(config.baseBranch, 'main');
  assert.equal(config.branchPrefix, 'pullops');
  assert.equal(config.runner.provider, 'codex');
  assert.equal(config.runner.command, 'codex exec');
  assert.deepEqual(config.runner.models, {
    high: 'codex-high',
    mid: 'codex-mid',
    low: 'codex-low',
  });
  assert.equal(config.operations.preparePrd.modelTier, 'low');
  assert.equal(config.operations.implementIssue.modelTier, 'high');
  assert.equal(config.operations.coordinatePrd.modelTier, 'low');
  assert.equal(config.operations.fixCi.modelTier, 'mid');
  assert.equal(config.operations.updateBranch.modelTier, 'low');
});

test('loadPullOpsConfig loads JavaScript config and merges with defaults', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pullops-config-custom-'));
  await writeFile(
    join(cwd, 'pullops.config.js'),
    `
      export default {
        baseBranch: 'trunk',
        branchPrefix: 'automation/pullops',
        runner: {
          command: 'codex exec --sandbox workspace-write',
          models: {
            high: 'model-high',
            mid: 'model-mid',
            low: 'model-low',
          },
        },
        operations: {
          reviewPr: { modelTier: 'low' },
        },
      };
    `,
  );

  const config = await loadPullOpsConfig({ cwd });

  assert.equal(config.baseBranch, 'trunk');
  assert.equal(config.branchPrefix, 'automation/pullops');
  assert.equal(config.runner.provider, 'codex');
  assert.equal(config.runner.command, 'codex exec --sandbox workspace-write');
  assert.deepEqual(config.runner.models, {
    high: 'model-high',
    mid: 'model-mid',
    low: 'model-low',
  });
  assert.equal(config.operations.reviewPr.modelTier, 'low');
  assert.equal(config.operations.implementIssue.modelTier, 'high');
  assert.equal(config.operations.preparePrd.modelTier, 'low');
});

test('loadPullOpsConfig rejects partial model-tier overrides', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pullops-config-partial-models-'));
  await writeFile(
    join(cwd, 'pullops.config.js'),
    `
      export default {
        runner: {
          models: {
            high: 'model-high',
          },
        },
      };
    `,
  );

  await assert.rejects(
    loadPullOpsConfig({ cwd }),
    /runner\.models must override all model tiers .* missing mid, low/,
  );
});

test('loadPullOpsConfig rejects unknown operation model tiers', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pullops-config-unknown-tier-'));
  await writeFile(
    join(cwd, 'pullops.config.js'),
    `
      export default {
        operations: {
          reviewPr: { modelTier: 'tiny' },
        },
      };
    `,
  );

  await assert.rejects(
    loadPullOpsConfig({ cwd }),
    /operations\.reviewPr\.modelTier must be one of: high, mid, low/,
  );
});
