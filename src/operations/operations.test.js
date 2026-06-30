import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { DEFAULT_PULL_OPS_CONFIG } from '../config/PullOpsConfig.js';
import { PULL_OPS_OPERATION_LABELS } from '../labels/pullOpsLabels.js';
import { createManagedPrStateSection } from '../managed-pr/ManagedPrState.js';
import { runWorkflowOperation } from './operations.js';

/**
 * @typedef {import('../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../git/types.js').CheckoutBranchOptions} CheckoutBranchOptions
 * @typedef {import('../git/types.js').CreateBranchOptions} CreateBranchOptions
 * @typedef {import('../runner/types.js').CodexRunOptions} CodexRunOptions
 */

describe('runWorkflowOperation', () => {
  it('01: restores the starting branch after local operations switch branches', async () => {
    const git = createFakeGit();

    const result = await runWorkflowOperation(
      createContext({
        executionBackend: 'local',
        gitClient: git.client,
        githubClient: createFakeGitHubClient(),
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(git.currentBranch, 'main');
    assert.deepEqual(git.createdBranches, [
      {
        branchName: 'pullops/prd-12',
        baseBranch: 'main',
      },
    ]);
    assert.deepEqual(git.checkouts, [{ branchName: 'main' }]);
  });

  it('02: restores the starting branch after local operations fail', async () => {
    const git = createFakeGit();

    await assert.rejects(
      runWorkflowOperation(
        createContext({
          executionBackend: 'local',
          gitClient: git.client,
          githubClient: createFakeGitHubClient({ failCreatePullRequest: true }),
        }),
      ),
      /draft PR failed/,
    );

    assert.equal(git.currentBranch, 'main');
    assert.deepEqual(git.checkouts, [{ branchName: 'main' }]);
  });

  it('03: reports branch restoration blockers without replacing local operation output', async () => {
    const git = createFakeGit({ failCheckout: true });

    const result = await runWorkflowOperation(
      createContext({
        executionBackend: 'local',
        gitClient: git.client,
        githubClient: createFakeGitHubClient(),
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(git.currentBranch, 'pullops/prd-12');
    assert.deepEqual(result.localBranchRestore, {
      status: 'blocked',
      branch: 'main',
      reason: 'checkout failed',
    });
  });

  it('04: dispatches issue:implement through the catalog-backed workflow runner', async () => {
    const git = createFakeGit();
    const githubClient = createFakeGitHubClient();
    githubClient.addLabelsToPullRequest = async () => {};
    githubClient.commentOnPullRequest = async () => {};
    /** @type {CodexRunOptions[]} */
    const codexCalls = [];

    /** @type {import('../runner/types.js').CodexRunner} */
    const codexRunner = {
      async run(options) {
        codexCalls.push(options);
        return JSON.stringify({
          status: 'implemented',
          summary: 'Implemented the issue through catalog dispatch.',
          changes: ['Added issue implementation dispatch coverage.'],
          testPlan: ['npm test -- src/operations/operations.test.js'],
          followUps: [],
        });
      },
    };

    const result = await runWorkflowOperation(
      createContext({
        executionBackend: 'local',
        operation: 'issue-implement',
        githubClient,
        gitClient: git.client,
        codexRunner,
        runnerAdapter: 'codex-cli',
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(codexCalls.length, 1);
    assert.match(codexCalls[0].prompt, /Use the pullops-issue-implement skill\./);
    assert.match(codexCalls[0].prompt, /Issue #12/);
    assert.deepEqual(git.createdBranches, [
      {
        branchName: 'pullops/issue-12',
        baseBranch: 'main',
      },
    ]);
    assert.equal(git.currentBranch, 'main');
  });

  it('05: dispatches pr-review and pr-address-review through the catalog-backed workflow runner', async () => {
    const githubClient = createCatalogReviewGitHubClient();
    const git = createFakeGit();
    const outputDirectory = await mkdtemp(join(tmpdir(), 'pullops-catalog-review-'));
    /** @type {CodexRunOptions[]} */
    const codexCalls = [];

    /** @type {import('../runner/types.js').CodexRunner} */
    const codexRunner = {
      async run(options) {
        codexCalls.push(options);
        throw new Error('codexRunner.run was not expected in this test.');
      },
    };

    /** @type {Array<[string, 'prepare' | 'finalize', string | undefined, string | undefined]>} */
    const cases = [
      ['pr-review', 'prepare', 'high', 'gpt-5.5'],
      ['pr-address-review', 'prepare', 'mid', 'gpt-5.4'],
      ['pr-review', 'finalize', undefined, undefined],
      ['pr-address-review', 'finalize', undefined, undefined],
    ];

    for (const [operation, phase, expectedModelTier, expectedModel] of cases) {
      const result = await runWorkflowOperation(
        createContext({
          executionBackend: 'github-actions',
          operation,
          phase,
          runnerAdapter: 'codex-action',
          runnerRan: phase === 'finalize' ? false : undefined,
          target: {
            type: 'pr',
            number: 456,
          },
          githubClient,
          gitClient: git.client,
          codexRunner,
          outputDirectory,
        }),
      );

      const reviewResult = /** @type {any} */ (result);
      assert.equal(reviewResult.status, 'accepted');
      if (phase === 'prepare') {
        assert.equal(codexCalls.length, 0);
        assert.equal(reviewResult.modelTier, expectedModelTier);
        assert.equal(reviewResult.model, expectedModel);
        assert.match(reviewResult.summary, /Prepared Codex Action/);
        assert.match(reviewResult.codexAction.promptFile, /codex_prompt\.md$/);
        assert.equal(reviewResult.codexAction.model, expectedModel);
      } else {
        assert.deepEqual(reviewResult.runner, { adapter: 'codex-action', ran: false });
        assert.match(reviewResult.summary, /Skipped pr-/);
      }
    }
  });

  it('06: rejects unsupported catalog lifecycles for prd-auto-advance before dispatch', async () => {
    await assert.rejects(
      runWorkflowOperation(
        createContext({
          executionBackend: 'local',
          operation: 'prd-auto-advance',
          runnerAdapter: 'codex-action',
        }),
      ),
      /prd-auto-advance with --runner codex-action and --phase run is not supported by the operation catalog\./,
    );
  });

  it('07: rejects unsupported catalog lifecycles for prd-auto-complete before dispatch', async () => {
    await assert.rejects(
      runWorkflowOperation(
        createContext({
          executionBackend: 'local',
          operation: 'prd-auto-complete',
          runnerAdapter: 'codex-action',
        }),
      ),
      /prd-auto-complete with --runner codex-action and --phase run is not supported by the operation catalog\./,
    );
  });

  it('08: rejects unsupported catalog phases for prd-auto-advance before dispatch', async () => {
    await assert.rejects(
      runWorkflowOperation(
        createContext({
          executionBackend: 'local',
          operation: 'prd-auto-advance',
          phase: 'prepare',
        }),
      ),
      /prd-auto-advance with --runner codex-cli and --phase prepare is not supported by the operation catalog\./,
    );
  });

  it('09: rejects unsupported catalog phases for prd-auto-complete before dispatch', async () => {
    await assert.rejects(
      runWorkflowOperation(
        createContext({
          executionBackend: 'local',
          operation: 'prd-auto-complete',
          phase: 'prepare',
        }),
      ),
      /prd-auto-complete with --runner codex-cli and --phase prepare is not supported by the operation catalog\./,
    );
  });

  it('10: dispatches pr-fix-ci prepare through the catalog-backed workflow runner', async () => {
    const githubClient = createCatalogFixCiGitHubClient();
    const git = createFakeGit();
    const outputDirectory = await mkdtemp(join(tmpdir(), 'pullops-catalog-pr-fix-ci-'));
    /** @type {import('../runner/types.js').CodexRunOptions[]} */
    const codexCalls = [];

    /** @type {import('../runner/types.js').CodexRunner} */
    const codexRunner = {
      async run(options) {
        codexCalls.push(options);
        throw new Error('codexRunner.run was not expected in this test.');
      },
    };

    const result = await runWorkflowOperation(
      createContext({
        operation: 'pr-fix-ci',
        phase: 'prepare',
        runnerAdapter: 'codex-action',
        target: {
          type: 'pr',
          number: 456,
        },
        modelTier: 'mid',
        model: DEFAULT_PULL_OPS_CONFIG.runner.models.mid,
        githubClient,
        gitClient: git.client,
        codexRunner,
        outputDirectory,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(codexCalls.length, 0);
    assert.match(String(result.summary), /Prepared Codex Action pr-fix-ci run/);
    const codexAction = result.codexAction;
    if (typeof codexAction !== 'object' || codexAction === null) {
      assert.fail('Expected the prepared pr-fix-ci result to include a codexAction payload.');
    }
    assert.match(String(Reflect.get(codexAction, 'promptFile')), /codex_prompt\.md$/);
    assert.equal(Reflect.get(codexAction, 'model'), DEFAULT_PULL_OPS_CONFIG.runner.models.mid);
  });

  it('11: rejects unsupported codex-action lifecycle combinations for pr-update-branch before dispatch', async () => {
    await assert.rejects(
      runWorkflowOperation(
        createContext({
          operation: 'pr-update-branch',
          phase: 'prepare',
          runnerAdapter: 'codex-action',
          target: {
            type: 'pr',
            number: 456,
          },
        }),
      ),
      /pr-update-branch with --runner codex-action and --phase prepare is not supported by the operation catalog\./,
    );
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
    githubClient: createFakeGitHubClient(),
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
 * @returns {any}
 */
function createCatalogReviewGitHubClient() {
  return {
    async ensureLabels() {
      return {
        created: [],
        updated: [],
        alreadyCorrect: [],
      };
    },
    /**
     * @param {number} number
     */
    async getIssue(number) {
      return {
        number,
        title: 'Linked issue',
        body: 'Issue body.',
        state: 'OPEN',
        url: `https://github.test/owner/repo/issues/${number}`,
        authorLogin: 'maintainer',
        labels: [],
        parent: null,
        subIssues: [],
      };
    },
    /**
     * @param {number} number
     */
    async getPullRequest(number) {
      return {
        number,
        title: 'Managed PR',
        url: `https://github.test/owner/repo/pull/${number}`,
        headRefName: 'pullops/issue-42',
        baseRefName: 'main',
        body: createManagedPrStateSection({
          status: 'Draft automation',
          source: {
            kind: 'issue',
            number: 42,
          },
          branchName: 'pullops/issue-42',
          runnerTask: 'pr-review',
          modelTier: 'high',
          model: 'gpt-5.5',
          reviewCycles: {
            current: 1,
            max: 3,
          },
          lastOperation: 'pullops:issue-implement',
        }),
        isDraft: true,
        labels: [],
        isCrossRepository: false,
      };
    },
    async getPullRequestChecks() {
      return [];
    },
    async getPullRequestChecksForRef() {
      return [];
    },
    async getPullRequestReviewContext() {
      return {
        comments: [],
        reviews: [],
        unresolvedThreads: [],
        files: [],
      };
    },
    async getPullRequestDiff() {
      return {
        patch: '',
      };
    },
    async findOpenPullRequestByHead() {
      return undefined;
    },
    async createDraftPullRequest() {
      throw new Error('createDraftPullRequest was not expected in this test.');
    },
    async addLabelsToIssue() {},
    async removeLabelsFromIssue() {},
    async addLabelsToPullRequest() {},
    async removeLabelsFromPullRequest() {},
    async commentOnIssue() {},
    async closeIssue() {},
    async commentOnPullRequest() {},
    async updatePullRequestBody() {},
    async publishPullRequestReview() {},
    async replyToPullRequestReviewComment() {},
    async dismissPullRequestReview() {},
    async mergePullRequest() {},
    async resolveReviewThread() {},
  };
}

/**
 * @returns {any}
 */
function createCatalogFixCiGitHubClient() {
  return {
    async ensureLabels() {
      return {
        created: [],
        updated: [],
        alreadyCorrect: [],
      };
    },
    /**
     * @param {number} number
     */
    async getPullRequest(number) {
      return {
        number,
        title: 'Manual CI fix request',
        url: `https://github.test/owner/repo/pull/${number}`,
        headRefName: 'fix/manual-ci',
        baseRefName: 'main',
        body: 'Human-authored PR.',
        isDraft: false,
        labels: [PULL_OPS_OPERATION_LABELS.prFixCi],
        isCrossRepository: false,
      };
    },
    async getIssue() {
      throw new Error('getIssue was not expected in this test.');
    },
    async getPullRequestChecks() {
      return [
        {
          name: 'ESLint lint',
          workflowName: 'CI',
          bucket: 'fail',
          conclusion: 'failure',
        },
      ];
    },
    async getPullRequestReviewContext() {
      return {
        comments: [],
        reviews: [],
        unresolvedThreads: [],
        files: [],
      };
    },
    async getPullRequestDiff() {
      return {
        patch: '',
      };
    },
    async findOpenPullRequestByHead() {
      return undefined;
    },
    async createDraftPullRequest() {
      throw new Error('createDraftPullRequest was not expected in this test.');
    },
    async addLabelsToIssue() {},
    async removeLabelsFromIssue() {},
    async addLabelsToPullRequest() {},
    async removeLabelsFromPullRequest() {},
    async commentOnIssue() {},
    async closeIssue() {},
    async commentOnPullRequest() {},
    async updatePullRequestBody() {},
    async publishPullRequestReview() {},
    async replyToPullRequestReviewComment() {},
    async dismissPullRequestReview() {},
    async mergePullRequest() {},
    async resolveReviewThread() {},
  };
}

/**
 * @param {object} [options]
 * @param {boolean} [options.failCheckout]
 * @returns {{
 *   client: import('../git/types.js').GitClient;
 *   createdBranches: CreateBranchOptions[];
 *   checkouts: CheckoutBranchOptions[];
 *   currentBranch: string;
 * }}
 */
function createFakeGit({ failCheckout = false } = {}) {
  /** @type {CreateBranchOptions[]} */
  const createdBranches = [];
  /** @type {CheckoutBranchOptions[]} */
  const checkouts = [];
  let currentBranch = 'main';

  return {
    createdBranches,
    checkouts,
    get currentBranch() {
      return currentBranch;
    },
    client: {
      async createBranch(options) {
        createdBranches.push(options);
        currentBranch = options.branchName;
      },
      async getCurrentBranch() {
        return currentBranch;
      },
      async checkoutBranch(options) {
        if (failCheckout) {
          throw new Error('checkout failed');
        }

        checkouts.push(options);
        currentBranch = options.branchName;
      },
      async hasChanges() {
        return false;
      },
      async commitAll() {},
      async commitEmpty() {},
      async readWorkingTreePatch() {
        return '';
      },
      async pushBranch() {},
      async rebaseBranchOntoBase() {
        return {
          status: 'rebased',
          headSha: 'head-current',
          treeHash: 'tree-current',
        };
      },
      async pushBranchWithLease() {
        return {
          status: 'pushed',
          headSha: 'head-current',
          treeHash: 'tree-current',
        };
      },
      async getCurrentHeadSha() {
        return 'head-current';
      },
      async getCurrentTreeHash() {
        return 'tree-current';
      },
      async getChangedFilesSinceBase() {
        return [];
      },
      async rewriteBranchWithCommitPlan() {
        return {
          headSha: 'head-current',
          treeHash: 'tree-current',
        };
      },
    },
  };
}

/**
 * @param {object} [options]
 * @param {boolean} [options.failCreatePullRequest]
 * @returns {import('../github/types.js').GitHubClient}
 */
function createFakeGitHubClient({ failCreatePullRequest = false } = {}) {
  return {
    async ensureLabels() {
      return {
        created: [],
        updated: [],
        alreadyCorrect: [],
      };
    },
    async getIssue(number) {
      return {
        number,
        title: 'Parent issue',
        body: '',
        state: 'OPEN',
        url: `https://github.test/owner/repo/issues/${number}`,
        authorLogin: 'maintainer',
        labels: [],
        parent: null,
        subIssues: [],
      };
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
    async findOpenPullRequestByHead() {
      return undefined;
    },
    async createDraftPullRequest(options) {
      if (failCreatePullRequest) {
        throw new Error('draft PR failed');
      }

      return {
        number: 101,
        title: options.title,
        url: 'https://github.test/owner/repo/pull/101',
        headRefName: options.headBranch,
        baseRefName: options.baseBranch,
        body: options.body,
        isDraft: true,
        labels: [],
      };
    },
    async addLabelsToIssue() {},
    async removeLabelsFromIssue() {},
    async addLabelsToPullRequest() {
      throw new Error('addLabelsToPullRequest was not expected in this test.');
    },
    async removeLabelsFromPullRequest() {
      throw new Error('removeLabelsFromPullRequest was not expected in this test.');
    },
    async commentOnIssue() {},
    async closeIssue() {
      throw new Error('closeIssue was not expected in this test.');
    },
    async commentOnPullRequest() {
      throw new Error('commentOnPullRequest was not expected in this test.');
    },
    async updatePullRequestBody() {
      throw new Error('updatePullRequestBody was not expected in this test.');
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
  };
}
