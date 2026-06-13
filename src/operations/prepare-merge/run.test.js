import assert from 'node:assert/strict';
import { execFile as nodeExecFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

import { DEFAULT_PULL_OPS_CONFIG } from '../../config/PullOpsConfig.js';
import { createGitClient } from '../../git/GitClient.js';
import { runPrepareMerge } from './run.js';

const execFile = promisify(nodeExecFile);

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('../../github/types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('../../github/types.js').GitHubPullRequestReviewContext} GitHubPullRequestReviewContext
 * @typedef {import('../../github/types.js').GitHubPullRequestDiff} GitHubPullRequestDiff
 * @typedef {import('../../github/types.js').UpdatePullRequestBodyOptions} UpdatePullRequestBodyOptions
 * @typedef {import('../../github/types.js').EditLabelsOptions} EditLabelsOptions
 * @typedef {import('../../github/types.js').CommentOnPullRequestOptions} CommentOnPullRequestOptions
 * @typedef {import('../../runner/types.js').CodexRunOptions} CodexRunOptions
 */

describe('runPrepareMerge', () => {
  it('01: rewrites a Concrete Issue PR into one logical commit, updates PR body state, and hands off to final review', async () => {
    const repository = await createTemporaryRepository({
      branchName: 'pullops/issue-42',
      changes: async workDir => {
        await writeFile(join(workDir, 'src/feature.js'), 'export const value = 42;\n');
        await writeFile(join(workDir, 'src/feature.test.js'), 'assert.equal(value, 42);\n');
        await unlink(join(workDir, 'src/old.js'));
      },
    });
    const github = createFakeGitHub({
      pullRequest: createPullRequest(),
      issue: createIssue(),
      reviewContext: createReviewContext(),
      diff: await createDiff(repository.workDir),
    });
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'planned',
        summary: 'Prepared a one-commit issue history.',
        commitPlan: {
          commits: [
            {
              header: 'feat(issue): implement #42',
              body: ['Implement the feature and focused regression coverage.'],
              footers: ['Refs: #42'],
              files: ['src/feature.js', 'src/feature.test.js', 'src/old.js'],
            },
          ],
        },
        pullRequest: {
          summary: 'Implemented the feature behind issue #42.',
          changes: ['Added the feature module.', 'Covered the feature behavior.'],
          testPlan: ['node --test src/feature.test.js'],
          traceability: ['Closes #42'],
        },
      }),
    });

    const result = await runPrepareMerge(
      createContext({
        cwd: repository.workDir,
        githubClient: github.client,
        gitClient: createGitClientFor(repository.workDir),
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.match(codex.calls[0].prompt, /Use the pullops-prepare-merge skill/);
    assert.match(codex.calls[0].prompt, /src\/feature\.test\.js/);
    assert.equal(await countCommitsSinceBase(repository.workDir), 1);
    assert.deepEqual(await readCommitMessages(repository.workDir), [
      [
        'feat(issue): implement #42',
        '',
        'Implement the feature and focused regression coverage.',
        '',
        'Refs: #42',
      ].join('\n'),
    ]);
    assert.equal(
      await readFile(join(repository.workDir, 'src/feature.js'), 'utf8'),
      'export const value = 42;\n',
    );
    await assert.rejects(readFile(join(repository.workDir, 'src/old.js'), 'utf8'));
    assert.match(github.updatedBodies[0].body, /Implemented the feature behind issue #42/);
    assert.match(github.updatedBodies[0].body, /- Added the feature module\./);
    assert.match(github.updatedBodies[0].body, /node --test src\/feature\.test\.js/);
    assert.match(github.updatedBodies[0].body, /Closes #42/);
    assert.match(github.updatedBodies[0].body, /Status: Prepared for final review/);
    assert.match(github.updatedBodies[0].body, /Last operation: pullops:pr:prepare-merge/);
    assert.deepEqual(github.pullRequestLabelsRemoved, [
      {
        number: 100,
        labels: [
          'pullops:pr:prepare-merge',
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
  });

  it('02: rewrites a Parent Issue PR into Child Issue Commits with PRD closing traceability', async () => {
    const repository = await createTemporaryRepository({
      branchName: 'pullops/prd-1',
      changes: async workDir => {
        await writeFile(join(workDir, 'src/child-6.js'), 'export const child6 = true;\n');
        await writeFile(join(workDir, 'src/child-7.js'), 'export const child7 = true;\n');
      },
    });
    const github = createFakeGitHub({
      pullRequest: createPullRequest({
        title: 'Prepare #1: Dogfood workflow kit',
        headRefName: 'pullops/prd-1',
        body: createPullRequestBody({
          source: 'Source: Parent Issue #1',
          traceability: 'Closes #1',
          lastOperation: 'Last operation: pullops:pr:review',
        }),
      }),
      issue: createIssue({
        number: 1,
        title: 'PRD: Dogfood workflow kit',
        body: '## Problem Statement\n\nBuild the dogfood Workflow Kit.',
      }),
      reviewContext: createReviewContext(),
      diff: await createDiff(repository.workDir),
    });
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'planned',
        summary: 'Prepared a parent issue child commit stack.',
        commitPlan: {
          commits: [
            {
              header: 'feat(issue): implement #6',
              body: ['Add address-review workflow behavior.'],
              footers: ['Refs: #6', 'PRD: #1'],
              files: ['src/child-6.js'],
            },
            {
              header: 'feat(issue): implement #7',
              body: ['Add fix-ci workflow behavior.'],
              footers: ['Refs: #7', 'PRD: #1'],
              files: ['src/child-7.js'],
            },
          ],
        },
        pullRequest: {
          summary: 'Prepared the parent PR for final review.',
          changes: ['Completed child issue #6.', 'Completed child issue #7.'],
          testPlan: ['npm test'],
          traceability: ['Closes #1'],
        },
      }),
    });

    const result = await runPrepareMerge(
      createContext({
        cwd: repository.workDir,
        githubClient: github.client,
        gitClient: createGitClientFor(repository.workDir),
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(await countCommitsSinceBase(repository.workDir), 2);
    assert.deepEqual(await readCommitMessages(repository.workDir), [
      [
        'feat(issue): implement #6',
        '',
        'Add address-review workflow behavior.',
        '',
        'Refs: #6',
        'PRD: #1',
      ].join('\n'),
      [
        'feat(issue): implement #7',
        '',
        'Add fix-ci workflow behavior.',
        '',
        'Refs: #7',
        'PRD: #1',
      ].join('\n'),
    ]);
    assert.match(github.updatedBodies[0].body, /Closes #1/);
    assert.match(github.updatedBodies[0].body, /Status: Prepared for final review/);
  });

  it('03: rejects an invalid Commit Plan before rewriting branch history', async () => {
    const repository = await createTemporaryRepository({
      branchName: 'pullops/issue-42',
      changes: async workDir => {
        await writeFile(join(workDir, 'src/feature.js'), 'export const value = 42;\n');
        await writeFile(join(workDir, 'src/feature.test.js'), 'assert.equal(value, 42);\n');
      },
    });
    const originalHead = await gitOutput(repository.workDir, ['rev-parse', 'HEAD']);
    const github = createFakeGitHub({
      pullRequest: createPullRequest(),
      issue: createIssue(),
      reviewContext: createReviewContext(),
      diff: await createDiff(repository.workDir),
    });
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'planned',
        summary: 'This plan omits a changed file.',
        commitPlan: {
          commits: [
            {
              header: 'feat(issue): implement #42',
              body: ['Implement only part of the diff.'],
              footers: ['Refs: #42'],
              files: ['src/feature.js'],
            },
          ],
        },
        pullRequest: {
          summary: 'Incomplete summary.',
          changes: ['Updated the feature module.'],
          testPlan: ['Not run.'],
          traceability: ['Closes #42'],
        },
      }),
    });

    await assert.rejects(
      runPrepareMerge(
        createContext({
          cwd: repository.workDir,
          githubClient: github.client,
          gitClient: createGitClientFor(repository.workDir),
          codexRunner: codex.runner,
        }),
      ),
      /Invalid Commit Plan: Commit Plan does not assign every changed file: src\/feature\.test\.js/,
    );

    assert.equal(await gitOutput(repository.workDir, ['rev-parse', 'HEAD']), originalHead);
    assert.match(github.updatedBodies[0].body, /Status: Blocked/);
    assert.match(github.comments[0].body, /Invalid Commit Plan/);
  });
});

/**
 * @param {Partial<OperationRunnerContext>} overrides
 * @returns {OperationRunnerContext}
 */
function createContext(overrides = {}) {
  return {
    operation: 'prepare-merge',
    phase: 'run',
    runnerAdapter: 'codex-cli',
    target: {
      type: 'pr',
      number: 100,
    },
    cwd: '/workspace',
    config: DEFAULT_PULL_OPS_CONFIG,
    modelTier: 'high',
    model: 'gpt-5.5',
    githubClient: createFakeGitHub({
      pullRequest: createPullRequest(),
      issue: createIssue(),
      reviewContext: createReviewContext(),
      diff: { patch: '' },
    }).client,
    gitClient: createGitClientFor('/workspace'),
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
    title: 'Implement #42: Add prepare merge',
    url: 'https://github.com/acme/widgets/pull/100',
    headRefName: 'pullops/issue-42',
    baseRefName: 'main',
    body: createPullRequestBody(),
    isDraft: true,
    isCrossRepository: false,
    labels: ['pullops:pr:prepare-merge'],
    ...overrides,
  };
}

/**
 * @param {{ source?: string, traceability?: string, lastOperation?: string }} [options]
 * @returns {string}
 */
function createPullRequestBody({
  source = 'Source: Issue #42',
  traceability = 'Closes #42',
  lastOperation = 'Last operation: pullops:pr:review',
} = {}) {
  return [
    '## Summary',
    '',
    'First-pass implementation summary.',
    '',
    '## Changes',
    '',
    '- First-pass change.',
    '',
    '## Test Plan',
    '',
    '- npm test',
    '',
    '## Traceability',
    '',
    traceability,
    '',
    '## PullOps',
    '',
    'Managed PR: yes',
    'Status: Review approved',
    'Review cycles: 1 / 3',
    'CI fix cycles: 0 / 2',
    source,
    'Branch: pullops/issue-42',
    lastOperation,
  ].join('\n');
}

/**
 * @param {Partial<GitHubIssue>} [overrides]
 * @returns {GitHubIssue}
 */
function createIssue(overrides = {}) {
  return {
    number: 42,
    title: 'Add prepare merge',
    body: '## What to build\n\nPrepare a PR for merge.',
    state: 'OPEN',
    url: 'https://github.com/acme/widgets/issues/42',
    authorLogin: 'maintainer',
    labels: [],
    parent: null,
    subIssues: [],
    ...overrides,
  };
}

/**
 * @returns {GitHubPullRequestReviewContext}
 */
function createReviewContext() {
  return {
    comments: [],
    reviews: [],
    unresolvedThreads: [],
    files: [
      {
        path: 'src/feature.js',
        additions: 1,
        deletions: 1,
      },
    ],
  };
}

/**
 * @param {object} options
 * @param {GitHubPullRequest} options.pullRequest
 * @param {GitHubIssue} options.issue
 * @param {GitHubPullRequestReviewContext} options.reviewContext
 * @param {GitHubPullRequestDiff} options.diff
 * @returns {{
 *   updatedBodies: UpdatePullRequestBodyOptions[];
 *   pullRequestLabelsAdded: EditLabelsOptions[];
 *   pullRequestLabelsRemoved: EditLabelsOptions[];
 *   comments: CommentOnPullRequestOptions[];
 *   client: import('../../github/types.js').GitHubClient;
 * }}
 */
function createFakeGitHub({ pullRequest, issue, reviewContext, diff }) {
  /** @type {UpdatePullRequestBodyOptions[]} */
  const updatedBodies = [];
  /** @type {EditLabelsOptions[]} */
  const pullRequestLabelsAdded = [];
  /** @type {EditLabelsOptions[]} */
  const pullRequestLabelsRemoved = [];
  /** @type {CommentOnPullRequestOptions[]} */
  const comments = [];

  return {
    updatedBodies,
    pullRequestLabelsAdded,
    pullRequestLabelsRemoved,
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
        return pullRequest;
      },
      async getPullRequestChecks() {
        throw new Error('getPullRequestChecks was not expected in this test.');
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

/**
 * @param {string} cwd
 * @returns {import('../../git/types.js').GitClient}
 */
function createGitClientFor(cwd) {
  return createGitClient({
    execFile: async (file, args) => await execFile(file, args, { cwd }),
  });
}

/**
 * @param {object} options
 * @param {string} options.branchName
 * @param {(workDir: string) => Promise<void>} options.changes
 * @returns {Promise<{ root: string, originDir: string, workDir: string }>}
 */
async function createTemporaryRepository({ branchName, changes }) {
  const root = await mkdtemp(join(tmpdir(), 'pullops-prepare-merge-'));
  const originDir = join(root, 'origin.git');
  const workDir = join(root, 'work');

  await mkdir(originDir, { recursive: true });
  await mkdir(workDir, { recursive: true });
  await git(originDir, ['init', '--bare']);
  await git(workDir, ['init', '--initial-branch=main']);
  await git(workDir, ['config', 'user.name', 'Test User']);
  await git(workDir, ['config', 'user.email', 'test@example.com']);
  await mkdir(join(workDir, 'src'), { recursive: true });
  await writeFile(join(workDir, 'README.md'), '# Test\n');
  await writeFile(join(workDir, 'src/feature.js'), 'export const value = 1;\n');
  await writeFile(join(workDir, 'src/old.js'), 'export const old = true;\n');
  await git(workDir, ['add', '--all']);
  await git(workDir, ['commit', '-m', 'chore: initial commit']);
  await git(workDir, ['remote', 'add', 'origin', originDir]);
  await git(workDir, ['push', '-u', 'origin', 'main']);
  await git(workDir, ['checkout', '-b', branchName]);
  await changes(workDir);
  await git(workDir, ['add', '--all']);
  await git(workDir, ['commit', '-m', 'wip: noisy automation commit']);
  await git(workDir, ['push', '-u', 'origin', branchName]);

  return { root, originDir, workDir };
}

/**
 * @param {string} workDir
 * @returns {Promise<GitHubPullRequestDiff>}
 */
async function createDiff(workDir) {
  return {
    patch: await gitOutput(workDir, ['diff', 'origin/main...HEAD', '--patch']),
  };
}

/**
 * @param {string} workDir
 * @returns {Promise<number>}
 */
async function countCommitsSinceBase(workDir) {
  return Number(await gitOutput(workDir, ['rev-list', '--count', 'origin/main..HEAD']));
}

/**
 * @param {string} workDir
 * @returns {Promise<string[]>}
 */
async function readCommitMessages(workDir) {
  const stdout = await gitOutput(workDir, [
    'log',
    '--format=%B%x00',
    '--reverse',
    'origin/main..HEAD',
  ]);
  return stdout
    .split('\0')
    .map(message => message.trim())
    .filter(Boolean);
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<string>}
 */
async function gitOutput(cwd, args) {
  const result = await git(cwd, args);
  return result.stdout.trim();
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
async function git(cwd, args) {
  return await execFile('git', args, { cwd });
}
