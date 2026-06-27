import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { PullOpsCli } from './PullOpsCli.js';
import { WORKFLOW_OPERATIONS } from '../operations/operations.js';
import { createChildIssueBody } from '../issue-store/childIssueBody.js';
import { createConcreteIssueBody } from '../issue-store/concreteIssueBody.js';
import { createPrdIssueBody } from '../issue-store/prdIssueBody.js';

/**
 * @typedef {import('./types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../git/types.js').GitClient} GitClient
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

test('run pr-address-review accepts a trusted review id', async () => {
  const stdout = createWritableBuffer();
  /** @type {OperationRunnerContext[]} */
  const calls = [];
  const cli = new PullOpsCli({
    stdout,
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
    'pr-address-review',
    '--pr',
    '456',
    '--review-id',
    'PRR_requested',
  ]);

  assert.equal(exitCode, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].reviewId, 'PRR_requested');
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
      async getIssue(number) {
        return createGitHubIssue({ number, labels: [] });
      },
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

test('run operation refreshes an existing GitHub Actions label before reapplying it', async () => {
  const stdout = createWritableBuffer();
  /** @type {import('../github/types.js').EditLabelsOptions[]} */
  const issueLabelRemovals = [];
  /** @type {import('../github/types.js').EditLabelsOptions[]} */
  const issueLabelAdds = [];
  const cli = new PullOpsCli({
    stdout,
    githubClient: createFakeGitHubClient({
      async getIssue(number) {
        return createGitHubIssue({
          number,
          labels: ['pullops:issue:implement'],
        });
      },
      async removeLabelsFromIssue(options) {
        issueLabelRemovals.push(options);
      },
      async addLabelsToIssue(options) {
        issueLabelAdds.push(options);
      },
    }),
  });

  const exitCode = await cli.run(['run', 'issue:implement', '123', '--backend', 'github-actions']);

  assert.equal(exitCode, 0);
  assert.deepEqual(issueLabelRemovals, [{ number: 123, labels: ['pullops:issue:implement'] }]);
  assert.deepEqual(issueLabelAdds, [{ number: 123, labels: ['pullops:issue:implement'] }]);
  assert.deepEqual(JSON.parse(stdout.text), {
    status: 'accepted',
    summary: 'Applied pullops:issue:implement to issue #123.',
    operation: 'pullops:issue:implement',
    target: { type: 'issue', number: 123 },
    backend: 'github-actions',
  });
});

test('run issue:implement defaults to local finalized dry-run execution', async () => {
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  /** @type {import('../github/types.js').EditLabelsOptions[]} */
  const issueLabelAdds = [];
  /** @type {OperationRunnerContext[]} */
  const runnerCalls = [];
  const cli = new PullOpsCli({
    stdout,
    stderr,
    githubClient: createFakeGitHubClient({
      async addLabelsToIssue(options) {
        issueLabelAdds.push(options);
      },
    }),
    operationRunner: async context => {
      runnerCalls.push(context);
      return {
        status: 'accepted',
        summary: 'local finalized dry-run accepted',
        publicationMode: context.publicationMode,
        runGoal: context.runGoal,
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
  assert.equal(runnerCalls[0].runGoal, 'finalized');
  assert.equal(runnerCalls[0].runnerAdapter, 'codex-cli');
  runnerCalls[0].progress?.('Starting Codex runner.');
  assert.equal(stderr.text, '[pullops] Starting Codex runner.\n');
  assert.deepEqual(runnerCalls[0].target, { type: 'issue', number: 123 });
  assert.deepEqual(JSON.parse(stdout.text), {
    status: 'accepted',
    summary: 'local finalized dry-run accepted',
    publicationMode: 'dry-run',
    runGoal: 'finalized',
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
        runGoal: context.runGoal,
        target: context.target,
      };
    },
  });

  const exitCode = await cli.run(['run', 'issue:implement', '123', '--publish', 'pr']);

  assert.equal(exitCode, 0);
  assert.equal(runnerCalls.length, 1);
  assert.equal(runnerCalls[0].executionBackend, 'local');
  assert.equal(runnerCalls[0].publicationMode, 'publish');
  assert.equal(runnerCalls[0].runGoal, 'finalized');
  assert.deepEqual(JSON.parse(stdout.text), {
    status: 'accepted',
    summary: 'local PR publication accepted',
    publicationMode: 'publish',
    runGoal: 'finalized',
    target: { type: 'issue', number: 123 },
  });
});

test('run issue:implement allows explicit operation-only local PR publication', async () => {
  const stdout = createWritableBuffer();
  /** @type {OperationRunnerContext[]} */
  const runnerCalls = [];
  const cli = new PullOpsCli({
    stdout,
    operationRunner: async context => {
      runnerCalls.push(context);
      return {
        status: 'accepted',
        summary: 'local operation-only PR publication accepted',
        publicationMode: context.publicationMode,
        runGoal: context.runGoal,
        target: context.target,
      };
    },
  });

  const exitCode = await cli.run([
    'run',
    'issue:implement',
    '123',
    '--publish',
    'pr',
    '--until',
    'operation',
  ]);

  assert.equal(exitCode, 0);
  assert.equal(runnerCalls.length, 1);
  assert.equal(runnerCalls[0].executionBackend, 'local');
  assert.equal(runnerCalls[0].publicationMode, 'publish');
  assert.equal(runnerCalls[0].runGoal, 'operation');
  assert.deepEqual(JSON.parse(stdout.text), {
    status: 'accepted',
    summary: 'local operation-only PR publication accepted',
    publicationMode: 'publish',
    runGoal: 'operation',
    target: { type: 'issue', number: 123 },
  });
});

test('run issue:implement accepts explicit dry-run publication and finalized run goal', async () => {
  const stdout = createWritableBuffer();
  /** @type {OperationRunnerContext[]} */
  const runnerCalls = [];
  const cli = new PullOpsCli({
    stdout,
    operationRunner: async context => {
      runnerCalls.push(context);
      return {
        status: 'accepted',
        summary: 'local finalized dry-run accepted',
        publicationMode: context.publicationMode,
        runGoal: context.runGoal,
        target: context.target,
      };
    },
  });

  const exitCode = await cli.run([
    'run',
    'issue:implement',
    '123',
    '--publish',
    'dry-run',
    '--until',
    'finalized',
  ]);

  assert.equal(exitCode, 0);
  assert.equal(runnerCalls.length, 1);
  assert.equal(runnerCalls[0].publicationMode, 'dry-run');
  assert.equal(runnerCalls[0].runGoal, 'finalized');
  assert.deepEqual(JSON.parse(stdout.text), {
    status: 'accepted',
    summary: 'local finalized dry-run accepted',
    publicationMode: 'dry-run',
    runGoal: 'finalized',
    target: { type: 'issue', number: 123 },
  });
});

test('run prd:auto-advance defaults local dry-run to finalized', async () => {
  const stdout = createWritableBuffer();
  /** @type {OperationRunnerContext[]} */
  const runnerCalls = [];
  const cli = new PullOpsCli({
    stdout,
    operationRunner: async context => {
      runnerCalls.push(context);
      return {
        status: 'accepted',
        summary: 'local PRD auto-advance dry-run accepted',
        publicationMode: context.publicationMode,
        runGoal: context.runGoal,
        target: context.target,
      };
    },
  });

  const exitCode = await cli.run(['run', 'prd:auto-advance', '123']);

  assert.equal(exitCode, 0);
  assert.equal(runnerCalls.length, 1);
  assert.equal(runnerCalls[0].operation, 'prd-auto-advance');
  assert.equal(runnerCalls[0].executionBackend, 'local');
  assert.equal(runnerCalls[0].publicationMode, 'dry-run');
  assert.equal(runnerCalls[0].runGoal, 'finalized');
  assert.deepEqual(runnerCalls[0].target, { type: 'issue', number: 123 });
  assert.deepEqual(JSON.parse(stdout.text), {
    status: 'accepted',
    summary: 'local PRD auto-advance dry-run accepted',
    publicationMode: 'dry-run',
    runGoal: 'finalized',
    target: { type: 'issue', number: 123 },
  });
});

test('run prd:auto-advance allows explicit operation-only local dry-run', async () => {
  const stdout = createWritableBuffer();
  /** @type {OperationRunnerContext[]} */
  const runnerCalls = [];
  const cli = new PullOpsCli({
    stdout,
    operationRunner: async context => {
      runnerCalls.push(context);
      return {
        status: 'accepted',
        summary: 'local PRD auto-advance operation dry-run accepted',
        publicationMode: context.publicationMode,
        runGoal: context.runGoal,
        target: context.target,
      };
    },
  });

  const exitCode = await cli.run(['run', 'prd:auto-advance', '123', '--until', 'operation']);

  assert.equal(exitCode, 0);
  assert.equal(runnerCalls.length, 1);
  assert.equal(runnerCalls[0].publicationMode, 'dry-run');
  assert.equal(runnerCalls[0].runGoal, 'operation');
  assert.deepEqual(JSON.parse(stdout.text), {
    status: 'accepted',
    summary: 'local PRD auto-advance operation dry-run accepted',
    publicationMode: 'dry-run',
    runGoal: 'operation',
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
        runGoal: context.runGoal,
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
  assert.equal(runnerCalls[0].runGoal, 'finalized');
  assert.equal(runnerCalls[0].runnerAdapter, 'codex-cli');
  assert.deepEqual(runnerCalls[0].target, { type: 'issue', number: 123 });
  assert.deepEqual(JSON.parse(stdout.text), {
    status: 'accepted',
    summary: 'local PRD auto-advance accepted',
    publicationMode: 'publish',
    runGoal: 'finalized',
    target: { type: 'issue', number: 123 },
  });
});

test('run prd:auto-advance allows explicit operation-only local PR publication', async () => {
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
        runGoal: context.runGoal,
        target: context.target,
      };
    },
  });

  const exitCode = await cli.run([
    'run',
    'prd:auto-advance',
    '123',
    '--publish',
    'pr',
    '--until',
    'operation',
  ]);

  assert.equal(exitCode, 0);
  assert.equal(runnerCalls.length, 1);
  assert.equal(runnerCalls[0].publicationMode, 'publish');
  assert.equal(runnerCalls[0].runGoal, 'operation');
  assert.deepEqual(JSON.parse(stdout.text), {
    status: 'accepted',
    summary: 'local PRD auto-advance accepted',
    publicationMode: 'publish',
    runGoal: 'operation',
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
        runGoal: context.runGoal,
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
  assert.equal(runnerCalls[0].runGoal, 'finalized');
  assert.equal(runnerCalls[0].runnerAdapter, 'codex-cli');
  assert.deepEqual(runnerCalls[0].target, { type: 'issue', number: 123 });
  assert.deepEqual(JSON.parse(stdout.text), {
    status: 'accepted',
    summary: 'local PRD auto-complete accepted',
    publicationMode: 'publish',
    runGoal: 'finalized',
    target: { type: 'issue', number: 123 },
  });
});

test('run prd:auto-complete emits jsonl event streams for local runs', async () => {
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  /** @type {OperationRunnerContext[]} */
  const runnerCalls = [];
  const cli = new PullOpsCli({
    stdout,
    stderr,
    env: {
      PULLOPS_CONTEXT_USED_TOKENS: '12',
      PULLOPS_CONTEXT_LIMIT_TOKENS: '40',
    },
    operationRunner: async context => {
      runnerCalls.push(context);
      const runRecord = await bindProgressEventWriter(context);
      await context.progressEventWriter?.emit('run.started', {
        phase: 'run',
        message: 'Starting local PRD auto-complete for issue #123.',
      });
      assert.match(stdout.text, /"event":"run.started"/);
      await context.progressEventWriter?.emit('phase.started', {
        phase: 'child-coordination',
        message: 'Coordinating child issues for issue #123.',
      });
      await context.progressEventWriter?.emit('child.started', {
        phase: 'child-coordination',
        childIssue: {
          number: 34,
          url: 'https://github.test/issues/34',
        },
        message: 'Coordinating child issue #34.',
      });
      await context.progressEventWriter?.emit('child.completed', {
        phase: 'child-coordination',
        childIssue: {
          number: 34,
          url: 'https://github.test/issues/34',
        },
        status: 'merged',
        message: 'Merged finalized child PR #101 locally into PRD issue #123.',
        pullRequest: {
          number: 101,
          url: 'https://github.test/pull/101',
          baseBranch: 'pullops/prd-123',
          headBranch: 'pullops/prd-123-issue-34',
        },
      });
      await context.progressEventWriter?.emit('child.started', {
        phase: 'child-coordination',
        childIssue: {
          number: 36,
          url: 'https://github.test/issues/36',
        },
        message: 'Coordinating child issue #36.',
      });
      await context.progressEventWriter?.emit('child.completed', {
        phase: 'child-coordination',
        childIssue: {
          number: 36,
          url: 'https://github.test/issues/36',
        },
        status: 'merged',
        message: 'Merged finalized child PR #102 locally into PRD issue #123.',
        pullRequest: {
          number: 102,
          url: 'https://github.test/pull/102',
          baseBranch: 'pullops/prd-123',
          headBranch: 'pullops/prd-123-issue-36',
        },
      });
      await context.progressEventWriter?.emit('phase.completed', {
        phase: 'child-coordination',
        childCounts: {
          total: 2,
          completed: 2,
          blocked: 0,
        },
        message: 'Coordinated 2 child issue(s) for issue #123: 2 completed, 0 blocked.',
      });

      return {
        status: 'accepted',
        summary: 'local PRD auto-complete accepted',
        mode: 'auto-complete',
        publicationMode: context.publicationMode,
        issue: {
          number: 123,
          url: 'https://github.test/issues/123',
        },
        branch: 'pullops/prd-123',
        children: [
          {
            issue: {
              number: 34,
              url: 'https://github.test/issues/34',
            },
            status: 'merged',
            summary: 'Merged finalized child PR #101 locally into PRD issue #123.',
            pullRequest: {
              number: 101,
              url: 'https://github.test/pull/101',
              baseBranch: 'pullops/prd-123',
              headBranch: 'pullops/prd-123-issue-34',
            },
          },
          {
            issue: {
              number: 36,
              url: 'https://github.test/issues/36',
            },
            status: 'merged',
            summary: 'Merged finalized child PR #102 locally into PRD issue #123.',
            pullRequest: {
              number: 102,
              url: 'https://github.test/pull/102',
              baseBranch: 'pullops/prd-123',
              headBranch: 'pullops/prd-123-issue-36',
            },
          },
        ],
        parentPullRequest: {
          status: 'finalized',
          pullRequest: {
            number: 200,
            url: 'https://github.test/pull/200',
            baseBranch: 'main',
            headBranch: 'pullops/prd-123',
          },
        },
        localRunRecord: runRecord,
        localNextSteps: [
          'Review the Umbrella PR branch and merge the Umbrella PR manually when ready; PullOps did not merge it into the default branch.',
        ],
        virtualCompletedChildren: [34, 36],
        remainingBlockedChildren: [],
      };
    },
  });

  const exitCode = await cli.run([
    'run',
    'prd:auto-complete',
    '123',
    '--events',
    'jsonl',
    '--publish',
    'pr',
  ]);

  assert.equal(exitCode, 0);
  assert.equal(runnerCalls.length, 1);
  assert.equal(runnerCalls[0].publicationMode, 'publish');
  assert.equal(runnerCalls[0].runGoal, 'finalized');
  assert.equal(typeof runnerCalls[0].localRunRecordDirectory, 'string');
  assert.equal(
    runnerCalls[0].progressEventWriter?.runId,
    basename(String(runnerCalls[0].localRunRecordDirectory)),
  );
  assert.equal(stderr.text, '');

  const stdoutLines = stdout.text.trimEnd().split('\n');
  const events = stdoutLines.map(line => JSON.parse(line));
  const summaryEvent = events[events.length - 1];

  assert.deepEqual(
    events.map(event => event.event),
    [
      'run.started',
      'phase.started',
      'child.started',
      'child.completed',
      'child.started',
      'child.completed',
      'phase.completed',
      'run.summary',
    ],
  );
  assert.equal(events[0].runId, basename(String(runnerCalls[0].localRunRecordDirectory)));
  assert.equal(events[0].operationLabelReference, 'prd:auto-complete');
  assert.deepEqual(events[0].target, { type: 'issue', number: 123 });
  assert.deepEqual(events[6].childCounts, { total: 2, completed: 2, blocked: 0 });
  assert.equal(events[3].status, 'merged');
  assert.equal(events[5].status, 'merged');
  assert.equal(summaryEvent.runId, basename(String(runnerCalls[0].localRunRecordDirectory)));
  assert.equal(summaryEvent.operationLabelReference, 'prd:auto-complete');
  assert.equal(summaryEvent.status, 'accepted');
  assert.deepEqual(summaryEvent.contextUsage, { used: 12, limit: 40 });
  await assertPrdAutoCompleteEventStreamFixture(stdout.text, 'accepted');

  const runRecord = String(runnerCalls[0].localRunRecordDirectory);
  const eventsJsonl = await readFile(join(runRecord, 'events.jsonl'), 'utf8');
  assert.equal(eventsJsonl, stdout.text);
  const resultJson = await readFile(join(runRecord, 'result.json'), 'utf8');
  assert.deepEqual(JSON.parse(resultJson), summaryEvent);
});

test('run prd:auto-complete emits blocked jsonl event streams for dependency frontiers', async () => {
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  /** @type {OperationRunnerContext[]} */
  const runnerCalls = [];
  const cli = new PullOpsCli({
    stdout,
    stderr,
    env: {
      PULLOPS_CONTEXT_USED_TOKENS: '12',
      PULLOPS_CONTEXT_LIMIT_TOKENS: '40',
    },
    operationRunner: async context => {
      runnerCalls.push(context);
      const runRecord = await bindProgressEventWriter(context);
      await context.progressEventWriter?.emit('run.started', {
        phase: 'run',
        message: 'Starting local PRD auto-complete for issue #123.',
      });
      await context.progressEventWriter?.emit('phase.started', {
        phase: 'child-coordination',
        message: 'Coordinating child issues for issue #123.',
      });
      await context.progressEventWriter?.emit('child.started', {
        phase: 'child-coordination',
        childIssue: {
          number: 34,
          url: 'https://github.test/issues/34',
        },
        message: 'Coordinating child issue #34.',
      });
      await context.progressEventWriter?.emit('child.completed', {
        phase: 'child-coordination',
        childIssue: {
          number: 34,
          url: 'https://github.test/issues/34',
        },
        status: 'merged',
        message: 'Merged finalized child PR #101 locally into PRD issue #123.',
        pullRequest: {
          number: 101,
          url: 'https://github.test/pull/101',
          baseBranch: 'pullops/prd-123',
          headBranch: 'pullops/prd-123-issue-34',
        },
      });
      await context.progressEventWriter?.emit('child.started', {
        phase: 'child-coordination',
        childIssue: {
          number: 35,
          url: 'https://github.test/issues/35',
        },
        message: 'Coordinating child issue #35.',
      });
      await context.progressEventWriter?.emit('child.blocked', {
        phase: 'child-coordination',
        childIssue: {
          number: 35,
          url: 'https://github.test/issues/35',
        },
        status: 'blocked',
        message: 'Child issue #35 is blocked by #99.',
        blockedBy: [99],
        dependencyDecision: {
          blockedBy: [99],
          satisfiedByClosedIssues: [],
          satisfiedByVirtualCompletions: [],
          remainingBlockedBy: [99],
        },
      });
      await context.progressEventWriter?.emit('phase.completed', {
        phase: 'child-coordination',
        childCounts: {
          total: 2,
          completed: 1,
          blocked: 1,
        },
        message: 'Coordinated 2 child issue(s) for issue #123: 1 completed, 1 blocked.',
      });

      return {
        status: 'accepted',
        summary: 'local PRD auto-complete accepted',
        mode: 'auto-complete',
        publicationMode: context.publicationMode,
        issue: {
          number: 123,
          url: 'https://github.test/issues/123',
        },
        branch: 'pullops/prd-123',
        children: [
          {
            issue: {
              number: 34,
              url: 'https://github.test/issues/34',
            },
            status: 'merged',
            summary: 'Merged finalized child PR #101 locally into PRD issue #123.',
            pullRequest: {
              number: 101,
              url: 'https://github.test/pull/101',
              baseBranch: 'pullops/prd-123',
              headBranch: 'pullops/prd-123-issue-34',
            },
          },
          {
            issue: {
              number: 35,
              url: 'https://github.test/issues/35',
            },
            status: 'blocked',
            summary: 'Child issue #35 is blocked by #99.',
            blockedBy: [99],
            dependencyDecision: {
              blockedBy: [99],
              satisfiedByClosedIssues: [],
              satisfiedByVirtualCompletions: [],
              remainingBlockedBy: [99],
            },
          },
        ],
        parentPullRequest: {
          status: 'finalized',
          pullRequest: {
            number: 200,
            url: 'https://github.test/pull/200',
            baseBranch: 'main',
            headBranch: 'pullops/prd-123',
          },
        },
        localRunRecord: runRecord,
        localNextSteps: ['Resolve the blocker for child issue #35, then rerun PRD auto-complete.'],
        virtualCompletedChildren: [34],
        remainingBlockedChildren: [35],
      };
    },
  });

  const exitCode = await cli.run([
    'run',
    'prd:auto-complete',
    '123',
    '--events',
    'jsonl',
    '--publish',
    'pr',
  ]);

  assert.equal(exitCode, 0);
  assert.equal(runnerCalls.length, 1);
  assert.equal(stderr.text, '');

  const events = stdout.text
    .trimEnd()
    .split('\n')
    .map(line => JSON.parse(line));
  const summaryEvent = events.at(-1);

  assert.equal(summaryEvent.status, 'blocked');
  assert.deepEqual(summaryEvent.blockers, [
    {
      targetKind: 'issue',
      targetNumber: 35,
      phase: 'dependency',
      operationLabelReference: 'issue:implement',
      reason: 'dependency-wait',
      message: 'Child issue #35 is blocked by #99.',
      retryable: true,
    },
  ]);
  assert.deepEqual(summaryEvent.nextSteps, [
    'Resolve the blocker for child issue #35, then rerun PRD auto-complete.',
  ]);
  assert.deepEqual(summaryEvent.suggestedActions, [
    {
      kind: 'command',
      description: 'Rerun PRD auto-complete after the blocker is resolved.',
      argv: ['pullops', 'run', 'prd:auto-complete', '123', '--publish', 'pr'],
      approvalRequired: false,
    },
  ]);
});

test('run prd:auto-complete emits used-only context usage when the runner limit is unavailable', async () => {
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  /** @type {OperationRunnerContext[]} */
  const runnerCalls = [];
  const cli = new PullOpsCli({
    stdout,
    stderr,
    env: {
      PULLOPS_CONTEXT_USED_TOKENS: '12',
    },
    operationRunner: async context => {
      runnerCalls.push(context);
      const runRecord = await bindProgressEventWriter(context);
      return {
        status: 'accepted',
        summary: 'local PRD auto-complete accepted',
        mode: 'auto-complete',
        publicationMode: context.publicationMode,
        issue: {
          number: 123,
          url: 'https://github.test/issues/123',
        },
        branch: 'pullops/prd-123',
        children: [],
        parentPullRequest: {
          status: 'finalized',
          pullRequest: {
            number: 200,
            url: 'https://github.test/pull/200',
            baseBranch: 'main',
            headBranch: 'pullops/prd-123',
          },
        },
        localRunRecord: runRecord,
        localNextSteps: [],
      };
    },
  });

  const exitCode = await cli.run(['run', 'prd:auto-complete', '123', '--events', 'jsonl']);

  assert.equal(exitCode, 0);
  assert.equal(runnerCalls.length, 1);
  assert.equal(stderr.text, '');
  assert.deepEqual(runnerCalls[0].contextUsage, { used: 12 });

  const stdoutLines = stdout.text.trimEnd().split('\n');
  const events = stdoutLines.map(line => JSON.parse(line));
  const summaryEvent = events.at(-1);

  assert.equal(summaryEvent.event, 'run.summary');
  assert.deepEqual(summaryEvent.contextUsage, { used: 12 });

  const runRecord = String(runnerCalls[0].localRunRecordDirectory);
  const eventsJsonl = await readFile(join(runRecord, 'events.jsonl'), 'utf8');
  assert.equal(eventsJsonl, stdout.text);
  const resultJson = await readFile(join(runRecord, 'result.json'), 'utf8');
  assert.deepEqual(JSON.parse(resultJson), summaryEvent);
});

test('run prd:auto-complete emits null context usage when runner usage is unavailable', async () => {
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  /** @type {OperationRunnerContext[]} */
  const runnerCalls = [];
  const cli = new PullOpsCli({
    stdout,
    stderr,
    env: {},
    operationRunner: async context => {
      runnerCalls.push(context);
      const runRecord = await bindProgressEventWriter(context);
      return {
        status: 'accepted',
        summary: 'local PRD auto-complete accepted',
        mode: 'auto-complete',
        publicationMode: context.publicationMode,
        issue: {
          number: 123,
          url: 'https://github.test/issues/123',
        },
        branch: 'pullops/prd-123',
        children: [],
        parentPullRequest: {
          status: 'finalized',
          pullRequest: {
            number: 200,
            url: 'https://github.test/pull/200',
            baseBranch: 'main',
            headBranch: 'pullops/prd-123',
          },
        },
        localRunRecord: runRecord,
        localNextSteps: [],
      };
    },
  });

  const exitCode = await cli.run(['run', 'prd:auto-complete', '123', '--events', 'jsonl']);

  assert.equal(exitCode, 0);
  assert.equal(runnerCalls.length, 1);
  assert.equal(stderr.text, '');

  const stdoutLines = stdout.text.trimEnd().split('\n');
  const events = stdoutLines.map(line => JSON.parse(line));
  const summaryEvent = events.at(-1);

  assert.equal(summaryEvent.event, 'run.summary');
  assert.equal(Object.hasOwn(summaryEvent, 'contextUsage'), true);
  assert.equal(summaryEvent.contextUsage, null);

  const runRecord = String(runnerCalls[0].localRunRecordDirectory);
  const eventsJsonl = await readFile(join(runRecord, 'events.jsonl'), 'utf8');
  assert.equal(eventsJsonl, stdout.text);
  const resultJson = await readFile(join(runRecord, 'result.json'), 'utf8');
  assert.deepEqual(JSON.parse(resultJson), summaryEvent);
});

test('run prd:auto-complete emits blocked jsonl event streams for local waits', async () => {
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  /** @type {OperationRunnerContext[]} */
  const runnerCalls = [];
  const cli = new PullOpsCli({
    stdout,
    stderr,
    operationRunner: async context => {
      runnerCalls.push(context);
      const runRecord = await bindProgressEventWriter(context);
      await context.progressEventWriter?.emit('run.started', {
        phase: 'run',
        message: 'Starting local PRD auto-complete for issue #123.',
      });
      await context.progressEventWriter?.emit('phase.started', {
        phase: 'child-coordination',
        message: 'Coordinating child issues for issue #123.',
      });
      await context.progressEventWriter?.emit('child.started', {
        phase: 'child-coordination',
        childIssue: {
          number: 34,
          url: 'https://github.test/issues/34',
        },
        message: 'Coordinating child issue #34.',
      });
      await context.progressEventWriter?.emit('waiting', {
        phase: 'child-coordination',
        childIssue: {
          number: 34,
          url: 'https://github.test/issues/34',
        },
        status: 'waiting',
        message: 'Child PR #101 is waiting for human review or merge gates.',
        pullRequest: {
          number: 101,
          url: 'https://github.test/pull/101',
          baseBranch: 'pullops/prd-123',
          headBranch: 'pullops/prd-123-issue-34',
        },
        blockedPhase: 'review',
        blockedOperation: 'pr:review',
      });
      await context.progressEventWriter?.emit('phase.completed', {
        phase: 'child-coordination',
        childCounts: {
          total: 1,
          completed: 0,
          blocked: 0,
          waiting: 1,
        },
        message: 'Coordinated 1 child issue(s) for issue #123: 0 completed, 0 blocked, 1 waiting.',
      });

      return {
        status: 'accepted',
        summary: 'local PRD auto-complete reached a waiting boundary',
        mode: 'auto-complete',
        publicationMode: context.publicationMode,
        issue: {
          number: 123,
          url: 'https://github.test/issues/123',
        },
        branch: 'pullops/prd-123',
        children: [
          {
            issue: {
              number: 34,
              url: 'https://github.test/issues/34',
            },
            status: 'waiting',
            summary: 'Child PR #101 is waiting for human review or merge gates.',
            pullRequest: {
              number: 101,
              url: 'https://github.test/pull/101',
              baseBranch: 'pullops/prd-123',
              headBranch: 'pullops/prd-123-issue-34',
            },
            blockedPhase: 'review',
            blockedOperation: 'pr:review',
          },
        ],
        localRunRecord: runRecord,
        localNextSteps: [
          'Wait for child issue #34 to finish review or checks, then rerun PRD auto-complete.',
        ],
        remainingBlockedChildren: [34],
      };
    },
  });

  const exitCode = await cli.run([
    'run',
    'prd:auto-complete',
    '123',
    '--events',
    'jsonl',
    '--publish',
    'pr',
  ]);

  assert.equal(exitCode, 0);
  assert.equal(runnerCalls.length, 1);
  assert.equal(stderr.text, '');

  const events = stdout.text
    .trimEnd()
    .split('\n')
    .map(line => JSON.parse(line));
  const summaryEvent = events.at(-1);

  assert.deepEqual(
    events.map(event => event.event),
    ['run.started', 'phase.started', 'child.started', 'waiting', 'phase.completed', 'run.summary'],
  );
  assert.equal(events[3].status, 'waiting');
  assert.deepEqual(events[4].childCounts, { total: 1, completed: 0, blocked: 0, waiting: 1 });
  assert.equal(summaryEvent.status, 'blocked');
  await assertPrdAutoCompleteEventStreamFixture(stdout.text, 'blocked');
  assert.deepEqual(summaryEvent.blockers, [
    {
      targetKind: 'pull-request',
      targetNumber: 101,
      phase: 'review',
      operationLabelReference: 'pr:review',
      reason: 'review-wait',
      message: 'Child PR #101 is waiting for human review or merge gates.',
      retryable: true,
    },
  ]);
  assert.deepEqual(summaryEvent.nextSteps, [
    'Wait for child issue #34 to finish review or checks, then rerun PRD auto-complete.',
  ]);
  assert.deepEqual(summaryEvent.suggestedActions, [
    {
      kind: 'command',
      description: 'Rerun PRD auto-complete after the waiting boundary clears.',
      argv: ['pullops', 'run', 'prd:auto-complete', '123', '--publish', 'pr'],
      approvalRequired: false,
    },
  ]);

  const runRecord = String(runnerCalls[0].localRunRecordDirectory);
  const eventsJsonl = await readFile(join(runRecord, 'events.jsonl'), 'utf8');
  assert.equal(eventsJsonl, stdout.text);
  const resultJson = await readFile(join(runRecord, 'result.json'), 'utf8');
  assert.deepEqual(JSON.parse(resultJson), summaryEvent);
});

test('run prd:auto-complete emits refused jsonl event streams for local guardrails', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pullops-prd-auto-complete-refused-events-'));
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  const cli = new PullOpsCli({
    cwd,
    stdout,
    stderr,
    githubClient: createFakeGitHubClient({
      async getIssue(number) {
        if (number !== 34) {
          throw new Error(`Unexpected issue lookup #${number}.`);
        }

        return createGitHubIssue({
          number: 34,
          parent: {
            number: 12,
            relationshipSource: 'native',
          },
        });
      },
    }),
    gitClient: createFakeGitClient({
      async hasChanges() {
        return false;
      },
    }),
  });

  const exitCode = await cli.run(['run', 'prd:auto-complete', '34', '--events', 'jsonl']);

  assert.equal(exitCode, 1);
  assert.equal(stderr.text, '');

  const events = stdout.text
    .trimEnd()
    .split('\n')
    .map(line => JSON.parse(line));
  const summaryEvent = events.at(-1);

  assert.deepEqual(
    events.map(event => event.event),
    ['run.started', 'phase.started', 'phase.completed', 'run.summary'],
  );
  assert.equal(summaryEvent.operationLabelReference, 'prd:auto-complete');
  assert.deepEqual(summaryEvent.target, { type: 'issue', number: 34 });
  assert.equal(events[2].childCounts.total, 0);
  assert.equal(summaryEvent.status, 'refused');
  assert.equal(summaryEvent.reason, 'wrong-target');
  assert.equal(summaryEvent.displayMessage, summaryEvent.summary);
  await assertPrdAutoCompleteEventStreamFixture(stdout.text, 'refused');
  assert.deepEqual(summaryEvent.nextSteps, ['Run PRD auto-complete on Parent Issue #12 instead.']);
  assert.deepEqual(summaryEvent.suggestedActions, [
    {
      kind: 'command',
      description: 'Run PRD auto-complete on Parent Issue #12 instead.',
      argv: ['pullops', 'run', 'prd:auto-complete', '12'],
      approvalRequired: false,
    },
  ]);

  const runRecord = join(cwd, '.pullops', 'runs', summaryEvent.runId);
  const eventsJsonl = await readFile(join(runRecord, 'events.jsonl'), 'utf8');
  assert.equal(eventsJsonl, stdout.text);
  const resultJson = await readFile(join(runRecord, 'result.json'), 'utf8');
  assert.deepEqual(JSON.parse(resultJson), summaryEvent);
});

test('run prd:auto-complete classifies dirty worktree jsonl guardrails as refused', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pullops-prd-auto-complete-dirty-events-'));
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  const cli = new PullOpsCli({
    cwd,
    stdout,
    stderr,
    githubClient: createFakeGitHubClient(),
    gitClient: createFakeGitClient({
      async hasChanges() {
        return true;
      },
    }),
  });

  const exitCode = await cli.run(['run', 'prd:auto-complete', '123', '--events', 'jsonl']);

  assert.equal(exitCode, 1);
  assert.equal(stderr.text, '');
  assertStdoutIsPureJsonl(stdout.text);

  const events = stdout.text
    .trimEnd()
    .split('\n')
    .map(line => JSON.parse(line));
  const summaryEvent = events.at(-1);

  assert.deepEqual(
    events.map(event => event.event),
    ['run.started', 'phase.started', 'run.summary'],
  );
  assert.equal(summaryEvent.status, 'refused');
  assert.equal(summaryEvent.reason, 'dirty-worktree');
  assert.equal(summaryEvent.refusalReason, 'dirty-worktree');
  assert.match(summaryEvent.summary, /requires a clean worktree/);
  assert.doesNotMatch(summaryEvent.summary, /Local Run Record:/);
  assert.deepEqual(summaryEvent.nextSteps, [
    'Commit, stash, or discard existing changes and run PullOps again.',
  ]);
  assert.deepEqual(summaryEvent.suggestedActions, [
    {
      kind: 'command',
      description: 'Rerun PRD auto-complete after the worktree is clean.',
      argv: ['pullops', 'run', 'prd:auto-complete', '123'],
      approvalRequired: true,
      approvalReason:
        'Existing local changes require maintainer approval before rerunning PullOps.',
    },
  ]);

  const runRecord = join(cwd, '.pullops', 'runs', summaryEvent.runId);
  const eventsJsonl = await readFile(join(runRecord, 'events.jsonl'), 'utf8');
  assert.equal(eventsJsonl, stdout.text);
  const resultJson = await readFile(join(runRecord, 'result.json'), 'utf8');
  assert.deepEqual(JSON.parse(resultJson), summaryEvent);
  assert.match(await readFile(join(runRecord, 'failure-reason.txt'), 'utf8'), /clean worktree/);
  assert.match(await readFile(join(runRecord, 'error.txt'), 'utf8'), /clean worktree/);
});

test('run prd:auto-complete normalizes closed parent issues to accepted jsonl summaries', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pullops-prd-auto-complete-closed-events-'));
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  const cli = new PullOpsCli({
    cwd,
    stdout,
    stderr,
    githubClient: createFakeGitHubClient({
      async getIssue(number) {
        if (number !== 34) {
          throw new Error(`Unexpected issue lookup #${number}.`);
        }

        return createGitHubIssue({
          number: 34,
          state: 'CLOSED',
        });
      },
    }),
    gitClient: createFakeGitClient({
      async hasChanges() {
        return false;
      },
    }),
  });

  const exitCode = await cli.run(['run', 'prd:auto-complete', '34', '--events', 'jsonl']);

  assert.equal(exitCode, 0);
  assert.equal(stderr.text, '');

  const events = stdout.text
    .trimEnd()
    .split('\n')
    .map(line => JSON.parse(line));
  const summaryEvent = events.at(-1);

  assert.deepEqual(
    events.map(event => event.event),
    ['run.started', 'phase.started', 'phase.completed', 'run.summary'],
  );
  assert.equal(summaryEvent.status, 'accepted');
  assert.equal(summaryEvent.summary, 'PRD issue #34 is closed.');
  assert.equal(summaryEvent.contextUsage, null);

  const runRecord = join(cwd, '.pullops', 'runs', summaryEvent.runId);
  const eventsJsonl = await readFile(join(runRecord, 'events.jsonl'), 'utf8');
  assert.equal(eventsJsonl, stdout.text);
  const resultJson = await readFile(join(runRecord, 'result.json'), 'utf8');
  assert.deepEqual(JSON.parse(resultJson), summaryEvent);
});

test('run prd:auto-complete emits failed jsonl event streams for unexpected runtime errors', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pullops-prd-auto-complete-failed-events-'));
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  const cli = new PullOpsCli({
    cwd,
    stdout,
    stderr,
    env: {
      PULLOPS_CONTEXT_USED_TOKENS: '12',
      PULLOPS_CONTEXT_LIMIT_TOKENS: '40',
    },
    githubClient: createFakeGitHubClient(),
    gitClient: createFakeGitClient({
      async hasChanges() {
        throw new Error('git exploded');
      },
    }),
  });

  const exitCode = await cli.run(['run', 'prd:auto-complete', '123', '--events', 'jsonl']);

  assert.equal(exitCode, 1);
  assert.equal(stderr.text, '');

  const events = stdout.text
    .trimEnd()
    .split('\n')
    .map(line => JSON.parse(line));
  const summaryEvent = events.at(-1);

  assert.deepEqual(
    events.map(event => event.event),
    ['run.started', 'phase.started', 'run.summary'],
  );
  assert.equal(events[0].runId, summaryEvent.runId);
  assert.equal(events[0].operationLabelReference, 'prd:auto-complete');
  assert.deepEqual(events[0].target, { type: 'issue', number: 123 });
  assert.equal(events[1].phase, 'child-coordination');
  assert.equal(events[1].message, 'Coordinating child issues for issue #123.');
  assert.equal(summaryEvent.status, 'failed');
  assert.equal(summaryEvent.summary, 'Local PRD auto-complete for issue #123 failed unexpectedly.');
  assert.equal(summaryEvent.displayMessage, summaryEvent.summary);
  assert.equal(summaryEvent.failureReason, 'git exploded');
  assert.deepEqual(summaryEvent.contextUsage, { used: 12, limit: 40 });
  await assertPrdAutoCompleteEventStreamFixture(stdout.text, 'failed');

  const runRecord = join(cwd, '.pullops', 'runs', summaryEvent.runId);
  const eventsJsonl = await readFile(join(runRecord, 'events.jsonl'), 'utf8');
  assert.equal(eventsJsonl, stdout.text);
  const resultJson = await readFile(join(runRecord, 'result.json'), 'utf8');
  assert.deepEqual(JSON.parse(resultJson), summaryEvent);
  assert.match(await readFile(join(runRecord, 'error.txt'), 'utf8'), /git exploded/);
});

test('run prd:auto-complete emits failed jsonl summaries when summary validation fails after the runner returns', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pullops-prd-auto-complete-invalid-summary-'));
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  /** @type {OperationRunnerContext[]} */
  const runnerCalls = [];
  const cli = new PullOpsCli({
    cwd,
    stdout,
    stderr,
    operationRunner: async context => {
      runnerCalls.push(context);
      await context.progressEventWriter?.emit('run.started', {
        phase: 'run',
        message: 'Starting local PRD auto-complete for issue #123.',
      });
      return {
        status: 'accepted',
      };
    },
  });

  const exitCode = await cli.run(['run', 'prd:auto-complete', '123', '--events', 'jsonl']);

  assert.equal(exitCode, 1);
  assert.equal(stderr.text, '');
  assert.equal(runnerCalls.length, 1);

  const events = stdout.text
    .trimEnd()
    .split('\n')
    .map(line => JSON.parse(line));
  const summaryEvent = events.at(-1);

  assert.deepEqual(
    events.map(event => event.event),
    ['run.started', 'run.summary'],
  );
  assert.equal(summaryEvent.status, 'failed');
  assert.equal(summaryEvent.displayMessage, summaryEvent.summary);
  assert.match(summaryEvent.failureReason, /Invalid Operation Output/);

  const runRecord = join(cwd, '.pullops', 'runs', summaryEvent.runId);
  const eventsJsonl = await readFile(join(runRecord, 'events.jsonl'), 'utf8');
  assert.equal(eventsJsonl, stdout.text);
  const resultJson = await readFile(join(runRecord, 'result.json'), 'utf8');
  assert.deepEqual(JSON.parse(resultJson), summaryEvent);
});

test('run prd:auto-complete falls back to a preallocated jsonl run record without overwriting older runs', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pullops-prd-auto-complete-truncated-events-'));
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  const staleRunRecord = join(
    cwd,
    '.pullops',
    'runs',
    '2026-06-20T000000000Z-prd-auto-complete-123',
  );
  await mkdir(staleRunRecord, { recursive: true });
  await writeFile(join(staleRunRecord, 'events.jsonl'), '{"event":"stale"}\n');
  await writeFile(join(staleRunRecord, 'result.json'), '{"status":"accepted"}\n');

  const cli = new PullOpsCli({
    cwd,
    stdout,
    stderr,
    operationRunner: async () => {
      throw new Error('runner exploded before run record creation');
    },
  });

  const exitCode = await cli.run(['run', 'prd:auto-complete', '123', '--events', 'jsonl']);

  assert.equal(exitCode, 1);
  assert.equal(stderr.text, '');

  const events = stdout.text
    .trimEnd()
    .split('\n')
    .map(line => JSON.parse(line));
  const summaryEvent = events.at(-1);

  assert.deepEqual(
    events.map(event => event.event),
    ['run.summary'],
  );
  assert.equal(summaryEvent.status, 'failed');
  assert.match(summaryEvent.failureReason, /runner exploded before run record creation/);

  const runRecord = join(cwd, '.pullops', 'runs', summaryEvent.runId);
  const eventsJsonl = await readFile(join(runRecord, 'events.jsonl'), 'utf8');
  assert.equal(eventsJsonl, stdout.text);
  const resultJson = await readFile(join(runRecord, 'result.json'), 'utf8');
  assert.deepEqual(JSON.parse(resultJson), summaryEvent);
  assert.equal(await readFile(join(staleRunRecord, 'events.jsonl'), 'utf8'), '{"event":"stale"}\n');
  assert.equal(
    await readFile(join(staleRunRecord, 'result.json'), 'utf8'),
    '{"status":"accepted"}\n',
  );
});

test('run prd:auto-advance rejects jsonl event streams', async () => {
  const stderr = createWritableBuffer();
  const cli = new PullOpsCli({ stderr });

  const exitCode = await cli.run(['run', 'prd:auto-advance', '123', '--events', 'jsonl']);

  assert.equal(exitCode, 1);
  assert.match(stderr.text, /only supported for local prd:auto-complete/);
});

test('run local pull request operation references through the matching workflow operation', async () => {
  const cases = [
    ['pr:review', 'pr-review'],
    ['pr:address-review', 'pr-address-review'],
    ['pr:fix-ci', 'pr-fix-ci'],
    ['pr:update-branch', 'pr-update-branch'],
    ['pr:resolve-conflicts', 'pr-resolve-conflicts'],
    ['pr:finalize', 'pr-finalize'],
  ];

  for (const [reference, expectedOperation] of cases) {
    const stdout = createWritableBuffer();
    /** @type {OperationRunnerContext[]} */
    const runnerCalls = [];
    const cli = new PullOpsCli({
      stdout,
      operationRunner: async context => {
        runnerCalls.push(context);
        return {
          status: 'accepted',
          summary: 'local pull request operation accepted',
          operation: context.operation,
          target: context.target,
        };
      },
    });

    const exitCode = await cli.run(['run', reference, '456']);

    assert.equal(exitCode, 0);
    assert.equal(runnerCalls.length, 1);
    assert.equal(runnerCalls[0].operation, expectedOperation);
    assert.equal(runnerCalls[0].executionBackend, 'local');
    assert.equal(runnerCalls[0].publicationMode, 'dry-run');
    assert.equal(runnerCalls[0].phase, 'run');
    assert.equal(runnerCalls[0].runnerAdapter, 'codex-cli');
    assert.deepEqual(runnerCalls[0].target, { type: 'pr', number: 456 });
    assert.deepEqual(JSON.parse(stdout.text), {
      status: 'accepted',
      summary: 'local pull request operation accepted',
      operation: expectedOperation,
      target: { type: 'pr', number: 456 },
    });
  }
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
        async getIssue(number) {
          return createGitHubIssue({ number, labels: [] });
        },
        async getPullRequest(number) {
          return createGitHubPullRequest({ number, labels: [] });
        },
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

  await t.test('unsupported local reference explains the limited local catalog', async () => {
    const stderr = createWritableBuffer();
    const cli = new PullOpsCli({ stderr });

    const exitCode = await cli.run(['run', 'prd:prepare', '123']);

    assert.equal(exitCode, 1);
    assert.match(stderr.text, /Local execution is currently only supported for/);
    assert.match(stderr.text, /Use "prd:prepare --backend github-actions"/);
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

  await t.test('missing publish value', async () => {
    const stderr = createWritableBuffer();
    const cli = new PullOpsCli({ stderr });

    const exitCode = await cli.run(['run', 'issue:implement', '123', '--publish']);

    assert.equal(exitCode, 1);
    assert.match(stderr.text, /Missing value for "--publish"/);
  });

  await t.test('unsupported run goal', async () => {
    const stderr = createWritableBuffer();
    const cli = new PullOpsCli({ stderr });

    const exitCode = await cli.run(['run', 'issue:implement', '123', '--until', 'prepared']);

    assert.equal(exitCode, 1);
    assert.match(stderr.text, /Unsupported run goal "prepared"/);
  });

  await t.test('runner flag is rejected for label-shaped local commands', async () => {
    const stderr = createWritableBuffer();
    const cli = new PullOpsCli({ stderr });

    const exitCode = await cli.run(['run', 'issue:implement', '123', '--runner', 'codex-action']);

    assert.equal(exitCode, 1);
    assert.match(stderr.text, /Unknown arguments for issue:implement: --runner codex-action/);
  });
});

test('issues publish-issue accepts structured JSON from file and stdin', async t => {
  await t.test('file input', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-issue-file-'));
    const stdout = createWritableBuffer();
    /** @type {import('../github/types.js').CreateIssueOptions[]} */
    const createIssueCalls = [];
    /** @type {import('../github/types.js').EditLabelsOptions[]} */
    const addLabelCalls = [];
    const request = {
      title: 'Publish standalone issue',
      whatToBuild: 'Implement the issue-store publication path.',
      acceptanceCriteria: ['Reads structured JSON from --file.', 'Writes stable JSON output.'],
      blockedBy: [34],
      triageRole: 'ready-for-agent',
    };
    const requestPath = join(cwd, 'request.json');
    await writeFile(requestPath, `${JSON.stringify(request)}\n`);

    const cli = new PullOpsCli({
      cwd,
      stdout,
      githubClient: createFakeGitHubClient({
        async createIssue(options) {
          createIssueCalls.push(options);
          return createGitHubIssue({
            number: 88,
            url: 'https://github.test/owner/repo/issues/88',
          });
        },
        async addLabelsToIssue(options) {
          addLabelCalls.push(options);
        },
      }),
    });

    const exitCode = await cli.run(['issues', 'publish-issue', '--file', requestPath]);

    assert.equal(exitCode, 0);
    assert.equal(createIssueCalls.length, 1);
    assert.equal(createIssueCalls[0].title, request.title);
    assert.equal(createIssueCalls[0].labels, undefined);
    assert.match(createIssueCalls[0].body, /PullOps publication marker/);
    assert.match(createIssueCalls[0].body, /## What to build/);
    assert.match(createIssueCalls[0].body, /## Acceptance criteria/);
    assert.match(createIssueCalls[0].body, /## Blocked by/);
    assert.deepEqual(addLabelCalls, [{ number: 88, labels: ['ready-for-agent'] }]);

    const output = JSON.parse(stdout.text);
    assert.equal(output.status, 'accepted');
    assert.equal(output.action, 'created');
    assert.equal(output.issue.number, 88);
    assert.equal(output.triageRole, 'ready-for-agent');
    assert.deepEqual(output.warnings, []);
    assert.equal(output.localRunRecord.startsWith(join(cwd, '.pullops', 'runs')), true);
    assert.match(output.localRunRecord, /issues-publish-issue-new$/);
    assert.equal(
      await readFile(join(output.localRunRecord, 'request.raw.txt'), 'utf8'),
      `${JSON.stringify(request)}\n`,
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(output.localRunRecord, 'request.json'), 'utf8')),
      {
        title: request.title,
        whatToBuild: request.whatToBuild,
        acceptanceCriteria: request.acceptanceCriteria,
        blockedBy: request.blockedBy,
        triageRole: request.triageRole,
      },
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(output.localRunRecord, 'response.json'), 'utf8')),
      output,
    );
  });

  await t.test('stdin input', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-issue-stdin-'));
    const stdout = createWritableBuffer();
    /** @type {import('../github/types.js').UpdateIssueOptions[]} */
    const updateIssueCalls = [];
    /** @type {import('../github/types.js').EditLabelsOptions[]} */
    const removeLabelCalls = [];
    /** @type {import('../github/types.js').EditLabelsOptions[]} */
    const addLabelCalls = [];
    const request = {
      issueNumber: 41,
      title: 'Refresh standalone issue',
      whatToBuild: 'Update the rendered publication body.',
      acceptanceCriteria: [
        'Reads structured JSON from stdin.',
        'Updates a PullOps-published issue.',
      ],
      triageRole: 'ready-for-human',
    };
    const existingBody = createConcreteIssueBody({
      title: request.title,
      whatToBuild: request.whatToBuild,
      acceptanceCriteria: request.acceptanceCriteria,
      blockedBy: [],
    });

    const cli = new PullOpsCli({
      cwd,
      stdout,
      stdin: /** @type {NodeJS.ReadableStream} */ (Readable.from([JSON.stringify(request)])),
      githubClient: createFakeGitHubClient({
        async getIssue(number) {
          assert.equal(number, 41);
          return createGitHubIssue({
            number: 41,
            body: existingBody,
            labels: ['needs-triage', 'needs-info'],
          });
        },
        async updateIssue(options) {
          updateIssueCalls.push(options);
          return createGitHubIssue({
            number: 41,
            body: options.body,
            labels: ['ready-for-human'],
          });
        },
        async removeLabelsFromIssue(options) {
          removeLabelCalls.push(options);
        },
        async addLabelsToIssue(options) {
          addLabelCalls.push(options);
        },
      }),
    });

    const exitCode = await cli.run(['issues', 'publish-issue']);

    assert.equal(exitCode, 0);
    assert.equal(updateIssueCalls.length, 1);
    assert.equal(updateIssueCalls[0].number, 41);
    assert.equal(updateIssueCalls[0].labels, undefined);
    assert.match(updateIssueCalls[0].body, /PullOps publication marker/);
    assert.deepEqual(removeLabelCalls, [{ number: 41, labels: ['needs-triage', 'needs-info'] }]);
    assert.deepEqual(addLabelCalls, [{ number: 41, labels: ['ready-for-human'] }]);

    const output = JSON.parse(stdout.text);
    assert.equal(output.status, 'accepted');
    assert.equal(output.action, 'updated');
    assert.equal(output.issue.number, 41);
    assert.equal(output.triageRole, 'ready-for-human');
    assert.deepEqual(output.warnings, []);
    assert.equal(output.localRunRecord.startsWith(join(cwd, '.pullops', 'runs')), true);
    assert.match(output.localRunRecord, /issues-publish-issue-41$/);
    assert.equal(
      await readFile(join(output.localRunRecord, 'request.raw.txt'), 'utf8'),
      `${JSON.stringify(request)}\n`,
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(output.localRunRecord, 'request.json'), 'utf8')),
      {
        issueNumber: request.issueNumber,
        title: request.title,
        whatToBuild: request.whatToBuild,
        acceptanceCriteria: request.acceptanceCriteria,
        blockedBy: [],
        triageRole: request.triageRole,
      },
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(output.localRunRecord, 'response.json'), 'utf8')),
      output,
    );
  });
});

test('issues publish-prd accepts structured JSON from file and stdin', async t => {
  await t.test('file input', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-prd-file-'));
    const stdout = createWritableBuffer();
    /** @type {import('../github/types.js').CreateIssueOptions[]} */
    const createIssueCalls = [];
    /** @type {import('../github/types.js').EditLabelsOptions[]} */
    const addLabelCalls = [];
    const request = {
      title: 'Publish PRD issue support',
      problemStatement: 'PullOps should publish PRDs through its own Issue Store.',
      solution: 'Add a PRD publish command on top of the GitHub Issue Store path.',
      userStories: [
        {
          number: 8,
          story:
            'As an agent, I want to submit structured PRD fields, so that PullOps can render stable and parseable PRD bodies.',
        },
        {
          number: 1,
          story:
            'As a maintainer, I want PullOps to own PRD publication, so that generated issue bodies stay consistent.',
        },
      ],
      implementationDecisions: [
        'Use the GitHub Issue Store adapter.',
        'Preserve stable user story numbers.',
      ],
      testingDecisions: ['Exercise the publish command through fake GitHub clients.'],
      outOfScope: ['Child Issue publication.'],
      furtherNotes: ['This PRD was published from the new issue-store command.'],
      auditDetails: ['Requested by to-prd.', 'Recorded in a Local Run Record.'],
      triageRole: 'ready-for-agent',
    };
    const requestPath = join(cwd, 'request.json');
    await writeFile(requestPath, `${JSON.stringify(request)}\n`);

    const cli = new PullOpsCli({
      cwd,
      stdout,
      githubClient: createFakeGitHubClient({
        async createIssue(options) {
          createIssueCalls.push(options);
          return createGitHubIssue({
            number: 88,
            url: 'https://github.test/owner/repo/issues/88',
          });
        },
        async addLabelsToIssue(options) {
          addLabelCalls.push(options);
        },
      }),
    });

    const exitCode = await cli.run(['issues', 'publish-prd', '--file', requestPath]);

    assert.equal(exitCode, 0);
    assert.equal(createIssueCalls.length, 1);
    assert.equal(createIssueCalls[0].title, request.title);
    assert.equal(createIssueCalls[0].labels, undefined);
    assert.match(createIssueCalls[0].body, /PullOps publication marker/);
    assert.match(createIssueCalls[0].body, /## Problem Statement/);
    assert.match(createIssueCalls[0].body, /## User Stories/);
    assert.match(createIssueCalls[0].body, /- 1\. As a maintainer/);
    assert.match(createIssueCalls[0].body, /<summary>PullOps publication audit<\/summary>/);
    assert.deepEqual(addLabelCalls, [{ number: 88, labels: ['ready-for-agent'] }]);

    const output = JSON.parse(stdout.text);
    assert.equal(output.status, 'accepted');
    assert.equal(output.action, 'created');
    assert.equal(output.issue.number, 88);
    assert.equal(output.triageRole, 'ready-for-agent');
    assert.deepEqual(output.warnings, []);
    assert.equal(output.localRunRecord.startsWith(join(cwd, '.pullops', 'runs')), true);
    assert.match(output.localRunRecord, /issues-publish-prd-new$/);
    assert.equal(
      await readFile(join(output.localRunRecord, 'request.raw.txt'), 'utf8'),
      `${JSON.stringify(request)}\n`,
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(output.localRunRecord, 'request.json'), 'utf8')),
      {
        title: request.title,
        problemStatement: request.problemStatement,
        solution: request.solution,
        userStories: [
          {
            number: 1,
            story:
              'As a maintainer, I want PullOps to own PRD publication, so that generated issue bodies stay consistent.',
          },
          {
            number: 8,
            story:
              'As an agent, I want to submit structured PRD fields, so that PullOps can render stable and parseable PRD bodies.',
          },
        ],
        implementationDecisions: request.implementationDecisions,
        testingDecisions: request.testingDecisions,
        outOfScope: request.outOfScope,
        furtherNotes: request.furtherNotes,
        auditDetails: request.auditDetails,
        triageRole: request.triageRole,
      },
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(output.localRunRecord, 'response.json'), 'utf8')),
      output,
    );
  });

  await t.test('stdin input', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-prd-stdin-'));
    const stdout = createWritableBuffer();
    /** @type {import('../github/types.js').UpdateIssueOptions[]} */
    const updateIssueCalls = [];
    /** @type {import('../github/types.js').EditLabelsOptions[]} */
    const removeLabelCalls = [];
    /** @type {import('../github/types.js').EditLabelsOptions[]} */
    const addLabelCalls = [];
    const request = {
      issueNumber: 41,
      title: 'Refresh PRD issue',
      problemStatement: 'Update the rendered PRD body.',
      solution: 'Re-render the PRD issue body.',
      userStories: [
        {
          number: 8,
          story:
            'As an agent, I want to submit structured PRD fields, so that PullOps can render stable and parseable PRD bodies.',
        },
        {
          number: 1,
          story:
            'As a maintainer, I want PullOps to own PRD publication, so that generated issue bodies stay consistent.',
        },
      ],
      implementationDecisions: ['Use the GitHub Issue Store adapter.'],
      testingDecisions: ['Exercise the publish command through fake GitHub clients.'],
      outOfScope: ['Child Issue publication.'],
      triageRole: 'ready-for-human',
    };
    const existingBody = createPrdIssueBody({
      title: request.title,
      problemStatement: request.problemStatement,
      solution: request.solution,
      userStories: request.userStories,
      implementationDecisions: request.implementationDecisions,
      testingDecisions: request.testingDecisions,
      outOfScope: request.outOfScope,
      furtherNotes: [],
      auditDetails: [],
    });

    const cli = new PullOpsCli({
      cwd,
      stdout,
      stdin: /** @type {NodeJS.ReadableStream} */ (Readable.from([JSON.stringify(request)])),
      githubClient: createFakeGitHubClient({
        async getIssue(number) {
          assert.equal(number, 41);
          return createGitHubIssue({
            number: 41,
            body: existingBody,
            labels: ['needs-triage', 'needs-info'],
          });
        },
        async updateIssue(options) {
          updateIssueCalls.push(options);
          return createGitHubIssue({
            number: 41,
            body: options.body,
            labels: ['ready-for-human'],
          });
        },
        async removeLabelsFromIssue(options) {
          removeLabelCalls.push(options);
        },
        async addLabelsToIssue(options) {
          addLabelCalls.push(options);
        },
      }),
    });

    const exitCode = await cli.run(['issues', 'publish-prd']);

    assert.equal(exitCode, 0);
    assert.equal(updateIssueCalls.length, 1);
    assert.equal(updateIssueCalls[0].number, 41);
    assert.equal(updateIssueCalls[0].labels, undefined);
    assert.match(updateIssueCalls[0].body, /PullOps publication marker/);
    assert.deepEqual(removeLabelCalls, [{ number: 41, labels: ['needs-triage', 'needs-info'] }]);
    assert.deepEqual(addLabelCalls, [{ number: 41, labels: ['ready-for-human'] }]);

    const output = JSON.parse(stdout.text);
    assert.equal(output.status, 'accepted');
    assert.equal(output.action, 'updated');
    assert.equal(output.issue.number, 41);
    assert.equal(output.triageRole, 'ready-for-human');
    assert.deepEqual(output.warnings, []);
    assert.equal(output.localRunRecord.startsWith(join(cwd, '.pullops', 'runs')), true);
    assert.match(output.localRunRecord, /issues-publish-prd-41$/);
    assert.equal(
      await readFile(join(output.localRunRecord, 'request.raw.txt'), 'utf8'),
      `${JSON.stringify(request)}\n`,
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(output.localRunRecord, 'request.json'), 'utf8')),
      {
        issueNumber: request.issueNumber,
        title: request.title,
        problemStatement: request.problemStatement,
        solution: request.solution,
        userStories: [
          {
            number: 1,
            story:
              'As a maintainer, I want PullOps to own PRD publication, so that generated issue bodies stay consistent.',
          },
          {
            number: 8,
            story:
              'As an agent, I want to submit structured PRD fields, so that PullOps can render stable and parseable PRD bodies.',
          },
        ],
        implementationDecisions: request.implementationDecisions,
        testingDecisions: request.testingDecisions,
        outOfScope: request.outOfScope,
        furtherNotes: [],
        auditDetails: [],
        triageRole: request.triageRole,
      },
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(output.localRunRecord, 'response.json'), 'utf8')),
      output,
    );
  });
});

test('issues publish-children accepts parent from flag or JSON and rejects conflicts', async t => {
  await t.test('file input with --parent', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-children-file-'));
    const stdout = createWritableBuffer();
    /** @type {import('../github/types.js').CreateIssueOptions[]} */
    const createIssueCalls = [];
    /** @type {import('../github/types.js').AddSubIssueOptions[]} */
    const subIssueCalls = [];
    /** @type {import('../github/types.js').EditLabelsOptions[]} */
    const addLabelCalls = [];
    const request = {
      children: [
        {
          sliceRef: '1',
          title: 'Publish child issue',
          whatToBuild: 'Create a native Child Issue.',
          acceptanceCriteria: ['The child is created and attached.'],
          coveredUserStories: [2],
          triageRole: 'ready-for-agent',
        },
      ],
    };
    const requestPath = join(cwd, 'children.json');
    await writeFile(requestPath, `${JSON.stringify(request)}\n`);

    const cli = new PullOpsCli({
      cwd,
      stdout,
      githubClient: createFakeGitHubClient({
        async getIssue(number) {
          assert.equal(number, 126);
          return createGitHubIssue({
            number: 126,
            body: createPrdIssueBody({
              title: 'Published parent',
              problemStatement: 'Parent problem.',
              solution: 'Parent solution.',
              userStories: [{ number: 2, story: 'As a user, I want child issue publication.' }],
              implementationDecisions: ['Use native sub-issues.'],
              testingDecisions: ['Use fake clients.'],
              outOfScope: ['Dependency publication.'],
              furtherNotes: [],
              auditDetails: [],
            }),
          });
        },
        async createIssue(options) {
          createIssueCalls.push(options);
          return createGitHubIssue({
            number: 201,
            url: 'https://github.test/owner/repo/issues/201',
            body: options.body,
          });
        },
        async addSubIssue(options) {
          subIssueCalls.push(options);
        },
        async addLabelsToIssue(options) {
          addLabelCalls.push(options);
        },
      }),
    });

    const exitCode = await cli.run([
      'issues',
      'publish-children',
      '--parent',
      '126',
      '--file',
      requestPath,
    ]);

    assert.equal(exitCode, 0);
    assert.equal(createIssueCalls.length, 1);
    assert.match(createIssueCalls[0].body, /"sliceRef":"1"/);
    assert.match(createIssueCalls[0].body, /^## Covered PRD user stories$/m);
    assert.deepEqual(subIssueCalls, [{ parentIssueNumber: 126, childIssueNumber: 201 }]);
    assert.deepEqual(addLabelCalls, [{ number: 201, labels: ['ready-for-agent'] }]);

    const output = JSON.parse(stdout.text);
    assert.equal(output.status, 'accepted');
    assert.equal(output.parent.number, 126);
    assert.deepEqual(output.mappings, [
      {
        sliceRef: '1',
        issueNumber: 201,
        issueUrl: 'https://github.test/owner/repo/issues/201',
      },
    ]);
    assert.deepEqual(output.warnings, []);
    assert.match(output.localRunRecord, /issues-publish-children-126$/);
    assert.deepEqual(
      JSON.parse(await readFile(join(output.localRunRecord, 'response.json'), 'utf8')),
      output,
    );
  });

  await t.test('conflicting parent flag and JSON parent', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-children-conflict-'));
    const stdout = createWritableBuffer();
    const cli = new PullOpsCli({
      cwd,
      stdout,
      stdin: /** @type {NodeJS.ReadableStream} */ (
        Readable.from([
          JSON.stringify({
            parentIssueNumber: 127,
            children: [
              {
                sliceRef: '1',
                title: 'Publish child issue',
                whatToBuild: 'Create a native Child Issue.',
                acceptanceCriteria: ['The child is created and attached.'],
                coveredUserStories: [2],
              },
            ],
          }),
        ])
      ),
      githubClient: createFakeGitHubClient(),
    });

    const exitCode = await cli.run(['issues', 'publish-children', '--parent', '126']);

    assert.equal(exitCode, 1);
    const output = JSON.parse(stdout.text);
    assert.equal(output.status, 'failed');
    assert.match(output.failureReason, /Request.parentIssueNumber values conflict/);
    assert.match(output.localRunRecord, /issues-publish-children-invalid$/);
  });

  await t.test('--force updates an existing PullOps-published child by slice ref', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-children-force-'));
    const stdout = createWritableBuffer();
    /** @type {import('../github/types.js').UpdateIssueOptions[]} */
    const updates = [];
    const existingChild = createGitHubIssue({
      number: 201,
      title: 'Old child',
      body: createChildIssueBody({
        parentIssueNumber: 126,
        sliceRef: '1',
        title: 'Old child',
        whatToBuild: 'Old work.',
        acceptanceCriteria: ['Old criteria.'],
        blockedBy: [],
        blockedBySliceRefs: [],
        coveredUserStories: [2],
        supportWork: false,
      }),
      parent: {
        number: 126,
        title: 'Published parent',
        url: 'https://github.test/owner/repo/issues/126',
        state: 'OPEN',
        relationshipSource: 'native',
      },
    });
    const request = {
      parentIssueNumber: 126,
      children: [
        {
          sliceRef: '1',
          title: 'Updated child issue',
          whatToBuild: 'Update the native Child Issue.',
          acceptanceCriteria: ['The child is force-updated.'],
          coveredUserStories: [2],
        },
      ],
    };
    const requestPath = join(cwd, 'children.json');
    await writeFile(requestPath, `${JSON.stringify(request)}\n`);

    const cli = new PullOpsCli({
      cwd,
      stdout,
      githubClient: createFakeGitHubClient({
        async getIssue(number) {
          if (number === 126) {
            return createGitHubIssue({
              number,
              body: createPrdIssueBody({
                title: 'Published parent',
                problemStatement: 'Parent problem.',
                solution: 'Parent solution.',
                userStories: [{ number: 2, story: 'As a user, I want child issue publication.' }],
                implementationDecisions: ['Use native sub-issues.'],
                testingDecisions: ['Use fake clients.'],
                outOfScope: ['Dependency publication.'],
                furtherNotes: [],
                auditDetails: [],
              }),
              subIssues: [
                {
                  number: 201,
                  title: 'Old child',
                  url: 'https://github.test/owner/repo/issues/201',
                  state: 'OPEN',
                  relationshipSource: 'native',
                },
              ],
            });
          }
          assert.equal(number, 201);
          return existingChild;
        },
        async updateIssue(options) {
          updates.push(options);
          return createGitHubIssue({
            ...existingChild,
            title: options.title,
            body: options.body,
          });
        },
        async addSubIssue() {},
      }),
    });

    const exitCode = await cli.run([
      'issues',
      'publish-children',
      '--file',
      requestPath,
      '--force',
    ]);

    assert.equal(exitCode, 0);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].number, 201);

    const output = JSON.parse(stdout.text);
    assert.equal(output.status, 'accepted');
    assert.equal(output.action, 'updated');
    assert.equal(output.children[0].action, 'updated');
  });
});

test('issues publish-issue rejects malformed JSON input with stable failure output', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-issue-malformed-'));
  const stdout = createWritableBuffer();
  const cli = new PullOpsCli({
    cwd,
    stdout,
    stdin: /** @type {NodeJS.ReadableStream} */ (Readable.from(['{ "title": "broken"'])),
    githubClient: createFakeGitHubClient(),
  });

  const exitCode = await cli.run(['issues', 'publish-issue']);

  assert.equal(exitCode, 1);

  const output = JSON.parse(stdout.text);
  assert.equal(output.status, 'failed');
  assert.equal(output.summary, 'Publish issue request failed.');
  assert.match(output.failureReason, /Publish request must be valid JSON/);
  assert.deepEqual(output.warnings, []);
  assert.equal(output.localRunRecord.startsWith(join(cwd, '.pullops', 'runs')), true);
  assert.match(output.localRunRecord, /issues-publish-issue-invalid$/);
  assert.equal(
    await readFile(join(output.localRunRecord, 'request.raw.txt'), 'utf8'),
    '{ "title": "broken"\n',
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(output.localRunRecord, 'response.json'), 'utf8')),
    output,
  );
  assert.match(
    await readFile(join(output.localRunRecord, 'failure-reason.txt'), 'utf8'),
    /Publish request must be valid JSON/,
  );
});

test('issues publish-prd rejects malformed JSON input with stable failure output', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-prd-malformed-'));
  const stdout = createWritableBuffer();
  const cli = new PullOpsCli({
    cwd,
    stdout,
    stdin: /** @type {NodeJS.ReadableStream} */ (Readable.from(['{ "title": "broken"'])),
    githubClient: createFakeGitHubClient(),
  });

  const exitCode = await cli.run(['issues', 'publish-prd']);

  assert.equal(exitCode, 1);

  const output = JSON.parse(stdout.text);
  assert.equal(output.status, 'failed');
  assert.equal(output.summary, 'Publish PRD request failed.');
  assert.match(output.failureReason, /Publish request must be valid JSON/);
  assert.deepEqual(output.warnings, []);
  assert.equal(output.localRunRecord.startsWith(join(cwd, '.pullops', 'runs')), true);
  assert.match(output.localRunRecord, /issues-publish-prd-invalid$/);
  assert.equal(
    await readFile(join(output.localRunRecord, 'request.raw.txt'), 'utf8'),
    '{ "title": "broken"\n',
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(output.localRunRecord, 'response.json'), 'utf8')),
    output,
  );
  assert.match(
    await readFile(join(output.localRunRecord, 'failure-reason.txt'), 'utf8'),
    /Publish request must be valid JSON/,
  );
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
 * @param {Partial<import('../github/types.js').GitHubIssue>} [overrides]
 * @returns {import('../github/types.js').GitHubIssue}
 */
function createGitHubIssue(overrides = {}) {
  return {
    number: 1,
    title: 'Issue title',
    body: '',
    state: 'OPEN',
    url: 'https://github.test/owner/repo/issues/1',
    authorLogin: null,
    labels: [],
    parent: null,
    subIssues: [],
    ...overrides,
  };
}

/**
 * @param {Partial<import('../github/types.js').GitHubPullRequest>} [overrides]
 * @returns {import('../github/types.js').GitHubPullRequest}
 */
function createGitHubPullRequest(overrides = {}) {
  return {
    number: 1,
    title: 'Pull request title',
    url: 'https://github.test/owner/repo/pull/1',
    headRefName: 'pullops/issue-1',
    body: '',
    isDraft: true,
    labels: [],
    ...overrides,
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

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<string>}
 */
async function bindProgressEventWriter(context) {
  const runRecord = String(context.localRunRecordDirectory);
  await mkdir(runRecord, { recursive: true });
  await context.progressEventWriter?.bindLocalRunRecord(runRecord);
  return runRecord;
}

/**
 * @param {string} stdoutText
 * @param {'accepted' | 'blocked' | 'refused' | 'failed'} fixtureName
 * @returns {Promise<void>}
 */
async function assertPrdAutoCompleteEventStreamFixture(stdoutText, fixtureName) {
  assertStdoutIsPureJsonl(stdoutText);
  const fixture = await readFile(
    new URL(`./__fixtures__/prd-auto-complete-events/${fixtureName}.jsonl`, import.meta.url),
    'utf8',
  );
  assert.equal(normalizePrdAutoCompleteEventStream(stdoutText), fixture);
}

/**
 * @param {string} stdoutText
 * @returns {void}
 */
function assertStdoutIsPureJsonl(stdoutText) {
  assert.doesNotMatch(stdoutText, /\[pullops\]|git:|runner:/);
  for (const line of stdoutText.trimEnd().split('\n')) {
    assert.doesNotMatch(line, /^\s/);
    JSON.parse(line);
  }
}

/**
 * @param {string} stdoutText
 * @returns {string}
 */
function normalizePrdAutoCompleteEventStream(stdoutText) {
  const normalizedLines = stdoutText
    .trimEnd()
    .split('\n')
    .map(line => JSON.stringify(normalizeDynamicEventValues(JSON.parse(line))));
  return `${normalizedLines.join('\n')}\n`;
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function normalizeDynamicEventValues(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeDynamicEventValues);
  }

  if (typeof value !== 'object' || value === null) {
    return value;
  }

  const record = /** @type {Record<string, unknown>} */ (value);
  for (const [key, childValue] of Object.entries(record)) {
    if (key === 'runId') {
      record[key] = '<RUN_ID>';
      continue;
    }

    if (key === 'at' || key === 'startedAt' || key === 'finishedAt') {
      record[key] = '<TIMESTAMP>';
      continue;
    }

    if (key === 'durationMs') {
      record[key] = '<DURATION_MS>';
      continue;
    }

    if (key === 'localRunRecord') {
      record[key] = '<LOCAL_RUN_RECORD>';
      continue;
    }

    record[key] = normalizeDynamicEventValues(childValue);
  }

  return record;
}

/**
 * @param {Partial<GitClient>} [overrides]
 * @returns {GitClient}
 */
function createFakeGitClient(overrides = {}) {
  return {
    async createBranch() {
      throw new Error('createBranch was not expected in this test.');
    },
    async hasChanges() {
      return false;
    },
    async commitAll() {
      throw new Error('commitAll was not expected in this test.');
    },
    async commitEmpty() {
      throw new Error('commitEmpty was not expected in this test.');
    },
    async pushBranch() {
      throw new Error('pushBranch was not expected in this test.');
    },
    async rebaseBranchOntoBase() {
      throw new Error('rebaseBranchOntoBase was not expected in this test.');
    },
    async pushBranchWithLease() {
      throw new Error('pushBranchWithLease was not expected in this test.');
    },
    async getCurrentHeadSha() {
      throw new Error('getCurrentHeadSha was not expected in this test.');
    },
    async getCurrentTreeHash() {
      throw new Error('getCurrentTreeHash was not expected in this test.');
    },
    async getChangedFilesSinceBase() {
      throw new Error('getChangedFilesSinceBase was not expected in this test.');
    },
    async rewriteBranchWithCommitPlan() {
      throw new Error('rewriteBranchWithCommitPlan was not expected in this test.');
    },
    ...overrides,
  };
}
