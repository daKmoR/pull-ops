import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_PULL_OPS_CONFIG } from '../../config/PullOpsConfig.js';
import { runPrCloseChildIssue } from './run.js';

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('../../github/types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('../../github/types.js').CloseIssueOptions} CloseIssueOptions
 * @typedef {import('../../github/types.js').EditLabelsOptions} EditLabelsOptions
 */

describe('runPrCloseChildIssue', () => {
  it('01: closes an open child issue after its PR merges into the PRD branch', async () => {
    const issue = createIssue({
      number: 42,
      parent: {
        number: 1,
        title: 'PRD',
        relationshipSource: 'native',
      },
    });
    const pullRequest = createPullRequest({
      number: 100,
      headRefName: 'pullops/prd-1/issue-42',
      baseRefName: 'pullops/prd-1',
      state: 'MERGED',
      mergedAt: '2026-06-14T10:00:00Z',
    });
    const github = createFakeGitHub({ issue, pullRequest });

    const result = await runPrCloseChildIssue(
      createContext({
        githubClient: github.client,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.match(String(result.summary), /Closed child issue #42/);
    assert.deepEqual(github.closedIssues, [
      {
        number: 42,
        comment:
          'PullOps closed this Child Issue because PR #100 merged into the PRD branch `pullops/prd-1`.',
      },
    ]);
    assert.deepEqual(github.issueLabelsRemoved, [
      {
        number: 42,
        labels: [
          'pullops:issue:implement',
          'pullops:status:in-progress',
          'pullops:status:blocked',
          'pullops:status:prepared',
          'pullops:status:failed',
        ],
      },
    ]);
    assert.deepEqual(github.issueLabelsAdded, [
      {
        number: 42,
        labels: ['pullops:status:done'],
      },
    ]);
  });

  it('02: skips non-child issue PRs', async () => {
    const issue = createIssue({ number: 42 });
    const pullRequest = createPullRequest({
      number: 100,
      headRefName: 'pullops/issue-42',
      baseRefName: 'main',
      state: 'MERGED',
      mergedAt: '2026-06-14T10:00:00Z',
    });
    const github = createFakeGitHub({ issue, pullRequest });

    const result = await runPrCloseChildIssue(
      createContext({
        githubClient: github.client,
      }),
    );

    assert.equal(result.status, 'skipped');
    assert.match(String(result.summary), /not a PRD child issue PR/);
    assert.equal(github.closedIssues.length, 0);
  });

  it('03: skips cross-repository child issue PRs', async () => {
    const issue = createIssue({ number: 42 });
    const pullRequest = createPullRequest({
      number: 100,
      headRefName: 'pullops/prd-1/issue-42',
      baseRefName: 'pullops/prd-1',
      state: 'MERGED',
      mergedAt: '2026-06-14T10:00:00Z',
      isCrossRepository: true,
    });
    const github = createFakeGitHub({ issue, pullRequest });

    const result = await runPrCloseChildIssue(
      createContext({
        githubClient: github.client,
      }),
    );

    assert.equal(result.status, 'skipped');
    assert.match(String(result.summary), /not a same-repository PR/);
    assert.equal(github.closedIssues.length, 0);
  });

  it('04: skips child-shaped PRs that do not target the matching PRD branch', async () => {
    const issue = createIssue({ number: 42 });
    const pullRequest = createPullRequest({
      number: 100,
      headRefName: 'pullops/prd-1/issue-42',
      baseRefName: 'main',
      state: 'MERGED',
      mergedAt: '2026-06-14T10:00:00Z',
    });
    const github = createFakeGitHub({ issue, pullRequest });

    const result = await runPrCloseChildIssue(
      createContext({
        githubClient: github.client,
      }),
    );

    assert.equal(result.status, 'skipped');
    assert.match(String(result.summary), /does not target expected PRD branch pullops\/prd-1/);
    assert.equal(github.closedIssues.length, 0);
  });

  it('05: skips child PRs whose issue is not part of the parsed PRD parent', async () => {
    const issue = createIssue({
      number: 42,
      parent: {
        number: 2,
        title: 'Different PRD',
        relationshipSource: 'native',
      },
    });
    const pullRequest = createPullRequest({
      number: 100,
      headRefName: 'pullops/prd-1/issue-42',
      baseRefName: 'pullops/prd-1',
      state: 'MERGED',
      mergedAt: '2026-06-14T10:00:00Z',
    });
    const github = createFakeGitHub({ issue, pullRequest });

    const result = await runPrCloseChildIssue(
      createContext({
        githubClient: github.client,
      }),
    );

    assert.equal(result.status, 'skipped');
    assert.match(String(result.summary), /not part of PRD issue #1/);
    assert.equal(github.closedIssues.length, 0);
  });

  it('06: accepts already-closed child issues without mutating them again', async () => {
    const issue = createIssue({
      number: 42,
      state: 'CLOSED',
      parent: {
        number: 1,
        title: 'PRD',
        relationshipSource: 'native',
      },
    });
    const pullRequest = createPullRequest({
      number: 100,
      headRefName: 'pullops/prd-1/issue-42',
      baseRefName: 'pullops/prd-1',
      state: 'MERGED',
      mergedAt: '2026-06-14T10:00:00Z',
    });
    const github = createFakeGitHub({ issue, pullRequest });

    const result = await runPrCloseChildIssue(
      createContext({
        githubClient: github.client,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.match(String(result.summary), /already closed/);
    assert.equal(github.closedIssues.length, 0);
    assert.equal(github.issueLabelsRemoved.length, 0);
    assert.equal(github.issueLabelsAdded.length, 0);
  });
});

/**
 * @param {Partial<OperationRunnerContext>} overrides
 * @returns {OperationRunnerContext}
 */
function createContext(overrides = {}) {
  return {
    operation: 'pr-close-child-issue',
    phase: 'run',
    runnerAdapter: 'codex-cli',
    target: {
      type: 'pr',
      number: 100,
    },
    cwd: '/workspace',
    config: DEFAULT_PULL_OPS_CONFIG,
    modelTier: 'low',
    model: 'gpt-5.4-mini',
    githubClient: createFakeGitHub({
      issue: createIssue({ number: 42 }),
      pullRequest: createPullRequest(),
    }).client,
    gitClient: {
      async createBranch() {
        throw new Error('createBranch was not expected in this test.');
      },
      async hasChanges() {
        throw new Error('hasChanges was not expected in this test.');
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
      async getChangedFilesSinceBase() {
        throw new Error('getChangedFilesSinceBase was not expected in this test.');
      },
      async rewriteBranchWithCommitPlan() {
        throw new Error('rewriteBranchWithCommitPlan was not expected in this test.');
      },
    },
    codexRunner: {
      async run() {
        throw new Error('codexRunner.run was not expected in this test.');
      },
    },
    ...overrides,
  };
}

/**
 * @param {object} [options]
 * @param {number} [options.number]
 * @param {string} [options.state]
 * @param {import('../../github/types.js').GitHubIssueReference | null} [options.parent]
 * @returns {GitHubIssue}
 */
function createIssue({ number = 42, state = 'OPEN', parent = null } = {}) {
  return {
    number,
    title: 'Implement child behavior',
    body: '',
    state,
    url: `https://github.com/acme/widgets/issues/${number}`,
    authorLogin: 'maintainer',
    labels: ['pullops:issue:implement'],
    parent,
    subIssues: [],
  };
}

/**
 * @param {object} [options]
 * @param {number} [options.number]
 * @param {string} [options.headRefName]
 * @param {string} [options.baseRefName]
 * @param {string} [options.state]
 * @param {string} [options.mergedAt]
 * @param {boolean} [options.isCrossRepository]
 * @returns {GitHubPullRequest}
 */
function createPullRequest({
  number = 100,
  headRefName = 'pullops/prd-1/issue-42',
  baseRefName = 'pullops/prd-1',
  state = 'MERGED',
  mergedAt = '2026-06-14T10:00:00Z',
  isCrossRepository = false,
} = {}) {
  return {
    number,
    title: 'Implement #42',
    url: `https://github.com/acme/widgets/pull/${number}`,
    headRefName,
    baseRefName,
    state,
    mergedAt,
    body: 'Managed PR: yes',
    isDraft: false,
    isCrossRepository,
    labels: [],
  };
}

/**
 * @param {{ issue: GitHubIssue, pullRequest: GitHubPullRequest }} options
 * @returns {{
 *   closedIssues: CloseIssueOptions[];
 *   issueLabelsAdded: EditLabelsOptions[];
 *   issueLabelsRemoved: EditLabelsOptions[];
 *   client: import('../../github/types.js').GitHubClient;
 * }}
 */
function createFakeGitHub({ issue, pullRequest }) {
  /** @type {CloseIssueOptions[]} */
  const closedIssues = [];
  /** @type {EditLabelsOptions[]} */
  const issueLabelsAdded = [];
  /** @type {EditLabelsOptions[]} */
  const issueLabelsRemoved = [];

  return {
    closedIssues,
    issueLabelsAdded,
    issueLabelsRemoved,
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
        return pullRequest;
      },
      async getPullRequestChecks() {
        throw new Error('getPullRequestChecks was not expected in this test.');
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
      async commentOnIssue() {
        throw new Error('commentOnIssue was not expected in this test.');
      },
      async closeIssue(options) {
        closedIssues.push(options);
      },
      async commentOnPullRequest() {
        throw new Error('commentOnPullRequest was not expected in this test.');
      },
      async updatePullRequestBody() {
        throw new Error('updatePullRequestBody was not expected in this test.');
      },
      async publishPullRequestReview() {
        throw new Error('publishPullRequestReview was not expected in this test.');
      },
      async replyToPullRequestReviewComment() {
        throw new Error('replyToPullRequestReviewComment was not expected in this test.');
      },
    },
  };
}
