import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_PULL_OPS_CONFIG } from '../../config/PullOpsConfig.js';
import { GITHUB_ACTIONS_BOT_AUTHOR } from '../githubActionsBot.js';
import { createPrdPrepareCommitMessage, runPrdPrepare } from './run.js';

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('../../github/types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('../../github/types.js').CreateDraftPullRequestOptions} CreateDraftPullRequestOptions
 * @typedef {import('../../github/types.js').UpdatePullRequestBodyOptions} UpdatePullRequestBodyOptions
 * @typedef {import('../../github/types.js').EditLabelsOptions} EditLabelsOptions
 * @typedef {import('../../github/types.js').CommentOnIssueOptions} CommentOnIssueOptions
 * @typedef {import('../../git/types.js').CreateBranchOptions} CreateBranchOptions
 * @typedef {import('../../git/types.js').CommitEmptyOptions} CommitEmptyOptions
 * @typedef {import('../../git/types.js').PushBranchOptions} PushBranchOptions
 */

describe('runPrdPrepare', () => {
  it('01: creates an umbrella branch and draft PR for a parent issue', async () => {
    const issue = createIssue({
      number: 12,
      title: 'PRD: Parent workflow',
      subIssues: [
        {
          number: 34,
          title: 'Implement child workflow',
          state: 'OPEN',
          relationshipSource: 'native',
        },
      ],
    });
    const github = createFakeGitHub({ issue });
    const git = createFakeGit();

    const result = await runPrdPrepare(
      createContext({
        githubClient: github.client,
        gitClient: git.client,
        triggerActor: 'octocat',
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.deepEqual(git.branches, [
      {
        branchName: 'pullops/prd-12',
        baseBranch: 'main',
      },
    ]);
    assert.deepEqual(git.emptyCommits, [
      {
        message: createPrdPrepareCommitMessage(issue),
        author: GITHUB_ACTIONS_BOT_AUTHOR,
      },
    ]);
    assert.deepEqual(git.pushes, [{ branchName: 'pullops/prd-12' }]);
    assert.equal(github.createdPullRequests.length, 1);
    assert.equal(github.createdPullRequests[0].title, 'Prepare #12: PRD: Parent workflow');
    assert.equal(github.createdPullRequests[0].baseBranch, 'main');
    assert.equal(github.createdPullRequests[0].headBranch, 'pullops/prd-12');
    assert.match(github.createdPullRequests[0].body, /^## PullOps$/m);
    assert.match(github.createdPullRequests[0].body, /^Managed: yes$/m);
    assert.match(github.createdPullRequests[0].body, /^Status: Draft parent preparation$/m);
    assert.match(
      github.createdPullRequests[0].body,
      /<summary>PullOps workflow state<\/summary>[\s\S]*Last operation: pullops:prd:prepare/,
    );
    assert.match(github.createdPullRequests[0].body, /^## PullOps Link Summary$/m);
    assert.match(github.createdPullRequests[0].body, /^Kind: Umbrella PR$/m);
    assert.match(github.createdPullRequests[0].body, /^PRD Issue: #12$/m);
    assert.match(github.createdPullRequests[0].body, /^Closes: #12$/m);
    assert.match(github.createdPullRequests[0].body, /^Child PRs: none yet$/m);
    assert.doesNotMatch(github.createdPullRequests[0].body, /Managed PR: yes/);
    assert.doesNotMatch(github.createdPullRequests[0].body, /^## Traceability$/m);
    assert.doesNotMatch(github.createdPullRequests[0].body, /pullops\/prd-12/);
    assert.doesNotMatch(github.createdPullRequests[0].body, /#34 Implement child workflow/);
    assert.deepEqual(github.issueLabelsAdded, []);
    assert.deepEqual(github.issueLabelsRemoved, [
      {
        number: 12,
        labels: ['pullops:human-required'],
      },
      {
        number: 12,
        labels: ['pullops:prd:prepare', 'pullops:human-required'],
      },
    ]);
  });

  it('02: updates an existing umbrella PR with known Child PR links', async () => {
    const issue = createIssue({
      number: 12,
      subIssues: [
        {
          number: 34,
          title: 'Implement child workflow',
          state: 'OPEN',
          relationshipSource: 'native',
        },
      ],
    });
    const childPullRequest = {
      number: 101,
      title: 'Implement #34',
      url: 'https://github.com/acme/widgets/pull/101',
      headRefName: 'pullops/prd-12-issue-34',
      body: 'child body',
      isDraft: true,
    };
    const github = createFakeGitHub({
      issue,
      existingPullRequest: {
        number: 100,
        title: 'Prepare #12',
        url: 'https://github.com/acme/widgets/pull/100',
        headRefName: 'pullops/prd-12',
        body: 'old body',
        isDraft: true,
      },
      openPullRequestsByHead: new Map([['pullops/prd-12-issue-34', childPullRequest]]),
    });
    const git = createFakeGit();

    const result = await runPrdPrepare(
      createContext({
        githubClient: github.client,
        gitClient: git.client,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(git.branches.length, 0);
    assert.equal(git.emptyCommits.length, 0);
    assert.equal(github.createdPullRequests.length, 0);
    assert.equal(github.updatedPullRequestBodies.length, 1);
    assert.equal(github.updatedPullRequestBodies[0].number, 100);
    assert.match(github.updatedPullRequestBodies[0].body, /^Child PRs:$/m);
    assert.match(github.updatedPullRequestBodies[0].body, /^- #101 for #34$/m);
    assert.match(github.updatedPullRequestBodies[0].body, /Last operation: pullops:prd:prepare/);
    assert.deepEqual(github.issueLabelsAdded, []);
    assert.deepEqual(github.issueLabelsRemoved, [
      {
        number: 12,
        labels: ['pullops:prd:prepare', 'pullops:human-required'],
      },
    ]);
  });

  it('03: blocks prepare when applied to a known child issue', async () => {
    const issue = createIssue({
      number: 34,
      parent: {
        number: 12,
        title: 'PRD: Parent workflow',
        relationshipSource: 'native',
      },
    });
    const github = createFakeGitHub({ issue });
    const git = createFakeGit();

    const result = await runPrdPrepare(
      createContext({
        githubClient: github.client,
        gitClient: git.client,
      }),
    );

    assert.equal(result.status, 'blocked');
    assert.match(String(result.summary), /already part of parent issue #12/);
    assert.equal(git.branches.length, 0);
    assert.match(github.comments[0].body, /pullops:prd:prepare on the parent issue/);
  });
});

/**
 * @param {Partial<OperationRunnerContext>} overrides
 * @returns {OperationRunnerContext}
 */
function createContext(overrides = {}) {
  return {
    operation: 'prd-prepare',
    phase: 'run',
    runnerAdapter: 'codex-cli',
    target: {
      type: 'issue',
      number: 12,
    },
    cwd: '/workspace',
    config: DEFAULT_PULL_OPS_CONFIG,
    modelTier: 'low',
    model: 'gpt-5.4-mini',
    githubClient: createFakeGitHub({ issue: createIssue({ number: 12 }) }).client,
    gitClient: createFakeGit().client,
    runner: {
      async run() {
        throw new Error('runner.run was not expected in this test.');
      },
    },
    ...overrides,
  };
}

/**
 * @param {object} [options]
 * @param {number} [options.number]
 * @param {string} [options.title]
 * @param {string} [options.body]
 * @param {string} [options.state]
 * @param {import('../../github/types.js').GitHubIssueReference | null} [options.parent]
 * @param {import('../../github/types.js').GitHubIssueReference[]} [options.subIssues]
 * @returns {GitHubIssue}
 */
function createIssue({
  number = 12,
  title = 'PRD: Parent workflow',
  body = '## Problem Statement\n\nShip parent workflow.',
  state = 'OPEN',
  parent = null,
  subIssues = [],
} = {}) {
  return {
    number,
    title,
    body,
    state,
    url: `https://github.com/acme/widgets/issues/${number}`,
    authorLogin: 'maintainer',
    labels: ['pullops:prd:prepare'],
    parent,
    subIssues,
  };
}

/**
 * @param {{
 *   issue: GitHubIssue,
 *   existingPullRequest?: GitHubPullRequest,
 *   openPullRequestsByHead?: Map<string, GitHubPullRequest>,
 * }} options
 * @returns {{
 *   createdPullRequests: CreateDraftPullRequestOptions[];
 *   updatedPullRequestBodies: UpdatePullRequestBodyOptions[];
 *   issueLabelsAdded: EditLabelsOptions[];
 *   issueLabelsRemoved: EditLabelsOptions[];
 *   comments: CommentOnIssueOptions[];
 *   client: import('../../github/types.js').GitHubClient;
 * }}
 */
function createFakeGitHub({ issue, existingPullRequest, openPullRequestsByHead = new Map() }) {
  if (existingPullRequest !== undefined) {
    openPullRequestsByHead.set(existingPullRequest.headRefName, existingPullRequest);
  }

  /** @type {CreateDraftPullRequestOptions[]} */
  const createdPullRequests = [];
  /** @type {UpdatePullRequestBodyOptions[]} */
  const updatedPullRequestBodies = [];
  /** @type {EditLabelsOptions[]} */
  const issueLabelsAdded = [];
  /** @type {EditLabelsOptions[]} */
  const issueLabelsRemoved = [];
  /** @type {CommentOnIssueOptions[]} */
  const comments = [];

  return {
    createdPullRequests,
    updatedPullRequestBodies,
    issueLabelsAdded,
    issueLabelsRemoved,
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
        return issue;
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
      async findOpenPullRequestByHead(headBranch) {
        return openPullRequestsByHead.get(headBranch);
      },
      async createDraftPullRequest(options) {
        createdPullRequests.push(options);
        return {
          number: 100,
          title: options.title,
          url: 'https://github.com/acme/widgets/pull/100',
          headRefName: options.headBranch,
          body: options.body,
          isDraft: true,
        };
      },
      async addLabelsToIssue(options) {
        issueLabelsAdded.push(options);
      },
      async removeLabelsFromIssue(options) {
        issueLabelsRemoved.push(options);
      },
      async addLabelsToPullRequest() {
        throw new Error('addLabelsToPullRequest was not expected in this test.');
      },
      async removeLabelsFromPullRequest() {
        throw new Error('removeLabelsFromPullRequest was not expected in this test.');
      },
      async commentOnIssue(options) {
        comments.push(options);
      },
      async closeIssue() {
        throw new Error('closeIssue was not expected in this test.');
      },
      async commentOnPullRequest() {
        throw new Error('commentOnPullRequest was not expected in this test.');
      },
      async updatePullRequestBody(options) {
        updatedPullRequestBodies.push(options);
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
    },
  };
}

/**
 * @returns {{
 *   branches: CreateBranchOptions[];
 *   emptyCommits: CommitEmptyOptions[];
 *   pushes: PushBranchOptions[];
 *   client: import('../../git/types.js').GitClient;
 * }}
 */
function createFakeGit() {
  /** @type {CreateBranchOptions[]} */
  const branches = [];
  /** @type {CommitEmptyOptions[]} */
  const emptyCommits = [];
  /** @type {PushBranchOptions[]} */
  const pushes = [];

  return {
    branches,
    emptyCommits,
    pushes,
    client: {
      async createBranch(options) {
        branches.push(options);
      },
      async hasChanges() {
        throw new Error('hasChanges was not expected in this test.');
      },
      async commitAll() {
        throw new Error('commitAll was not expected in this test.');
      },
      async commitEmpty(options) {
        emptyCommits.push(options);
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
