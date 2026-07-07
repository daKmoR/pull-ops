import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { DEFAULT_PULL_OPS_CONFIG } from '../config/PullOpsConfig.js';
import {
  closeMergedChildIssuePullRequest,
  coordinateLocalPrdAutoComplete,
  coordinatePrdAutomation,
  readBlockingDependencies,
  readIssueWorkTarget,
} from './childCoordination.js';

/**
 * @typedef {import('../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../github/types.js').GitHubCheckRun} GitHubCheckRun
 * @typedef {import('../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('../github/types.js').GitHubIssueReference} GitHubIssueReference
 * @typedef {import('../github/types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('../github/types.js').CreateDraftPullRequestOptions} CreateDraftPullRequestOptions
 * @typedef {import('../github/types.js').EditLabelsOptions} EditLabelsOptions
 * @typedef {import('../github/types.js').CloseIssueOptions} CloseIssueOptions
 * @typedef {import('../github/types.js').MergePullRequestOptions} MergePullRequestOptions
 * @typedef {import('../github/types.js').UpdatePullRequestBodyOptions} UpdatePullRequestBodyOptions
 */

describe('PRD Child Coordination', () => {
  it('01: auto-advance starts native unblocked Child Issues only', async () => {
    const parent = createIssue({
      number: 12,
      labels: ['pullops:prd:auto-advance'],
      subIssues: [
        issueReference(34),
        issueReference(35),
        issueReference(36),
        issueReference(37),
        issueReference(38),
      ],
    });
    const github = createFakeGitHub({
      issues: [
        parent,
        createIssue({ number: 34, parent: issueReference(12) }),
        createIssue({
          number: 35,
          body: 'Blocked by: #34',
          parent: issueReference(12),
        }),
        createIssue({ number: 36, state: 'CLOSED', parent: issueReference(12) }),
        createIssue({
          number: 37,
          labels: ['pullops:issue:implement'],
          parent: issueReference(12),
        }),
        createIssue({ number: 38, parent: issueReference(12) }),
        createIssue({ number: 99, body: 'Part of: #12' }),
      ],
    });
    const git = createFakeGit();

    const result = await coordinatePrdAutomation(
      createContext({
        githubClient: github.client,
        gitClient: git.client,
      }),
      {
        parentIssueNumber: 12,
        mode: 'auto-advance',
      },
    );

    assert.equal(result.status, 'accepted');
    assert.deepEqual(git.createdBranches, [
      {
        branchName: 'pullops/prd-12',
        baseBranch: 'main',
      },
    ]);
    assert.deepEqual(github.issueLabelsAdded, [
      {
        number: 34,
        labels: ['pullops:issue:implement'],
      },
      {
        number: 38,
        labels: ['pullops:issue:implement'],
      },
    ]);
    assert.match(github.createdPullRequests[0].body, /^Kind: Umbrella PR$/m);
    assert.match(github.createdPullRequests[0].body, /^Child PRs: none yet$/m);
    assert.deepEqual(
      result.children?.map(child => [child.issue.number, child.status]),
      [
        [34, 'started'],
        [35, 'blocked'],
        [36, 'closed'],
        [37, 'already-active'],
        [38, 'started'],
      ],
    );
  });

  it('02: auto-complete merges finalized Child Issue PRs when finalized-head checks are absent', async () => {
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
          isDraft: false,
        }),
      ],
    });

    const result = await coordinatePrdAutomation(
      createContext({
        githubClient: github.client,
      }),
      {
        parentIssueNumber: 12,
        mode: 'auto-complete',
      },
    );

    assert.equal(result.status, 'accepted');
    assert.deepEqual(github.mergedPullRequests, [
      {
        number: 101,
        method: 'rebase',
      },
    ]);
    assert.match(github.updatedPullRequestBodies[0].body, /^Child PRs:$/m);
    assert.match(github.updatedPullRequestBodies[0].body, /^- #101 for #34$/m);
    assert.deepEqual(
      result.children?.map(child => child.status),
      ['merged'],
    );
  });

  it('03: local auto-complete keeps validating after three addressed Umbrella PR reviews', async () => {
    const parent = createIssue({
      number: 12,
      labels: ['pullops:prd:auto-complete'],
      subIssues: [
        {
          ...issueReference(34),
          state: 'CLOSED',
        },
      ],
    });
    const github = createFakeGitHub({
      issues: [parent, createIssue({ number: 34, state: 'CLOSED', parent: issueReference(12) })],
      pullRequests: [
        createPullRequest({
          number: 200,
          headRefName: 'pullops/prd-12',
          baseRefName: 'main',
          body: changesRequestedParentPullRequestBody(12),
        }),
      ],
    });
    const git = createFakeGit();
    git.client.hasChanges = async () => false;
    git.client.fetchRemoteRefs = async () => {};
    git.client.checkoutPullOpsBranch = async () => {};
    /** @type {import('./childCoordination.js').PullRequestOperationName[]} */
    const operations = [];
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-prd-parent-review-loop-'));

    const result = await coordinateLocalPrdAutoComplete(
      createContext({
        cwd,
        operation: 'prd-auto-complete',
        publicationMode: 'publish',
        runGoal: 'finalized',
        githubClient: github.client,
        gitClient: git.client,
      }),
      {
        parentIssueNumber: 12,
        async runChildIssue() {
          throw new Error('runChildIssue was not expected in this test.');
        },
        async runParentPullRequestOperation(request) {
          operations.push(request.operation);

          if (request.operation === 'pr-review') {
            const reviewCount = operations.filter(operation => operation === 'pr-review').length;
            return reviewCount < 4
              ? {
                  status: 'accepted',
                  summary: 'Requested changes.',
                  reviewResult: 'changes_requested',
                }
              : {
                  status: 'accepted',
                  summary: 'Approved.',
                  reviewResult: 'approved',
                };
          }

          if (request.operation === 'pr-address-review') {
            return {
              status: 'accepted',
              summary: 'Addressed feedback.',
            };
          }

          if (request.operation === 'pr-finalize') {
            return {
              status: 'accepted',
              summary: 'Finalized.',
            };
          }

          throw new Error(`Unexpected parent PR operation ${request.operation}.`);
        },
      },
    );

    assert.equal(result.status, 'accepted');
    assert.equal(result.parentPullRequest?.status, 'finalized');
    assert.deepEqual(operations, [
      'pr-address-review',
      'pr-review',
      'pr-address-review',
      'pr-review',
      'pr-address-review',
      'pr-review',
      'pr-address-review',
      'pr-review',
      'pr-finalize',
    ]);
  });

  it('03b: local auto-complete follows Umbrella PR finalize routes back to review', async () => {
    const parent = createIssue({
      number: 12,
      labels: ['pullops:prd:auto-complete'],
      subIssues: [
        {
          ...issueReference(34),
          state: 'CLOSED',
        },
      ],
    });
    const github = createFakeGitHub({
      issues: [parent, createIssue({ number: 34, state: 'CLOSED', parent: issueReference(12) })],
      pullRequests: [
        createPullRequest({
          number: 200,
          headRefName: 'pullops/prd-12',
          baseRefName: 'main',
          body: reviewApprovedParentPullRequestBody(12),
        }),
      ],
    });
    const git = createFakeGit();
    git.client.hasChanges = async () => false;
    git.client.fetchRemoteRefs = async () => {};
    git.client.checkoutPullOpsBranch = async () => {};
    /** @type {import('./childCoordination.js').PullRequestOperationName[]} */
    const operations = [];
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-prd-parent-finalize-route-'));

    const result = await coordinateLocalPrdAutoComplete(
      createContext({
        cwd,
        operation: 'prd-auto-complete',
        publicationMode: 'publish',
        runGoal: 'finalized',
        githubClient: github.client,
        gitClient: git.client,
      }),
      {
        parentIssueNumber: 12,
        async runChildIssue() {
          throw new Error('runChildIssue was not expected in this test.');
        },
        async runParentPullRequestOperation(request) {
          operations.push(request.operation);

          if (request.operation === 'pr-finalize') {
            const finalizeCount = operations.filter(
              operation => operation === 'pr-finalize',
            ).length;
            return finalizeCount === 1
              ? {
                  status: 'accepted',
                  summary: 'Routed back to review.',
                  prFinalize: {
                    routedTo: 'pullops:pr:review',
                  },
                }
              : {
                  status: 'accepted',
                  summary: 'Finalized.',
                };
          }

          if (request.operation === 'pr-review') {
            return {
              status: 'accepted',
              summary: 'Approved.',
              reviewResult: 'approved',
            };
          }

          throw new Error(`Unexpected parent PR operation ${request.operation}.`);
        },
      },
    );

    assert.equal(result.status, 'accepted');
    assert.equal(result.parentPullRequest?.status, 'finalized');
    assert.deepEqual(operations, ['pr-finalize', 'pr-review', 'pr-finalize']);
  });

  it('03c: local auto-complete follows Child PR finalize routes back to review', async () => {
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
          body: reviewRequiredChildPullRequestBody(34),
        }),
      ],
    });
    const git = createFakeGit();
    git.client.hasChanges = async () => false;
    git.client.fetchRemoteRefs = async () => {};
    git.client.checkoutPullOpsBranch = async () => {};
    /** @type {import('./childCoordination.js').PullRequestOperationName[]} */
    const operations = [];
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-prd-child-finalize-route-'));
    const runnerJob = {
      cwd,
      promptFile: join(cwd, 'runner_prompt.md'),
      outputFile: join(cwd, 'runner_output.json'),
      resultFile: join(cwd, 'runner_result.json'),
      workerPrompt: 'Review PR #101.',
      model: 'gpt-5.5',
      branch: 'pullops/prd-12-issue-34',
      completionCommands: {},
      completeCommand: {
        argv: ['npm', 'exec', '--', 'pullops', 'run', 'pr-review', '--pr', '101'],
        env: {},
      },
    };

    const result = await coordinateLocalPrdAutoComplete(
      createContext({
        cwd,
        operation: 'prd-auto-complete',
        publicationMode: 'publish',
        runGoal: 'finalized',
        githubClient: github.client,
        gitClient: git.client,
      }),
      {
        parentIssueNumber: 12,
        async runChildIssue() {
          throw new Error('runChildIssue was not expected in this test.');
        },
        async runChildPullRequestOperation(request) {
          operations.push(request.operation);
          return {
            status: 'waiting',
            summary: 'Prepared external review run.',
            runnerJob,
          };
        },
      },
    );

    assert.equal(result.status, 'waiting');
    assert.deepEqual(operations, ['pr-review']);
    assert.deepEqual(result.runnerJob, runnerJob);
    assert.deepEqual(
      result.children?.map(child => [
        child.issue.number,
        child.status,
        child.blockedOperation,
        child.runnerJob,
      ]),
      [
        [
          34,
          'waiting',
          'pr:review',
          {
            cwd: runnerJob.cwd,
            promptFile: runnerJob.promptFile,
            outputFile: runnerJob.outputFile,
            resultFile: runnerJob.resultFile,
            model: runnerJob.model,
            branch: runnerJob.branch,
          },
        ],
      ],
    );
  });

  it('03d: local auto-complete runs Child PR operations from the child branch', async () => {
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
          body: reviewedChildPullRequestBody(34),
        }),
      ],
    });
    const git = createFakeGit();
    git.client.hasChanges = async () => false;
    git.client.fetchRemoteRefs = async () => {};
    let currentBranch = 'main';
    git.client.checkoutPullOpsBranch = async options => {
      currentBranch = options.branchName;
    };
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-prd-child-pr-branch-'));
    const runnerJob = {
      cwd,
      promptFile: join(cwd, 'runner_prompt.md'),
      outputFile: join(cwd, 'runner_output.json'),
      resultFile: join(cwd, 'runner_result.json'),
      workerPrompt: 'Finalize PR #101.',
      model: 'gpt-5.5',
      branch: 'pullops/prd-12-issue-34',
      completionCommands: {},
      completeCommand: {
        argv: ['npm', 'exec', '--', 'pullops', 'run', 'pr-finalize', '--pr', '101'],
        env: {},
      },
    };

    const result = await coordinateLocalPrdAutoComplete(
      createContext({
        cwd,
        operation: 'prd-auto-complete',
        publicationMode: 'publish',
        runGoal: 'finalized',
        githubClient: github.client,
        gitClient: git.client,
      }),
      {
        parentIssueNumber: 12,
        async runChildIssue() {
          throw new Error('runChildIssue was not expected in this test.');
        },
        async runChildPullRequestOperation(request) {
          assert.equal(request.operation, 'pr-finalize');
          assert.equal(currentBranch, 'pullops/prd-12-issue-34');
          return {
            status: 'waiting',
            summary: 'Prepared external finalize run.',
            runnerJob,
          };
        },
      },
    );

    assert.equal(result.status, 'waiting');
    assert.deepEqual(result.runnerJob, runnerJob);
    assert.deepEqual(
      result.children?.map(child => [
        child.issue.number,
        child.status,
        child.blockedOperation,
        child.runnerJob,
      ]),
      [
        [
          34,
          'waiting',
          'pr:finalize',
          {
            cwd: runnerJob.cwd,
            promptFile: runnerJob.promptFile,
            outputFile: runnerJob.outputFile,
            resultFile: runnerJob.resultFile,
            model: runnerJob.model,
            branch: runnerJob.branch,
          },
        ],
      ],
    );
  });

  it('03e: local auto-complete preserves refused run state for dirty worktree guardrails', async () => {
    const git = createFakeGit();
    git.client.hasChanges = async () => true;
    const localRunRecordDirectory = await mkdtemp(join(tmpdir(), 'pullops-prd-dirty-worktree-'));

    await assert.rejects(
      async () =>
        await coordinateLocalPrdAutoComplete(
          createContext({
            operation: 'prd-auto-complete',
            publicationMode: 'publish',
            localRunRecordDirectory,
            gitClient: git.client,
          }),
          {
            parentIssueNumber: 12,
            async runChildIssue() {
              throw new Error('runChildIssue was not expected in this test.');
            },
          },
        ),
      error => {
        const runError = /** @type {{ localRunRecord?: unknown }} */ (error);
        assert.equal(runError.localRunRecord, localRunRecordDirectory);
        return true;
      },
    );

    const state = JSON.parse(await readFile(join(localRunRecordDirectory, 'state.json'), 'utf8'));
    assert.equal(state.status, 'refused');
    assert.equal(state.lastEvent.status, 'refused');
    assert.match(String(state.lastEvent.summary), /requires a clean worktree/);
  });

  it('04: close-child requests Umbrella PR review even without an active automation mode', async () => {
    const childIssue = createIssue({
      number: 42,
      state: 'CLOSED',
      parent: issueReference(1),
    });
    const parentIssue = createIssue({
      number: 1,
      labels: [],
      subIssues: [
        {
          ...issueReference(42),
          state: 'CLOSED',
        },
      ],
    });
    const childPullRequest = createPullRequest({
      number: 100,
      headRefName: 'pullops/prd-1-issue-42',
      baseRefName: 'pullops/prd-1',
      state: 'MERGED',
      mergedAt: '2026-06-14T10:00:00Z',
    });
    const parentPullRequest = createPullRequest({
      number: 200,
      headRefName: 'pullops/prd-1',
      baseRefName: 'main',
      body: parentPullRequestBody(1),
    });
    const github = createFakeGitHub({
      issues: [childIssue, parentIssue],
      targetPullRequest: childPullRequest,
      pullRequests: [parentPullRequest],
    });

    const result = await closeMergedChildIssuePullRequest(
      createContext({
        target: { type: 'pr', number: 100 },
        operation: 'pr-close-child-issue',
        githubClient: github.client,
      }),
      {
        pullRequestNumber: 100,
      },
    );

    assert.equal(result.status, 'accepted');
    assert.equal(result.prdAutomation?.status, 'skipped');
    assert.equal(result.parentPullRequest?.status, 'review-requested');
    assert.deepEqual(github.pullRequestLabelsAdded, [
      {
        number: 200,
        labels: ['pullops:pr:review'],
      },
    ]);
  });

  it('05: reads Child Issue work targets from native parent identity and body dependencies', async () => {
    const github = createFakeGitHub({
      issues: [
        createIssue({
          number: 42,
          body: 'Blocked by: #41',
          parent: issueReference(7),
        }),
        createIssue({ number: 41 }),
      ],
    });

    const target = await readIssueWorkTarget(
      createContext({
        target: { type: 'issue', number: 42 },
        githubClient: github.client,
      }),
      {
        issueNumber: 42,
      },
    );

    assert.equal(target.parentIssueNumber, 7);
    assert.equal(target.branchName, 'pullops/prd-7-issue-42');
    assert.equal(target.baseBranch, 'pullops/prd-7');

    const blockingDependencies = await readBlockingDependencies(
      createContext({
        target: { type: 'issue', number: 42 },
        githubClient: github.client,
      }),
      {
        issue: target.issue,
      },
    );

    assert.deepEqual(
      blockingDependencies.map(issue => issue.number),
      [41],
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
 * @param {string} [options.state]
 * @param {string | undefined} [options.mergedAt]
 * @returns {GitHubPullRequest}
 */
function createPullRequest({
  number = 101,
  headRefName = 'pullops/prd-12-issue-34',
  baseRefName = 'pullops/prd-12',
  body = childPullRequestBody(34),
  labels = [],
  isDraft = true,
  state = 'OPEN',
  mergedAt,
} = {}) {
  return {
    number,
    title: `Pull request ${number}`,
    url: `https://github.com/acme/widgets/pull/${number}`,
    headRefName,
    headSha: `sha-${number}`,
    baseRefName,
    state,
    mergedAt,
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
function reviewRequiredChildPullRequestBody(issueNumber) {
  return [
    '## PullOps',
    '',
    'Managed: yes',
    'Status: Review required',
    '',
    '<details>',
    '<summary>PullOps workflow state</summary>',
    '',
    `Source: Issue #${issueNumber}`,
    'Review cycles: 1 / 3',
    'Last operation: pullops:pr:finalize',
    '',
    '</details>',
  ].join('\n');
}

/**
 * @param {number} issueNumber
 * @returns {string}
 */
function reviewedChildPullRequestBody(issueNumber) {
  return [
    '## PullOps',
    '',
    'Managed: yes',
    'Status: Review approved',
    '',
    '<details>',
    '<summary>PullOps workflow state</summary>',
    '',
    `Source: Issue #${issueNumber}`,
    'Review cycles: 1 / 3',
    'Reviewed tree: reviewed-tree',
    'Last operation: pullops:pr:review',
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
 * @param {number} issueNumber
 * @returns {string}
 */
function changesRequestedParentPullRequestBody(issueNumber) {
  return [
    '## PullOps',
    '',
    'Managed: yes',
    'Status: Changes requested',
    '',
    '<details>',
    '<summary>PullOps workflow state</summary>',
    '',
    `Source: Parent Issue #${issueNumber}`,
    'Last operation: pullops:pr:review',
    '',
    '</details>',
  ].join('\n');
}

/**
 * @param {number} issueNumber
 * @returns {string}
 */
function reviewApprovedParentPullRequestBody(issueNumber) {
  return [
    '## PullOps',
    '',
    'Managed: yes',
    'Status: Review approved',
    '',
    '<details>',
    '<summary>PullOps workflow state</summary>',
    '',
    `Source: Parent Issue #${issueNumber}`,
    'Reviewed tree: tree-reviewed',
    'Last operation: pullops:pr:review',
    '',
    '</details>',
  ].join('\n');
}

/**
 * @param {object} options
 * @param {GitHubIssue[]} options.issues
 * @param {GitHubPullRequest[]} [options.pullRequests]
 * @param {GitHubPullRequest} [options.targetPullRequest]
 * @param {Map<string, GitHubCheckRun[]>} [options.checksByRef]
 * @returns {{
 *   client: import('../github/types.js').GitHubClient;
 *   issueLabelsAdded: EditLabelsOptions[];
 *   pullRequestLabelsAdded: EditLabelsOptions[];
 *   createdPullRequests: CreateDraftPullRequestOptions[];
 *   updatedPullRequestBodies: UpdatePullRequestBodyOptions[];
 *   mergedPullRequests: MergePullRequestOptions[];
 *   closedIssues: CloseIssueOptions[];
 * }}
 */
function createFakeGitHub({
  issues,
  pullRequests = [],
  targetPullRequest,
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
  /** @type {UpdatePullRequestBodyOptions[]} */
  const updatedPullRequestBodies = [];
  /** @type {MergePullRequestOptions[]} */
  const mergedPullRequests = [];
  /** @type {CloseIssueOptions[]} */
  const closedIssues = [];

  return {
    issueLabelsAdded,
    pullRequestLabelsAdded,
    createdPullRequests,
    updatedPullRequestBodies,
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
        if (targetPullRequest === undefined) {
          throw new Error('getPullRequest was not expected in this test.');
        }
        return targetPullRequest;
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
        closedIssues.push(options);
      },
      async commentOnPullRequest() {
        throw new Error('commentOnPullRequest was not expected in this test.');
      },
      async updatePullRequestBody(options) {
        updatedPullRequestBodies.push(options);
        const pullRequest = [...pullRequestsByHead.values()].find(
          candidate => candidate.number === options.number,
        );
        if (pullRequest !== undefined) {
          pullRequest.body = options.body;
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

/**
 * @returns {{
 *   client: import('../git/types.js').GitClient;
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
