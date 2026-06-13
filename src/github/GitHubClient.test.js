import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createGitHubClient, PULL_OPS_LABELS } from './GitHubClient.js';

/**
 * @typedef {{ file: string, args: string[] }} ExecFileCall
 * @typedef {{ name: string, color: string, description: string | null }} ExistingLabel
 */

describe('createGitHubClient', () => {
  it('01: defines PullOps task and state labels', () => {
    assert.deepEqual(
      PULL_OPS_LABELS.map(label => [label.name, label.color, label.description]),
      [
        [
          'pullops:prepare',
          '5319E7',
          'Prepare an umbrella branch and draft PR for a parent issue or PRD.',
        ],
        [
          'pullops:implement',
          '5319E7',
          'Implement one concrete issue. Does not coordinate child issues.',
        ],
        [
          'pullops:coordinate',
          '5319E7',
          'Reserved for future automatic parent/child issue orchestration.',
        ],
        ['pullops:review', '5319E7', 'Run PullOps automated PR review.'],
        ['pullops:address-review', '5319E7', 'Address actionable PullOps PR review feedback.'],
        ['pullops:fix-ci', '5319E7', 'Classify and fix actionable CI failures.'],
        ['pullops:update-branch', '5319E7', 'Update a same-repository PR branch.'],
        [
          'pullops:resolve-conflicts',
          '5319E7',
          'Resolve branch update conflicts with the PullOps runner.',
        ],
        [
          'pullops:prepare-merge',
          '5319E7',
          'Prepare a PullOps-managed PR for human review and merge.',
        ],
        ['pullops:in-progress', 'FBCA04', 'PullOps automation is currently working.'],
        ['pullops:blocked', 'D93F0B', 'PullOps automation is blocked and needs human attention.'],
        ['pullops:done', '0E8A16', 'PullOps automation completed successfully.'],
        ['pullops:failed', 'B60205', 'PullOps automation failed and needs investigation.'],
      ],
    );
  });

  it('02: creates missing PullOps labels', async () => {
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
        'pullops:prepare',
        '--color',
        '5319E7',
        '--description',
        'Prepare an umbrella branch and draft PR for a parent issue or PRD.',
      ],
    });
  });

  it('03: leaves existing PullOps labels unchanged when already correct', async () => {
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

  it('04: creates missing labels and updates incorrect existing labels', async () => {
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

  it('05: reports GitHub command failures with label context', async () => {
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

  it('06: reads native issue parent and sub-issue relationships', async () => {
    const { calls, execFile } = createFakeIssueExecFile({
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
          totalCount: 1,
          nodes: [
            {
              number: 4,
              title: 'Implement a leaf issue',
              body: '## What to build\n\nDo the work.',
              state: 'OPEN',
              url: 'https://github.com/acme/widgets/issues/4',
            },
          ],
        },
      },
    });
    const client = createGitHubClient({ execFile });

    const issue = await client.getIssue(1);

    assert.deepEqual(issue.subIssues, [
      {
        number: 4,
        title: 'Implement a leaf issue',
        state: 'OPEN',
        url: 'https://github.com/acme/widgets/issues/4',
        relationshipSource: 'native',
      },
    ]);
    assert.equal(
      calls.some(call => call.args[0] === 'issue' && call.args[1] === 'list'),
      false,
    );
  });

  it('07: ignores legacy Parent body sections when native relationships are absent', async () => {
    const { calls, execFile } = createFakeIssueExecFile({
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
    });
    const client = createGitHubClient({ execFile });

    const issue = await client.getIssue(4);

    assert.equal(issue.parent, null);
    assert.deepEqual(issue.subIssues, []);
    assert.equal(
      calls.some(call => call.args[0] === 'issue' && call.args[1] === 'list'),
      false,
    );
  });

  it('08: loads pull request review context and diff context', async () => {
    const { calls, execFile } = createFakePullRequestExecFile();
    const client = createGitHubClient({ execFile });

    const pullRequest = await client.getPullRequest(100);
    const reviewContext = await client.getPullRequestReviewContext(100);
    const diff = await client.getPullRequestDiff(100);

    assert.equal(pullRequest.number, 100);
    assert.equal(pullRequest.isCrossRepository, false);
    assert.deepEqual(reviewContext.files, [
      {
        path: 'src/example.js',
        additions: 1,
        deletions: 0,
      },
    ]);
    assert.deepEqual(reviewContext.unresolvedThreads[0].comments[0].databaseId, 9001);
    assert.equal(diff.patch, 'diff --git a/src/example.js b/src/example.js\n');
    assert.deepEqual(
      calls.map(call => call.args.slice(0, 3)),
      [
        ['pr', 'view', '100'],
        ['repo', 'view', '--json'],
        ['api', 'graphql', '-f'],
        ['pr', 'diff', '100'],
      ],
    );
  });

  it('09: publishes review decisions, replies, PR body updates, PR labels, and PR comments through gh', async () => {
    const { calls, execFile } = createFakePullRequestExecFile();
    const client = createGitHubClient({ execFile });

    await client.publishPullRequestReview({
      number: 100,
      event: 'REQUEST_CHANGES',
      body: 'Needs changes.',
      comments: [
        {
          path: 'src/example.js',
          line: 2,
          body: 'Inline feedback.',
        },
      ],
    });
    await client.replyToPullRequestReviewComment({
      commentId: 9001,
      body: 'Reply body.',
    });
    await client.updatePullRequestBody({
      number: 100,
      body: 'Updated body.',
    });
    await client.removeLabelsFromPullRequest({
      number: 100,
      labels: ['pullops:review'],
    });
    await client.commentOnPullRequest({
      number: 100,
      body: 'Failure reason.',
    });

    assert.deepEqual(calls[1], {
      file: 'gh',
      args: [
        'api',
        '--method',
        'POST',
        'repos/acme/widgets/pulls/100/reviews',
        '-f',
        'event=REQUEST_CHANGES',
        '-f',
        'body=Needs changes.',
        '-f',
        'comments[0][path]=src/example.js',
        '-F',
        'comments[0][line]=2',
        '-f',
        'comments[0][side]=RIGHT',
        '-f',
        'comments[0][body]=Inline feedback.',
      ],
    });
    assert.deepEqual(calls[3], {
      file: 'gh',
      args: [
        'api',
        '--method',
        'POST',
        'repos/acme/widgets/pulls/comments/9001/replies',
        '-f',
        'body=Reply body.',
      ],
    });
    assert.deepEqual(calls.slice(4), [
      {
        file: 'gh',
        args: ['pr', 'edit', '100', '--body', 'Updated body.'],
      },
      {
        file: 'gh',
        args: ['pr', 'edit', '100', '--remove-label', 'pullops:review'],
      },
      {
        file: 'gh',
        args: ['pr', 'comment', '100', '--body', 'Failure reason.'],
      },
    ]);
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
 * @returns {{ calls: ExecFileCall[], execFile: (file: string, args: string[]) => Promise<{ stdout: string }> }}
 */
function createFakeIssueExecFile({ issue }) {
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

      throw new Error(`Unexpected command: ${file} ${args.join(' ')}`);
    },
  };
}

/**
 * @returns {{ calls: ExecFileCall[], execFile: (file: string, args: string[]) => Promise<{ stdout: string }> }}
 */
function createFakePullRequestExecFile() {
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

      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          stdout: JSON.stringify({
            number: 100,
            title: 'Implement #42',
            url: 'https://github.com/acme/widgets/pull/100',
            headRefName: 'pullops/issue-42',
            baseRefName: 'main',
            body: 'Managed PR: yes',
            isDraft: true,
            isCrossRepository: false,
          }),
        };
      }

      if (args[0] === 'api' && args[1] === 'graphql') {
        return {
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  comments: {
                    nodes: [
                      {
                        body: 'PR comment.',
                        url: 'https://github.com/acme/widgets/pull/100#issuecomment-1',
                        author: {
                          login: 'maintainer',
                        },
                      },
                    ],
                  },
                  reviews: {
                    nodes: [
                      {
                        id: 'R_1',
                        state: 'COMMENTED',
                        body: 'Review summary.',
                        url: 'https://github.com/acme/widgets/pull/100#pullrequestreview-1',
                        author: {
                          login: 'reviewer',
                        },
                      },
                    ],
                  },
                  reviewThreads: {
                    nodes: [
                      {
                        isResolved: false,
                        comments: {
                          nodes: [
                            {
                              id: 'PRRC_1',
                              databaseId: 9001,
                              body: 'Unresolved feedback.',
                              path: 'src/example.js',
                              line: 2,
                              diffHunk: '@@ -1 +1 @@',
                              url: 'https://github.com/acme/widgets/pull/100#discussion_r9001',
                              author: {
                                login: 'reviewer',
                              },
                            },
                          ],
                        },
                      },
                    ],
                  },
                  files: {
                    nodes: [
                      {
                        path: 'src/example.js',
                        additions: 1,
                        deletions: 0,
                      },
                    ],
                  },
                },
              },
            },
          }),
        };
      }

      if (args[0] === 'pr' && args[1] === 'diff') {
        return {
          stdout: 'diff --git a/src/example.js b/src/example.js\n',
        };
      }

      return { stdout: '' };
    },
  };
}
