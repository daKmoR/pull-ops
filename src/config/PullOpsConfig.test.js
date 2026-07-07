import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  getOperationCatalogDefaultOperationSettings,
  getOperationCatalogWorkflowOperations,
} from '../operations/operationCatalog.js';
import { DEFAULT_PULL_OPS_CONFIG, loadPullOpsConfig } from './PullOpsConfig.js';

test('DEFAULT_PULL_OPS_CONFIG derives operation defaults from the catalog workflow entries', () => {
  const expectedOperationDefaults = /** @type {Record<string, unknown>} */ ({});

  for (const operation of getOperationCatalogWorkflowOperations()) {
    const defaultOperationSettings = getOperationCatalogDefaultOperationSettings(operation.name);
    if (defaultOperationSettings === undefined) {
      throw new Error(`${operation.name} defaults are missing from the operation catalog.`);
    }

    expectedOperationDefaults[operation.configKey] = defaultOperationSettings;
  }

  assert.deepEqual(
    DEFAULT_PULL_OPS_CONFIG.operations,
    /** @type {typeof DEFAULT_PULL_OPS_CONFIG.operations} */ (expectedOperationDefaults),
  );
});

test('loadPullOpsConfig returns defaults and infers GitHub issue store when a GitHub remote exists', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pullops-config-defaults-'));

  const config = await loadPullOpsConfig({
    cwd,
    env: {},
    readRemoteOriginUrl: () => 'git@github.com:acme/widgets.git',
  });

  assert.equal(config.baseBranch, 'main');
  assert.equal(config.branchPrefix, 'pullops');
  assert.equal(config.issueStore.provider, 'github');
  assert.equal(config.runner.adapter, 'codex-cli');
  assert.equal(config.runner.command, 'codex exec');
  assert.deepEqual(config.runner.models, {
    high: 'gpt-5.5',
    mid: 'gpt-5.4',
    low: 'gpt-5.4-mini',
  });
  assert.equal(config.operations.prdPrepare.modelTier, 'low');
  assert.equal(config.operations.issueImplement.modelTier, 'high');
  assert.deepEqual(
    config.operations.prdAutoAdvance,
    getOperationCatalogDefaultOperationSettings('prd-auto-advance'),
  );
  assert.deepEqual(
    config.operations.prdAutoComplete,
    getOperationCatalogDefaultOperationSettings('prd-auto-complete'),
  );
  assert.equal(config.operations.prFixCi.modelTier, 'mid');
  assert.equal(config.operations.prUpdateBranch.modelTier, 'low');
  assert.equal(config.operations.prResolveConflicts.modelTier, 'high');
  assert.equal(config.operations.prResolveConflicts.maxConflictResolutionPasses, 3);
  assert.equal(config.operations.prFinalize.aiHistoryCleanup, true);
  assert.equal(config.operations.prCloseChildIssue.modelTier, 'low');
  assert.deepEqual(
    config.operations.prFixCi,
    getOperationCatalogDefaultOperationSettings('pr-fix-ci'),
  );
  assert.deepEqual(
    config.operations.prUpdateBranch,
    getOperationCatalogDefaultOperationSettings('pr-update-branch'),
  );
  assert.deepEqual(
    config.operations.prResolveConflicts,
    getOperationCatalogDefaultOperationSettings('pr-resolve-conflicts'),
  );
  assert.deepEqual(
    config.operations.prReview,
    getOperationCatalogDefaultOperationSettings('pr-review'),
  );
  assert.deepEqual(
    config.operations.prAddressReview,
    getOperationCatalogDefaultOperationSettings('pr-address-review'),
  );
  assert.deepEqual(
    config.operations.prFinalize,
    getOperationCatalogDefaultOperationSettings('pr-finalize'),
  );
  assert.deepEqual(
    config.operations.prCloseChildIssue,
    getOperationCatalogDefaultOperationSettings('pr-close-child-issue'),
  );
});

test('loadPullOpsConfig keeps issue store provider explicit when no GitHub remote is known', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pullops-config-no-issue-store-default-'));

  const config = await loadPullOpsConfig({
    cwd,
    env: {},
    readRemoteOriginUrl: () => undefined,
  });

  assert.equal(config.baseBranch, 'main');
  assert.equal(config.branchPrefix, 'pullops');
  assert.equal(config.issueStore.provider, undefined);
});

test('loadPullOpsConfig loads JavaScript config and merges with defaults', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pullops-config-custom-'));
  await writeFile(
    join(cwd, 'pullops.config.js'),
    `
      export default {
        baseBranch: 'trunk',
        branchPrefix: 'automation/pullops',
        issueStore: {
          provider: 'github',
        },
        runner: {
          adapter: 'external',
          command: 'codex exec --sandbox workspace-write',
          models: {
            high: 'model-high',
            mid: 'model-mid',
            low: 'model-low',
          },
        },
        operations: {
          prReview: {
            modelTier: 'low',
            escalationModelTier: 'mid',
            humanFeedbackResponseModelTier: 'high',
          },
          prAddressReview: {
            modelTier: 'mid',
            escalationModelTier: 'high',
            humanFeedbackResponseModelTier: 'low',
          },
          prResolveConflicts: { maxConflictResolutionPasses: 5 },
          prFinalize: { aiHistoryCleanup: false },
        },
      };
    `,
  );

  const config = await loadPullOpsConfig({ cwd });

  assert.equal(config.baseBranch, 'trunk');
  assert.equal(config.branchPrefix, 'automation/pullops');
  assert.equal(config.issueStore.provider, 'github');
  assert.equal(config.runner.adapter, 'external');
  assert.equal(config.runner.command, 'codex exec --sandbox workspace-write');
  assert.deepEqual(config.runner.models, {
    high: 'model-high',
    mid: 'model-mid',
    low: 'model-low',
  });
  assert.equal(config.operations.prReview.modelTier, 'low');
  assert.equal(config.operations.prReview.escalationModelTier, 'mid');
  assert.equal(config.operations.prReview.humanFeedbackResponseModelTier, 'high');
  assert.equal(config.operations.prAddressReview.modelTier, 'mid');
  assert.equal(config.operations.prAddressReview.escalationModelTier, 'high');
  assert.equal(config.operations.prAddressReview.humanFeedbackResponseModelTier, 'low');
  assert.deepEqual(
    config.operations.prFixCi,
    getOperationCatalogDefaultOperationSettings('pr-fix-ci'),
  );
  assert.deepEqual(
    config.operations.prUpdateBranch,
    getOperationCatalogDefaultOperationSettings('pr-update-branch'),
  );
  assert.equal(config.operations.prResolveConflicts.modelTier, 'high');
  assert.equal(config.operations.prResolveConflicts.maxConflictResolutionPasses, 5);
  assert.equal(config.operations.prFixCi.modelTier, 'mid');
  assert.equal(config.operations.prUpdateBranch.modelTier, 'low');
  assert.equal(config.operations.prFinalize.modelTier, 'high');
  assert.equal(config.operations.prFinalize.aiHistoryCleanup, false);
  assert.equal(config.operations.prCloseChildIssue.modelTier, 'low');
  assert.equal(config.operations.issueImplement.modelTier, 'high');
  assert.equal(config.operations.prdPrepare.modelTier, 'low');
});

test('loadPullOpsConfig defaults model tiers to Claude models for claude Runner Commands', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pullops-config-claude-models-'));
  await writeFile(
    join(cwd, 'pullops.config.js'),
    `
      export default {
        runner: {
          command: 'claude --permission-mode bypassPermissions',
        },
      };
    `,
  );

  const config = await loadPullOpsConfig({ cwd });

  assert.equal(config.runner.adapter, 'codex-cli');
  assert.equal(config.runner.command, 'claude --permission-mode bypassPermissions');
  assert.deepEqual(config.runner.models, {
    high: 'claude-opus-4-8',
    mid: 'claude-sonnet-5',
    low: 'claude-haiku-4-5',
  });
});

test('loadPullOpsConfig keeps configured models for claude Runner Commands', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pullops-config-claude-model-overrides-'));
  await writeFile(
    join(cwd, 'pullops.config.js'),
    `
      export default {
        runner: {
          command: 'claude',
          models: {
            high: 'claude-model-high',
            mid: 'claude-model-mid',
            low: 'claude-model-low',
          },
        },
      };
    `,
  );

  const config = await loadPullOpsConfig({ cwd });

  assert.deepEqual(config.runner.models, {
    high: 'claude-model-high',
    mid: 'claude-model-mid',
    low: 'claude-model-low',
  });
});

test('loadPullOpsConfig accepts a runner args template and rejects invalid ones', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pullops-config-args-template-'));
  await writeFile(
    join(cwd, 'pullops.config.js'),
    `
      export default {
        runner: {
          command: 'my-agent chat',
          argsTemplate: ['--model', '{model}', '--message', '{prompt}'],
        },
      };
    `,
  );

  const config = await loadPullOpsConfig({ cwd });

  assert.deepEqual(config.runner.argsTemplate, ['--model', '{model}', '--message', '{prompt}']);
  assert.equal(DEFAULT_PULL_OPS_CONFIG.runner.argsTemplate, undefined);

  const invalidCwd = await mkdtemp(join(tmpdir(), 'pullops-config-args-template-invalid-'));
  await writeFile(
    join(invalidCwd, 'pullops.config.js'),
    `
      export default {
        runner: {
          argsTemplate: ['--model', ''],
        },
      };
    `,
  );

  await assert.rejects(
    loadPullOpsConfig({ cwd: invalidCwd }),
    /runner\.argsTemplate must be a non-empty array of non-empty strings/,
  );
});

test('loadPullOpsConfig defaults and overrides the Run Budget', async () => {
  assert.deepEqual(DEFAULT_PULL_OPS_CONFIG.runBudget, {
    maxUsedTokens: 2_000_000,
    maxDurationMs: 4 * 60 * 60 * 1000,
  });

  const cwd = await mkdtemp(join(tmpdir(), 'pullops-config-run-budget-'));
  await writeFile(
    join(cwd, 'pullops.config.js'),
    `
      export default {
        runBudget: {
          maxUsedTokens: 500000,
        },
      };
    `,
  );

  const config = await loadPullOpsConfig({ cwd });

  assert.equal(config.runBudget.maxUsedTokens, 500000);
  assert.equal(config.runBudget.maxDurationMs, 4 * 60 * 60 * 1000);
});

test('loadPullOpsConfig rejects invalid Run Budget values', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pullops-config-run-budget-invalid-'));
  await writeFile(
    join(cwd, 'pullops.config.js'),
    `
      export default {
        runBudget: {
          maxDurationMs: -5,
        },
      };
    `,
  );

  await assert.rejects(
    loadPullOpsConfig({ cwd }),
    /runBudget\.maxDurationMs must be a positive integer/,
  );
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
    /runner\.adapter must be one of: codex-cli, external/,
  );
});

test('loadPullOpsConfig rejects unknown operation keys', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pullops-config-unknown-operation-key-'));
  await writeFile(
    join(cwd, 'pullops.config.js'),
    `
      export default {
        operations: {
          issueImplement: { modelTier: 'mid' },
          notARealOperation: { modelTier: 'high' },
        },
      };
    `,
  );

  await assert.rejects(
    loadPullOpsConfig({ cwd }),
    /operations contains unknown operation keys: notARealOperation/,
  );
});

test('loadPullOpsConfig rejects unsupported issue store providers', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pullops-config-unknown-issue-store-provider-'));
  await writeFile(
    join(cwd, 'pullops.config.js'),
    `
      export default {
        issueStore: {
          provider: 'local-markdown',
        },
      };
    `,
  );

  await assert.rejects(loadPullOpsConfig({ cwd }), /issueStore\.provider must be one of: github/);
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

test('loadPullOpsConfig rejects invalid pr-review escalation model tiers', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pullops-config-invalid-pr-review-escalation-tier-'));
  await writeFile(
    join(cwd, 'pullops.config.js'),
    `
      export default {
        operations: {
          prReview: { escalationModelTier: 'tiny' },
        },
      };
    `,
  );

  await assert.rejects(
    loadPullOpsConfig({ cwd }),
    /operations\.prReview\.escalationModelTier must be one of: high, mid, low/,
  );
});

test('loadPullOpsConfig rejects invalid pr-address-review human feedback response model tiers', async () => {
  const cwd = await mkdtemp(
    join(tmpdir(), 'pullops-config-invalid-pr-address-review-human-feedback-tier-'),
  );
  await writeFile(
    join(cwd, 'pullops.config.js'),
    `
      export default {
        operations: {
          prAddressReview: { humanFeedbackResponseModelTier: 'tiny' },
        },
      };
    `,
  );

  await assert.rejects(
    loadPullOpsConfig({ cwd }),
    /operations\.prAddressReview\.humanFeedbackResponseModelTier must be one of: high, mid, low/,
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
