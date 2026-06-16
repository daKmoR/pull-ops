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
  assert.equal(config.runner.adapter, 'codex-cli');
  assert.equal(config.runner.command, 'codex exec');
  assert.deepEqual(config.runner.models, {
    high: 'gpt-5.5',
    mid: 'gpt-5.4-mini',
    low: 'gpt-5.4-mini',
  });
  assert.equal(config.operations.prdPrepare.modelTier, 'low');
  assert.equal(config.operations.issueImplement.modelTier, 'high');
  assert.equal(config.operations.prdCoordinate.modelTier, 'low');
  assert.equal(config.operations.prdAutoAdvance.modelTier, 'low');
  assert.equal(config.operations.prdAutoComplete.modelTier, 'low');
  assert.equal(config.operations.prFixCi.modelTier, 'mid');
  assert.equal(config.operations.prUpdateBranch.modelTier, 'low');
  assert.equal(config.operations.prResolveConflicts.modelTier, 'high');
  assert.equal(config.operations.prResolveConflicts.maxConflictResolutionPasses, 3);
  assert.equal(config.operations.prFinalize.aiHistoryCleanup, true);
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
          adapter: 'codex-action',
          command: 'codex exec --sandbox workspace-write',
          models: {
            high: 'model-high',
            mid: 'model-mid',
            low: 'model-low',
          },
        },
        operations: {
          prReview: { modelTier: 'low' },
          prResolveConflicts: { maxConflictResolutionPasses: 5 },
          prFinalize: { aiHistoryCleanup: false },
        },
      };
    `,
  );

  const config = await loadPullOpsConfig({ cwd });

  assert.equal(config.baseBranch, 'trunk');
  assert.equal(config.branchPrefix, 'automation/pullops');
  assert.equal(config.runner.adapter, 'codex-action');
  assert.equal(config.runner.command, 'codex exec --sandbox workspace-write');
  assert.deepEqual(config.runner.models, {
    high: 'model-high',
    mid: 'model-mid',
    low: 'model-low',
  });
  assert.equal(config.operations.prReview.modelTier, 'low');
  assert.equal(config.operations.prResolveConflicts.modelTier, 'high');
  assert.equal(config.operations.prResolveConflicts.maxConflictResolutionPasses, 5);
  assert.equal(config.operations.prFinalize.modelTier, 'high');
  assert.equal(config.operations.prFinalize.aiHistoryCleanup, false);
  assert.equal(config.operations.issueImplement.modelTier, 'high');
  assert.equal(config.operations.prdPrepare.modelTier, 'low');
});

test('loadPullOpsConfig rejects unknown runner adapters', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pullops-config-unknown-adapter-'));
  await writeFile(
    join(cwd, 'pullops.config.js'),
    `
      export default {
        runner: {
          adapter: 'codex-cloud',
        },
      };
    `,
  );

  await assert.rejects(
    loadPullOpsConfig({ cwd }),
    /runner\.adapter must be one of: codex-cli, codex-action/,
  );
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
          prReview: { modelTier: 'tiny' },
        },
      };
    `,
  );

  await assert.rejects(
    loadPullOpsConfig({ cwd }),
    /operations\.prReview\.modelTier must be one of: high, mid, low/,
  );
});

test('loadPullOpsConfig rejects non-boolean pr-finalize AI history cleanup config', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pullops-config-pr-finalize-ai-history-cleanup-'));
  await writeFile(
    join(cwd, 'pullops.config.js'),
    `
      export default {
        operations: {
          prFinalize: { aiHistoryCleanup: 'false' },
        },
      };
    `,
  );

  await assert.rejects(
    loadPullOpsConfig({ cwd }),
    /operations\.prFinalize\.aiHistoryCleanup must be a boolean/,
  );
});

test('loadPullOpsConfig rejects invalid pr-resolve-conflicts pass budget config', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pullops-config-pr-resolve-conflicts-budget-'));
  await writeFile(
    join(cwd, 'pullops.config.js'),
    `
      export default {
        operations: {
          prResolveConflicts: { maxConflictResolutionPasses: 0 },
        },
      };
    `,
  );

  await assert.rejects(
    loadPullOpsConfig({ cwd }),
    /operations\.prResolveConflicts\.maxConflictResolutionPasses must be a positive integer/,
  );
});
