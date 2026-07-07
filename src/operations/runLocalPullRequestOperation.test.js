import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { DEFAULT_PULL_OPS_CONFIG } from '../config/PullOpsConfig.js';
import { createManagedPrStateSection } from '../managed-pr/ManagedPrState.js';
import { requireOperationCatalogOperationLabelName } from './operationCatalog.js';
import { runPrFinalize } from './pr-finalize/run.js';
import { runPrReview } from './pr-review/run.js';
import { runPrUpdateBranch } from './pr-update-branch/run.js';

/**
 * @typedef {import('../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../runner/types.js').RunnerRunOptions} RunnerRunOptions
 * @typedef {import('../git/types.js').CommitAllOptions} CommitAllOptions
 */

describe('local pull request operations', () => {
  it('01: runs pr-review locally without mutating GitHub', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-local-pr-review-'));
    const github = createFakeGitHub();
    const git = createFakeGit({ hasChangesResults: [false, false] });
    const fakeRunner = createFakeRunner({
      output: JSON.stringify({
        status: 'approved',
        summary: 'Local review approved.',
        comments: [],
        replies: [],
        directChanges: [],
        followUps: [],
      }),
    });

    const result = await runPrReview(
      createContext({
        cwd,
        operation: 'pr-review',
        githubClient: github.client,
        gitClient: git.client,
        runner: fakeRunner.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(result.operation, 'pr:review');
    assert.equal(result.publicationMode, 'dry-run');
    assert.equal(fakeRunner.calls.length, 1);
    assert.match(fakeRunner.calls[0].prompt, /Use the pullops-pr-review skill/);
    const localRunRecord = String(result.localRunRecord);
    const state = JSON.parse(await readFile(join(localRunRecord, 'state.json'), 'utf8'));
    const call = fakeRunner.calls[0];
    assert(call);
    const env = call.env;
    assert(env);
    assert.equal(env.PULLOPS_RUN_STATE_PATH, join(localRunRecord, 'state.json'));
    assert.equal(env.PULLOPS_HEARTBEAT_COMMAND, 'npm exec -- pullops heartbeat');
    assert.equal(env.PULLOPS_HEARTBEAT_TOKEN, state.heartbeatToken);
    assert.equal(env.PULLOPS_HEARTBEAT_INTERVAL_MS, String(state.heartbeatIntervalMs));
    assert.equal(env.npm_config_cache, join(localRunRecord, 'npm-cache'));
    assert.equal(state.status, 'accepted');
    assert.equal(state.phase, 'run');
    assert.equal(state.lastEvent.status, 'accepted');
    assert.equal(git.commits.length, 0);
    assert.equal(github.mutations, 0);

    assert.match(localRunRecord, /\.pullops\/runs\/.+pr-review-7$/);
    assert.match(await readFile(join(localRunRecord, 'pr-review-prompt.md'), 'utf8'), /PR #7/);
    assert.match(
      await readFile(join(localRunRecord, 'pr-review-raw-output.txt'), 'utf8'),
      /Local review approved/,
    );
    assert.match(await readFile(join(localRunRecord, 'result.json'), 'utf8'), /pr:review/);
  });

  it('02: blocks unsupported local PR maintenance operations without falling through to hosted behavior', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-local-pr-update-'));
    const github = createFakeGitHub();
    const git = createFakeGit({ hasChangesResults: [false] });
    const fakeRunner = createFakeRunner({ output: '{}' });

    const result = await runPrUpdateBranch(
      createContext({
        cwd,
        operation: 'pr-update-branch',
        githubClient: github.client,
        gitClient: git.client,
        runner: fakeRunner.runner,
      }),
    );

    assert.equal(result.status, 'blocked');
    assert.equal(result.operation, 'pr:update-branch');
    assert.match(String(result.summary), /not implemented yet for pr:update-branch/);
    const state = JSON.parse(
      await readFile(join(String(result.localRunRecord), 'state.json'), 'utf8'),
    );
    assert.equal(state.status, 'blocked');
    assert.equal(state.operationReference, 'pr:update-branch');
    assert.equal(fakeRunner.calls.length, 0);
    assert.equal(github.mutations, 0);
  });

  it('03: records accepted run-state status for planned local pr-finalize output', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-local-pr-finalize-'));
    const github = createFakeGitHub();
    const git = createFakeGit({ hasChangesResults: [false, false] });
    const fakeRunner = createFakeRunner({
      output: JSON.stringify({
        status: 'planned',
        summary: 'Planned local finalize run.',
        commitPlan: {
          commits: [
            {
              header: 'feat(issue): implement #42',
              body: ['Finalize local PR history.'],
              footers: ['Refs: #42'],
              files: ['src/file.js'],
            },
          ],
        },
        followUps: [],
      }),
    });

    const previousUsedTokens = process.env.PULLOPS_CONTEXT_USED_TOKENS;
    process.env.PULLOPS_CONTEXT_USED_TOKENS = '75000';
    let result;
    try {
      result = await runPrFinalize(
        createContext({
          cwd,
          operation: 'pr-finalize',
          githubClient: github.client,
          gitClient: git.client,
          runner: fakeRunner.runner,
        }),
      );
    } finally {
      if (previousUsedTokens === undefined) {
        delete process.env.PULLOPS_CONTEXT_USED_TOKENS;
      } else {
        process.env.PULLOPS_CONTEXT_USED_TOKENS = previousUsedTokens;
      }
    }

    assert.equal(result.status, 'planned');
    const localRunRecord = String(result.localRunRecord);
    const state = JSON.parse(await readFile(join(localRunRecord, 'state.json'), 'utf8'));
    assert.equal(state.status, 'accepted');
    assert.equal(state.lastEvent.status, 'accepted');
    assert.equal(typeof state.startedAt, 'string');
    assert.equal(typeof state.finishedAt, 'string');
    assert.equal(typeof state.durationMs, 'number');
    assert.ok(state.durationMs >= 0);
    assert.deepEqual(state.contextUsage, { used: 75000 });
    assert.match(
      await readFile(join(localRunRecord, 'result.json'), 'utf8'),
      /"status": "planned"/,
    );
  });

  it('04: links nested local PR runs back to the parent run state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-local-pr-nested-'));
    const github = createFakeGitHub();
    const git = createFakeGit({ hasChangesResults: [false, false] });
    const fakeRunner = createFakeRunner({
      output: JSON.stringify({
        status: 'approved',
        summary: 'Nested local review approved.',
        comments: [],
        replies: [],
        directChanges: [],
        followUps: [],
      }),
    });
    const parentRun = /** @type {import('../local-run-state/types.js').LocalRunRunLink} */ ({
      runId: '2024-01-01T000000000Z-prd-auto-complete-12',
      operationReference: 'prd:auto-complete',
      normalizedOperationReference: 'prd-auto-complete',
      target: {
        type: 'issue',
        number: 12,
      },
      statePath: join(
        cwd,
        '.pullops',
        'runs',
        '2024-01-01T000000000Z-prd-auto-complete-12',
        'state.json',
      ),
    });

    const result = await runPrReview(
      createContext({
        cwd,
        operation: 'pr-review',
        githubClient: github.client,
        gitClient: git.client,
        runner: fakeRunner.runner,
        parentRun,
      }),
    );

    const state = JSON.parse(
      await readFile(join(String(result.localRunRecord), 'state.json'), 'utf8'),
    );
    assert.deepEqual(state.parentRun, parentRun);
  });
});

/**
 * @param {Partial<OperationRunnerContext>} overrides
 * @returns {OperationRunnerContext}
 */
function createContext(overrides = {}) {
  return {
    operation: 'pr-review',
    phase: 'run',
    runnerAdapter: 'codex-cli',
    executionBackend: 'local',
    publicationMode: 'dry-run',
    target: {
      type: 'pr',
      number: 7,
    },
    cwd: process.cwd(),
    config: DEFAULT_PULL_OPS_CONFIG,
    modelTier: 'high',
    model: 'gpt-5.5',
    githubClient: createFakeGitHub().client,
    gitClient: createFakeGit().client,
    runner: createFakeRunner({ output: '{}' }).runner,
    ...overrides,
  };
}

function createFakeGitHub() {
  let mutations = 0;
  const client = {
    async ensureLabels() {
      return {
        created: [],
        updated: [],
        alreadyCorrect: [],
      };
    },
    async getIssue() {
      return {
        number: 42,
        title: 'Implement local PR operations',
        body: 'Issue body.',
        state: 'OPEN',
        url: 'https://github.com/acme/widgets/issues/42',
        authorLogin: 'octocat',
        labels: [],
        parent: null,
        subIssues: [],
      };
    },
    async getPullRequest() {
      return {
        number: 7,
        title: 'Implement #42',
        url: 'https://github.com/acme/widgets/pull/7',
        headRefName: 'pullops/issue-42',
        baseRefName: 'main',
        body: createManagedBody(),
        isDraft: true,
        labels: [],
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
        files: [
          {
            path: 'src/file.js',
            additions: 1,
            deletions: 0,
          },
        ],
      };
    },
    async getPullRequestDiff() {
      return {
        patch: [
          'diff --git a/src/file.js b/src/file.js',
          '+++ b/src/file.js',
          '@@ -0,0 +1 @@',
          '+new line',
        ].join('\n'),
      };
    },
    async findOpenPullRequestByHead() {
      return undefined;
    },
    async createDraftPullRequest() {
      mutations += 1;
      throw new Error('createDraftPullRequest was not expected.');
    },
    async addLabelsToIssue() {
      mutations += 1;
      throw new Error('addLabelsToIssue was not expected.');
    },
    async removeLabelsFromIssue() {
      mutations += 1;
      throw new Error('removeLabelsFromIssue was not expected.');
    },
    async addLabelsToPullRequest() {
      mutations += 1;
      throw new Error('addLabelsToPullRequest was not expected.');
    },
    async removeLabelsFromPullRequest() {
      mutations += 1;
      throw new Error('removeLabelsFromPullRequest was not expected.');
    },
    async commentOnIssue() {
      mutations += 1;
      throw new Error('commentOnIssue was not expected.');
    },
    async closeIssue() {
      mutations += 1;
      throw new Error('closeIssue was not expected.');
    },
    async commentOnPullRequest() {
      mutations += 1;
      throw new Error('commentOnPullRequest was not expected.');
    },
    async updatePullRequestBody() {
      mutations += 1;
      throw new Error('updatePullRequestBody was not expected.');
    },
    async markPullRequestReadyForReview() {
      mutations += 1;
      throw new Error('markPullRequestReadyForReview was not expected.');
    },
    async publishPullRequestReview() {
      mutations += 1;
      throw new Error('publishPullRequestReview was not expected.');
    },
    async replyToPullRequestReviewComment() {
      mutations += 1;
      throw new Error('replyToPullRequestReviewComment was not expected.');
    },
    async resolvePullRequestReviewThread() {
      mutations += 1;
      throw new Error('resolvePullRequestReviewThread was not expected.');
    },
  };

  return {
    client,
    get mutations() {
      return mutations;
    },
  };
}

/**
 * @param {{ hasChangesResults?: boolean[] }} [options]
 */
function createFakeGit({ hasChangesResults = [false] } = {}) {
  /** @type {CommitAllOptions[]} */
  const commits = [];

  return {
    commits,
    client: {
      async createBranch() {},
      async getCurrentBranch() {
        return 'pullops/issue-42';
      },
      async hasChanges() {
        const next = hasChangesResults.shift();
        return next ?? hasChangesResults.at(-1) ?? false;
      },
      /**
       * @param {CommitAllOptions} options
       */
      async commitAll(options) {
        commits.push(options);
      },
      async commitEmpty() {},
      async pushBranch() {
        throw new Error('pushBranch was not expected.');
      },
      async rebaseBranchOntoBase() {
        throw new Error('rebaseBranchOntoBase was not expected.');
      },
      async pushBranchWithLease() {
        throw new Error('pushBranchWithLease was not expected.');
      },
      async getCurrentHeadSha() {
        return 'head-current';
      },
      async getCurrentTreeHash() {
        return 'tree-current';
      },
      async getChangedFilesSinceBase() {
        return ['src/file.js'];
      },
      async getCommitsSinceBase() {
        return [
          {
            sha: 'abc123',
            subject: 'feat(issue): implement #42',
            body: 'Refs: #42',
            files: ['src/file.js'],
          },
        ];
      },
      async rewriteBranchWithCommitPlan() {
        throw new Error('rewriteBranchWithCommitPlan was not expected.');
      },
    },
  };
}

/**
 * @param {{ output: unknown }} options
 */
function createFakeRunner({ output }) {
  /** @type {RunnerRunOptions[]} */
  const calls = [];
  return {
    calls,
    runner: {
      /**
       * @param {RunnerRunOptions} options
       */
      async run(options) {
        calls.push(options);
        return output;
      },
    },
  };
}

function createManagedBody() {
  return [
    createManagedPrStateSection({
      status: 'Draft automation',
      source: {
        kind: 'issue',
        number: 42,
      },
      branchName: 'pullops/issue-42',
      triggerActor: 'octocat',
      runnerTask: 'pullops-issue-implement',
      modelTier: 'high',
      model: 'gpt-5.5',
      lastOperation: requireOperationCatalogOperationLabelName('issue-implement'),
      reviewCycles: {
        current: 1,
        max: 3,
      },
      ciFixCycles: {
        current: 0,
        max: 2,
      },
    }),
    '',
    '## Summary',
    '',
    'Implemented work.',
  ].join('\n');
}
