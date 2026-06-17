import assert from 'node:assert/strict';
import { execFile as nodeExecFile } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

import { DEFAULT_PULL_OPS_CONFIG } from '../../config/PullOpsConfig.js';
import { createGitClient } from '../../git/GitClient.js';
import { runPrUpdateBranch } from './run.js';

const execFile = promisify(nodeExecFile);

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../../github/types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('../../github/types.js').UpdatePullRequestBodyOptions} UpdatePullRequestBodyOptions
 * @typedef {import('../../github/types.js').EditLabelsOptions} EditLabelsOptions
 * @typedef {import('../../github/types.js').CommentOnPullRequestOptions} CommentOnPullRequestOptions
 */

describe('runPrUpdateBranch', () => {
  it('01: rebases a same-repository PR branch onto its base without requesting review', async () => {
    const repository = await createTemporaryBranchRepository({ conflict: false });
    const github = createFakeGitHub({
      pullRequest: createPullRequest({
        body: createManagedPullRequestBody(),
      }),
    });

    const result = await runPrUpdateBranch(
      createContext({
        repository,
        githubClient: github.client,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.match(String(result.summary), /Updated PR #100 branch/);
    assert.equal(
      await isAncestor(repository.workDir, 'origin/main', 'origin/pullops/issue-42'),
      true,
    );
    assert.deepEqual(await readRemoteCommitSubjects(repository.workDir, 'pullops/issue-42', 2), [
      'feat: add feature file',
      'chore: update base file',
    ]);
    assert.match(github.updatedBodies[0].body, /Status: Branch updated/);
    assert.match(github.updatedBodies[0].body, /Last operation: pullops:pr:update-branch/);
    assert.doesNotMatch(github.updatedBodies[0].body, /Reviewed tree:/);
    assert.doesNotMatch(github.updatedBodies[0].body, /Finalized tree:/);
    assert.doesNotMatch(github.updatedBodies[0].body, /Finalized head:/);
    assert.doesNotMatch(github.updatedBodies[0].body, /Merge method:/);
    assert.deepEqual(github.pullRequestLabelsRemoved, [
      {
        number: 100,
        labels: [
          'pullops:pr:update-branch',
          'pullops:human-required',
          'pullops:status:in-progress',
          'pullops:status:blocked',
          'pullops:status:prepared',
          'pullops:status:done',
          'pullops:status:failed',
        ],
      },
    ]);
    assert.deepEqual(github.pullRequestLabelsAdded, []);
    assert.equal(github.comments.length, 0);
  });

  it('02: blocks stale leases without overwriting concurrent branch advancement', async () => {
    const repository = await createTemporaryBranchRepository({ conflict: false });
    let advanced = false;
    const gitClient = createGitClientFor(repository.workDir, {
      beforeForceWithLeasePush: async () => {
        if (advanced) {
          return;
        }

        advanced = true;
        await advanceRemoteBranch(repository);
      },
    });
    const github = createFakeGitHub({
      pullRequest: createPullRequest({
        body: createManagedPullRequestBody(),
      }),
    });

    const result = await runPrUpdateBranch(
      createContext({
        repository,
        githubClient: github.client,
        gitClient,
      }),
    );

    assert.equal(result.status, 'blocked');
    assert.match(String(result.summary), /Concurrent branch advancement/);
    assert.deepEqual(await readRemoteCommitSubjects(repository.workDir, 'pullops/issue-42', 1), [
      'chore: concurrent branch update',
    ]);
    assert.match(github.updatedBodies[0].body, /Status: Human required/);
    assert.deepEqual(github.pullRequestLabelsAdded, [
      {
        number: 100,
        labels: ['pullops:human-required'],
      },
    ]);
    assert.match(github.comments[0].body, /force-with-lease push was rejected/);
  });

  it('03: aborts rebase conflicts and hands off to pr-resolve-conflicts', async () => {
    const repository = await createTemporaryBranchRepository({ conflict: true });
    const github = createFakeGitHub({
      pullRequest: createPullRequest({
        body: createManagedPullRequestBody(),
      }),
    });

    const result = await runPrUpdateBranch(
      createContext({
        repository,
        githubClient: github.client,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.match(String(result.summary), /produced conflicts/);
    assert.equal(await gitOutput(repository.workDir, ['status', '--porcelain']), '');
    assert.equal(await fileExists(join(repository.workDir, '.git', 'rebase-merge')), false);
    assert.equal(await fileExists(join(repository.workDir, '.git', 'rebase-apply')), false);
    assert.deepEqual(await readRemoteCommitSubjects(repository.workDir, 'pullops/issue-42', 1), [
      'feat: change shared file on feature',
    ]);
    assert.match(github.updatedBodies[0].body, /Status: Rebase conflicts/);
    assert.deepEqual(github.pullRequestLabelsAdded, [
      {
        number: 100,
        labels: ['pullops:pr:resolve-conflicts'],
      },
    ]);
    assert.match(github.comments[0].body, /Conflicted files: shared.txt/);
  });

  it('04: refuses fork PRs with a clear comment without touching git', async () => {
    const repository = await createTemporaryBranchRepository({ conflict: false });
    const headBefore = await gitOutput(repository.workDir, [
      'rev-parse',
      'origin/pullops/issue-42',
    ]);
    const github = createFakeGitHub({
      pullRequest: createPullRequest({
        body: createManagedPullRequestBody(),
        isCrossRepository: true,
      }),
    });

    const result = await runPrUpdateBranch(
      createContext({
        repository,
        githubClient: github.client,
      }),
    );

    const headAfter = await gitOutput(repository.workDir, ['rev-parse', 'origin/pullops/issue-42']);
    assert.equal(result.status, 'refused');
    assert.match(String(result.summary), /comes from a fork/);
    assert.equal(headAfter, headBefore);
    assert.match(github.updatedBodies[0].body, /Status: Human required/);
    assert.deepEqual(github.pullRequestLabelsAdded, [
      {
        number: 100,
        labels: ['pullops:human-required'],
      },
    ]);
    assert.match(github.comments[0].body, /same-repository PR branches/);
  });
});

/**
 * @param {object} options
 * @param {{ root: string, originDir: string, seedDir: string, workDir: string }} options.repository
 * @param {import('../../github/types.js').GitHubClient} options.githubClient
 * @param {import('../../git/types.js').GitClient} [options.gitClient]
 * @returns {OperationRunnerContext}
 */
function createContext({
  repository,
  githubClient,
  gitClient = createGitClientFor(repository.workDir),
}) {
  return {
    operation: 'pr-update-branch',
    phase: 'run',
    runnerAdapter: 'codex-cli',
    target: {
      type: 'pr',
      number: 100,
    },
    cwd: repository.workDir,
    config: DEFAULT_PULL_OPS_CONFIG,
    modelTier: 'low',
    model: DEFAULT_PULL_OPS_CONFIG.runner.models.low,
    githubClient,
    gitClient,
    codexRunner: {
      async run() {
        throw new Error('codexRunner.run was not expected in this test.');
      },
    },
  };
}

/**
 * @param {object} options
 * @param {GitHubPullRequest} options.pullRequest
 * @returns {{
 *   updatedBodies: UpdatePullRequestBodyOptions[];
 *   pullRequestLabelsAdded: EditLabelsOptions[];
 *   pullRequestLabelsRemoved: EditLabelsOptions[];
 *   comments: CommentOnPullRequestOptions[];
 *   client: import('../../github/types.js').GitHubClient;
 * }}
 */
function createFakeGitHub({ pullRequest }) {
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
        throw new Error('getIssue was not expected in this test.');
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
 * @param {Partial<GitHubPullRequest>} [overrides]
 * @returns {GitHubPullRequest}
 */
function createPullRequest(overrides = {}) {
  return {
    number: 100,
    title: 'Update branch',
    url: 'https://github.com/acme/widgets/pull/100',
    headRefName: 'pullops/issue-42',
    baseRefName: 'main',
    body: 'Human-authored PR.',
    isDraft: true,
    isCrossRepository: false,
    labels: ['pullops:pr:update-branch'],
    ...overrides,
  };
}

/**
 * @returns {string}
 */
function createManagedPullRequestBody() {
  return [
    '## PullOps',
    '',
    'Managed: yes',
    'Status: Review approved',
    '',
    '<details>',
    '<summary>PullOps workflow state</summary>',
    '',
    'Source: Issue #42',
    'Review cycles: 1 / 3',
    'Reviewed tree: stale-reviewed-tree',
    'Finalized tree: stale-finalized-tree',
    'Finalized head: stale-finalized-head',
    'Merge method: rebase',
    'Last operation: pullops:pr:review',
    '',
    '</details>',
  ].join('\n');
}

/**
 * @param {string} cwd
 * @param {{ beforeForceWithLeasePush?: () => Promise<void> }} [options]
 * @returns {import('../../git/types.js').GitClient}
 */
function createGitClientFor(cwd, { beforeForceWithLeasePush } = {}) {
  return createGitClient({
    execFile: async (file, args) => {
      if (args[0] === 'push' && args[1] === '--force-with-lease') {
        await beforeForceWithLeasePush?.();
      }

      return await execFile(file, args, { cwd });
    },
  });
}

/**
 * @param {{ conflict: boolean }} options
 * @returns {Promise<{ root: string, originDir: string, seedDir: string, workDir: string }>}
 */
async function createTemporaryBranchRepository({ conflict }) {
  const root = await mkdirTemporaryDirectory('pullops-pr-update-branch-');
  const originDir = join(root, 'origin.git');
  const seedDir = join(root, 'seed');
  const workDir = join(root, 'work');

  await mkdir(originDir, { recursive: true });
  await mkdir(seedDir, { recursive: true });
  await git(originDir, ['init', '--bare']);
  await git(seedDir, ['init', '--initial-branch=main']);
  await configureUser(seedDir);
  await writeFile(join(seedDir, 'shared.txt'), 'initial\n');
  await git(seedDir, ['add', '--all']);
  await git(seedDir, ['commit', '-m', 'chore: initial commit']);
  await git(seedDir, ['remote', 'add', 'origin', originDir]);
  await git(seedDir, ['push', '-u', 'origin', 'main']);
  await git(seedDir, ['checkout', '-b', 'pullops/issue-42']);

  if (conflict) {
    await writeFile(join(seedDir, 'shared.txt'), 'feature\n');
    await git(seedDir, ['add', '--all']);
    await git(seedDir, ['commit', '-m', 'feat: change shared file on feature']);
  } else {
    await writeFile(join(seedDir, 'feature.txt'), 'feature\n');
    await git(seedDir, ['add', '--all']);
    await git(seedDir, ['commit', '-m', 'feat: add feature file']);
  }

  await git(seedDir, ['push', '-u', 'origin', 'pullops/issue-42']);
  await git(seedDir, ['checkout', 'main']);
  await writeFile(join(seedDir, 'shared.txt'), conflict ? 'base\n' : 'initial\nbase update\n');
  await git(seedDir, ['add', '--all']);
  await git(seedDir, ['commit', '-m', 'chore: update base file']);
  await git(seedDir, ['push', 'origin', 'main']);
  await git(root, ['clone', originDir, workDir]);
  await configureUser(workDir);
  await git(workDir, ['checkout', 'pullops/issue-42']);

  return { root, originDir, seedDir, workDir };
}

/**
 * @param {{ seedDir: string }} repository
 * @returns {Promise<void>}
 */
async function advanceRemoteBranch(repository) {
  await git(repository.seedDir, ['checkout', 'pullops/issue-42']);
  await writeFile(join(repository.seedDir, 'concurrent.txt'), 'concurrent\n');
  await git(repository.seedDir, ['add', '--all']);
  await git(repository.seedDir, ['commit', '-m', 'chore: concurrent branch update']);
  await git(repository.seedDir, ['push', 'origin', 'pullops/issue-42']);
}

/**
 * @param {string} cwd
 * @param {string} ancestor
 * @param {string} descendant
 * @returns {Promise<boolean>}
 */
async function isAncestor(cwd, ancestor, descendant) {
  await git(cwd, ['fetch', 'origin']);
  try {
    await git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} cwd
 * @param {string} branchName
 * @param {number} count
 * @returns {Promise<string[]>}
 */
async function readRemoteCommitSubjects(cwd, branchName, count) {
  await git(cwd, [
    'fetch',
    'origin',
    `+refs/heads/${branchName}:refs/remotes/origin/${branchName}`,
  ]);
  return (
    await gitOutput(cwd, ['log', `--max-count=${count}`, '--format=%s', `origin/${branchName}`])
  )
    .split('\n')
    .filter(Boolean);
}

/**
 * @param {string} cwd
 * @returns {Promise<void>}
 */
async function configureUser(cwd) {
  await git(cwd, ['config', 'user.name', 'Test User']);
  await git(cwd, ['config', 'user.email', 'test@example.com']);
}

/**
 * @param {string} prefix
 * @returns {Promise<string>}
 */
async function mkdirTemporaryDirectory(prefix) {
  const { mkdtemp } = await import('node:fs/promises');
  return await mkdtemp(join(tmpdir(), prefix));
}

/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
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
