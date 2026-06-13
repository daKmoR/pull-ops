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

  it('05: infers malformed PRD relationships from issue body Parent sections', async () => {
    const { execFile } = createFakeIssueExecFile({
      issue: {
        number: 1,
        title: 'PRD',
        body: '## What to build\n\nShip the workflow kit.',
        state: 'OPEN',
        url: 'https://github.com/acme/widgets/issues/1',
        author: {
          login: 'maintainer',
        },
        labels: {
          nodes: [],
        },
        parent: null,
        subIssues: {
          totalCount: 0,
          nodes: [],
        },
      },
      issues: [
        {
          number: 4,
          title: 'Implement a leaf issue',
          body: '## Parent\n\n#1\n\n## What to build\n\nDo the work.',
          state: 'OPEN',
          url: 'https://github.com/acme/widgets/issues/4',
        },
      ],
    });
    const client = createGitHubClient({ execFile });

    const issue = await client.getIssue(1);

    assert.deepEqual(issue.subIssues, [
      {
        number: 4,
        title: 'Implement a leaf issue',
        state: 'OPEN',
        url: 'https://github.com/acme/widgets/issues/4',
        relationshipSource: 'body',
      },
    ]);
  });

  it('06: infers a malformed sub-issue parent from its own Parent section', async () => {
    const { execFile } = createFakeIssueExecFile({
      issue: {
        number: 4,
        title: 'Implement a leaf issue',
        body: '## Parent\n\n#1\n\n## What to build\n\nDo the work.',
        state: 'OPEN',
        url: 'https://github.com/acme/widgets/issues/4',
        author: {
          login: 'maintainer',
        },
        labels: {
          nodes: [],
        },
        parent: null,
        subIssues: {
          totalCount: 0,
          nodes: [],
        },
      },
      issues: [
        {
          number: 1,
          title: 'PRD',
          body: '## What to build\n\nShip the workflow kit.',
          state: 'OPEN',
          url: 'https://github.com/acme/widgets/issues/1',
        },
      ],
    });
    const client = createGitHubClient({ execFile });

    const issue = await client.getIssue(4);

    assert.deepEqual(issue.parent, {
      number: 1,
      title: 'PRD',
      state: 'OPEN',
      url: 'https://github.com/acme/widgets/issues/1',
      relationshipSource: 'body',
    });
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

/**
 * @param {object} options
 * @param {Record<string, unknown>} options.issue
 * @param {Record<string, unknown>[]} options.issues
 * @returns {{ calls: ExecFileCall[], execFile: (file: string, args: string[]) => Promise<{ stdout: string }> }}
 */
function createFakeIssueExecFile({ issue, issues }) {
  /** @type {ExecFileCall[]} */
  const calls = [];

  return {
    calls,
    async execFile(file, args) {
      calls.push({ file, args });

      if (args[0] === 'repo' && args[1] === 'view') {
        return {
          stdout: JSON.stringify({
            nameWithOwner: 'acme/widgets',
          }),
        };
      }

      if (args[0] === 'api' && args[1] === 'graphql') {
        return {
          stdout: JSON.stringify({
            data: {
              repository: {
                issue,
              },
            },
          }),
        };
      }

      if (args[0] === 'issue' && args[1] === 'list') {
        return {
          stdout: JSON.stringify(issues),
        };
      }

      throw new Error(`Unexpected command: ${file} ${args.join(' ')}`);
    },
  };
}
