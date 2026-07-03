import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { PullOpsCli } from './PullOpsCli.js';
import { PULL_OPS_LABELS } from '../github/GitHubClient.js';
import { getOperationCatalogWorkflowOperations } from '../operations/operationCatalog.js';
import { createChildIssueBody } from '../issue-store/childIssueBody.js';
import { createConcreteIssueBody } from '../issue-store/concreteIssueBody.js';
import { createPrdIssueBody } from '../issue-store/prdIssueBody.js';
import {
  initializeLocalRunState,
  recordLocalRunWaitingForRunner,
} from '../local-run-state/localRunState.js';
import { runPullOpsInit } from '../setup/init.js';

const execFileAsync = promisify(execFile);

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

test('run operation accepts explicit external runner lifecycle arguments', async () => {
  const stdout = createWritableBuffer();
  /** @type {OperationRunnerContext[]} */
  const calls = [];
  const cli = new PullOpsCli({
    stdout,
    env: {
      OUTPUT_DIR: '/tmp/pullops-output',
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
    'complete',
    '--runner',
    'external',
    '--issue',
    '42',
  ]);

  assert.equal(exitCode, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].phase, 'complete');
  assert.equal(calls[0].runnerAdapter, 'external');
  assert.equal(calls[0].executionBackend, 'local');
  assert.equal(calls[0].outputDirectory, '/tmp/pullops-output');
  assert.equal(calls[0].suppressFollowUpOperationLabels, true);
  assert.deepEqual(JSON.parse(stdout.text), {
    status: 'accepted',
    summary: 'operation accepted',
  });
});

test('run operation records local external complete status in the run state', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'pullops-external-complete-state-'));
  const stateRecord = await initializeLocalRunState({
    runRecordDirectory: outputDirectory,
    operationReference: 'issue:implement',
    target: {
      type: 'issue',
      number: 42,
    },
    publicationMode: 'publish',
    runGoal: 'finalized',
    phase: 'prepare',
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
  });
  const runnerJob = {
    cwd: outputDirectory,
    promptFile: join(outputDirectory, 'runner_prompt.md'),
    outputFile: join(outputDirectory, 'runner_output.json'),
    resultFile: join(outputDirectory, 'runner_result.json'),
    workerPrompt: 'Use the pullops-issue-implement skill.',
    model: 'gpt-5.5',
    branch: 'pullops/issue-42',
    completionCommands: {
      success: { argv: ['npm', 'exec', '--', 'pullops', 'runner-result'], env: {} },
      failed: { argv: ['npm', 'exec', '--', 'pullops', 'runner-result'], env: {} },
      cancelled: { argv: ['npm', 'exec', '--', 'pullops', 'runner-result'], env: {} },
      skipped: { argv: ['npm', 'exec', '--', 'pullops', 'runner-result'], env: {} },
    },
    completeCommand: {
      argv: ['npm', 'exec', '--', 'pullops', 'run', 'issue-implement'],
      env: { OUTPUT_DIR: outputDirectory },
    },
  };
  await recordLocalRunWaitingForRunner({
    statePath: stateRecord.statePath,
    summary: 'Prepared external implement run for issue #42.',
    phase: 'prepare',
    runnerJob,
    at: new Date('2024-01-01T00:01:00.000Z'),
  });
  const stdout = createWritableBuffer();
  const cli = new PullOpsCli({
    stdout,
    env: {
      OUTPUT_DIR: outputDirectory,
    },
    operationRunner: async () => {
      return {
        status: 'accepted',
        summary: 'Opened draft PullOps-managed PR #100 for issue #42.',
      };
    },
  });

  const exitCode = await cli.run([
    'run',
    'issue-implement',
    '--phase',
    'complete',
    '--runner',
    'external',
    '--issue',
    '42',
  ]);

  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(stdout.text), {
    status: 'accepted',
    summary: 'Opened draft PullOps-managed PR #100 for issue #42.',
  });
  const state = JSON.parse(await readFile(stateRecord.statePath, 'utf8'));
  assert.equal(state.status, 'accepted');
  assert.equal(state.phase, 'complete');
  assert.equal(state.lastEvent.status, 'accepted');
  assert.equal(state.lastEvent.phase, 'complete');
  assert.equal(state.lastEvent.summary, 'Opened draft PullOps-managed PR #100 for issue #42.');
  assert.deepEqual(state.runnerJob, runnerJob);
});

test('run operation marks GitHub Actions external lifecycle commands as workflow-backed', async () => {
  const stdout = createWritableBuffer();
  /** @type {OperationRunnerContext[]} */
  const calls = [];
  const cli = new PullOpsCli({
    stdout,
    env: {
      GITHUB_ACTIONS: 'true',
      OUTPUT_DIR: '/tmp/pullops-output',
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
    'complete',
    '--runner',
    'external',
    '--issue',
    '42',
  ]);

  assert.equal(exitCode, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executionBackend, 'github-actions');
  assert.equal(calls[0].suppressFollowUpOperationLabels, undefined);
});

test('run review loop operations accept catalog-backed external lifecycles', async () => {
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
        operation: context.operation,
        phase: context.phase,
        runnerAdapter: context.runnerAdapter,
      };
    },
  });

  /** @type {Array<[string, 'prepare' | 'complete', string]>} */
  const cases = [
    ['pr-review', 'prepare', '456'],
    ['pr-address-review', 'complete', '789'],
  ];

  for (const [operation, phase, targetNumber] of cases) {
    /** @type {string[]} */
    const args = ['run', operation, '--phase', phase, '--runner', 'external', '--pr', targetNumber];

    const exitCode = await cli.run(args);

    assert.equal(exitCode, 0);
    assert.equal(calls.at(-1)?.operation, operation);
    assert.equal(calls.at(-1)?.phase, phase);
    assert.equal(calls.at(-1)?.runnerAdapter, 'external');
  }

  assert.match(stdout.text, /"status": "accepted"/);
});

test('run operation rejects unsupported external lifecycle arguments for prd-prepare', async () => {
  const stderr = createWritableBuffer();
  const cli = new PullOpsCli({ stderr });

  const exitCode = await cli.run([
    'run',
    'prd-prepare',
    '--phase',
    'prepare',
    '--runner',
    'external',
    '--issue',
    '42',
  ]);

  assert.equal(exitCode, 1);
  assert.match(stderr.text, /prd-prepare only supports codex-cli with the run phase/);
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
  for (const operation of getOperationCatalogWorkflowOperations()) {
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
    env: {},
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

test('run issue:implement defaults to an external runner handoff inside Codex host', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pullops-codex-hosted-issue-'));
  const stdout = createWritableBuffer();
  /** @type {OperationRunnerContext[]} */
  const runnerCalls = [];
  const runnerJob = {
    cwd,
    promptFile: join(cwd, '.pullops', 'runs', 'runner_prompt.md'),
    outputFile: join(cwd, '.pullops', 'runs', 'runner_output.json'),
    resultFile: join(cwd, '.pullops', 'runs', 'runner_result.json'),
    workerPrompt: 'Use the pullops-issue-implement skill.',
    model: 'gpt-5.5',
    branch: 'pullops/issue-123',
    completionCommands: {
      success: { argv: ['npm', 'exec', '--', 'pullops', 'runner-result'], env: {} },
      failed: { argv: ['npm', 'exec', '--', 'pullops', 'runner-result'], env: {} },
      cancelled: { argv: ['npm', 'exec', '--', 'pullops', 'runner-result'], env: {} },
      skipped: { argv: ['npm', 'exec', '--', 'pullops', 'runner-result'], env: {} },
    },
    completeCommand: {
      argv: [
        'npm',
        'exec',
        '--',
        'pullops',
        'run',
        'issue-implement',
        '--runner',
        'external',
        '--phase',
        'complete',
        '--issue',
        '123',
      ],
      env: {},
    },
  };
  const cli = new PullOpsCli({
    cwd,
    stdout,
    env: {
      CODEX_THREAD_ID: 'thread-123',
    },
    gitClient: createFakeGitClient(),
    operationRunner: async context => {
      runnerCalls.push(context);
      return {
        status: 'waiting',
        summary: 'Prepared external implement run for issue #123.',
        runnerJob,
      };
    },
  });

  const exitCode = await cli.run(['run', 'issue:implement', '123', '--publish', 'pr']);

  assert.equal(exitCode, 0);
  assert.equal(runnerCalls.length, 1);
  assert.equal(runnerCalls[0].phase, 'prepare');
  assert.equal(runnerCalls[0].runnerAdapter, 'external');
  assert.equal(runnerCalls[0].executionBackend, 'local');
  assert.equal(runnerCalls[0].publicationMode, 'publish');
  assert.equal(runnerCalls[0].runGoal, 'finalized');

  const output = JSON.parse(stdout.text);
  assert.equal(output.status, 'waiting');
  assert.equal(output.localRunRecord, runnerCalls[0].outputDirectory);
  assert.equal(output.runStatePath, join(runnerCalls[0].outputDirectory ?? '', 'state.json'));
  assert.deepEqual(output.runnerJob, runnerJob);
});

test('run issue:implement accepts local PR publication', async () => {
  const stdout = createWritableBuffer();
  /** @type {OperationRunnerContext[]} */
  const runnerCalls = [];
  const cli = new PullOpsCli({
    stdout,
    env: {},
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
    env: {},
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
    env: {},
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

test('run issue:implement with the external runner records a waiting runner handoff', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pullops-local-external-issue-'));
  await writeExternalRunnerConfig(cwd);
  const stdout = createWritableBuffer();
  /** @type {OperationRunnerContext[]} */
  const runnerCalls = [];
  const runnerJob = {
    cwd,
    promptFile: join(cwd, '.pullops', 'runs', 'runner_prompt.md'),
    outputFile: join(cwd, '.pullops', 'runs', 'runner_output.json'),
    resultFile: join(cwd, '.pullops', 'runs', 'runner_result.json'),
    workerPrompt: 'Use the pullops-issue-implement skill.',
    model: 'gpt-5.5',
    branch: 'pullops/issue-123',
    completionCommands: {
      success: { argv: ['npm', 'exec', '--', 'pullops', 'runner-result'], env: {} },
      failed: { argv: ['npm', 'exec', '--', 'pullops', 'runner-result'], env: {} },
      cancelled: { argv: ['npm', 'exec', '--', 'pullops', 'runner-result'], env: {} },
      skipped: { argv: ['npm', 'exec', '--', 'pullops', 'runner-result'], env: {} },
    },
    completeCommand: {
      argv: [
        'npm',
        'exec',
        '--',
        'pullops',
        'run',
        'issue-implement',
        '--runner',
        'external',
        '--phase',
        'complete',
        '--issue',
        '123',
      ],
      env: {},
    },
  };
  const cli = new PullOpsCli({
    cwd,
    stdout,
    gitClient: createFakeGitClient(),
    operationRunner: async context => {
      runnerCalls.push(context);
      return {
        status: 'waiting',
        summary: 'Prepared external implement run for issue #123.',
        runnerJob,
      };
    },
  });

  const exitCode = await cli.run(['run', 'issue:implement', '123', '--publish', 'pr']);

  assert.equal(exitCode, 0);
  assert.equal(runnerCalls.length, 1);
  assert.equal(runnerCalls[0].phase, 'prepare');
  assert.equal(runnerCalls[0].runnerAdapter, 'external');
  assert.equal(runnerCalls[0].executionBackend, 'local');
  assert.equal(runnerCalls[0].publicationMode, 'publish');
  assert.equal(runnerCalls[0].runGoal, 'finalized');
  assert.match(runnerCalls[0].outputDirectory ?? '', /\.pullops\/runs\//);

  const output = JSON.parse(stdout.text);
  assert.equal(output.status, 'waiting');
  assert.equal(output.localRunRecord, runnerCalls[0].outputDirectory);
  assert.equal(output.runStatePath, join(runnerCalls[0].outputDirectory ?? '', 'state.json'));
  assert.deepEqual(output.runnerJob, runnerJob);

  const state = JSON.parse(await readFile(output.runStatePath, 'utf8'));
  assert.equal(state.status, 'waiting');
  assert.equal(state.phase, 'prepare');
  assert.deepEqual(state.runnerJob, runnerJob);
  assert.deepEqual(state.lastEvent.runnerJob, runnerJob);
});

test('heartbeat accepts the worker environment and advances lease timing', async () => {
  const runRecordDirectory = await mkdtemp(join(tmpdir(), 'pullops-heartbeat-cli-'));
  const stateRecord = await initializeLocalRunState({
    runRecordDirectory,
    operationReference: 'issue:implement',
    target: {
      type: 'issue',
      number: 42,
    },
    publicationMode: 'dry-run',
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    heartbeatIntervalMs: 120000,
    leaseDurationMs: 240000,
  });
  const before = JSON.parse(await readFile(stateRecord.statePath, 'utf8'));
  const stdout = createWritableBuffer();
  const cli = new PullOpsCli({
    stdout,
    githubClient: createFakeGitHubClient(),
    gitClient: createFakeGitClient(),
    env: {
      PULLOPS_RUN_STATE_PATH: stateRecord.statePath,
      PULLOPS_HEARTBEAT_TOKEN: stateRecord.state.heartbeatToken,
    },
  });

  const exitCode = await cli.run(['heartbeat', '--summary', 'inspecting setup command tests']);

  assert.equal(exitCode, 0);
  const output = JSON.parse(stdout.text);
  assert.equal(output.status, 'accepted');
  assert.equal(output.localRunRecord, runRecordDirectory);
  assert.equal(output.runStatePath, stateRecord.statePath);
  assert.equal(output.runState.status, 'running');
  assert.equal(output.runState.heartbeatToken, stateRecord.state.heartbeatToken);
  assert.equal(output.runState.heartbeatSummary, 'inspecting setup command tests');

  const after = JSON.parse(await readFile(stateRecord.statePath, 'utf8'));
  assert.equal(after.heartbeatToken, before.heartbeatToken);
  assert.equal(after.heartbeatSummary, 'inspecting setup command tests');
  assert.notEqual(after.heartbeatAt, before.heartbeatAt);
  assert.notEqual(after.leaseExpiresAt, before.leaseExpiresAt);
  assert.equal(after.heartbeatIntervalMs, before.heartbeatIntervalMs);
  assert.equal(after.leaseDurationMs, before.leaseDurationMs);
});

test('runner-result writes and validates the external runner result artifact', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'pullops-runner-result-'));
  const explicitResultFile = join(outputDirectory, 'explicit-result.json');

  {
    const stdout = createWritableBuffer();
    const cli = new PullOpsCli({
      stdout,
      env: {
        OUTPUT_DIR: outputDirectory,
      },
    });

    const exitCode = await cli.run(['runner-result', '--status', 'success']);

    assert.equal(exitCode, 0);
    const resultFile = join(outputDirectory, 'runner_result.json');
    assert.deepEqual(JSON.parse(await readFile(resultFile, 'utf8')), {
      schemaVersion: 1,
      status: 'success',
    });
    assert.deepEqual(JSON.parse(stdout.text), {
      status: 'accepted',
      summary: `Wrote external runner result to ${resultFile}.`,
      runnerResult: {
        status: 'success',
        resultFile,
      },
    });
  }

  {
    const stdout = createWritableBuffer();
    const cli = new PullOpsCli({ stdout });

    const exitCode = await cli.run([
      'runner-result',
      '--status',
      'cancelled',
      '--file',
      explicitResultFile,
    ]);

    assert.equal(exitCode, 0);
    assert.deepEqual(JSON.parse(await readFile(explicitResultFile, 'utf8')), {
      schemaVersion: 1,
      status: 'cancelled',
    });
  }

  {
    const stderr = createWritableBuffer();
    const cli = new PullOpsCli({
      stderr,
      env: {
        OUTPUT_DIR: outputDirectory,
      },
    });

    const exitCode = await cli.run(['runner-result', '--status', 'failure']);

    assert.equal(exitCode, 1);
    assert.match(
      stderr.text,
      /runner-result --status must be one of: success, failed, cancelled, skipped/,
    );
  }
});

test('heartbeat accepts durable recording when parent event sink delivery fails', async () => {
  const runRecordDirectory = await mkdtemp(join(tmpdir(), 'pullops-heartbeat-sink-failed-'));
  const stateRecord = await initializeLocalRunState({
    runRecordDirectory,
    operationReference: 'issue:implement',
    target: {
      type: 'issue',
      number: 42,
    },
    publicationMode: 'dry-run',
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
  });
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  const cli = new PullOpsCli({
    stdout,
    stderr,
    githubClient: createFakeGitHubClient(),
    gitClient: createFakeGitClient(),
    env: {
      PULLOPS_RUN_STATE_PATH: stateRecord.statePath,
      PULLOPS_HEARTBEAT_TOKEN: stateRecord.state.heartbeatToken,
      PULLOPS_PARENT_EVENT_SINK_URL: 'http://127.0.0.1:1/events',
      PULLOPS_PARENT_EVENT_SINK_TOKEN: 'parent-sink-token',
      PULLOPS_PARENT_RUN_ID: '2026-06-20T010203000Z-prd-auto-complete-12',
      PULLOPS_CHILD_RUN_ID: stateRecord.state.runId,
      PULLOPS_CHILD_ISSUE_NUMBER: '42',
      PULLOPS_CHILD_LOCAL_RUN_RECORD: runRecordDirectory,
      PULLOPS_CHILD_RUN_STATE_PATH: stateRecord.statePath,
    },
  });

  const exitCode = await cli.run(['heartbeat', '--summary', 'sink failure still records']);

  assert.equal(exitCode, 0);
  assert.equal(stderr.text, '');
  const output = JSON.parse(stdout.text);
  assert.equal(output.status, 'accepted');
  assert.equal(output.warnings.length, 1);
  assert.match(output.warnings[0], /^Parent event sink delivery failed:/);
  assert.equal(output.runState.heartbeatCount, 1);
  assert.equal(output.runState.heartbeatSummary, 'sink failure still records');

  const after = JSON.parse(await readFile(stateRecord.statePath, 'utf8'));
  assert.equal(after.heartbeatCount, 1);
  assert.equal(after.heartbeatSummary, 'sink failure still records');
});

test('heartbeat refuses a mismatched token without mutating the state file', async () => {
  const runRecordDirectory = await mkdtemp(join(tmpdir(), 'pullops-heartbeat-cli-refused-'));
  const stateRecord = await initializeLocalRunState({
    runRecordDirectory,
    operationReference: 'issue:implement',
    target: {
      type: 'issue',
      number: 42,
    },
    publicationMode: 'dry-run',
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
  });
  const before = JSON.parse(await readFile(stateRecord.statePath, 'utf8'));
  const stdout = createWritableBuffer();
  const cli = new PullOpsCli({
    stdout,
    githubClient: createFakeGitHubClient(),
    gitClient: createFakeGitClient(),
    env: {
      PULLOPS_RUN_STATE_PATH: stateRecord.statePath,
      PULLOPS_HEARTBEAT_TOKEN: 'wrong-token',
    },
  });

  const exitCode = await cli.run(['heartbeat']);

  assert.equal(exitCode, 1);
  const output = JSON.parse(stdout.text);
  assert.equal(output.status, 'refused');
  assert.equal(output.localRunRecord, runRecordDirectory);
  assert.match(output.summary, /Heartbeat token mismatch/);

  const after = JSON.parse(await readFile(stateRecord.statePath, 'utf8'));
  assert.deepEqual(after, before);
});

test('step emits a heartbeat before the first wrapped command', async () => {
  const runRecordDirectory = await mkdtemp(join(tmpdir(), 'pullops-step-first-'));
  const stateRecord = await initializeLocalRunState({
    runRecordDirectory,
    operationReference: 'issue:implement',
    target: {
      type: 'issue',
      number: 42,
    },
    publicationMode: 'dry-run',
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
  });
  /** @type {number[]} */
  const spawnHeartbeatCounts = [];
  const { spawnCommand } = createFakeStepSpawn({
    onSpawn: () => {
      spawnHeartbeatCounts.push(
        JSON.parse(readFileSync(stateRecord.statePath, 'utf8')).heartbeatCount,
      );
    },
  });
  const cli = createStepCli({ stateRecord, spawnCommand });

  const exitCode = await cli.run(['step', 'inspecting setup command tests', '--', 'echo', 'ok']);

  assert.equal(exitCode, 0);
  assert.deepEqual(spawnHeartbeatCounts, [1]);
  const state = JSON.parse(await readFile(stateRecord.statePath, 'utf8'));
  assert.equal(state.heartbeatCount, 1);
  assert.equal(state.completedNonHeartbeatStepsSinceHeartbeat, 0);
  assert.equal(state.heartbeatSummary, 'inspecting setup command tests');
});

test('step does not heartbeat again for a repeated command shortly after', async () => {
  const runRecordDirectory = await mkdtemp(join(tmpdir(), 'pullops-step-repeat-'));
  const stateRecord = await initializeLocalRunState({
    runRecordDirectory,
    operationReference: 'issue:implement',
    target: {
      type: 'issue',
      number: 42,
    },
    publicationMode: 'dry-run',
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
  });
  const { spawnCommand } = createFakeStepSpawn();
  const cli = createStepCli({ stateRecord, spawnCommand });

  assert.equal(await cli.run(['step', 'first command', '--', 'echo', 'one']), 0);
  const afterFirst = JSON.parse(await readFile(stateRecord.statePath, 'utf8'));

  assert.equal(await cli.run(['step', 'second command', '--', 'echo', 'two']), 0);

  const afterSecond = JSON.parse(await readFile(stateRecord.statePath, 'utf8'));
  assert.equal(afterSecond.heartbeatCount, 1);
  assert.equal(afterSecond.heartbeatAt, afterFirst.heartbeatAt);
  assert.equal(afterSecond.completedNonHeartbeatStepsSinceHeartbeat, 1);
});

test('step emits a heartbeat when the last heartbeat is stale', async () => {
  const runRecordDirectory = await mkdtemp(join(tmpdir(), 'pullops-step-stale-'));
  const stateRecord = await initializeLocalRunState({
    runRecordDirectory,
    operationReference: 'issue:implement',
    target: {
      type: 'issue',
      number: 42,
    },
    publicationMode: 'dry-run',
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
  });
  let now = new Date('2024-01-01T00:00:01.000Z');
  const { spawnCommand } = createFakeStepSpawn();
  const cli = createStepCli({ stateRecord, spawnCommand, now: () => now });

  assert.equal(await cli.run(['step', 'fresh command', '--', 'echo', 'one']), 0);

  now = new Date('2024-01-01T00:04:02.000Z');
  assert.equal(await cli.run(['step', 'stale command', '--', 'echo', 'two']), 0);

  const state = JSON.parse(await readFile(stateRecord.statePath, 'utf8'));
  assert.equal(state.heartbeatCount, 2);
  assert.equal(state.completedNonHeartbeatStepsSinceHeartbeat, 0);
  assert.equal(state.heartbeatSummary, 'stale command');
});

test('step emits a heartbeat after three completed non-heartbeat steps', async () => {
  const runRecordDirectory = await mkdtemp(join(tmpdir(), 'pullops-step-count-'));
  const stateRecord = await initializeLocalRunState({
    runRecordDirectory,
    operationReference: 'issue:implement',
    target: {
      type: 'issue',
      number: 42,
    },
    publicationMode: 'dry-run',
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
  });
  const { spawnCommand } = createFakeStepSpawn();
  const cli = createStepCli({ stateRecord, spawnCommand });

  assert.equal(await cli.run(['step', 'first command', '--', 'echo', 'one']), 0);
  assert.equal(await cli.run(['step', 'second command', '--', 'echo', 'two']), 0);
  assert.equal(await cli.run(['step', 'third command', '--', 'echo', 'three']), 0);
  assert.equal(await cli.run(['step', 'fourth command', '--', 'echo', 'four']), 0);
  const beforeDueStep = JSON.parse(await readFile(stateRecord.statePath, 'utf8'));
  assert.equal(beforeDueStep.completedNonHeartbeatStepsSinceHeartbeat, 3);

  assert.equal(await cli.run(['step', 'fifth command', '--', 'echo', 'five']), 0);

  const afterDueStep = JSON.parse(await readFile(stateRecord.statePath, 'utf8'));
  assert.equal(afterDueStep.heartbeatCount, 2);
  assert.equal(afterDueStep.completedNonHeartbeatStepsSinceHeartbeat, 0);
  assert.equal(afterDueStep.heartbeatSummary, 'fifth command');
});

test('step --long heartbeats before and during a long-running command', async () => {
  const runRecordDirectory = await mkdtemp(join(tmpdir(), 'pullops-step-long-'));
  const stateRecord = await initializeLocalRunState({
    runRecordDirectory,
    operationReference: 'issue:implement',
    target: {
      type: 'issue',
      number: 42,
    },
    publicationMode: 'dry-run',
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    heartbeatIntervalMs: 15,
    leaseDurationMs: 60,
  });
  /** @type {number[]} */
  const spawnHeartbeatCounts = [];
  const { spawnCommand } = createFakeStepSpawn({
    closeAfterMs: 55,
    onSpawn: () => {
      spawnHeartbeatCounts.push(
        JSON.parse(readFileSync(stateRecord.statePath, 'utf8')).heartbeatCount,
      );
    },
  });
  const cli = createStepCli({ stateRecord, spawnCommand, now: () => new Date() });

  const exitCode = await cli.run([
    'step',
    '--long',
    'waiting for slow verification',
    '--',
    'npm',
    'test',
  ]);

  assert.equal(exitCode, 0);
  assert.deepEqual(spawnHeartbeatCounts, [1]);
  const state = JSON.parse(await readFile(stateRecord.statePath, 'utf8'));
  assert.ok(state.heartbeatCount >= 2);
  assert.equal(state.completedNonHeartbeatStepsSinceHeartbeat, 0);
  assert.equal(state.heartbeatSummary, 'waiting for slow verification');
});

test('step preserves wrapped stdout, stderr, and exit code', async () => {
  const runRecordDirectory = await mkdtemp(join(tmpdir(), 'pullops-step-streams-'));
  const stateRecord = await initializeLocalRunState({
    runRecordDirectory,
    operationReference: 'issue:implement',
    target: {
      type: 'issue',
      number: 42,
    },
    publicationMode: 'dry-run',
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
  });
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  const { spawnCommand, calls } = createFakeStepSpawn({
    stdout: 'wrapped stdout\n',
    stderr: 'wrapped stderr\n',
    exitCode: 7,
  });
  const cli = createStepCli({ stateRecord, spawnCommand, stdout, stderr });

  const exitCode = await cli.run(['step', 'running failing command', '--', 'node', '-e', 'fail']);

  assert.equal(exitCode, 7);
  assert.equal(stdout.text, 'wrapped stdout\n');
  assert.equal(stderr.text, 'wrapped stderr\n');
  assert.deepEqual(
    calls.map(call => [call.command, call.args]),
    [['node', ['-e', 'fail']]],
  );
});

test('step shows usage for missing separator or command', async () => {
  for (const args of [
    ['step', 'running tests', 'npm', 'test'],
    ['step', 'running tests', '--'],
  ]) {
    const stderr = createWritableBuffer();
    const cli = new PullOpsCli({ stderr });

    const exitCode = await cli.run(args);

    assert.equal(exitCode, 1);
    assert.equal(stderr.text, 'Usage: pullops step [--long] "<summary>" -- <command...>\n');
  }
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
  const stateJson = JSON.parse(await readFile(join(runRecord, 'state.json'), 'utf8'));
  assert.equal(stateJson.status, 'refused');
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
  const stateJson = JSON.parse(await readFile(join(runRecord, 'state.json'), 'utf8'));
  assert.equal(stateJson.status, 'refused');
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
  const stateJson = JSON.parse(await readFile(join(runRecord, 'state.json'), 'utf8'));
  assert.equal(stateJson.status, 'failed');
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
    await writeGitHubIssueStoreConfig(cwd);
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

  await t.test('relative file input resolves against cli cwd', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-issue-relative-file-'));
    await writeGitHubIssueStoreConfig(cwd);
    const stdout = createWritableBuffer();
    /** @type {import('../github/types.js').CreateIssueOptions[]} */
    const createIssueCalls = [];
    const request = {
      title: 'Publish standalone issue from relative file',
      whatToBuild: 'Read the publish request from the CLI cwd.',
      acceptanceCriteria: ['Relative --file paths resolve against the CLI cwd.'],
      blockedBy: [],
    };
    await writeFile(join(cwd, 'request.json'), `${JSON.stringify(request)}\n`);

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
      }),
    });

    const exitCode = await cli.run(['issues', 'publish-issue', '--file', 'request.json']);

    assert.equal(exitCode, 0);
    assert.equal(createIssueCalls.length, 1);
    assert.equal(createIssueCalls[0].title, request.title);
  });

  await t.test('stdin input', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-issue-stdin-'));
    await writeGitHubIssueStoreConfig(cwd);
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
    await writeGitHubIssueStoreConfig(cwd);
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

  await t.test('relative file input resolves against cli cwd', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-prd-relative-file-'));
    await writeGitHubIssueStoreConfig(cwd);
    const stdout = createWritableBuffer();
    /** @type {import('../github/types.js').CreateIssueOptions[]} */
    const createIssueCalls = [];
    const request = {
      title: 'Publish PRD issue support from relative file',
      problemStatement: 'PullOps should resolve PRD request files from the CLI cwd.',
      solution: 'Resolve relative --file paths before reading publish-prd input.',
      userStories: [
        {
          number: 1,
          story:
            'As a maintainer, I want relative publish files to resolve from the target repo cwd, so that machine callers can pass stable local paths.',
        },
      ],
      implementationDecisions: ['Resolve relative input paths against PullOpsCli.cwd.'],
      testingDecisions: ['Cover relative file input through the CLI seam.'],
      outOfScope: ['Changing stdin behavior.'],
    };
    await writeFile(join(cwd, 'request.json'), `${JSON.stringify(request)}\n`);

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
      }),
    });

    const exitCode = await cli.run(['issues', 'publish-prd', '--file', 'request.json']);

    assert.equal(exitCode, 0);
    assert.equal(createIssueCalls.length, 1);
    assert.equal(createIssueCalls[0].title, request.title);
  });

  await t.test('stdin input', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-prd-stdin-'));
    await writeGitHubIssueStoreConfig(cwd);
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
    await writeGitHubIssueStoreConfig(cwd);
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

  await t.test('relative file input resolves against cli cwd', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-children-relative-file-'));
    await writeGitHubIssueStoreConfig(cwd);
    const stdout = createWritableBuffer();
    /** @type {import('../github/types.js').CreateIssueOptions[]} */
    const createIssueCalls = [];
    const request = {
      children: [
        {
          sliceRef: '1',
          title: 'Publish child issue from relative file',
          whatToBuild: 'Read the child batch request from the CLI cwd.',
          acceptanceCriteria: ['Relative --file paths resolve against the CLI cwd.'],
          coveredUserStories: [2],
        },
      ],
    };
    await writeFile(join(cwd, 'children.json'), `${JSON.stringify(request)}\n`);

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
        async addSubIssue() {},
      }),
    });

    const exitCode = await cli.run([
      'issues',
      'publish-children',
      '--parent',
      '126',
      '--file',
      'children.json',
    ]);

    assert.equal(exitCode, 0);
    assert.equal(createIssueCalls.length, 1);
    assert.equal(createIssueCalls[0].title, request.children[0].title);
  });

  await t.test('conflicting parent flag and JSON parent', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-children-conflict-'));
    await writeGitHubIssueStoreConfig(cwd);
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

  await t.test('plain reruns reuse an existing PullOps-published child by slice ref', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-children-rerun-'));
    await writeGitHubIssueStoreConfig(cwd);
    const stdout = createWritableBuffer();
    const existingChild = createGitHubIssue({
      number: 201,
      url: 'https://github.test/owner/repo/issues/201',
      title: 'Base child',
      body: createChildIssueBody({
        parentIssueNumber: 126,
        sliceRef: 'base',
        title: 'Base child',
        whatToBuild: 'Base work.',
        acceptanceCriteria: ['Base criteria.'],
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
    /** @type {import('../github/types.js').CreateIssueOptions[]} */
    const createIssueCalls = [];
    const request = {
      parentIssueNumber: 126,
      children: [
        {
          sliceRef: 'base',
          title: 'Base child',
          whatToBuild: 'Base work.',
          acceptanceCriteria: ['Base criteria.'],
          coveredUserStories: [2],
        },
        {
          sliceRef: 'dependent',
          title: 'Dependent child issue',
          whatToBuild: 'Create a dependent native Child Issue.',
          acceptanceCriteria: ['The dependent child is created and attached.'],
          blockedBy: ['base'],
          coveredUserStories: [3],
        },
      ],
    };

    const cli = new PullOpsCli({
      cwd,
      stdout,
      stdin: /** @type {NodeJS.ReadableStream} */ (Readable.from([JSON.stringify(request)])),
      githubClient: createFakeGitHubClient({
        async getIssue(number) {
          if (number === 126) {
            return createGitHubIssue({
              number,
              body: createPrdIssueBody({
                title: 'Published parent',
                problemStatement: 'Parent problem.',
                solution: 'Parent solution.',
                userStories: [
                  { number: 2, story: 'As a user, I want child issue publication.' },
                  { number: 3, story: 'As a user, I want reruns to resume safely.' },
                ],
                implementationDecisions: ['Reuse marker-owned children on plain reruns.'],
                testingDecisions: ['Use fake clients.'],
                outOfScope: ['Dependency publication.'],
                furtherNotes: [],
                auditDetails: [],
              }),
              subIssues: [
                {
                  number: 201,
                  title: 'Base child',
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
        async createIssue(options) {
          createIssueCalls.push(options);
          return createGitHubIssue({
            number: 202,
            url: 'https://github.test/owner/repo/issues/202',
            body: options.body,
          });
        },
        async addSubIssue() {},
      }),
    });

    const exitCode = await cli.run(['issues', 'publish-children']);

    assert.equal(exitCode, 0);
    assert.equal(createIssueCalls.length, 1);
    assert.match(createIssueCalls[0].body, /^## Blocked by$/m);
    assert.match(createIssueCalls[0].body, /- #201/);
    assert.doesNotMatch(createIssueCalls[0].body, /base/);

    const output = JSON.parse(stdout.text);
    assert.equal(output.status, 'accepted');
    assert.equal(output.action, 'mixed');
    assert.deepEqual(output.children, [
      {
        sliceRef: 'base',
        action: 'reused',
        issue: {
          number: 201,
          url: 'https://github.test/owner/repo/issues/201',
        },
        blockedBy: [],
      },
      {
        sliceRef: 'dependent',
        action: 'created',
        issue: {
          number: 202,
          url: 'https://github.test/owner/repo/issues/202',
        },
        blockedBy: [201],
      },
    ]);
    assert.deepEqual(output.mappings, [
      {
        sliceRef: 'base',
        issueNumber: 201,
        issueUrl: 'https://github.test/owner/repo/issues/201',
      },
      {
        sliceRef: 'dependent',
        issueNumber: 202,
        issueUrl: 'https://github.test/owner/repo/issues/202',
      },
    ]);
  });

  await t.test('--force updates an existing PullOps-published child by slice ref', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-children-force-'));
    await writeGitHubIssueStoreConfig(cwd);
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

test('setup github-labels --check reports label reconciliation results from the GitHub client seam', async () => {
  const cwd = await createSetupRepository();
  const stdout = createWritableBuffer();
  /** @type {PullOpsLabel[]} */
  const listedLabels = PULL_OPS_LABELS.map(label => ({ ...label }));
  listedLabels[1] = {
    ...listedLabels[1],
    color: '000000',
  };
  listedLabels.splice(5, 1);
  const cli = new PullOpsCli({
    cwd,
    stdout,
    githubClient: createFakeGitHubClient({
      async listRepositoryLabels() {
        return listedLabels;
      },
      async ensureLabels() {
        throw new Error('ensureLabels was not expected in this test.');
      },
    }),
  });

  const exitCode = await cli.run(['setup', 'github-labels', '--check', '--json']);

  assert.equal(exitCode, 1);
  assert.deepEqual(JSON.parse(stdout.text), {
    status: 'blocked',
    area: 'github-labels',
    summary: `PullOps GitHub label setup found 2 labels needing changes: 1 created, 1 updated, ${PULL_OPS_LABELS.length - 2} already correct.`,
    changes: {},
    changesNeeded: {
      labels: {
        created: [PULL_OPS_LABELS[5].name],
        updated: [PULL_OPS_LABELS[1].name],
      },
    },
    blockers: [],
    warnings: [],
    suggestions: ['Run PullOps setup github-labels to reconcile the repository labels.'],
  });
});

test('setup github-labels reports label reconciliation results from the GitHub client seam', async () => {
  const cwd = await createSetupRepository();
  const stdout = createWritableBuffer();
  /** @type {PullOpsLabel[]} */
  const ensuredLabels = [];
  const cli = new PullOpsCli({
    cwd,
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
      async listRepositoryLabels() {
        throw new Error('listRepositoryLabels was not expected in this test.');
      },
    }),
  });

  const exitCode = await cli.run(['setup', 'github-labels', '--json']);

  assert.equal(exitCode, 0);
  assert.deepEqual(
    ensuredLabels.map(label => label.name),
    [
      'pullops:prd:prepare',
      'pullops:prd:auto-advance',
      'pullops:prd:auto-complete',
      'pullops:issue:implement',
      'pullops:pr:review',
      'pullops:pr:address-review',
      'pullops:pr:fix-ci',
      'pullops:pr:update-branch',
      'pullops:pr:resolve-conflicts',
      'pullops:pr:finalize',
      'pullops:human-required',
    ],
  );
  const expectedLabels = {
    created: [ensuredLabels[0].name],
    updated: [ensuredLabels[1].name],
    alreadyCorrect: ensuredLabels.slice(2).map(label => label.name),
  };
  assert.deepEqual(JSON.parse(stdout.text), {
    status: 'changed',
    summary: `Reconciled ${PULL_OPS_LABELS.length} PullOps labels: 1 created, 1 updated, ${PULL_OPS_LABELS.length - 2} already correct.`,
    area: 'github-labels',
    changes: {
      labels: {
        created: [expectedLabels.created[0]],
        updated: [expectedLabels.updated[0]],
      },
    },
    changesNeeded: {},
    blockers: [],
    warnings: [],
    suggestions: [],
  });
});

test('setup github-labels reports GitHub failures', async () => {
  const cwd = await createSetupRepository();
  const stdout = createWritableBuffer();
  const cli = new PullOpsCli({
    cwd,
    stdout,
    githubClient: createFakeGitHubClient({
      async ensureLabels() {
        throw new Error('Failed to list GitHub labels: authentication required');
      },
      async listRepositoryLabels() {
        throw new Error('listRepositoryLabels was not expected in this test.');
      },
    }),
  });

  const exitCode = await cli.run(['setup', 'github-labels']);

  assert.equal(exitCode, 1);
  assert.match(
    stdout.text,
    /Unable to reconcile PullOps GitHub labels: Failed to list GitHub labels: authentication required/,
  );
});

test('setup github-labels accepts --repo owner/repo', async () => {
  const cwd = await createSetupRepository();
  const stdout = createWritableBuffer();
  const cli = new PullOpsCli({
    cwd,
    stdout,
    githubClient: createFakeGitHubClient({
      async listRepositoryLabels() {
        return PULL_OPS_LABELS.map(label => ({ ...label }));
      },
      async ensureLabels() {
        throw new Error('ensureLabels was not expected in this test.');
      },
    }),
  });

  const exitCode = await cli.run([
    'setup',
    'github-labels',
    '--check',
    '--json',
    '--repo',
    'acme/widgets',
  ]);

  assert.equal(exitCode, 0);
  assert.equal(JSON.parse(stdout.text).area, 'github-labels');
});

test('cli reports clear usage errors for unknown commands and missing arguments', async t => {
  await t.test('unknown command', async () => {
    const stderr = createWritableBuffer();
    const cli = new PullOpsCli({ stderr });

    const exitCode = await cli.run(['unknown']);

    assert.equal(exitCode, 1);
    assert.match(stderr.text, /Unknown command "unknown"/);
  });

  await t.test('legacy labels command', async () => {
    const stderr = createWritableBuffer();
    const cli = new PullOpsCli({ stderr });

    const exitCode = await cli.run(['labels', 'ensure']);

    assert.equal(exitCode, 1);
    assert.match(stderr.text, /Unknown command "labels"/);
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

  await t.test('external requires an explicit lifecycle phase', async () => {
    const stderr = createWritableBuffer();
    const cli = new PullOpsCli({ stderr });

    const exitCode = await cli.run([
      'run',
      'issue-implement',
      '--runner',
      'external',
      '--issue',
      '1',
    ]);

    assert.equal(exitCode, 1);
    assert.match(stderr.text, /requires "--phase prepare" or "--phase complete"/);
  });

  await t.test('codex-action is not a public runner adapter', async () => {
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
    assert.match(
      stderr.text,
      /Unknown runner "codex-action". Expected one of: codex-cli, external/,
    );
  });

  await t.test('finalize is not a public runner phase', async () => {
    const stderr = createWritableBuffer();
    const cli = new PullOpsCli({ stderr });

    const exitCode = await cli.run([
      'run',
      'issue-implement',
      '--runner',
      'external',
      '--phase',
      'finalize',
      '--issue',
      '1',
    ]);

    assert.equal(exitCode, 1);
    assert.match(stderr.text, /Unknown phase "finalize". Expected one of: run, prepare, complete/);
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

/**
 * @param {string} cwd
 * @returns {Promise<void>}
 */
async function writeGitHubIssueStoreConfig(cwd) {
  await writeFile(
    join(cwd, 'pullops.config.js'),
    "export default { issueStore: { provider: 'github' } };\n",
  );
}

/**
 * @param {string} cwd
 * @returns {Promise<void>}
 */
async function writeExternalRunnerConfig(cwd) {
  await writeFile(
    join(cwd, 'pullops.config.js'),
    "export default { runner: { adapter: 'external' } };\n",
  );
}

/**
 * @param {object} options
 * @param {import('../local-run-state/types.js').LocalRunStateRecord} options.stateRecord
 * @param {(command: string, args: string[], options: import('node:child_process').SpawnOptions) => import('node:child_process').ChildProcess} options.spawnCommand
 * @param {ReturnType<typeof createWritableBuffer>} [options.stdout]
 * @param {ReturnType<typeof createWritableBuffer>} [options.stderr]
 * @param {() => Date} [options.now]
 * @returns {PullOpsCli}
 */
function createStepCli({
  stateRecord,
  spawnCommand,
  stdout = createWritableBuffer(),
  stderr = createWritableBuffer(),
  now = () => new Date('2024-01-01T00:00:01.000Z'),
}) {
  return new PullOpsCli({
    stdout,
    stderr,
    spawnCommand,
    now,
    githubClient: createFakeGitHubClient(),
    gitClient: createFakeGitClient(),
    env: {
      PULLOPS_RUN_STATE_PATH: stateRecord.statePath,
      PULLOPS_HEARTBEAT_TOKEN: stateRecord.state.heartbeatToken,
    },
  });
}

/**
 * @param {object} [options]
 * @param {string} [options.stdout]
 * @param {string} [options.stderr]
 * @param {number} [options.exitCode]
 * @param {number} [options.closeAfterMs]
 * @param {() => void} [options.onSpawn]
 * @returns {{
 *   calls: { command: string, args: string[], options: import('node:child_process').SpawnOptions }[],
 *   spawnCommand: (command: string, args: string[], options: import('node:child_process').SpawnOptions) => import('node:child_process').ChildProcess,
 * }}
 */
function createFakeStepSpawn({
  stdout = '',
  stderr = '',
  exitCode = 0,
  closeAfterMs = 0,
  onSpawn = () => undefined,
} = {}) {
  /** @type {{ command: string, args: string[], options: import('node:child_process').SpawnOptions }[]} */
  const calls = [];

  return {
    calls,
    spawnCommand(command, args, options) {
      calls.push({ command, args, options });
      onSpawn();

      const child = /** @type {any} */ (new EventEmitter());
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();

      setTimeout(() => {
        child.stdout?.write(stdout);
        child.stdout?.end();
        child.stderr?.write(stderr);
        child.stderr?.end();
        child.emit('close', exitCode, null);
      }, closeAfterMs);

      return /** @type {import('node:child_process').ChildProcess} */ (child);
    },
  };
}

/**
 * @returns {Promise<string>}
 */
async function createSetupRepository() {
  const cwd = await mkdtemp(join(tmpdir(), 'pullops-cli-setup-'));
  await execFileAsync('git', ['init', '--initial-branch=main'], { cwd });
  await writeFile(
    join(cwd, 'package.json'),
    `${JSON.stringify(
      {
        name: 'demo-target',
        private: true,
        type: 'module',
        dependencies: {
          '@pull-ops/cli': '^0.1.0',
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(cwd, 'package-lock.json'),
    `${JSON.stringify(
      {
        name: 'demo-target',
        lockfileVersion: 3,
      },
      null,
      2,
    )}\n`,
  );
  await mkdir(join(cwd, 'node_modules', '@pull-ops', 'cli'), { recursive: true });
  await writeFile(
    join(cwd, 'node_modules', '@pull-ops', 'cli', 'package.json'),
    `${JSON.stringify(
      {
        name: '@pull-ops/cli',
        version: '0.1.0',
        type: 'module',
      },
      null,
      2,
    )}\n`,
  );
  await mkdir(join(cwd, 'node_modules', '.bin'), { recursive: true });
  await writeFile(join(cwd, 'node_modules', '.bin', 'pullops'), '#!/bin/sh\nexit 0\n');
  await chmod(join(cwd, 'node_modules', '.bin', 'pullops'), 0o755);
  await runPullOpsInit({ cwd });
  return cwd;
}

function createWritableBuffer() {
  return {
    text: '',
    /**
     * @param {string | Uint8Array} chunk
     */
    write(chunk) {
      this.text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
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
    async listRepositoryLabels() {
      throw new Error('listRepositoryLabels was not expected in this test.');
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
