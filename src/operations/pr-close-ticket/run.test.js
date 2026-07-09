import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_PULL_OPS_CONFIG } from '../../config/PullOpsConfig.js';
import { runPrCloseTicket } from './run.js';

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('../../github/types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('../../github/types.js').CloseIssueOptions} CloseIssueOptions
 * @typedef {import('../../github/types.js').EditLabelsOptions} EditLabelsOptions
 * @typedef {import('../../github/types.js').UpdatePullRequestBodyOptions} UpdatePullRequestBodyOptions
 */

describe('runPrCloseTicket', () => {
  it('01: closes an open ticket after its PR merges into the Spec branch', async () => {
    const issue = createIssue({
      number: 42,
      parent: {
        number: 1,
        title: 'Spec',
        relationshipSource: 'native',
      },
    });
    const pullRequest = createPullRequest({
      number: 100,
      headRefName: 'pullops/spec-1-issue-42',
      baseRefName: 'pullops/spec-1',
      state: 'MERGED',
      mergedAt: '2026-06-14T10:00:00Z',
    });
    const parentIssue = createIssue({
      number: 1,
      subIssues: [
        {
          number: 42,
          title: 'Implement ticket behavior',
          state: 'CLOSED',
          relationshipSource: 'native',
        },
      ],
    });
    const github = createFakeGitHub({ issues: [issue, parentIssue], pullRequest });

    const result = await runPrCloseTicket(
      createContext({
        githubClient: github.client,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.match(String(result.summary), /Closed ticket #42/);
    assert.deepEqual(github.closedIssues, [
      {
        number: 42,
        comment:
          'PullOps closed this Ticket because PR #100 merged into the Spec branch `pullops/spec-1`.',
      },
    ]);
    assert.deepEqual(github.issueLabelsRemoved, [
      {
        number: 42,
        labels: ['pullops:issue:implement', 'pullops:human-required'],
      },
    ]);
    assert.deepEqual(github.issueLabelsAdded, []);
  });

  it('02: skips non-ticket PRs', async () => {
    const issue = createIssue({ number: 42 });
    const pullRequest = createPullRequest({
      number: 100,
      headRefName: 'pullops/issue-42',
      baseRefName: 'main',
      state: 'MERGED',
      mergedAt: '2026-06-14T10:00:00Z',
    });
    const github = createFakeGitHub({ issue, pullRequest });

    const result = await runPrCloseTicket(
      createContext({
        githubClient: github.client,
      }),
    );

    assert.equal(result.status, 'skipped');
    assert.match(String(result.summary), /not a Spec ticket PR/);
    assert.equal(github.closedIssues.length, 0);
  });

  it('03: skips cross-repository ticket PRs', async () => {
    const issue = createIssue({ number: 42 });
    const pullRequest = createPullRequest({
      number: 100,
      headRefName: 'pullops/spec-1-issue-42',
      baseRefName: 'pullops/spec-1',
      state: 'MERGED',
      mergedAt: '2026-06-14T10:00:00Z',
      isCrossRepository: true,
    });
    const github = createFakeGitHub({ issue, pullRequest });

    const result = await runPrCloseTicket(
      createContext({
        githubClient: github.client,
      }),
    );

    assert.equal(result.status, 'skipped');
    assert.match(String(result.summary), /not a same-repository PR/);
    assert.equal(github.closedIssues.length, 0);
  });

  it('04: skips ticket-shaped PRs that do not target the matching Spec branch', async () => {
    const issue = createIssue({ number: 42 });
    const pullRequest = createPullRequest({
      number: 100,
      headRefName: 'pullops/spec-1-issue-42',
      baseRefName: 'main',
      state: 'MERGED',
      mergedAt: '2026-06-14T10:00:00Z',
    });
    const github = createFakeGitHub({ issue, pullRequest });

    const result = await runPrCloseTicket(
      createContext({
        githubClient: github.client,
      }),
    );

    assert.equal(result.status, 'skipped');
    assert.match(String(result.summary), /does not target expected Spec branch pullops\/spec-1/);
    assert.equal(github.closedIssues.length, 0);
  });

  it('05: skips ticket PRs whose issue is not part of the parsed Spec parent', async () => {
    const issue = createIssue({
      number: 42,
      parent: {
        number: 2,
        title: 'Different Spec',
        relationshipSource: 'native',
      },
    });
    const pullRequest = createPullRequest({
      number: 100,
      headRefName: 'pullops/spec-1-issue-42',
      baseRefName: 'pullops/spec-1',
      state: 'MERGED',
      mergedAt: '2026-06-14T10:00:00Z',
    });
    const github = createFakeGitHub({ issue, pullRequest });

    const result = await runPrCloseTicket(
      createContext({
        githubClient: github.client,
      }),
    );

    assert.equal(result.status, 'skipped');
    assert.match(String(result.summary), /not part of Spec issue #1/);
    assert.equal(github.closedIssues.length, 0);
  });

  it('06: accepts already-closed tickets without mutating them again', async () => {
    const issue = createIssue({
      number: 42,
      state: 'CLOSED',
      parent: {
        number: 1,
        title: 'Spec',
        relationshipSource: 'native',
      },
    });
    const pullRequest = createPullRequest({
      number: 100,
      headRefName: 'pullops/spec-1-issue-42',
      baseRefName: 'pullops/spec-1',
      state: 'MERGED',
      mergedAt: '2026-06-14T10:00:00Z',
    });
    const parentIssue = createIssue({
      number: 1,
      subIssues: [
        {
          number: 42,
          title: 'Implement ticket behavior',
          state: 'CLOSED',
          relationshipSource: 'native',
        },
      ],
    });
    const github = createFakeGitHub({ issues: [issue, parentIssue], pullRequest });

    const result = await runPrCloseTicket(
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

  it('07: requests Umbrella PR review when the final Ticket is closed', async () => {
    const ticket = createIssue({
      number: 42,
      state: 'CLOSED',
      parent: {
        number: 1,
        title: 'Spec',
        relationshipSource: 'native',
      },
    });
    const parentIssue = createIssue({
      number: 1,
      subIssues: [
        {
          number: 42,
          title: 'Implement ticket behavior',
          state: 'CLOSED',
          relationshipSource: 'native',
        },
      ],
    });
    const ticketPullRequest = createPullRequest({
      number: 100,
      headRefName: 'pullops/spec-1-issue-42',
      baseRefName: 'pullops/spec-1',
      state: 'MERGED',
      mergedAt: '2026-06-14T10:00:00Z',
    });
    const parentPullRequest = createPullRequest({
      number: 200,
      title: 'Prepare #1: Spec',
      headRefName: 'pullops/spec-1',
      baseRefName: 'main',
      state: 'OPEN',
      mergedAt: undefined,
      isDraft: true,
    });
    const github = createFakeGitHub({
      issues: [ticket, parentIssue],
      pullRequest: ticketPullRequest,
      openPullRequestsByHead: new Map([['pullops/spec-1', parentPullRequest]]),
    });

    const result = await runPrCloseTicket(
      createContext({
        githubClient: github.client,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.deepEqual(github.pullRequestLabelsAdded, [
      {
        number: 200,
        labels: ['pullops:pr:review'],
      },
    ]);
    assert.match(github.updatedPullRequestBodies[0].body, /^Ticket PRs:$/m);
    assert.match(github.updatedPullRequestBodies[0].body, /^- #100 for #42$/m);
  });

  it('08: leaves Umbrella PR review unrequested while sibling Tickets remain open', async () => {
    const ticket = createIssue({
      number: 42,
      state: 'CLOSED',
      parent: {
        number: 1,
        title: 'Spec',
        relationshipSource: 'native',
      },
    });
    const parentIssue = createIssue({
      number: 1,
      subIssues: [
        {
          number: 42,
          title: 'Implement ticket behavior',
          state: 'CLOSED',
          relationshipSource: 'native',
        },
        {
          number: 43,
          title: 'Implement remaining behavior',
          state: 'OPEN',
          relationshipSource: 'native',
        },
      ],
    });
    const ticketPullRequest = createPullRequest({
      number: 100,
      headRefName: 'pullops/spec-1-issue-42',
      baseRefName: 'pullops/spec-1',
      state: 'MERGED',
      mergedAt: '2026-06-14T10:00:00Z',
    });
    const parentPullRequest = createPullRequest({
      number: 200,
      title: 'Prepare #1: Spec',
      headRefName: 'pullops/spec-1',
      baseRefName: 'main',
      state: 'OPEN',
      mergedAt: undefined,
      isDraft: true,
    });
    const github = createFakeGitHub({
      issues: [ticket, parentIssue],
      pullRequest: ticketPullRequest,
      openPullRequestsByHead: new Map([['pullops/spec-1', parentPullRequest]]),
    });

    const result = await runPrCloseTicket(
      createContext({
        githubClient: github.client,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(github.pullRequestLabelsAdded.length, 0);
  });
});

/**
 * @param {Partial<OperationRunnerContext>} overrides
 * @returns {OperationRunnerContext}
 */
function createContext(overrides = {}) {
  return {
    operation: 'pr-close-ticket',
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
 * @param {string} [options.state]
 * @param {import('../../github/types.js').GitHubIssueReference | null} [options.parent]
 * @param {import('../../github/types.js').GitHubIssueReference[]} [options.subIssues]
 * @returns {GitHubIssue}
 */
function createIssue({ number = 42, state = 'OPEN', parent = null, subIssues = [] } = {}) {
  return {
    number,
    title: 'Implement ticket behavior',
    body: '',
    state,
    url: `https://github.com/acme/widgets/issues/${number}`,
    authorLogin: 'maintainer',
    labels: ['pullops:issue:implement'],
    parent,
    subIssues,
  };
}

/**
 * @param {object} [options]
 * @param {number} [options.number]
 * @param {string} [options.headRefName]
 * @param {string} [options.baseRefName]
 * @param {string} [options.state]
 * @param {string | undefined} [options.mergedAt]
 * @param {boolean} [options.isCrossRepository]
 * @param {boolean} [options.isDraft]
 * @param {string} [options.title]
 * @returns {GitHubPullRequest}
 */
function createPullRequest({
  number = 100,
  title = 'Implement #42',
  headRefName = 'pullops/spec-1-issue-42',
  baseRefName = 'pullops/spec-1',
  state = 'MERGED',
  mergedAt = '2026-06-14T10:00:00Z',
  isCrossRepository = false,
  isDraft = false,
} = {}) {
  return {
    number,
    title,
    url: `https://github.com/acme/widgets/pull/${number}`,
    headRefName,
    baseRefName,
    state,
    mergedAt,
    body: [
      '## PullOps',
      '',
      'Managed: yes',
      'Status: Draft parent preparation',
      '',
      '<details>',
      '<summary>PullOps workflow state</summary>',
      '',
      'Source: Parent Issue #1',
      'Last operation: pullops:spec:prepare',
      '',
      '</details>',
    ].join('\n'),
    isDraft,
    isCrossRepository,
    labels: [],
  };
}

/**
 * @param {object} options
 * @param {GitHubIssue} [options.issue]
 * @param {GitHubIssue[]} [options.issues]
 * @param {GitHubPullRequest} options.pullRequest
 * @param {Map<string, GitHubPullRequest>} [options.openPullRequestsByHead]
 * @returns {{
 *   closedIssues: CloseIssueOptions[];
 *   issueLabelsAdded: EditLabelsOptions[];
 *   issueLabelsRemoved: EditLabelsOptions[];
 *   pullRequestLabelsAdded: EditLabelsOptions[];
 *   updatedPullRequestBodies: UpdatePullRequestBodyOptions[];
 *   client: import('../../github/types.js').GitHubClient;
 * }}
 */
function createFakeGitHub({ issue, issues, pullRequest, openPullRequestsByHead = new Map() }) {
  const issueList = issues ?? (issue === undefined ? [] : [issue]);
  const issuesByNumber = new Map(issueList.map(githubIssue => [githubIssue.number, githubIssue]));
  const pullRequestsByHead = new Map([[pullRequest.headRefName, pullRequest]]);
  for (const [headBranch, openPullRequest] of openPullRequestsByHead) {
    pullRequestsByHead.set(headBranch, openPullRequest);
  }
  /** @type {CloseIssueOptions[]} */
  const closedIssues = [];
  /** @type {EditLabelsOptions[]} */
  const issueLabelsAdded = [];
  /** @type {EditLabelsOptions[]} */
  const issueLabelsRemoved = [];
  /** @type {EditLabelsOptions[]} */
  const pullRequestLabelsAdded = [];
  /** @type {UpdatePullRequestBodyOptions[]} */
  const updatedPullRequestBodies = [];

  return {
    closedIssues,
    issueLabelsAdded,
    issueLabelsRemoved,
    pullRequestLabelsAdded,
    updatedPullRequestBodies,
    client: {
      async ensureLabels() {
        return {
          created: [],
          updated: [],
          alreadyCorrect: [],
        };
      },
      async getIssue(number) {
        const requestedIssue = issuesByNumber.get(number);
        if (requestedIssue === undefined) {
          throw new Error(`Unexpected issue lookup: #${number}`);
        }

        return requestedIssue;
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
        throw new Error('getPullRequestReviewContext was not expected in this test.');
      },
      async getPullRequestDiff() {
        throw new Error('getPullRequestDiff was not expected in this test.');
      },
      async findOpenPullRequestByHead(headBranch) {
        return openPullRequestsByHead.get(headBranch);
      },
      async findPullRequestByHead(headBranch) {
        return pullRequestsByHead.get(headBranch);
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
      async addLabelsToPullRequest(options) {
        pullRequestLabelsAdded.push(options);
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
      async updatePullRequestBody(options) {
        updatedPullRequestBodies.push(options);
        const updatedPullRequest = [...pullRequestsByHead.values()].find(
          candidate => candidate.number === options.number,
        );
        if (updatedPullRequest !== undefined) {
          updatedPullRequest.body = options.body;
        }
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
