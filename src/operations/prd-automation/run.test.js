import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_PULL_OPS_CONFIG } from '../../config/PullOpsConfig.js';
import { resumePrdAutomationForParentIssue, runPrdAutoAdvance, runPrdAutoComplete } from './run.js';

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../../github/types.js').GitHubCheckRun} GitHubCheckRun
 * @typedef {import('../../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('../../github/types.js').GitHubIssueReference} GitHubIssueReference
 * @typedef {import('../../github/types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('../../github/types.js').CreateDraftPullRequestOptions} CreateDraftPullRequestOptions
 * @typedef {import('../../github/types.js').EditLabelsOptions} EditLabelsOptions
 * @typedef {import('../../github/types.js').MergePullRequestOptions} MergePullRequestOptions
 */

/** @typedef {{ issue: { number: number }, status: string }} ChildAutomationResult */
/** @typedef {import('../../prd-automation/childCoordination.types.js').ParentReviewResult} ParentReviewResult */

describe('runPrdAutoAdvance', () => {
  it('01: prepares the PRD and starts currently unblocked open child issues only', async () => {
    const parent = createIssue({
      number: 12,
      labels: ['pullops:prd:auto-advance'],
      subIssues: [issueReference(34), issueReference(35), issueReference(36), issueReference(37)],
    });
    const github = createFakeGitHub({
      issues: [
        parent,
        createIssue({ number: 34, parent: issueReference(12) }),
        createIssue({
          number: 35,
          body: 'Part of: #12\n\n## Blocked by\n\n#34',
          parent: issueReference(12),
        }),
        createIssue({ number: 36, state: 'CLOSED', parent: issueReference(12) }),
        createIssue({
          number: 37,
          labels: ['pullops:issue:implement'],
          parent: issueReference(12),
        }),
      ],
    });
    const git = createFakeGit();

    const result = await runPrdAutoAdvance(
      createContext({
        githubClient: github.client,
        gitClient: git.client,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.deepEqual(git.createdBranches, [
      {
        branchName: 'pullops/prd-12',
        baseBranch: 'main',
      },
    ]);
    assert.deepEqual(
      github.createdPullRequests.map(pullRequest => ({
        baseBranch: pullRequest.baseBranch,
        headBranch: pullRequest.headBranch,
      })),
      [
        {
          baseBranch: 'main',
          headBranch: 'pullops/prd-12',
        },
      ],
    );
    assert.deepEqual(github.issueLabelsAdded, [
      {
        number: 34,
        labels: ['pullops:issue:implement'],
      },
    ]);
    assert.equal(
      github.issueLabelsAdded.some(
        edit => edit.number === 12 && edit.labels.includes('pullops:issue:implement'),
      ),
      false,
    );
    assert.deepEqual(
      readChildResults(result).map(child => [child.issue.number, child.status]),
      [
        [34, 'started'],
        [35, 'blocked'],
        [36, 'closed'],
        [37, 'already-active'],
      ],
    );
  });

  it('02: ignores Part of body references that are not native Child Issues', async () => {
    const parent = createIssue({
      number: 12,
      labels: ['pullops:prd:auto-advance'],
      subIssues: [],
    });
    const github = createFakeGitHub({
      issues: [
        parent,
        createIssue({ number: 34, body: 'Part of: #12' }),
        createIssue({ number: 35, body: 'Part of: #99' }),
      ],
      bodyReferences: [issueReference(34), issueReference(35)],
      pullRequests: [
        createPullRequest({
          number: 200,
          headRefName: 'pullops/prd-12',
          baseRefName: 'main',
          body: parentPullRequestBody(12),
        }),
      ],
    });

    const result = await runPrdAutoAdvance(
      createContext({
        githubClient: github.client,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(readParentPullRequest(result)?.status, 'waiting-for-child-issues');
    assert.deepEqual(github.issueLabelsAdded, []);
    assert.deepEqual(github.pullRequestLabelsAdded, []);
    assert.deepEqual(
      readChildResults(result).map(child => child.issue.number),
      [],
    );
  });
});

describe('resumePrdAutomationForParentIssue', () => {
  it('01: starts newly unblocked child issues after a blocking issue closes', async () => {
    const parent = createIssue({
      number: 12,
      labels: ['pullops:prd:auto-advance'],
      subIssues: [issueReference(35)],
    });
    const github = createFakeGitHub({
      issues: [
        parent,
        createIssue({ number: 34, state: 'CLOSED', parent: issueReference(12) }),
        createIssue({
          number: 35,
          body: 'Part of: #12\nBlocked by: #34',
          parent: issueReference(12),
        }),
      ],
      pullRequests: [
        createPullRequest({
          number: 200,
          headRefName: 'pullops/prd-12',
          baseRefName: 'main',
          body: parentPullRequestBody(12),
        }),
      ],
    });

    const result = await resumePrdAutomationForParentIssue(
      createContext({
        target: { type: 'pr', number: 101 },
        githubClient: github.client,
      }),
      12,
    );

    assert.equal(result.status, 'accepted');
    assert.deepEqual(github.issueLabelsAdded, [
      {
        number: 35,
        labels: ['pullops:issue:implement'],
      },
    ]);
  });
});

describe('runPrdAutoComplete', () => {
  it('01: rebase-merges finalized child PRs and leaves child issue closure to pr-close-child-issue', async () => {
    const parent = createIssue({
      number: 12,
      labels: ['pullops:prd:auto-complete'],
      subIssues: [issueReference(34)],
    });
    const github = createFakeGitHub({
      issues: [parent, createIssue({ number: 34, parent: issueReference(12) })],
      pullRequests: [
        createPullRequest({
          number: 200,
          headRefName: 'pullops/prd-12',
          baseRefName: 'main',
          body: parentPullRequestBody(12),
        }),
        createPullRequest({
          number: 101,
          headRefName: 'pullops/prd-12-issue-34',
          baseRefName: 'pullops/prd-12',
          body: finalizedChildPullRequestBody(34),
          labels: [],
          isDraft: false,
        }),
      ],
      checksByRef: new Map([
        [
          'head-finalized',
          [
            {
              name: 'CI',
              state: 'success',
              conclusion: 'success',
              bucket: 'pass',
            },
          ],
        ],
      ]),
    });

    const result = await runPrdAutoComplete(
      createContext({
        operation: 'prd-auto-complete',
        githubClient: github.client,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.deepEqual(github.mergedPullRequests, [
      {
        number: 101,
        method: 'rebase',
      },
    ]);
    assert.deepEqual(github.closedIssues, []);
    assert.deepEqual(
      readChildResults(result).map(child => [child.issue.number, child.status]),
      [[34, 'merged']],
    );
  });

  it('02: does not start duplicate work for active child PRs', async () => {
    const parent = createIssue({
      number: 12,
      labels: ['pullops:prd:auto-complete'],
      subIssues: [issueReference(34)],
    });
    const github = createFakeGitHub({
      issues: [parent, createIssue({ number: 34, parent: issueReference(12) })],
      pullRequests: [
        createPullRequest({
          number: 200,
          headRefName: 'pullops/prd-12',
          baseRefName: 'main',
          body: parentPullRequestBody(12),
        }),
        createPullRequest({
          number: 101,
          headRefName: 'pullops/prd-12-issue-34',
          baseRefName: 'pullops/prd-12',
          body: childPullRequestBody(34),
          labels: ['pullops:pr:review'],
        }),
      ],
    });

    const result = await runPrdAutoComplete(
      createContext({
        operation: 'prd-auto-complete',
        githubClient: github.client,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.deepEqual(github.issueLabelsAdded, []);
    assert.deepEqual(github.pullRequestLabelsAdded, []);
    assert.deepEqual(github.mergedPullRequests, []);
    assert.deepEqual(
      readChildResults(result).map(child => child.status),
      ['already-active'],
    );
  });
});

/**
 * @param {Partial<OperationRunnerContext>} overrides
 * @returns {OperationRunnerContext}
 */
function createContext(overrides = {}) {
  return {
    operation: 'prd-auto-advance',
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
    githubClient: createFakeGitHub({ issues: [createIssue({ number: 12 })] }).client,
    gitClient: createFakeGit().client,
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
 * @param {string} [options.title]
 * @param {string} [options.body]
 * @param {string} [options.state]
 * @param {string[]} [options.labels]
 * @param {GitHubIssueReference | null} [options.parent]
 * @param {GitHubIssueReference[]} [options.subIssues]
 * @returns {GitHubIssue}
 */
function createIssue({
  number = 12,
  title = number === 12 ? 'PRD: Parent workflow' : `Child issue ${number}`,
  body = '',
  state = 'OPEN',
  labels = [],
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
    labels,
    parent,
    subIssues,
  };
}

/**
 * @param {number} number
 * @returns {GitHubIssueReference}
 */
function issueReference(number) {
  return {
    number,
    title: number === 12 ? 'PRD: Parent workflow' : `Child issue ${number}`,
    state: 'OPEN',
    url: `https://github.com/acme/widgets/issues/${number}`,
    relationshipSource: 'native',
  };
}

/**
 * @param {object} [options]
 * @param {number} [options.number]
 * @param {string} [options.headRefName]
 * @param {string} [options.baseRefName]
 * @param {string} [options.body]
 * @param {string[]} [options.labels]
 * @param {boolean} [options.isDraft]
 * @returns {GitHubPullRequest}
 */
function createPullRequest({
  number = 101,
  headRefName = 'pullops/prd-12-issue-34',
  baseRefName = 'pullops/prd-12',
  body = childPullRequestBody(34),
  labels = [],
  isDraft = true,
} = {}) {
  return {
    number,
    title: `Pull request ${number}`,
    url: `https://github.com/acme/widgets/pull/${number}`,
    headRefName,
    headSha: `sha-${number}`,
    baseRefName,
    state: 'OPEN',
    body,
    isDraft,
    isCrossRepository: false,
    labels,
  };
}

/**
 * @param {number} issueNumber
 * @returns {string}
 */
function childPullRequestBody(issueNumber) {
  return [
    '## PullOps',
    '',
    'Managed: yes',
    'Status: Draft automation',
    '',
    '<details>',
    '<summary>PullOps workflow state</summary>',
    '',
    `Source: Issue #${issueNumber}`,
    'Last operation: pullops:issue:implement',
    '',
    '</details>',
  ].join('\n');
}

/**
 * @param {number} issueNumber
 * @returns {string}
 */
function finalizedChildPullRequestBody(issueNumber) {
  return [
    '## PullOps',
    '',
    'Managed: yes',
    'Status: Ready for human merge',
    '',
    '<details>',
    '<summary>PullOps workflow state</summary>',
    '',
    `Source: Issue #${issueNumber}`,
    'Reviewed tree: tree-reviewed',
    'Finalized tree: tree-finalized',
    'Finalized head: head-finalized',
    'Merge method: rebase',
    'Last operation: pullops:pr:finalize',
    '',
    '</details>',
  ].join('\n');
}

/**
 * @param {number} issueNumber
 * @returns {string}
 */
function parentPullRequestBody(issueNumber) {
  return [
    '## PullOps',
    '',
    'Managed: yes',
    'Status: Draft parent preparation',
    '',
    '<details>',
    '<summary>PullOps workflow state</summary>',
    '',
    `Source: Parent Issue #${issueNumber}`,
    'Last operation: pullops:prd:prepare',
    '',
    '</details>',
  ].join('\n');
}

/**
 * @param {Record<string, unknown>} result
 * @returns {ChildAutomationResult[]}
 */
function readChildResults(result) {
  return /** @type {ChildAutomationResult[]} */ (result.children);
}

/**
 * @param {Record<string, unknown>} result
 * @returns {ParentReviewResult | undefined}
 */
function readParentPullRequest(result) {
  return /** @type {ParentReviewResult | undefined} */ (result.parentPullRequest);
}

/**
 * @param {object} options
 * @param {GitHubIssue[]} options.issues
 * @param {GitHubIssueReference[]} [options.bodyReferences]
 * @param {GitHubPullRequest[]} [options.pullRequests]
 * @param {Map<string, GitHubCheckRun[]>} [options.checksByRef]
 * @returns {{
 *   client: import('../../github/types.js').GitHubClient;
 *   issueLabelsAdded: EditLabelsOptions[];
 *   pullRequestLabelsAdded: EditLabelsOptions[];
 *   createdPullRequests: CreateDraftPullRequestOptions[];
 *   mergedPullRequests: MergePullRequestOptions[];
 *   closedIssues: number[];
 * }}
 */
function createFakeGitHub({
  issues,
  bodyReferences = [],
  pullRequests = [],
  checksByRef = new Map(),
}) {
  const issuesByNumber = new Map(issues.map(issue => [issue.number, issue]));
  const pullRequestsByHead = new Map(
    pullRequests.map(pullRequest => [pullRequest.headRefName, pullRequest]),
  );
  /** @type {EditLabelsOptions[]} */
  const issueLabelsAdded = [];
  /** @type {EditLabelsOptions[]} */
  const issueLabelsRemoved = [];
  /** @type {EditLabelsOptions[]} */
  const pullRequestLabelsAdded = [];
  /** @type {CreateDraftPullRequestOptions[]} */
  const createdPullRequests = [];
  /** @type {MergePullRequestOptions[]} */
  const mergedPullRequests = [];
  /** @type {number[]} */
  const closedIssues = [];

  return {
    issueLabelsAdded,
    pullRequestLabelsAdded,
    createdPullRequests,
    mergedPullRequests,
    closedIssues,
    client: {
      async ensureLabels() {
        return {
          created: [],
          updated: [],
          alreadyCorrect: [],
        };
      },
      async getIssue(number) {
        const issue = issuesByNumber.get(number);
        if (issue === undefined) {
          throw new Error(`Unexpected issue lookup #${number}.`);
        }
        return issue;
      },
      async getPullRequest() {
        throw new Error('getPullRequest was not expected in this test.');
      },
      async getPullRequestChecks() {
        throw new Error('getPullRequestChecks was not expected in this test.');
      },
      async getPullRequestChecksForRef(ref) {
        return checksByRef.get(ref) ?? [];
      },
      async getPullRequestReviewContext() {
        throw new Error('getPullRequestReviewContext was not expected in this test.');
      },
      async getPullRequestDiff() {
        throw new Error('getPullRequestDiff was not expected in this test.');
      },
      async findOpenPullRequestByHead(headBranch) {
        return pullRequestsByHead.get(headBranch);
      },
      async findIssuesByBodyReference() {
        return bodyReferences;
      },
      async createDraftPullRequest(options) {
        createdPullRequests.push(options);
        const pullRequest = createPullRequest({
          number: 300 + createdPullRequests.length,
          headRefName: options.headBranch,
          baseRefName: options.baseBranch,
          body: options.body,
        });
        pullRequestsByHead.set(options.headBranch, pullRequest);
        return pullRequest;
      },
      async mergePullRequest(options) {
        mergedPullRequests.push(options);
      },
      async addLabelsToIssue(options) {
        issueLabelsAdded.push(options);
        const issue = issuesByNumber.get(options.number);
        if (issue !== undefined) {
          issue.labels = [...new Set([...issue.labels, ...options.labels])];
        }
      },
      async removeLabelsFromIssue(options) {
        issueLabelsRemoved.push(options);
        const issue = issuesByNumber.get(options.number);
        if (issue !== undefined) {
          issue.labels = issue.labels.filter(label => !options.labels.includes(label));
        }
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
        closedIssues.push(options.number);
      },
      async commentOnPullRequest() {
        throw new Error('commentOnPullRequest was not expected in this test.');
      },
      async updatePullRequestBody() {},
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
 *   client: import('../../git/types.js').GitClient;
 *   createdBranches: { branchName: string, baseBranch: string }[];
 * }}
 */
function createFakeGit() {
  /** @type {{ branchName: string, baseBranch: string }[]} */
  const createdBranches = [];

  return {
    createdBranches,
    client: {
      async createBranch(options) {
        createdBranches.push(options);
      },
      async hasChanges() {
        throw new Error('hasChanges was not expected in this test.');
      },
      async commitAll() {
        throw new Error('commitAll was not expected in this test.');
      },
      async commitEmpty() {},
      async pushBranch() {},
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
