import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { DEFAULT_PULL_OPS_CONFIG } from '../../config/PullOpsConfig.js';
import {
  GITHUB_ACTIONS_BOT_AUTHOR,
  runReviewPr,
  runReviewPrCodexActionFinalize,
  runReviewPrCodexActionPrepare,
} from './run.js';

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('../../github/types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('../../github/types.js').GitHubPullRequestReviewContext} GitHubPullRequestReviewContext
 * @typedef {import('../../github/types.js').GitHubPullRequestDiff} GitHubPullRequestDiff
 * @typedef {import('../../github/types.js').PublishPullRequestReviewOptions} PublishPullRequestReviewOptions
 * @typedef {import('../../github/types.js').ReplyToPullRequestReviewCommentOptions} ReplyToPullRequestReviewCommentOptions
 * @typedef {import('../../github/types.js').UpdatePullRequestBodyOptions} UpdatePullRequestBodyOptions
 * @typedef {import('../../github/types.js').EditLabelsOptions} EditLabelsOptions
 * @typedef {import('../../github/types.js').CommentOnPullRequestOptions} CommentOnPullRequestOptions
 * @typedef {import('../../git/types.js').CommitAllOptions} CommitAllOptions
 * @typedef {import('../../git/types.js').PushBranchOptions} PushBranchOptions
 * @typedef {import('../../runner/types.js').CodexRunOptions} CodexRunOptions
 */

describe('runReviewPr', () => {
  it('01: approves a managed same-repository PR, publishes valid comments and replies, drops invalid anchors, and updates PR state', async () => {
    const github = createFakeGitHub({
      pullRequest: createPullRequest(),
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const git = createFakeGit({ hasChanges: false });
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'approved',
        summary: 'The PR satisfies the issue and coding standards.',
        comments: [
          {
            path: 'src/example.js',
            line: 2,
            body: 'This new line is clear.',
          },
          {
            path: 'src/example.js',
            line: 99,
            body: 'This line is not in the diff.',
          },
          {
            path: 'src/missing.js',
            line: 1,
            body: 'This path is not in the diff.',
          },
        ],
        replies: [
          {
            commentId: 9001,
            body: 'This unresolved thread is now accounted for.',
          },
          {
            commentId: 9999,
            body: 'This reply target is not unresolved.',
          },
        ],
      }),
    });

    const result = await runReviewPr(
      createContext({
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(result.reviewResult, 'approved');
    assert.equal(codex.calls.length, 1);
    assert.match(codex.calls[0].prompt, /Use the pullops-review-pr skill/);
    assert.match(codex.calls[0].prompt, /Coding Standards Pass/);
    assert.deepEqual(github.publishedReviews, [
      {
        number: 100,
        event: 'APPROVE',
        body: 'The PR satisfies the issue and coding standards.',
        comments: [
          {
            path: 'src/example.js',
            line: 2,
            body: 'This new line is clear.',
          },
        ],
      },
    ]);
    assert.deepEqual(github.replies, [
      {
        commentId: 9001,
        body: 'This unresolved thread is now accounted for.',
      },
    ]);
    assert.match(github.updatedBodies[0].body, /Status: Review approved/);
    assert.match(github.updatedBodies[0].body, /Review cycles: 2 \/ 3/);
    assert.match(github.updatedBodies[0].body, /Last operation: pullops:pr:review/);
    assert.deepEqual(github.pullRequestLabelsRemoved, [
      {
        number: 100,
        labels: [
          'pullops:pr:review',
          'pullops:status:in-progress',
          'pullops:status:blocked',
          'pullops:status:prepared',
          'pullops:status:done',
          'pullops:status:failed',
        ],
      },
    ]);
    assert.deepEqual(github.pullRequestLabelsAdded, [
      {
        number: 100,
        labels: ['pullops:pr:prepare-merge'],
      },
    ]);
    const review = /** @type {{
      comments: { published: number, dropped: number };
      replies: { published: number, dropped: number };
      directChangesCommitted: boolean;
    }} */ (result.review);
    assert.deepEqual(review, {
      comments: {
        published: 1,
        dropped: 2,
      },
      replies: {
        published: 1,
        dropped: 1,
      },
      directChangesCommitted: false,
    });
  });

  it('02: requests changes, commits direct review improvements, pushes the PR branch, and hands off to address-review', async () => {
    const github = createFakeGitHub({
      pullRequest: createPullRequest(),
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const git = createFakeGit({ hasChanges: true });
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'changes_requested',
        summary: 'The PR needs one implementation fix.',
        comments: [],
        directChanges: ['Normalized a local coding-standards issue found during review.'],
      }),
    });

    const result = await runReviewPr(
      createContext({
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.reviewResult, 'changes_requested');
    assert.deepEqual(git.commits, [
      {
        message: [
          'chore(review): apply review improvements for PR #100',
          '',
          '- Normalized a local coding-standards issue found during review.',
          '',
          'Refs: #100',
        ].join('\n'),
        author: GITHUB_ACTIONS_BOT_AUTHOR,
      },
    ]);
    assert.deepEqual(git.pushes, [{ branchName: 'pullops/issue-42' }]);
    assert.equal(github.publishedReviews[0].event, 'REQUEST_CHANGES');
    assert.match(github.updatedBodies[0].body, /Status: Changes requested/);
    assert.deepEqual(github.pullRequestLabelsAdded, [
      {
        number: 100,
        labels: ['pullops:pr:address-review'],
      },
    ]);
    const review = /** @type {{ directChangesCommitted: boolean }} */ (result.review);
    assert.equal(review.directChangesCommitted, true);
  });

  it('03: prepares a Codex Action prompt without invoking the runner', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'pullops-codex-action-'));
    const github = createFakeGitHub({
      pullRequest: createPullRequest(),
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const codex = createFakeCodexRunner({ output: '{}' });

    const result = await runReviewPrCodexActionPrepare(
      createContext({
        githubClient: github.client,
        codexRunner: codex.runner,
        outputDirectory,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(codex.calls.length, 0);

    const prompt = await readFile(join(outputDirectory, 'codex_prompt.md'), 'utf8');
    assert.match(prompt, /Use the pullops-review-pr skill/);
    assert.match(prompt, /Review PullOps-managed PR #100/);
    assert.deepEqual(result.codexAction, {
      promptFile: join(outputDirectory, 'codex_prompt.md'),
      outputFile: join(outputDirectory, 'codex_output.json'),
      model: 'gpt-5.5',
      branch: 'pullops/issue-42',
    });
  });

  it('04: finalizes a Codex Action output without invoking the runner', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'pullops-codex-action-'));
    await writeFile(
      join(outputDirectory, 'codex_output.json'),
      JSON.stringify({
        status: 'approved',
        summary: 'The PR satisfies the issue and coding standards.',
        comments: [],
        replies: [],
      }),
    );

    const github = createFakeGitHub({
      pullRequest: createPullRequest(),
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const git = createFakeGit({ hasChanges: false });
    const codex = createFakeCodexRunner({ output: '{}' });

    const result = await runReviewPrCodexActionFinalize(
      createContext({
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
        outputDirectory,
        codexActionOutcome: 'success',
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(result.reviewResult, 'approved');
    assert.equal(codex.calls.length, 0);
    assert.equal(github.publishedReviews.length, 1);
    assert.equal(github.publishedReviews[0].event, 'APPROVE');
    assert.match(github.updatedBodies[0].body, /Status: Review approved/);
  });

  it('05: records a blocked Review Result without publishing a GitHub review', async () => {
    const github = createFakeGitHub({
      pullRequest: createPullRequest(),
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'blocked',
        summary: 'Review could not complete.',
        failureReason: 'The diff context was incomplete.',
      }),
    });

    const result = await runReviewPr(
      createContext({
        githubClient: github.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'blocked');
    assert.equal(github.publishedReviews.length, 0);
    assert.match(github.updatedBodies[0].body, /Status: Blocked/);
    assert.match(github.updatedBodies[0].body, /Review cycles: 2 \/ 3/);
    assert.deepEqual(github.pullRequestLabelsAdded, [
      {
        number: 100,
        labels: ['pullops:status:blocked'],
      },
    ]);
    assert.match(github.comments[0].body, /The diff context was incomplete/);
  });

  it('06: records invalid Review Result before publishing reviews, replies, commits, or pushes', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'pullops-review-failure-'));
    const github = createFakeGitHub({
      pullRequest: createPullRequest(),
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const git = createFakeGit({ hasChanges: true });
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'changes_requested',
        summary: 'Needs changes.',
        comments: [
          {
            path: 'src/example.js',
            line: '2',
            body: 'Line must be numeric.',
          },
        ],
      }),
    });

    await assert.rejects(
      runReviewPr(
        createContext({
          githubClient: github.client,
          gitClient: git.client,
          codexRunner: codex.runner,
          outputDirectory,
        }),
      ),
      /Invalid Review Result: Operation Output\.comments\[0\]\.line must be a positive integer\./,
    );

    assert.equal(github.publishedReviews.length, 0);
    assert.equal(github.replies.length, 0);
    assert.equal(git.commits.length, 0);
    assert.equal(git.pushes.length, 0);
    assert.match(github.updatedBodies[0].body, /Status: Blocked/);
    assert.equal(
      await readFile(join(outputDirectory, 'failure_reason.txt'), 'utf8'),
      'Invalid Review Result: Operation Output.comments[0].line must be a positive integer.\n',
    );
  });

  it('07: refuses forked PRs without running Codex', async () => {
    const github = createFakeGitHub({
      pullRequest: createPullRequest({ isCrossRepository: true }),
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const codex = createFakeCodexRunner({ output: '{}' });

    const result = await runReviewPr(
      createContext({
        githubClient: github.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'refused');
    assert.match(String(result.summary), /same-repository PRs/);
    assert.equal(codex.calls.length, 0);
    assert.deepEqual(github.pullRequestLabelsAdded, [
      {
        number: 100,
        labels: ['pullops:status:blocked'],
      },
    ]);
  });
});

/**
 * @param {Partial<OperationRunnerContext>} overrides
 * @returns {OperationRunnerContext}
 */
function createContext(overrides = {}) {
  return {
    operation: 'review-pr',
    phase: 'run',
    target: {
      type: 'pr',
      number: 100,
    },
    cwd: '/workspace',
    config: DEFAULT_PULL_OPS_CONFIG,
    modelTier: 'high',
    model: 'gpt-5.5',
    githubClient: createFakeGitHub({
      pullRequest: createPullRequest(),
      reviewContext: createReviewContext(),
      diff: createDiff(),
    }).client,
    gitClient: createFakeGit({ hasChanges: false }).client,
    codexRunner: createFakeCodexRunner({ output: '{}' }).runner,
    ...overrides,
  };
}

/**
 * @param {Partial<GitHubPullRequest>} [overrides]
 * @returns {GitHubPullRequest}
 */
function createPullRequest(overrides = {}) {
  return {
    number: 100,
    title: 'Implement #42: Add review automation',
    url: 'https://github.com/acme/widgets/pull/100',
    headRefName: 'pullops/issue-42',
    baseRefName: 'main',
    body: [
      '## Summary',
      '',
      'Implemented the issue.',
      '',
      '## PullOps',
      '',
      'Managed PR: yes',
      'Status: Draft automation',
      'Review cycles: 1 / 3',
      'Source: Issue #42',
      'Branch: pullops/issue-42',
      'Last operation: pullops:issue:implement',
    ].join('\n'),
    isDraft: true,
    isCrossRepository: false,
    ...overrides,
  };
}

/**
 * @returns {GitHubIssue}
 */
function createIssue() {
  return {
    number: 42,
    title: 'Add review automation',
    body: '## What to build\n\nReview PullOps-managed PRs.',
    state: 'OPEN',
    url: 'https://github.com/acme/widgets/issues/42',
    authorLogin: 'maintainer',
    labels: [],
    parent: null,
    subIssues: [],
  };
}

/**
 * @returns {GitHubPullRequestReviewContext}
 */
function createReviewContext() {
  return {
    comments: [
      {
        body: 'Please review this change.',
        authorLogin: 'maintainer',
      },
    ],
    reviews: [
      {
        id: 'R_1',
        state: 'COMMENTED',
        body: 'Earlier review summary.',
        authorLogin: 'reviewer',
      },
    ],
    unresolvedThreads: [
      {
        isResolved: false,
        comments: [
          {
            id: 'PRRC_1',
            databaseId: 9001,
            body: 'Existing unresolved feedback.',
            authorLogin: 'reviewer',
            path: 'src/example.js',
            line: 2,
          },
        ],
      },
    ],
    files: [
      {
        path: 'src/example.js',
        additions: 1,
        deletions: 0,
      },
    ],
  };
}

/**
 * @returns {GitHubPullRequestDiff}
 */
function createDiff() {
  return {
    patch: [
      'diff --git a/src/example.js b/src/example.js',
      '--- a/src/example.js',
      '+++ b/src/example.js',
      '@@ -1,2 +1,3 @@',
      ' const a = 1;',
      '+const b = 2;',
      ' const c = 3;',
    ].join('\n'),
  };
}

/**
 * @param {object} options
 * @param {GitHubPullRequest} options.pullRequest
 * @param {GitHubPullRequestReviewContext} options.reviewContext
 * @param {GitHubPullRequestDiff} options.diff
 * @returns {{
 *   publishedReviews: PublishPullRequestReviewOptions[];
 *   replies: ReplyToPullRequestReviewCommentOptions[];
 *   updatedBodies: UpdatePullRequestBodyOptions[];
 *   pullRequestLabelsAdded: EditLabelsOptions[];
 *   pullRequestLabelsRemoved: EditLabelsOptions[];
 *   comments: CommentOnPullRequestOptions[];
 *   client: import('../../github/types.js').GitHubClient;
 * }}
 */
function createFakeGitHub({ pullRequest, reviewContext, diff }) {
  /** @type {PublishPullRequestReviewOptions[]} */
  const publishedReviews = [];
  /** @type {ReplyToPullRequestReviewCommentOptions[]} */
  const replies = [];
  /** @type {UpdatePullRequestBodyOptions[]} */
  const updatedBodies = [];
  /** @type {EditLabelsOptions[]} */
  const pullRequestLabelsAdded = [];
  /** @type {EditLabelsOptions[]} */
  const pullRequestLabelsRemoved = [];
  /** @type {CommentOnPullRequestOptions[]} */
  const comments = [];

  return {
    publishedReviews,
    replies,
    updatedBodies,
    pullRequestLabelsAdded,
    pullRequestLabelsRemoved,
    comments,
    client: {
      async ensureLabels() {
        return {
          created: [],
          updated: [],
          alreadyCorrect: [],
        };
      },
      async getIssue() {
        return createIssue();
      },
      async getPullRequest() {
        return pullRequest;
      },
      async getPullRequestReviewContext() {
        return reviewContext;
      },
      async getPullRequestDiff() {
        return diff;
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
      async addLabelsToPullRequest(options) {
        pullRequestLabelsAdded.push(options);
      },
      async removeLabelsFromPullRequest(options) {
        pullRequestLabelsRemoved.push(options);
      },
      async commentOnIssue() {
        throw new Error('commentOnIssue was not expected in this test.');
      },
      async commentOnPullRequest(options) {
        comments.push(options);
      },
      async updatePullRequestBody(options) {
        updatedBodies.push(options);
      },
      async publishPullRequestReview(options) {
        publishedReviews.push(options);
      },
      async replyToPullRequestReviewComment(options) {
        replies.push(options);
      },
    },
  };
}

/**
 * @param {{ hasChanges: boolean }} options
 * @returns {{
 *   commits: CommitAllOptions[];
 *   pushes: PushBranchOptions[];
 *   client: import('../../git/types.js').GitClient;
 * }}
 */
function createFakeGit({ hasChanges }) {
  /** @type {CommitAllOptions[]} */
  const commits = [];
  /** @type {PushBranchOptions[]} */
  const pushes = [];

  return {
    commits,
    pushes,
    client: {
      async createBranch() {
        throw new Error('createBranch was not expected in this test.');
      },
      async hasChanges() {
        return hasChanges;
      },
      async commitAll(options) {
        commits.push(options);
      },
      async commitEmpty() {
        throw new Error('commitEmpty was not expected in this test.');
      },
      async pushBranch(options) {
        pushes.push(options);
      },
    },
  };
}

/**
 * @param {{ output: unknown }} options
 * @returns {{ calls: CodexRunOptions[], runner: import('../../runner/types.js').CodexRunner }}
 */
function createFakeCodexRunner({ output }) {
  /** @type {CodexRunOptions[]} */
  const calls = [];

  return {
    calls,
    runner: {
      async run(options) {
        calls.push(options);
        return output;
      },
    },
  };
}
