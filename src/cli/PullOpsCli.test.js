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
  assert.equal(calls[0].model, 'codex-high');
  assert.deepEqual(JSON.parse(stdout.text), {
    status: 'accepted',
    summary: 'operation accepted',
    operation: 'implement-issue',
    target: { type: 'issue', number: 42 },
    modelTier: 'high',
    model: 'codex-high',
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
    assert.equal(calls[0].target.type, operation.target);
  }
});

test('labels ensure reports label reconciliation results from the GitHub client seam', async () => {
  const stdout = createWritableBuffer();
  /** @type {PullOpsLabel[]} */
  const ensuredLabels = [];
  const cli = new PullOpsCli({
    stdout,
    githubClient: {
      async ensureLabels(labels) {
        ensuredLabels.push(...labels);
        return {
          created: [labels[0].name],
          updated: [labels[1].name],
          alreadyCorrect: labels.slice(2).map(label => label.name),
        };
      },
    },
  });

  const exitCode = await cli.run(['labels', 'ensure']);

  assert.equal(exitCode, 0);
  assert.equal(
    ensuredLabels.some(label => label.name === 'pullops:implement'),
    true,
  );
  assert.equal(
    ensuredLabels.some(label => label.name === 'pullops:blocked'),
    true,
  );
  const expectedLabels = {
    created: [ensuredLabels[0].name],
    updated: [ensuredLabels[1].name],
    alreadyCorrect: ensuredLabels.slice(2).map(label => label.name),
  };
  assert.deepEqual(JSON.parse(stdout.text), {
    status: 'accepted',
    summary: 'Ensured 9 PullOps labels: 1 created, 1 updated, 7 already correct.',
    labels: expectedLabels,
  });
});

test('labels ensure reports GitHub failures', async () => {
  const stderr = createWritableBuffer();
  const cli = new PullOpsCli({
    stderr,
    githubClient: {
      async ensureLabels() {
        throw new Error('Failed to list GitHub labels: authentication required');
      },
    },
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
