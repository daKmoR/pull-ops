import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { DEFAULT_PULL_OPS_CONFIG } from '../../config/PullOpsConfig.js';
import { createImplementIssueBranchName } from './branch.js';
import { GITHUB_ACTIONS_BOT_AUTHOR, runImplementIssue } from './run.js';

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('../../github/types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('../../github/types.js').CreateDraftPullRequestOptions} CreateDraftPullRequestOptions
 * @typedef {import('../../github/types.js').EditLabelsOptions} EditLabelsOptions
 * @typedef {import('../../github/types.js').CommentOnIssueOptions} CommentOnIssueOptions
 * @typedef {import('../../git/types.js').CreateBranchOptions} CreateBranchOptions
 * @typedef {import('../../git/types.js').CommitAllOptions} CommitAllOptions
 * @typedef {import('../../git/types.js').CommitEmptyOptions} CommitEmptyOptions
 * @typedef {import('../../git/types.js').PushBranchOptions} PushBranchOptions
 * @typedef {import('../../runner/types.js').CodexRunOptions} CodexRunOptions
 */

describe('runImplementIssue', () => {
  it('01: creates a deterministic branch, validates runner output, commits, pushes, and opens a managed draft PR', async () => {
    const issue = createIssue({ number: 42, title: 'Add the first operation' });
    const github = createFakeGitHub({ issue });
    const git = createFakeGit();
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'implemented',
        summary: 'Implemented the first operation.',
        changes: ['Added operation orchestration.', 'Covered the command seam with tests.'],
        testPlan: ['npm test -- src/operations/implement-issue/run.test.js'],
      }),
    });

    const result = await runImplementIssue(
      createContext({
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
        triggerActor: 'octocat',
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.deepEqual(git.branches, [
      {
        branchName: 'pullops/issue-42',
        baseBranch: 'main',
      },
    ]);
    assert.equal(codex.calls.length, 1);
    assert.equal(codex.calls[0].command, 'codex exec');
    assert.equal(codex.calls[0].model, 'codex-high');
    assert.match(codex.calls[0].prompt, /Use the pullops-implement-issue skill/);
    assert.deepEqual(git.commits, [
      {
        message: [
          'feat(issue): implement #42',
          '',
          'Implement Add the first operation.',
          '',
          'Refs: #42',
        ].join('\n'),
        author: GITHUB_ACTIONS_BOT_AUTHOR,
      },
    ]);
    assert.deepEqual(git.pushes, [{ branchName: 'pullops/issue-42' }]);
    assert.equal(github.createdPullRequests.length, 1);
    assert.equal(github.createdPullRequests[0].title, 'Implement #42: Add the first operation');
    assert.equal(github.createdPullRequests[0].baseBranch, 'main');
    assert.equal(github.createdPullRequests[0].headBranch, 'pullops/issue-42');
    assert.match(github.createdPullRequests[0].body, /Managed PR: yes/);
    assert.match(github.createdPullRequests[0].body, /Status: Draft automation/);
    assert.match(github.createdPullRequests[0].body, /Review cycles: 0 \/ 3/);
    assert.match(github.createdPullRequests[0].body, /Triggered by: @octocat/);
    assert.match(github.createdPullRequests[0].body, /Model tier: high/);
    assert.match(github.createdPullRequests[0].body, /Model: codex-high/);
    assert.deepEqual(github.pullRequestLabels, [
      {
        number: 100,
        labels: ['pullops:pr:review'],
      },
    ]);
    assert.deepEqual(github.issueLabelsAdded, [
      {
        number: 42,
        labels: ['pullops:status:in-progress'],
      },
      {
        number: 42,
        labels: ['pullops:status:done'],
      },
    ]);
  });

  it('02: implements a manually selected child issue against the parent branch', async () => {
    const issue = createIssue({
      number: 42,
      title: 'Do one child task',
      parent: {
        number: 1,
        title: 'PRD',
        relationshipSource: 'native',
      },
    });
    const github = createFakeGitHub({ issue });
    const git = createFakeGit();
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'implemented',
        summary: 'Implemented the selected child issue.',
        changes: ['Added the selected behavior.'],
        testPlan: ['npm test -- src/operations/implement-issue/run.test.js'],
      }),
    });

    const result = await runImplementIssue(
      createContext({
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(codex.calls.length, 1);
    assert.match(codex.calls[0].prompt, /Parent Issue #1: PRD/);
    assert.match(codex.calls[0].prompt, /Implement only the selected Child Issue/);
    assert.deepEqual(git.branches, [
      {
        branchName: 'pullops/prd-1/issue-42',
        baseBranch: 'pullops/prd-1',
      },
    ]);
    assert.deepEqual(git.commits, [
      {
        message: [
          'feat(issue): implement #42',
          '',
          'Implement Do one child task.',
          '',
          'Refs: #42',
          'PRD: #1',
        ].join('\n'),
        author: GITHUB_ACTIONS_BOT_AUTHOR,
      },
    ]);
    assert.equal(github.createdPullRequests.length, 1);
    assert.equal(github.createdPullRequests[0].baseBranch, 'pullops/prd-1');
    assert.equal(github.createdPullRequests[0].headBranch, 'pullops/prd-1/issue-42');
    assert.match(github.createdPullRequests[0].body, /Closes #42/);
    assert.match(github.createdPullRequests[0].body, /PRD: #1/);
  });

  it('03: blocks a PRD-looking issue without native GitHub child issues', async () => {
    const issue = createIssue({
      number: 1,
      title: 'PRD: Dogfood PullOps workflow kit',
      body: [
        '## Problem Statement',
        '',
        'Build the thing.',
        '',
        '## Solution',
        '',
        'Ship it.',
      ].join('\n'),
    });
    const github = createFakeGitHub({ issue });
    const git = createFakeGit();
    const codex = createFakeCodexRunner({ output: '{}' });

    const result = await runImplementIssue(
      createContext({
        target: {
          type: 'issue',
          number: 1,
        },
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'blocked');
    assert.match(String(result.summary), /Use pullops:prd:prepare/);
    assert.equal(codex.calls.length, 0);
    assert.equal(git.branches.length, 0);
    assert.match(github.comments[0].body, /Use pullops:prd:prepare/);
  });

  it('04: blocks a parent issue with children without implementing child issues', async () => {
    const issue = createIssue({
      number: 1,
      title: 'PRD: Dogfood PullOps workflow kit',
      subIssues: [
        {
          number: 4,
          title: 'Implement a Child Issue',
          relationshipSource: 'native',
        },
      ],
    });
    const github = createFakeGitHub({ issue });
    const git = createFakeGit();
    const codex = createFakeCodexRunner({ output: '{}' });

    const result = await runImplementIssue(
      createContext({
        target: {
          type: 'issue',
          number: 1,
        },
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'blocked');
    assert.match(String(result.summary), /child issues/);
    assert.match(String(result.summary), /Use pullops:prd:prepare/);
    assert.equal(codex.calls.length, 0);
    assert.equal(git.branches.length, 0);
  });

  it('05: refuses closed issues before creating a branch', async () => {
    const issue = createIssue({
      number: 42,
      state: 'CLOSED',
    });
    const github = createFakeGitHub({ issue });
    const git = createFakeGit();
    const codex = createFakeCodexRunner({ output: '{}' });

    const result = await runImplementIssue(
      createContext({
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'blocked');
    assert.match(String(result.summary), /closed/);
    assert.equal(codex.calls.length, 0);
    assert.equal(git.branches.length, 0);
  });

  it('06: refuses when the deterministic PullOps branch already has an open implementation PR', async () => {
    const github = createFakeGitHub({
      issue: createIssue({ number: 42 }),
      existingPullRequest: {
        number: 7,
        title: 'Existing PR',
        url: 'https://github.com/acme/widgets/pull/7',
        headRefName: 'pullops/issue-42',
        body: '',
        isDraft: true,
      },
    });
    const git = createFakeGit();
    const codex = createFakeCodexRunner({ output: '{}' });

    const result = await runImplementIssue(
      createContext({
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.match(String(result.summary), /already exists/);
    assert.equal(codex.calls.length, 0);
    assert.equal(git.branches.length, 0);
    assert.equal(github.createdPullRequests.length, 0);
    assert.deepEqual(github.issueLabelsRemoved, [
      {
        number: 42,
        labels: [
          'pullops:issue:implement',
          'pullops:status:in-progress',
          'pullops:status:blocked',
          'pullops:status:failed',
        ],
      },
    ]);
  });

  it('07: records invalid Operation Output before committing, pushing, or opening a PR', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'pullops-failure-'));
    const github = createFakeGitHub({ issue: createIssue({ number: 42 }) });
    const git = createFakeGit();
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'implemented',
        summary: 'Done.',
        changes: ['Changed code.'],
      }),
    });

    await assert.rejects(
      runImplementIssue(
        createContext({
          githubClient: github.client,
          gitClient: git.client,
          codexRunner: codex.runner,
          outputDirectory,
        }),
      ),
      /Invalid Operation Output: Operation Output\.testPlan must be an array\./,
    );

    assert.deepEqual(git.branches, [
      {
        branchName: 'pullops/issue-42',
        baseBranch: 'main',
      },
    ]);
    assert.equal(git.commits.length, 0);
    assert.equal(git.pushes.length, 0);
    assert.equal(github.createdPullRequests.length, 0);
    assert.match(github.comments[0].body, /Operation Output\.testPlan must be an array/);
    assert.deepEqual(github.issueLabelsAdded.at(-1), {
      number: 42,
      labels: ['pullops:status:failed'],
    });
    assert.equal(
      await readFile(join(outputDirectory, 'failure_reason.txt'), 'utf8'),
      'Invalid Operation Output: Operation Output.testPlan must be an array.\n',
    );
  });

  it('08: records unexpected git or GitHub failures after valid runner output', async () => {
    const github = createFakeGitHub({ issue: createIssue({ number: 42 }) });
    const git = createFakeGit({
      failOn: action => action === 'pushBranch',
    });
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'implemented',
        summary: 'Implemented the issue.',
        changes: ['Changed code.'],
        testPlan: ['npm test'],
      }),
    });

    await assert.rejects(
      runImplementIssue(
        createContext({
          githubClient: github.client,
          gitClient: git.client,
          codexRunner: codex.runner,
        }),
      ),
      /push failed/,
    );

    assert.equal(github.createdPullRequests.length, 0);
    assert.match(github.comments[0].body, /push failed/);
    assert.deepEqual(github.issueLabelsAdded.at(-1), {
      number: 42,
      labels: ['pullops:status:failed'],
    });
  });

  it('09: blocks an issue when a dependency is not done', async () => {
    const issue = createIssue({
      number: 42,
      body: ['Blocked by: #7', '', '## What to build', '', 'Do the thing.'].join('\n'),
    });
    const dependency = createIssue({
      number: 7,
      title: 'Dependency',
      labels: [],
    });
    const github = createFakeGitHub({
      issue,
      issuesByNumber: new Map([
        [42, issue],
        [7, dependency],
      ]),
    });
    const git = createFakeGit();
    const codex = createFakeCodexRunner({ output: '{}' });

    const result = await runImplementIssue(
      createContext({
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'blocked');
    assert.match(String(result.summary), /#7/);
    assert.equal(codex.calls.length, 0);
    assert.equal(git.branches.length, 0);
    assert.deepEqual(github.issueLabelsAdded, [
      {
        number: 42,
        labels: ['pullops:status:blocked'],
      },
    ]);
  });

  it('10: uses the configured Branch Prefix for deterministic branch names', () => {
    assert.equal(
      createImplementIssueBranchName({
        branchPrefix: 'automation/pullops/',
        issueNumber: 123,
      }),
      'automation/pullops/issue-123',
    );
    assert.equal(
      createImplementIssueBranchName({
        branchPrefix: 'automation/pullops/',
        parentNumber: 10,
        issueNumber: 123,
      }),
      'automation/pullops/prd-10/issue-123',
    );
  });
});

/**
 * @param {Partial<OperationRunnerContext>} overrides
 * @returns {OperationRunnerContext}
 */
function createContext(overrides = {}) {
  return {
    operation: 'implement-issue',
    target: {
      type: 'issue',
      number: 42,
    },
    cwd: '/workspace',
    config: DEFAULT_PULL_OPS_CONFIG,
    modelTier: 'high',
    model: 'codex-high',
    githubClient: createFakeGitHub({ issue: createIssue({ number: 42 }) }).client,
    gitClient: createFakeGit().client,
    codexRunner: createFakeCodexRunner({ output: '{}' }).runner,
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
 * @param {import('../../github/types.js').GitHubIssueReference | null} [options.parent]
 * @param {import('../../github/types.js').GitHubIssueReference[]} [options.subIssues]
 * @returns {GitHubIssue}
 */
function createIssue({
  number = 42,
  title = 'Implement the issue',
  body = '## What to build\n\nDo the thing.',
  state = 'OPEN',
  labels = ['pullops:issue:implement'],
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
 * @param {{ issue: GitHubIssue, issuesByNumber?: Map<number, GitHubIssue>, existingPullRequest?: GitHubPullRequest }} options
 * @returns {{
 *   createdPullRequests: CreateDraftPullRequestOptions[];
 *   issueLabelsAdded: EditLabelsOptions[];
 *   issueLabelsRemoved: EditLabelsOptions[];
 *   pullRequestLabels: EditLabelsOptions[];
 *   comments: CommentOnIssueOptions[];
 *   client: import('../../github/types.js').GitHubClient;
 * }}
 */
function createFakeGitHub({
  issue,
  issuesByNumber = new Map([[issue.number, issue]]),
  existingPullRequest,
}) {
  /** @type {CreateDraftPullRequestOptions[]} */
  const createdPullRequests = [];
  /** @type {EditLabelsOptions[]} */
  const issueLabelsAdded = [];
  /** @type {EditLabelsOptions[]} */
  const issueLabelsRemoved = [];
  /** @type {EditLabelsOptions[]} */
  const pullRequestLabels = [];
  /** @type {CommentOnIssueOptions[]} */
  const comments = [];

  return {
    createdPullRequests,
    issueLabelsAdded,
    issueLabelsRemoved,
    pullRequestLabels,
    comments,
    client: {
      async ensureLabels() {
        return {
          created: [],
          updated: [],
          alreadyCorrect: [],
        };
      },
      async getIssue(number) {
        const foundIssue = issuesByNumber.get(number);
        if (foundIssue === undefined) {
          throw new Error(`Unexpected issue lookup: #${number}`);
        }
        return foundIssue;
      },
      async getPullRequest() {
        throw new Error('getPullRequest was not expected in this test.');
      },
      async getPullRequestReviewContext() {
        throw new Error('getPullRequestReviewContext was not expected in this test.');
      },
      async getPullRequestDiff() {
        throw new Error('getPullRequestDiff was not expected in this test.');
      },
      async findOpenPullRequestByHead() {
        return existingPullRequest;
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
      async addLabelsToPullRequest(options) {
        pullRequestLabels.push(options);
      },
      async removeLabelsFromPullRequest() {
        throw new Error('removeLabelsFromPullRequest was not expected in this test.');
      },
      async commentOnIssue(options) {
        comments.push(options);
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

/**
 * @param {{ failOn?: (action: string) => boolean }} [options]
 * @returns {{
 *   branches: CreateBranchOptions[];
 *   commits: CommitAllOptions[];
 *   emptyCommits: CommitEmptyOptions[];
 *   pushes: PushBranchOptions[];
 *   client: import('../../git/types.js').GitClient;
 * }}
 */
function createFakeGit({ failOn = () => false } = {}) {
  /** @type {CreateBranchOptions[]} */
  const branches = [];
  /** @type {CommitAllOptions[]} */
  const commits = [];
  /** @type {CommitEmptyOptions[]} */
  const emptyCommits = [];
  /** @type {PushBranchOptions[]} */
  const pushes = [];

  return {
    branches,
    commits,
    emptyCommits,
    pushes,
    client: {
      async createBranch(options) {
        if (failOn('createBranch')) {
          throw new Error('create branch failed');
        }
        branches.push(options);
      },
      async hasChanges() {
        if (failOn('hasChanges')) {
          throw new Error('status failed');
        }
        return true;
      },
      async commitAll(options) {
        if (failOn('commitAll')) {
          throw new Error('commit failed');
        }
        commits.push(options);
      },
      async commitEmpty(options) {
        if (failOn('commitEmpty')) {
          throw new Error('empty commit failed');
        }
        emptyCommits.push(options);
      },
      async pushBranch(options) {
        if (failOn('pushBranch')) {
          throw new Error('push failed');
        }
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
