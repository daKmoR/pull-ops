import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { DEFAULT_PULL_OPS_CONFIG } from '../config/PullOpsConfig.js';
import { createManagedPrStateSection } from '../managed-pr/ManagedPrState.js';
import { requireOperationCatalogOperationLabelName } from './operationCatalog.js';
import { runWorkflowOperation } from './operations.js';

/**
 * @typedef {import('../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../git/types.js').CheckoutBranchOptions} CheckoutBranchOptions
 * @typedef {import('../git/types.js').CreateBranchOptions} CreateBranchOptions
 * @typedef {import('../runner/types.js').RunnerRunOptions} RunnerRunOptions
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
        branchName: 'pullops/spec-12',
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
    assert.equal(git.currentBranch, 'pullops/spec-12');
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
    /** @type {RunnerRunOptions[]} */
    const runnerCalls = [];

    /** @type {import('../runner/types.js').Runner} */
    const runner = {
      async run(options) {
        runnerCalls.push(options);
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
        runner,
        runnerAdapter: 'codex-cli',
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(runnerCalls.length, 1);
    assert.match(runnerCalls[0].prompt, /Use the pullops-issue-implement skill\./);
    assert.match(runnerCalls[0].prompt, /Issue #12/);
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
    /** @type {RunnerRunOptions[]} */
    const runnerCalls = [];

    /** @type {import('../runner/types.js').Runner} */
    const runner = {
      async run(options) {
        runnerCalls.push(options);
        throw new Error('runner.run was not expected in this test.');
      },
    };

    /** @type {Array<[string, 'prepare' | 'complete', string | undefined, string | undefined]>} */
    const cases = [
      ['pr-review', 'prepare', 'high', 'gpt-5.5'],
      ['pr-address-review', 'prepare', 'mid', 'gpt-5.4'],
      ['pr-review', 'complete', undefined, undefined],
      ['pr-address-review', 'complete', undefined, undefined],
    ];

    for (const [operation, phase, expectedModelTier, expectedModel] of cases) {
      if (phase === 'complete') {
        await writeFile(
          join(outputDirectory, 'runner_result.json'),
          JSON.stringify({
            schemaVersion: 1,
            status: 'skipped',
          }),
        );
      }

      const result = await runWorkflowOperation(
        createContext({
          executionBackend: 'github-actions',
          operation,
          phase,
          runnerAdapter: 'external',
          target: {
            type: 'pr',
            number: 456,
          },
          githubClient,
          gitClient: git.client,
          runner,
          outputDirectory,
        }),
      );

      const reviewResult = /** @type {any} */ (result);
      if (phase === 'prepare') {
        assert.equal(reviewResult.status, 'waiting');
        assert.equal(runnerCalls.length, 0);
        assert.equal(reviewResult.modelTier, expectedModelTier);
        assert.equal(reviewResult.model, expectedModel);
        assert.match(reviewResult.summary, /Prepared external/);
        assert.match(reviewResult.runnerJob.promptFile, /runner_prompt\.md$/);
        assert.match(reviewResult.runnerJob.resultFile, /runner_result\.json$/);
        assert.equal(reviewResult.runnerJob.model, expectedModel);
      } else {
        assert.equal(reviewResult.status, 'accepted');
        assert.deepEqual(reviewResult.runner, { adapter: 'external', status: 'skipped' });
        assert.match(reviewResult.summary, /Skipped pr-/);
      }
    }
  });

  it('05b: dispatches local external pr-review prepare through the catalog handler', async () => {
    const githubClient = createCatalogReviewGitHubClient();
    const git = createFakeGit();
    const outputDirectory = await mkdtemp(join(tmpdir(), 'pullops-local-catalog-review-'));
    /** @type {RunnerRunOptions[]} */
    const runnerCalls = [];

    /** @type {import('../runner/types.js').Runner} */
    const runner = {
      async run(options) {
        runnerCalls.push(options);
        throw new Error('runner.run was not expected in this test.');
      },
    };

    const result = await runWorkflowOperation(
      createContext({
        executionBackend: 'local',
        operation: 'pr-review',
        phase: 'prepare',
        runnerAdapter: 'external',
        target: {
          type: 'pr',
          number: 456,
        },
        githubClient,
        gitClient: git.client,
        runner,
        outputDirectory,
      }),
    );

    assert.equal(result.status, 'waiting');
    assert.equal(runnerCalls.length, 0);
    const runnerJob = /** @type {any} */ (result.runnerJob);
    assert.match(runnerJob.promptFile, /runner_prompt\.md$/);
    assert.match(runnerJob.resultFile, /runner_result\.json$/);
  });

  it('06: rejects unsupported catalog lifecycles for spec-auto-advance before dispatch', async () => {
    await assert.rejects(
      runWorkflowOperation(
        createContext({
          executionBackend: 'local',
          operation: 'spec-auto-advance',
          runnerAdapter: 'external',
        }),
      ),
      /spec-auto-advance with --runner external and --phase run is not supported by the operation catalog\./,
    );
  });

  it('07: rejects unsupported catalog lifecycles for spec-auto-complete before dispatch', async () => {
    await assert.rejects(
      runWorkflowOperation(
        createContext({
          executionBackend: 'local',
          operation: 'spec-auto-complete',
          runnerAdapter: 'external',
          phase: 'prepare',
        }),
      ),
      /spec-auto-complete with --runner external and --phase prepare is not supported by the operation catalog\./,
    );
  });

  it('08: rejects unsupported catalog phases for spec-auto-advance before dispatch', async () => {
    await assert.rejects(
      runWorkflowOperation(
        createContext({
          executionBackend: 'local',
          operation: 'spec-auto-advance',
          phase: 'prepare',
        }),
      ),
      /spec-auto-advance with --runner codex-cli and --phase prepare is not supported by the operation catalog\./,
    );
  });

  it('09: rejects unsupported catalog phases for spec-auto-complete before dispatch', async () => {
    await assert.rejects(
      runWorkflowOperation(
        createContext({
          executionBackend: 'local',
          operation: 'spec-auto-complete',
          phase: 'prepare',
        }),
      ),
      /spec-auto-complete with --runner codex-cli and --phase prepare is not supported by the operation catalog\./,
    );
  });

  it('10: dispatches pr-fix-ci prepare through the catalog-backed workflow runner', async () => {
    const githubClient = createCatalogFixCiGitHubClient();
    const git = createFakeGit();
    const outputDirectory = await mkdtemp(join(tmpdir(), 'pullops-catalog-pr-fix-ci-'));
    /** @type {import('../runner/types.js').RunnerRunOptions[]} */
    const runnerCalls = [];

    /** @type {import('../runner/types.js').Runner} */
    const runner = {
      async run(options) {
        runnerCalls.push(options);
        throw new Error('runner.run was not expected in this test.');
      },
    };

    const result = await runWorkflowOperation(
      createContext({
        operation: 'pr-fix-ci',
        phase: 'prepare',
        runnerAdapter: 'external',
        target: {
          type: 'pr',
          number: 456,
        },
        modelTier: 'mid',
        model: DEFAULT_PULL_OPS_CONFIG.runner.models.mid,
        githubClient,
        gitClient: git.client,
        runner,
        outputDirectory,
      }),
    );

    assert.equal(result.status, 'waiting');
    assert.equal(runnerCalls.length, 0);
    assert.match(String(result.summary), /Prepared external pr-fix-ci run/);
    const runnerJob = result.runnerJob;
    if (typeof runnerJob !== 'object' || runnerJob === null) {
      assert.fail('Expected the prepared pr-fix-ci result to include a runnerJob payload.');
    }
    assert.match(String(Reflect.get(runnerJob, 'promptFile')), /runner_prompt\.md$/);
    assert.match(String(Reflect.get(runnerJob, 'resultFile')), /runner_result\.json$/);
    assert.equal(Reflect.get(runnerJob, 'model'), DEFAULT_PULL_OPS_CONFIG.runner.models.mid);
  });

  it('11: rejects unsupported external lifecycle combinations for pr-update-branch before dispatch', async () => {
    await assert.rejects(
      runWorkflowOperation(
        createContext({
          operation: 'pr-update-branch',
          phase: 'prepare',
          runnerAdapter: 'external',
          target: {
            type: 'pr',
            number: 456,
          },
        }),
      ),
      /pr-update-branch with --runner external and --phase prepare is not supported by the operation catalog\./,
    );
  });

  it('12: rejects unsupported local pull request lifecycles before local dry-run dispatch', async () => {
    const cases = /** @type {Array<{
      operation: string,
      phase: import('../cli/types.js').OperationPhase,
      runnerAdapter: import('../runner/types.js').RunnerAdapter,
      message: RegExp,
    }>} */ ([
      {
        operation: 'pr-review',
        phase: 'prepare',
        runnerAdapter: 'codex-cli',
        message:
          /pr-review with --runner codex-cli and --phase prepare is not supported by the operation catalog\./,
      },
      {
        operation: 'pr-update-branch',
        phase: 'prepare',
        runnerAdapter: 'external',
        message:
          /pr-update-branch with --runner external and --phase prepare is not supported by the operation catalog\./,
      },
    ]);

    for (const { operation, phase, runnerAdapter, message } of cases) {
      await assert.rejects(
        runWorkflowOperation(
          createContext({
            executionBackend: 'local',
            operation,
            phase,
            runnerAdapter,
            target: {
              type: 'pr',
              number: 456,
            },
          }),
        ),
        message,
      );
    }
  });

  it('13: rejects uncataloged operations before local PR fallback or placeholder dispatch', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-unknown-operation-'));
    const cases = /** @type {Array<{
      name: string,
      context: Partial<OperationRunnerContext>,
    }>} */ ([
      {
        name: 'local PR fallback',
        context: {
          cwd,
          executionBackend: 'local',
          operation: 'pr-non-cataloged',
          target: {
            type: 'pr',
            number: 456,
          },
        },
      },
      {
        name: 'placeholder dispatch',
        context: {
          operation: 'issue-non-cataloged',
          target: {
            type: 'issue',
            number: 12,
          },
        },
      },
    ]);

    for (const { name, context } of cases) {
      await assert.rejects(
        runWorkflowOperation(createContext(context)),
        /Unknown operation ".*". Expected a cataloged PullOps Operation\./,
        name,
      );
    }
  });
});

/**
 * @param {Partial<OperationRunnerContext>} overrides
 * @returns {OperationRunnerContext}
 */
function createContext(overrides = {}) {
  return {
    operation: 'spec-prepare',
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
    runner: {
      async run() {
        throw new Error('runner.run was not expected in this test.');
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
        labels: [requireOperationCatalogOperationLabelName('pr-fix-ci')],
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
