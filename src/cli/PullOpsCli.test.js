import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PullOpsCli } from './PullOpsCli.js';
import { WORKFLOW_OPERATIONS } from '../operations/operations.js';

/**
 * @typedef {import('./types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../github/types.js').PullOpsLabel} PullOpsLabel
 */

test('run operation accepts explicit workflow command shapes', async () => {
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  /** @type {OperationRunnerContext[]} */
  const calls = [];
  const cli = new PullOpsCli({
    stdout,
    stderr,
    operationRunner: async context => {
      calls.push(context);
      return {
        status: 'accepted',
        summary: 'operation accepted',
        operation: context.operation,
        target: context.target,
        modelTier: context.modelTier,
        model: context.model,
      };
    },
  });

  const exitCode = await cli.run(['run', 'implement-issue', '--issue', '42']);

  assert.equal(exitCode, 0);
  assert.equal(stderr.text, '');
  assert.deepEqual(
    calls.map(call => call.operation),
    ['implement-issue'],
  );
  assert.deepEqual(calls[0].target, { type: 'issue', number: 42 });
  assert.equal(calls[0].config.baseBranch, 'main');
  assert.equal(calls[0].modelTier, 'high');
  assert.equal(calls[0].phase, 'run');
  assert.equal(calls[0].runnerAdapter, 'codex-cli');
  assert.equal(calls[0].model, 'gpt-5.5');
  assert.deepEqual(JSON.parse(stdout.text), {
    status: 'accepted',
    summary: 'operation accepted',
    operation: 'implement-issue',
    target: { type: 'issue', number: 42 },
    modelTier: 'high',
    model: 'gpt-5.5',
  });
});

test('run operation accepts explicit Codex Action lifecycle arguments', async () => {
  const stdout = createWritableBuffer();
  /** @type {OperationRunnerContext[]} */
  const calls = [];
  const cli = new PullOpsCli({
    stdout,
    env: {
      OUTPUT_DIR: '/tmp/pullops-output',
      PULLOPS_CODEX_ACTION_OUTCOME: 'success',
    },
    operationRunner: async context => {
      calls.push(context);
      return {
        status: 'accepted',
        summary: 'operation accepted',
      };
    },
  });

  const exitCode = await cli.run([
    'run',
    'implement-issue',
    '--phase',
    'finalize',
    '--runner',
    'codex-action',
    '--runner-ran',
    'true',
    '--issue',
    '42',
  ]);

  assert.equal(exitCode, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].phase, 'finalize');
  assert.equal(calls[0].runnerAdapter, 'codex-action');
  assert.equal(calls[0].runnerRan, true);
  assert.equal(calls[0].outputDirectory, '/tmp/pullops-output');
  assert.equal(calls[0].codexActionOutcome, 'success');
  assert.deepEqual(JSON.parse(stdout.text), {
    status: 'accepted',
    summary: 'operation accepted',
  });
});

test('run operation accepts every workflow-facing operation shape', async () => {
  for (const operation of WORKFLOW_OPERATIONS) {
    /** @type {OperationRunnerContext[]} */
    const calls = [];
    const cli = new PullOpsCli({
      stdout: createWritableBuffer(),
      operationRunner: async context => {
        calls.push(context);
        return {
          status: 'accepted',
          summary: 'operation accepted',
        };
      },
    });

    const exitCode = await cli.run([
      'run',
      operation.name,
      `--${operation.option}`,
      operation.target === 'issue' ? '123' : '456',
    ]);

    assert.equal(exitCode, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].operation, operation.name);
    assert.equal(calls[0].phase, 'run');
    assert.equal(calls[0].runnerAdapter, 'codex-cli');
    assert.equal(calls[0].target.type, operation.target);
  }
});

test('run operation accepts explicit local runner override', async () => {
  /** @type {OperationRunnerContext[]} */
  const calls = [];
  const cli = new PullOpsCli({
    stdout: createWritableBuffer(),
    operationRunner: async context => {
      calls.push(context);
      return {
        status: 'accepted',
        summary: 'operation accepted',
      };
    },
  });

  const exitCode = await cli.run([
    'run',
    'implement-issue',
    '--runner',
    'codex-cli',
    '--issue',
    '42',
  ]);

  assert.equal(exitCode, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].phase, 'run');
  assert.equal(calls[0].runnerAdapter, 'codex-cli');
});

test('labels ensure reports label reconciliation results from the GitHub client seam', async () => {
  const stdout = createWritableBuffer();
  /** @type {PullOpsLabel[]} */
  const ensuredLabels = [];
  const cli = new PullOpsCli({
    stdout,
    githubClient: createFakeGitHubClient({
      async ensureLabels(labels) {
        ensuredLabels.push(...labels);
        return {
          created: [labels[0].name],
          updated: [labels[1].name],
          alreadyCorrect: labels.slice(2).map(label => label.name),
        };
      },
    }),
  });

  const exitCode = await cli.run(['labels', 'ensure']);

  assert.equal(exitCode, 0);
  assert.equal(
    ensuredLabels.some(label => label.name === 'pullops:prd:prepare'),
    true,
  );
  assert.equal(
    ensuredLabels.some(label => label.name === 'pullops:issue:implement'),
    true,
  );
  assert.equal(
    ensuredLabels.some(label => label.name === 'pullops:prd:coordinate'),
    true,
  );
  assert.equal(
    ensuredLabels.some(label => label.name === 'pullops:status:blocked'),
    true,
  );
  assert.equal(
    ensuredLabels.some(label => label.name === 'pullops:status:prepared'),
    true,
  );
  assert.equal(
    ensuredLabels.some(label => label.name === 'pullops:status:done'),
    true,
  );
  assert.equal(
    ensuredLabels.some(label => label.name === 'pullops:status:failed'),
    true,
  );
  const expectedLabels = {
    created: [ensuredLabels[0].name],
    updated: [ensuredLabels[1].name],
    alreadyCorrect: ensuredLabels.slice(2).map(label => label.name),
  };
  assert.deepEqual(JSON.parse(stdout.text), {
    status: 'accepted',
    summary: 'Ensured 14 PullOps labels: 1 created, 1 updated, 12 already correct.',
    labels: expectedLabels,
  });
});

test('labels ensure reports GitHub failures', async () => {
  const stderr = createWritableBuffer();
  const cli = new PullOpsCli({
    stderr,
    githubClient: createFakeGitHubClient({
      async ensureLabels() {
        throw new Error('Failed to list GitHub labels: authentication required');
      },
    }),
  });

  const exitCode = await cli.run(['labels', 'ensure']);

  assert.equal(exitCode, 1);
  assert.match(stderr.text, /Failed to list GitHub labels: authentication required/);
});

test('cli reports clear usage errors for unknown commands and missing arguments', async t => {
  await t.test('unknown command', async () => {
    const stderr = createWritableBuffer();
    const cli = new PullOpsCli({ stderr });

    const exitCode = await cli.run(['unknown']);

    assert.equal(exitCode, 1);
    assert.match(stderr.text, /Unknown command "unknown"/);
  });

  await t.test('unknown operation', async () => {
    const stderr = createWritableBuffer();
    const cli = new PullOpsCli({ stderr });

    const exitCode = await cli.run(['run', 'nope', '--issue', '1']);

    assert.equal(exitCode, 1);
    assert.match(stderr.text, /Unknown operation "nope"/);
  });

  await t.test('missing target number', async () => {
    const stderr = createWritableBuffer();
    const cli = new PullOpsCli({ stderr });

    const exitCode = await cli.run(['run', 'review-pr']);

    assert.equal(exitCode, 1);
    assert.match(stderr.text, /Missing required argument "--pr <number>"/);
  });

  await t.test('old runner-coupled phase names are rejected', async () => {
    const stderr = createWritableBuffer();
    const cli = new PullOpsCli({ stderr });

    const exitCode = await cli.run([
      'run',
      'implement-issue',
      '--phase',
      'prepare-codex',
      '--issue',
      '1',
    ]);

    assert.equal(exitCode, 1);
    assert.match(stderr.text, /Unknown phase "prepare-codex"/);
  });

  await t.test('codex-action requires an explicit lifecycle phase', async () => {
    const stderr = createWritableBuffer();
    const cli = new PullOpsCli({ stderr });

    const exitCode = await cli.run([
      'run',
      'implement-issue',
      '--runner',
      'codex-action',
      '--issue',
      '1',
    ]);

    assert.equal(exitCode, 1);
    assert.match(stderr.text, /requires "--phase prepare" or "--phase finalize"/);
  });

  await t.test('codex-action finalize requires runner-ran state', async () => {
    const stderr = createWritableBuffer();
    const cli = new PullOpsCli({ stderr });

    const exitCode = await cli.run([
      'run',
      'implement-issue',
      '--runner',
      'codex-action',
      '--phase',
      'finalize',
      '--issue',
      '1',
    ]);

    assert.equal(exitCode, 1);
    assert.match(stderr.text, /requires "--runner-ran <true\|false>"/);
  });

  await t.test('local runner rejects workflow-only phases', async () => {
    const stderr = createWritableBuffer();
    const cli = new PullOpsCli({ stderr });

    const exitCode = await cli.run([
      'run',
      'implement-issue',
      '--runner',
      'codex-cli',
      '--phase',
      'prepare',
      '--issue',
      '1',
    ]);

    assert.equal(exitCode, 1);
    assert.match(stderr.text, /only supports the default run phase/);
  });
});

function createWritableBuffer() {
  return {
    text: '',
    /**
     * @param {string} chunk
     */
    write(chunk) {
      this.text += chunk;
    },
  };
}

/**
 * @param {Partial<import('../github/types.js').GitHubClient>} overrides
 * @returns {import('../github/types.js').GitHubClient}
 */
function createFakeGitHubClient(overrides = {}) {
  return {
    async ensureLabels() {
      return {
        created: [],
        updated: [],
        alreadyCorrect: [],
      };
    },
    async getIssue() {
      throw new Error('getIssue was not expected in this test.');
    },
    async getPullRequest() {
      throw new Error('getPullRequest was not expected in this test.');
    },
    async getPullRequestChecks() {
      throw new Error('getPullRequestChecks was not expected in this test.');
    },
    async getPullRequestReviewContext() {
      throw new Error('getPullRequestReviewContext was not expected in this test.');
    },
    async getPullRequestDiff() {
      throw new Error('getPullRequestDiff was not expected in this test.');
    },
    async findOpenPullRequestByHead() {
      throw new Error('findOpenPullRequestByHead was not expected in this test.');
    },
    async createDraftPullRequest() {
      throw new Error('createDraftPullRequest was not expected in this test.');
    },
    async addLabelsToIssue() {
      throw new Error('addLabelsToIssue was not expected in this test.');
    },
    async removeLabelsFromIssue() {
      throw new Error('removeLabelsFromIssue was not expected in this test.');
    },
    async addLabelsToPullRequest() {
      throw new Error('addLabelsToPullRequest was not expected in this test.');
    },
    async removeLabelsFromPullRequest() {
      throw new Error('removeLabelsFromPullRequest was not expected in this test.');
    },
    async commentOnIssue() {
      throw new Error('commentOnIssue was not expected in this test.');
    },
    async commentOnPullRequest() {
      throw new Error('commentOnPullRequest was not expected in this test.');
    },
    async updatePullRequestBody() {
      throw new Error('updatePullRequestBody was not expected in this test.');
    },
    async publishPullRequestReview() {
      throw new Error('publishPullRequestReview was not expected in this test.');
    },
    async replyToPullRequestReviewComment() {
      throw new Error('replyToPullRequestReviewComment was not expected in this test.');
    },
    ...overrides,
  };
}
