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

  const exitCode = await cli.run(['run', 'issue-implement', '--issue', '42']);

  assert.equal(exitCode, 0);
  assert.equal(stderr.text, '');
  assert.deepEqual(
    calls.map(call => call.operation),
    ['issue-implement'],
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
    operation: 'issue-implement',
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
    'issue-implement',
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

test('run operation dispatches short operation label references through GitHub Actions labels', async () => {
  const stdout = createWritableBuffer();
  /** @type {import('../github/types.js').EditLabelsOptions[]} */
  const issueLabelAdds = [];
  /** @type {import('../github/types.js').EditLabelsOptions[]} */
  const pullRequestLabelAdds = [];
  /** @type {OperationRunnerContext[]} */
  const runnerCalls = [];
  const cli = new PullOpsCli({
    stdout,
    githubClient: createFakeGitHubClient({
      async addLabelsToIssue(options) {
        issueLabelAdds.push(options);
      },
      async addLabelsToPullRequest(options) {
        pullRequestLabelAdds.push(options);
      },
    }),
    operationRunner: async context => {
      runnerCalls.push(context);
      return {
        status: 'accepted',
        summary: 'operation accepted',
      };
    },
  });

  const exitCode = await cli.run(['run', 'issue:implement', '123', '--backend', 'github-actions']);

  assert.equal(exitCode, 0);
  assert.deepEqual(issueLabelAdds, [{ number: 123, labels: ['pullops:issue:implement'] }]);
  assert.deepEqual(pullRequestLabelAdds, []);
  assert.deepEqual(runnerCalls, []);
  assert.deepEqual(JSON.parse(stdout.text), {
    status: 'accepted',
    summary: 'Applied pullops:issue:implement to issue #123.',
    operation: 'pullops:issue:implement',
    target: { type: 'issue', number: 123 },
    backend: 'github-actions',
  });
});

test('run issue:implement defaults to local dry-run operation execution', async () => {
  const stdout = createWritableBuffer();
  /** @type {import('../github/types.js').EditLabelsOptions[]} */
  const issueLabelAdds = [];
  /** @type {OperationRunnerContext[]} */
  const runnerCalls = [];
  const cli = new PullOpsCli({
    stdout,
    githubClient: createFakeGitHubClient({
      async addLabelsToIssue(options) {
        issueLabelAdds.push(options);
      },
    }),
    operationRunner: async context => {
      runnerCalls.push(context);
      return {
        status: 'accepted',
        summary: 'local dry-run accepted',
        publicationMode: context.publicationMode,
        target: context.target,
      };
    },
  });

  const exitCode = await cli.run(['run', 'issue:implement', '123']);

  assert.equal(exitCode, 0);
  assert.deepEqual(issueLabelAdds, []);
  assert.equal(runnerCalls.length, 1);
  assert.equal(runnerCalls[0].operation, 'issue-implement');
  assert.equal(runnerCalls[0].executionBackend, 'local');
  assert.equal(runnerCalls[0].publicationMode, 'dry-run');
  assert.equal(runnerCalls[0].runGoal, 'operation');
  assert.equal(runnerCalls[0].runnerAdapter, 'codex-cli');
  assert.deepEqual(runnerCalls[0].target, { type: 'issue', number: 123 });
  assert.deepEqual(JSON.parse(stdout.text), {
    status: 'accepted',
    summary: 'local dry-run accepted',
    publicationMode: 'dry-run',
    target: { type: 'issue', number: 123 },
  });
});

test('run issue:implement accepts local PR publication', async () => {
  const stdout = createWritableBuffer();
  /** @type {OperationRunnerContext[]} */
  const runnerCalls = [];
  const cli = new PullOpsCli({
    stdout,
    operationRunner: async context => {
      runnerCalls.push(context);
      return {
        status: 'accepted',
        summary: 'local PR publication accepted',
        publicationMode: context.publicationMode,
        target: context.target,
      };
    },
  });

  const exitCode = await cli.run(['run', 'issue:implement', '123', '--publish', 'pr']);

  assert.equal(exitCode, 0);
  assert.equal(runnerCalls.length, 1);
  assert.equal(runnerCalls[0].executionBackend, 'local');
  assert.equal(runnerCalls[0].publicationMode, 'publish');
  assert.deepEqual(JSON.parse(stdout.text), {
    status: 'accepted',
    summary: 'local PR publication accepted',
    publicationMode: 'publish',
    target: { type: 'issue', number: 123 },
  });
});

test('run prd:auto-advance accepts local PR publication', async () => {
  const stdout = createWritableBuffer();
  /** @type {OperationRunnerContext[]} */
  const runnerCalls = [];
  const cli = new PullOpsCli({
    stdout,
    operationRunner: async context => {
      runnerCalls.push(context);
      return {
        status: 'accepted',
        summary: 'local PRD auto-advance accepted',
        publicationMode: context.publicationMode,
        target: context.target,
      };
    },
  });

  const exitCode = await cli.run(['run', 'prd:auto-advance', '123', '--publish', 'pr']);

  assert.equal(exitCode, 0);
  assert.equal(runnerCalls.length, 1);
  assert.equal(runnerCalls[0].operation, 'prd-auto-advance');
  assert.equal(runnerCalls[0].executionBackend, 'local');
  assert.equal(runnerCalls[0].publicationMode, 'publish');
  assert.equal(runnerCalls[0].runnerAdapter, 'codex-cli');
  assert.deepEqual(runnerCalls[0].target, { type: 'issue', number: 123 });
  assert.deepEqual(JSON.parse(stdout.text), {
    status: 'accepted',
    summary: 'local PRD auto-advance accepted',
    publicationMode: 'publish',
    target: { type: 'issue', number: 123 },
  });
});

test('run prd:auto-complete accepts local PR publication', async () => {
  const stdout = createWritableBuffer();
  /** @type {OperationRunnerContext[]} */
  const runnerCalls = [];
  const cli = new PullOpsCli({
    stdout,
    operationRunner: async context => {
      runnerCalls.push(context);
      return {
        status: 'accepted',
        summary: 'local PRD auto-complete accepted',
        publicationMode: context.publicationMode,
        target: context.target,
      };
    },
  });

  const exitCode = await cli.run(['run', 'prd:auto-complete', '123', '--publish', 'pr']);

  assert.equal(exitCode, 0);
  assert.equal(runnerCalls.length, 1);
  assert.equal(runnerCalls[0].operation, 'prd-auto-complete');
  assert.equal(runnerCalls[0].executionBackend, 'local');
  assert.equal(runnerCalls[0].publicationMode, 'publish');
  assert.equal(runnerCalls[0].runnerAdapter, 'codex-cli');
  assert.deepEqual(runnerCalls[0].target, { type: 'issue', number: 123 });
  assert.deepEqual(JSON.parse(stdout.text), {
    status: 'accepted',
    summary: 'local PRD auto-complete accepted',
    publicationMode: 'publish',
    target: { type: 'issue', number: 123 },
  });
});

test('run operation accepts every short operation label reference and infers target kind', async () => {
  const cases = [
    ['prd:prepare', 'pullops:prd:prepare', 'issue'],
    ['prd:auto-advance', 'pullops:prd:auto-advance', 'issue'],
    ['prd:auto-complete', 'pullops:prd:auto-complete', 'issue'],
    ['issue:implement', 'pullops:issue:implement', 'issue'],
    ['pr:review', 'pullops:pr:review', 'pr'],
    ['pr:address-review', 'pullops:pr:address-review', 'pr'],
    ['pr:fix-ci', 'pullops:pr:fix-ci', 'pr'],
    ['pr:update-branch', 'pullops:pr:update-branch', 'pr'],
    ['pr:resolve-conflicts', 'pullops:pr:resolve-conflicts', 'pr'],
    ['pr:finalize', 'pullops:pr:finalize', 'pr'],
  ];

  for (const [reference, expectedLabel, expectedTarget] of cases) {
    /** @type {import('../github/types.js').EditLabelsOptions[]} */
    const issueLabelAdds = [];
    /** @type {import('../github/types.js').EditLabelsOptions[]} */
    const pullRequestLabelAdds = [];
    const cli = new PullOpsCli({
      stdout: createWritableBuffer(),
      githubClient: createFakeGitHubClient({
        async addLabelsToIssue(options) {
          issueLabelAdds.push(options);
        },
        async addLabelsToPullRequest(options) {
          pullRequestLabelAdds.push(options);
        },
      }),
    });

    const exitCode = await cli.run(['run', reference, '321', '--backend', 'github-actions']);

    assert.equal(exitCode, 0);
    if (expectedTarget === 'issue') {
      assert.deepEqual(issueLabelAdds, [{ number: 321, labels: [expectedLabel] }]);
      assert.deepEqual(pullRequestLabelAdds, []);
    } else {
      assert.deepEqual(issueLabelAdds, []);
      assert.deepEqual(pullRequestLabelAdds, [{ number: 321, labels: [expectedLabel] }]);
    }
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
    'issue-implement',
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

test('run operation reports usage errors for invalid GitHub Actions label reference commands', async t => {
  await t.test('unknown short reference', async () => {
    const stderr = createWritableBuffer();
    const cli = new PullOpsCli({ stderr });

    const exitCode = await cli.run(['run', 'issue:nope', '123', '--backend', 'github-actions']);

    assert.equal(exitCode, 1);
    assert.match(stderr.text, /Unknown operation label reference "issue:nope"/);
  });

  await t.test('full canonical label input', async () => {
    const stderr = createWritableBuffer();
    const cli = new PullOpsCli({ stderr });

    const exitCode = await cli.run([
      'run',
      'pullops:issue:implement',
      '123',
      '--backend',
      'github-actions',
    ]);

    assert.equal(exitCode, 1);
    assert.match(stderr.text, /Full PullOps labels are not accepted/);
  });

  await t.test('missing backend for non-local label reference', async () => {
    const stderr = createWritableBuffer();
    const cli = new PullOpsCli({ stderr });

    const exitCode = await cli.run(['run', 'pr:review', '123']);

    assert.equal(exitCode, 1);
    assert.match(stderr.text, /pr:review requires "--backend github-actions"/);
  });

  await t.test('publish flag with github-actions backend', async () => {
    const stderr = createWritableBuffer();
    const cli = new PullOpsCli({ stderr });

    const exitCode = await cli.run([
      'run',
      'issue:implement',
      '123',
      '--backend',
      'github-actions',
      '--publish',
    ]);

    assert.equal(exitCode, 1);
    assert.match(stderr.text, /--publish is only supported by the local execution backend/);
  });

  await t.test('until flag with github-actions backend', async () => {
    const stderr = createWritableBuffer();
    const cli = new PullOpsCli({ stderr });

    const exitCode = await cli.run([
      'run',
      'pr:review',
      '456',
      '--backend',
      'github-actions',
      '--until',
      'prepared',
    ]);

    assert.equal(exitCode, 1);
    assert.match(stderr.text, /--until is only supported by the local execution backend/);
  });
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
    ensuredLabels.some(label => label.name === 'pullops:prd:auto-advance'),
    true,
  );
  assert.equal(
    ensuredLabels.some(label => label.name === 'pullops:prd:auto-complete'),
    true,
  );
  assert.equal(
    ensuredLabels.some(label => label.name === 'pullops:human-required'),
    true,
  );
  assert.equal(
    ensuredLabels.some(label => label.name.startsWith('pullops:status:')),
    false,
  );
  const expectedLabels = {
    created: [ensuredLabels[0].name],
    updated: [ensuredLabels[1].name],
    alreadyCorrect: ensuredLabels.slice(2).map(label => label.name),
  };
  assert.deepEqual(JSON.parse(stdout.text), {
    status: 'accepted',
    summary: 'Ensured 11 PullOps labels: 1 created, 1 updated, 9 already correct.',
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

    const exitCode = await cli.run(['run', 'pr-review']);

    assert.equal(exitCode, 1);
    assert.match(stderr.text, /Missing required argument "--pr <number>"/);
  });

  await t.test('old runner-coupled phase names are rejected', async () => {
    const stderr = createWritableBuffer();
    const cli = new PullOpsCli({ stderr });

    const exitCode = await cli.run([
      'run',
      'issue-implement',
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
      'issue-implement',
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
      'issue-implement',
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
      'issue-implement',
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
    async getPullRequestChecksForRef() {
      throw new Error('getPullRequestChecksForRef was not expected in this test.');
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
    async closeIssue() {
      throw new Error('closeIssue was not expected in this test.');
    },
    async commentOnPullRequest() {
      throw new Error('commentOnPullRequest was not expected in this test.');
    },
    async updatePullRequestBody() {
      throw new Error('updatePullRequestBody was not expected in this test.');
    },
    async markPullRequestReadyForReview() {
      throw new Error('markPullRequestReadyForReview was not expected in this test.');
    },
    async publishPullRequestReview() {
      throw new Error('publishPullRequestReview was not expected in this test.');
    },
    async replyToPullRequestReviewComment() {
      throw new Error('replyToPullRequestReviewComment was not expected in this test.');
    },
    async resolvePullRequestReviewThread() {
      throw new Error('resolvePullRequestReviewThread was not expected in this test.');
    },
    ...overrides,
  };
}
