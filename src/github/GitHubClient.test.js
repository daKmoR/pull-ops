import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createGitHubClient, PULL_OPS_LABELS } from './GitHubClient.js';

/**
 * @typedef {{ file: string, args: string[] }} ExecFileCall
 * @typedef {{ name: string, color: string, description: string | null }} ExistingLabel
 */

describe('createGitHubClient', () => {
  it('01: creates missing PullOps labels', async () => {
    const { calls, execFile } = createFakeExecFile({ labels: [] });
    const client = createGitHubClient({ execFile });

    const result = await client.ensureLabels(PULL_OPS_LABELS);

    assert.deepEqual(result, {
      created: PULL_OPS_LABELS.map(label => label.name),
      updated: [],
      alreadyCorrect: [],
    });
    assert.equal(calls.length, PULL_OPS_LABELS.length + 1);
    assert.deepEqual(calls[0], {
      file: 'gh',
      args: ['label', 'list', '--limit', '1000', '--json', 'name,color,description'],
    });
    assert.deepEqual(calls[1], {
      file: 'gh',
      args: [
        'label',
        'create',
        'pullops:implement',
        '--color',
        '5319E7',
        '--description',
        'Run PullOps implementation for an issue or PRD.',
      ],
    });
  });

  it('02: leaves existing PullOps labels unchanged when already correct', async () => {
    const labels = PULL_OPS_LABELS.map(label => ({
      ...label,
      color: label.color.toLowerCase(),
    }));
    const { calls, execFile } = createFakeExecFile({ labels });
    const client = createGitHubClient({ execFile });

    const result = await client.ensureLabels(PULL_OPS_LABELS);

    assert.deepEqual(result, {
      created: [],
      updated: [],
      alreadyCorrect: PULL_OPS_LABELS.map(label => label.name),
    });
    assert.equal(calls.length, 1);
  });

  it('03: creates missing labels and updates incorrect existing labels', async () => {
    const labels = [
      {
        name: 'pullops:missing',
        color: '111111',
        description: 'Missing label.',
      },
      {
        name: 'pullops:wrong-color',
        color: '222222',
        description: 'Correct description.',
      },
      {
        name: 'pullops:wrong-description',
        color: '333333',
        description: 'Correct description.',
      },
      {
        name: 'pullops:already-correct',
        color: '444444',
        description: 'Already correct.',
      },
    ];
    const { calls, execFile } = createFakeExecFile({
      labels: [
        {
          name: 'pullops:wrong-color',
          color: '000000',
          description: 'Correct description.',
        },
        {
          name: 'pullops:wrong-description',
          color: '333333',
          description: 'Old description.',
        },
        {
          name: 'pullops:already-correct',
          color: '444444',
          description: 'Already correct.',
        },
      ],
    });
    const client = createGitHubClient({ execFile });

    const result = await client.ensureLabels(labels);

    assert.deepEqual(result, {
      created: ['pullops:missing'],
      updated: ['pullops:wrong-color', 'pullops:wrong-description'],
      alreadyCorrect: ['pullops:already-correct'],
    });
    assert.deepEqual(
      calls.map(call => call.args.slice(0, 3)),
      [
        ['label', 'list', '--limit'],
        ['label', 'create', 'pullops:missing'],
        ['label', 'edit', 'pullops:wrong-color'],
        ['label', 'edit', 'pullops:wrong-description'],
      ],
    );
  });

  it('04: reports GitHub command failures with label context', async () => {
    const { execFile } = createFakeExecFile({
      labels: [
        {
          name: 'pullops:wrong-color',
          color: '000000',
          description: 'Correct description.',
        },
      ],
      failOn: call => call.args[1] === 'edit',
    });
    const client = createGitHubClient({ execFile });

    await assert.rejects(
      client.ensureLabels([
        {
          name: 'pullops:wrong-color',
          color: '222222',
          description: 'Correct description.',
        },
      ]),
      /Failed to update GitHub label "pullops:wrong-color": GitHub refused the label change./,
    );
  });
});

/**
 * @param {object} options
 * @param {ExistingLabel[]} options.labels
 * @param {(call: ExecFileCall) => boolean} [options.failOn]
 * @returns {{ calls: ExecFileCall[], execFile: (file: string, args: string[]) => Promise<{ stdout: string }> }}
 */
function createFakeExecFile({ labels, failOn = () => false }) {
  /** @type {ExecFileCall[]} */
  const calls = [];

  return {
    calls,
    async execFile(file, args) {
      const call = { file, args };
      calls.push(call);

      if (failOn(call)) {
        const error = new Error('Command failed.');
        Object.assign(error, { stderr: 'GitHub refused the label change.' });
        throw error;
      }

      if (args[0] === 'label' && args[1] === 'list') {
        return { stdout: JSON.stringify(labels) };
      }

      return { stdout: '' };
    },
  };
}
