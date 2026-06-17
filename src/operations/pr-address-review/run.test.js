import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { DEFAULT_PULL_OPS_CONFIG } from '../../config/PullOpsConfig.js';
import { GITHUB_ACTIONS_BOT_AUTHOR, runPrAddressReview } from './run.js';

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('../../github/types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('../../github/types.js').GitHubPullRequestReviewContext} GitHubPullRequestReviewContext
 * @typedef {import('../../github/types.js').GitHubPullRequestDiff} GitHubPullRequestDiff
 * @typedef {import('../../github/types.js').ReplyToPullRequestReviewCommentOptions} ReplyToPullRequestReviewCommentOptions
 * @typedef {import('../../github/types.js').UpdatePullRequestBodyOptions} UpdatePullRequestBodyOptions
 * @typedef {import('../../github/types.js').EditLabelsOptions} EditLabelsOptions
 * @typedef {import('../../github/types.js').CommentOnPullRequestOptions} CommentOnPullRequestOptions
 * @typedef {import('../../git/types.js').CommitAllOptions} CommitAllOptions
 * @typedef {import('../../git/types.js').PushBranchOptions} PushBranchOptions
 * @typedef {import('../../runner/types.js').CodexRunOptions} CodexRunOptions
 */

describe('runPrAddressReview', () => {
  it('01: addresses inline threads, requested-change summaries, PullOps review output, and top-level comments before returning to review', async () => {
    const github = createFakeGitHub({
      pullRequest: createPullRequest(),
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const git = createFakeGit({ hasChanges: true });
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'addressed',
        summary: 'Addressed all review feedback.',
        addressed: [
          {
            feedbackId: 'thread:9001',
            response: 'Updated the implementation to cover the inline concern.',
          },
          {
            feedbackId: 'review:PRR_requested',
            response: 'Updated the docs requested by the review summary.',
          },
          {
            feedbackId: 'pullops-pr-review:PRR_pullops',
            response: 'Added the missing regression test noted by PullOps review.',
          },
          {
            feedbackId: 'comment:7001',
            response: 'Clarified the behavior requested in the top-level comment.',
          },
        ],
        declined: [],
        deferred: [],
        changes: ['Adjusted implementation, docs, and regression coverage.'],
        testPlan: ['node --test src/operations/pr-address-review/run.test.js'],
      }),
    });

    const result = await runPrAddressReview(
      createContext({
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(codex.calls.length, 1);
    assert.match(codex.calls[0].prompt, /Use the pullops-pr-address-review skill/);
    assert.match(codex.calls[0].prompt, /feedbackId `thread:9001`/);
    assert.match(codex.calls[0].prompt, /requested-change review summary/);
    assert.match(codex.calls[0].prompt, /PullOps review output/);
    assert.match(codex.calls[0].prompt, /top-level PR comment/);
    assert.deepEqual(git.commits, [
      {
        message: [
          'fix(pr-address-review): address feedback for PR #100',
          '',
          '- Adjusted implementation, docs, and regression coverage.',
          '',
          'Refs: #100',
        ].join('\n'),
        author: GITHUB_ACTIONS_BOT_AUTHOR,
      },
    ]);
    assert.deepEqual(git.pushes, [{ branchName: 'pullops/issue-42' }]);
    assert.deepEqual(github.replies, [
      {
        commentId: 9001,
        body: [
          'PullOps addressed this feedback.',
          '',
          'Updated the implementation to cover the inline concern.',
        ].join('\n'),
      },
    ]);
    assert.deepEqual(github.resolvedReviewThreads, ['PRRT_1']);
    assert.equal(github.comments.length, 4);
    assert.match(github.comments[0].body, /<summary>PullOps operation audit<\/summary>/);
    assert.match(github.comments[0].body, /Operation: pullops:pr:address-review/);
    assert.match(github.comments[1].body, /PullOps addressed feedback `review:PRR_requested`/);
    assert.match(
      github.comments[2].body,
      /PullOps addressed feedback `pullops-pr-review:PRR_pullops`/,
    );
    assert.match(github.comments[3].body, /PullOps addressed feedback `comment:7001`/);
    assert.match(github.updatedBodies[0].body, /Status: Review feedback addressed/);
    assert.match(github.updatedBodies[0].body, /Review cycles: 1 \/ 3/);
    assert.match(github.updatedBodies[0].body, /Last operation: pullops:pr:address-review/);
    assert.deepEqual(github.pullRequestLabelsRemoved, [
      {
        number: 100,
        labels: [
          'pullops:pr:address-review',
          'pullops:human-required',
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
        labels: ['pullops:pr:review'],
      },
    ]);
    assert.deepEqual(result.prAddressReview, {
      feedback: {
        addressed: 4,
        declined: 0,
        deferred: 0,
      },
      changesCommitted: true,
    });
  });

  it('02: posts declined feedback responses, defers stale feedback without responding, and returns to review without requiring code changes', async () => {
    const github = createFakeGitHub({
      pullRequest: createPullRequest(),
      reviewContext: createReviewContext({
        comments: [
          {
            databaseId: 7001,
            body: 'Please rename the public option.',
            authorLogin: 'maintainer',
          },
          {
            databaseId: 7002,
            body: 'This comment predates the latest review.',
            authorLogin: 'maintainer',
          },
        ],
        reviews: [],
      }),
      diff: createDiff(),
    });
    const git = createFakeGit({ hasChanges: false });
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'addressed',
        summary: 'Declined one request and deferred one stale comment.',
        addressed: [],
        declined: [
          {
            feedbackId: 'thread:9001',
            reason: 'The requested inline change would break the linked issue behavior.',
          },
          {
            feedbackId: 'comment:7001',
            reason: 'The public option name is already documented and released.',
          },
        ],
        deferred: [
          {
            feedbackId: 'comment:7002',
            reason: 'The comment is stale after the latest review cycle.',
          },
        ],
        changes: [],
        testPlan: [],
      }),
    });

    const result = await runPrAddressReview(
      createContext({
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(git.commits.length, 0);
    assert.equal(git.pushes.length, 0);
    assert.deepEqual(github.replies, [
      {
        commentId: 9001,
        body: [
          'PullOps declined this feedback.',
          '',
          'Reason: The requested inline change would break the linked issue behavior.',
        ].join('\n'),
      },
    ]);
    assert.equal(github.comments.length, 2);
    assert.match(github.comments[0].body, /<summary>PullOps operation audit<\/summary>/);
    assert.match(github.comments[1].body, /PullOps declined feedback `comment:7001`/);
    assert.doesNotMatch(github.comments[1].body, /7002/);
    assert.deepEqual(github.resolvedReviewThreads, []);
    assert.deepEqual(github.pullRequestLabelsAdded, [
      {
        number: 100,
        labels: ['pullops:pr:review'],
      },
    ]);
    assert.deepEqual(result.prAddressReview, {
      feedback: {
        addressed: 0,
        declined: 2,
        deferred: 1,
      },
      changesCommitted: false,
    });
  });

  it('03: blocks without running Codex when the review cycle budget is exhausted', async () => {
    const github = createFakeGitHub({
      pullRequest: createPullRequest({
        body: createPullRequestBody({ reviewCycles: '3 / 3' }),
      }),
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const codex = createFakeCodexRunner({ output: '{}' });

    const result = await runPrAddressReview(
      createContext({
        githubClient: github.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'blocked');
    assert.match(String(result.summary), /Review cycle budget exhausted/);
    assert.equal(codex.calls.length, 0);
    assert.match(github.updatedBodies[0].body, /Status: Human required/);
    assert.match(github.comments[0].body, /3 \/ 3 Review Cycles have already run/);
    assert.deepEqual(github.pullRequestLabelsAdded, [
      {
        number: 100,
        labels: ['pullops:human-required'],
      },
    ]);
  });

  it('04: records invalid output before posting responses, committing, or pushing', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'pullops-pr-address-review-failure-'));
    const github = createFakeGitHub({
      pullRequest: createPullRequest(),
      reviewContext: createReviewContext({
        reviews: [],
      }),
      diff: createDiff(),
    });
    const git = createFakeGit({ hasChanges: true });
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'addressed',
        summary: 'Only classified one feedback item.',
        addressed: [
          {
            feedbackId: 'thread:9001',
            response: 'Handled the inline comment.',
          },
        ],
        declined: [],
        deferred: [],
        changes: ['A change that must not be committed after invalid output.'],
        testPlan: ['Not run.'],
      }),
    });

    await assert.rejects(
      runPrAddressReview(
        createContext({
          githubClient: github.client,
          gitClient: git.client,
          codexRunner: codex.runner,
          outputDirectory,
        }),
      ),
      /Feedback item "comment:7001" must be classified as addressed, declined, or deferred/,
    );

    assert.equal(github.replies.length, 0);
    assert.equal(git.commits.length, 0);
    assert.equal(git.pushes.length, 0);
    assert.equal(github.comments.length, 2);
    assert.match(github.comments[0].body, /<summary>PullOps operation audit<\/summary>/);
    assert.match(github.comments[1].body, /Invalid Address Review Output/);
    assert.match(github.updatedBodies[0].body, /Status: Human required/);
    assert.equal(
      await readFile(join(outputDirectory, 'failure_reason.txt'), 'utf8'),
      [
        'Invalid Address Review Output: Feedback item "comment:7001" must be classified as addressed, declined, or deferred.',
        '',
      ].join('\n'),
    );
  });
});

/**
 * @param {Partial<OperationRunnerContext>} overrides
 * @returns {OperationRunnerContext}
 */
function createContext(overrides = {}) {
  return {
    operation: 'pr-address-review',
    phase: 'run',
    runnerAdapter: 'codex-cli',
    target: {
      type: 'pr',
      number: 100,
    },
    cwd: '/workspace',
    config: DEFAULT_PULL_OPS_CONFIG,
    modelTier: 'mid',
    model: 'gpt-5.4-mini',
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
    body: createPullRequestBody(),
    isDraft: true,
    isCrossRepository: false,
    ...overrides,
  };
}

/**
 * @param {{ reviewCycles?: string }} [options]
 * @returns {string}
 */
function createPullRequestBody({ reviewCycles = '1 / 3' } = {}) {
  return [
    '## Summary',
    '',
    'Implemented the issue.',
    '',
    '## PullOps',
    '',
    'Managed: yes',
    'Status: Changes requested',
    '',
    '<details>',
    '<summary>PullOps workflow state</summary>',
    '',
    `Review cycles: ${reviewCycles}`,
    'Source: Issue #42',
    'Last operation: pullops:pr:review',
    '',
    '</details>',
  ].join('\n');
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
 * @param {Partial<GitHubPullRequestReviewContext>} [overrides]
 * @returns {GitHubPullRequestReviewContext}
 */
function createReviewContext(overrides = {}) {
  return {
    comments: [
      {
        databaseId: 7001,
        body: 'Please clarify how this works from the top-level conversation.',
        authorLogin: 'maintainer',
      },
    ],
    reviews: [
      {
        id: 'PRR_requested',
        state: 'CHANGES_REQUESTED',
        body: 'Please update the docs for this behavior.',
        authorLogin: 'reviewer',
      },
      {
        id: 'PRR_pullops',
        state: 'COMMENTED',
        body: 'PullOps review found missing regression coverage.',
        authorLogin: 'github-actions[bot]',
      },
    ],
    unresolvedThreads: [
      {
        id: 'PRRT_1',
        isResolved: false,
        comments: [
          {
            id: 'PRRC_1',
            databaseId: 9001,
            body: 'Existing unresolved inline feedback.',
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
    ...overrides,
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
 *   replies: ReplyToPullRequestReviewCommentOptions[];
 *   updatedBodies: UpdatePullRequestBodyOptions[];
 *   pullRequestLabelsAdded: EditLabelsOptions[];
 *   pullRequestLabelsRemoved: EditLabelsOptions[];
 *   comments: CommentOnPullRequestOptions[];
 *   resolvedReviewThreads: string[];
 *   client: import('../../github/types.js').GitHubClient;
 * }}
 */
function createFakeGitHub({ pullRequest, reviewContext, diff }) {
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
  /** @type {string[]} */
  const resolvedReviewThreads = [];

  return {
    replies,
    updatedBodies,
    pullRequestLabelsAdded,
    pullRequestLabelsRemoved,
    comments,
    resolvedReviewThreads,
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
      async getPullRequestChecks() {
        throw new Error('getPullRequestChecks was not expected in this test.');
      },
      async getPullRequestChecksForRef() {
        throw new Error('getPullRequestChecksForRef was not expected in this test.');
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
      async closeIssue() {
        throw new Error('closeIssue was not expected in this test.');
      },
      async commentOnPullRequest(options) {
        comments.push(options);
      },
      async updatePullRequestBody(options) {
        updatedBodies.push(options);
      },
      async markPullRequestReadyForReview() {
        throw new Error('markPullRequestReadyForReview was not expected in this test.');
      },
      async publishPullRequestReview() {
        throw new Error('publishPullRequestReview was not expected in this test.');
      },
      async replyToPullRequestReviewComment(options) {
        replies.push(options);
      },
      async resolvePullRequestReviewThread(threadId) {
        resolvedReviewThreads.push(threadId);
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
