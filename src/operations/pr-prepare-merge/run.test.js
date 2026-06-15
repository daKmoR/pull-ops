import assert from 'node:assert/strict';
import { execFile as nodeExecFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

import { DEFAULT_PULL_OPS_CONFIG } from '../../config/PullOpsConfig.js';
import { createGitClient } from '../../git/GitClient.js';
import {
  PULL_OPS_OPERATION_LABELS,
  PULL_OPS_STATUS_LABEL_NAMES,
} from '../../labels/pullOpsLabels.js';
import { runPrPrepareMerge } from './run.js';

const execFile = promisify(nodeExecFile);

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../../github/types.js').GitHubCheckRun} GitHubCheckRun
 * @typedef {import('../../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('../../github/types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('../../github/types.js').GitHubPullRequestReviewContext} GitHubPullRequestReviewContext
 * @typedef {import('../../github/types.js').UpdatePullRequestBodyOptions} UpdatePullRequestBodyOptions
 * @typedef {import('../../github/types.js').EditLabelsOptions} EditLabelsOptions
 * @typedef {import('../../github/types.js').CommentOnPullRequestOptions} CommentOnPullRequestOptions
 * @typedef {import('../../runner/types.js').CodexRunOptions} CodexRunOptions
 */

describe('runPrPrepareMerge', () => {
  it('01: rewrites a standalone Concrete Issue PR once, records prepared markers, waits, and then marks it ready', async () => {
    const repository = await createTemporaryRepository();
    const reviewedTree = await readTreeHash(repository.workDir);
    const reviewedHead = await readHeadSha(repository.workDir);
    const github = createFakeGitHub({
      pullRequest: createPullRequest({
        headSha: reviewedHead,
        body: createPullRequestBody({ reviewedTree }),
      }),
      reviewContext: createReviewContext({
        comments: [
          {
            body: 'A regular PR-level comment must not block prepare merge.',
            authorLogin: 'maintainer',
          },
        ],
      }),
      checksByRef: new Map([[reviewedHead, [createCheck({ name: 'test' })]]]),
    });

    const firstResult = await runPrPrepareMerge(
      createContext({
        cwd: repository.workDir,
        githubClient: github.client,
        gitClient: createGitClientFor(repository.workDir),
      }),
    );

    assert.equal(firstResult.status, 'accepted');
    assert.deepEqual(firstResult.prPrepareMerge, {
      waiting: true,
      stage: 'prepared-head',
      checkedRef: readMarker(github.updatedBodies[0].body, 'Prepared head:'),
      checks: 0,
    });
    assert.equal(await countCommitsSinceBase(repository.workDir), 1);
    assert.equal(await readTreeHash(repository.workDir), reviewedTree);
    assert.deepEqual(await readCommitMessages(repository.workDir), [
      [
        'feat(issue): implement #42',
        '',
        'Prepare standalone Concrete Issue #42 for rebase merge.',
        '',
        'Closes #42',
      ].join('\n'),
    ]);

    const preparedBody = github.updatedBodies[0].body;
    const preparedHead = readMarker(preparedBody, 'Prepared head:');
    assert.equal(readMarker(preparedBody, 'Prepared tree:'), reviewedTree);
    assert.equal(readMarker(preparedBody, 'Merge method:'), 'rebase');
    assert.match(preparedBody, /Status: Prepared for rebase merge/);
    assert.match(preparedBody, /Closes #42/);
    assert.equal(github.readyPullRequests.length, 0);
    assert.equal(github.comments.length, 0);
    assert.equal(github.pullRequestLabelsRemoved.length, 0);

    github.setPullRequest(
      createPullRequest({
        headSha: preparedHead,
        body: preparedBody,
      }),
    );
    github.setChecksForRef(preparedHead, [createCheck({ name: 'test' })]);

    const secondResult = await runPrPrepareMerge(
      createContext({
        cwd: repository.workDir,
        githubClient: github.client,
        gitClient: createGitClientFor(repository.workDir),
      }),
    );

    assert.equal(secondResult.status, 'accepted');
    assert.equal(await countCommitsSinceBase(repository.workDir), 1);
    assert.deepEqual(github.readyPullRequests, [100]);
    assert.deepEqual(github.pullRequestLabelsRemoved, [
      {
        number: 100,
        labels: [PULL_OPS_OPERATION_LABELS.prPrepareMerge, ...PULL_OPS_STATUS_LABEL_NAMES],
      },
    ]);
    assert.equal(github.pullRequestLabelsAdded.length, 0);
    assert.equal(github.comments.length, 0);
    assert.match(github.updatedBodies[1].body, /Status: Ready for human rebase merge/);
  });

  it('02: waits, routes, or blocks from reviewed-head check state before rewriting', async () => {
    const pending = await createReviewedScenario({
      checks: [createCheck({ state: 'in_progress', conclusion: undefined, bucket: undefined })],
    });

    const pendingResult = await runPrPrepareMerge(pending.context);

    assert.equal(pendingResult.status, 'accepted');
    assert.deepEqual(pendingResult.prPrepareMerge, {
      waiting: true,
      stage: 'reviewed-head',
      checkedRef: pending.reviewedHead,
      checks: 1,
    });
    assert.equal(await countCommitsSinceBase(pending.repository.workDir), 2);

    const failing = await createReviewedScenario({
      checks: [
        createCheck({
          name: 'test',
          conclusion: 'failure',
          bucket: 'fail',
        }),
      ],
    });

    const failingResult = await runPrPrepareMerge(failing.context);

    assert.equal(failingResult.status, 'accepted');
    assert.deepEqual(failing.github.pullRequestLabelsAdded, [
      {
        number: 100,
        labels: [PULL_OPS_OPERATION_LABELS.prFixCi],
      },
    ]);
    assert.match(failing.github.comments[0].body, /Reviewed-head checks failed/);
    assert.equal(await countCommitsSinceBase(failing.repository.workDir), 2);

    const absent = await createReviewedScenario({ checks: [] });

    const absentResult = await runPrPrepareMerge(absent.context);

    assert.equal(absentResult.status, 'blocked');
    assert.match(absent.github.comments[0].body, /no checks on reviewed head/);
    assert.equal(await countCommitsSinceBase(absent.repository.workDir), 2);
  });

  it('03: routes changed reviewed trees back to review while cycles remain and blocks when exhausted', async () => {
    const route = await createReviewedScenario({
      body: createPullRequestBody({
        reviewedTree: 'stale-reviewed-tree',
        reviewCycles: '1 / 3',
      }),
    });

    const routeResult = await runPrPrepareMerge(route.context);

    assert.equal(routeResult.status, 'accepted');
    assert.deepEqual(route.github.pullRequestLabelsAdded, [
      {
        number: 100,
        labels: [PULL_OPS_OPERATION_LABELS.prReview],
      },
    ]);
    assert.doesNotMatch(route.github.updatedBodies[0].body, /Reviewed tree:/);
    assert.match(route.github.comments[0].body, /tree changed after approval/);

    const block = await createReviewedScenario({
      body: createPullRequestBody({
        reviewedTree: 'stale-reviewed-tree',
        reviewCycles: '3 / 3',
      }),
    });

    const blockResult = await runPrPrepareMerge(block.context);

    assert.equal(blockResult.status, 'blocked');
    assert.match(block.github.comments[0].body, /Review Cycles are exhausted \(3 \/ 3\)/);
    assert.deepEqual(block.github.pullRequestLabelsAdded, [
      {
        number: 100,
        labels: ['pullops:status:blocked'],
      },
    ]);
  });

  it('04: blocks unresolved file review threads and unsuperseded requested-change reviews', async () => {
    const unresolvedThread = await createReviewedScenario({
      reviewContext: createReviewContext({
        unresolvedThreads: [
          {
            isResolved: false,
            comments: [
              {
                databaseId: 1,
                body: 'Please update this line.',
                authorLogin: 'reviewer',
                path: 'src/feature.js',
                line: 1,
              },
            ],
          },
        ],
      }),
    });

    const unresolvedResult = await runPrPrepareMerge(unresolvedThread.context);

    assert.equal(unresolvedResult.status, 'blocked');
    assert.match(unresolvedThread.github.comments[0].body, /unresolved file review thread/);
    assert.equal(await countCommitsSinceBase(unresolvedThread.repository.workDir), 2);

    const requestedChanges = await createReviewedScenario({
      reviewContext: createReviewContext({
        reviews: [
          {
            state: 'CHANGES_REQUESTED',
            body: 'Needs an explanation.',
            authorLogin: 'reviewer',
            submittedAt: '2026-06-14T10:00:00Z',
          },
          {
            state: 'APPROVED',
            body: 'The explanation is fine.',
            authorLogin: 'reviewer',
            submittedAt: '2026-06-14T10:05:00Z',
          },
          {
            state: 'CHANGES_REQUESTED',
            body: 'This reviewer is still waiting.',
            authorLogin: 'maintainer',
            submittedAt: '2026-06-14T10:10:00Z',
          },
        ],
      }),
    });

    const requestedChangesResult = await runPrPrepareMerge(requestedChanges.context);

    assert.equal(requestedChangesResult.status, 'blocked');
    assert.match(
      requestedChanges.github.comments[0].body,
      /requested-change review by @maintainer/,
    );
    assert.doesNotMatch(requestedChanges.github.comments[0].body, /@reviewer/);
  });

  it('05: refuses non-managed PRs and managed PRs without a reviewed tree', async () => {
    const nonManaged = await createReviewedScenario({
      body: '## Summary\n\nHuman PR.\n',
    });

    const nonManagedResult = await runPrPrepareMerge(nonManaged.context);

    assert.equal(nonManagedResult.status, 'refused');
    assert.match(String(nonManagedResult.summary), /not a PullOps-managed PR/);
    assert.equal(nonManaged.github.updatedBodies.length, 0);

    const missingReviewedTree = await createReviewedScenario({
      body: createPullRequestBody({ reviewedTree: null }),
    });

    const missingReviewedTreeResult = await runPrPrepareMerge(missingReviewedTree.context);

    assert.equal(missingReviewedTreeResult.status, 'refused');
    assert.match(String(missingReviewedTreeResult.summary), /Reviewed tree marker/);
    assert.match(missingReviewedTree.github.comments[0].body, /Reviewed tree marker/);
  });
});

/**
 * @param {Partial<OperationRunnerContext>} overrides
 * @returns {OperationRunnerContext}
 */
function createContext(overrides = {}) {
  return {
    operation: 'pr-prepare-merge',
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
    }).client,
    gitClient: createGitClientFor('/workspace'),
    codexRunner: createFakeCodexRunner().runner,
    ...overrides,
  };
}

/**
 * @param {object} options
 * @param {GitHubCheckRun[]} [options.checks]
 * @param {string} [options.body]
 * @param {GitHubPullRequestReviewContext} [options.reviewContext]
 * @returns {Promise<{
 *   repository: { root: string, originDir: string, workDir: string };
 *   reviewedTree: string;
 *   reviewedHead: string;
 *   github: ReturnType<typeof createFakeGitHub>;
 *   context: OperationRunnerContext;
 * }>}
 */
async function createReviewedScenario({ checks, body, reviewContext } = {}) {
  const repository = await createTemporaryRepository();
  const reviewedTree = await readTreeHash(repository.workDir);
  const reviewedHead = await readHeadSha(repository.workDir);
  const pullRequest = createPullRequest({
    headSha: reviewedHead,
    body: body ?? createPullRequestBody({ reviewedTree }),
  });
  const github = createFakeGitHub({
    pullRequest,
    reviewContext,
    checksByRef: new Map([[reviewedHead, checks ?? [createCheck({ name: 'test' })]]]),
  });

  return {
    repository,
    reviewedTree,
    reviewedHead,
    github,
    context: createContext({
      cwd: repository.workDir,
      githubClient: github.client,
      gitClient: createGitClientFor(repository.workDir),
    }),
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
    headSha: 'reviewed-head',
    baseRefName: 'main',
    body: createPullRequestBody(),
    isDraft: true,
    isCrossRepository: false,
    labels: [PULL_OPS_OPERATION_LABELS.prPrepareMerge],
    ...overrides,
  };
}

/**
 * @param {{ reviewedTree?: string | null, reviewCycles?: string }} [options]
 * @returns {string}
 */
function createPullRequestBody({ reviewedTree = 'reviewed-tree', reviewCycles = '1 / 3' } = {}) {
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
    'Closes #42',
    '',
    '## PullOps',
    '',
    'Managed PR: yes',
    'Status: Review approved',
    `Review cycles: ${reviewCycles}`,
    'CI fix cycles: 0 / 2',
    'Source: Issue #42',
    'Branch: pullops/issue-42',
    ...(reviewedTree === null ? [] : [`Reviewed tree: ${reviewedTree}`]),
    'Last operation: pullops:pr:review',
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
 * @param {object} [options]
 * @param {import('../../github/types.js').GitHubPullRequestComment[]} [options.comments]
 * @param {import('../../github/types.js').GitHubPullRequestReviewSummary[]} [options.reviews]
 * @param {import('../../github/types.js').GitHubPullRequestReviewThread[]} [options.unresolvedThreads]
 * @returns {GitHubPullRequestReviewContext}
 */
function createReviewContext({ comments = [], reviews = [], unresolvedThreads = [] } = {}) {
  return {
    comments,
    reviews,
    unresolvedThreads,
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
 * @param {Partial<GitHubCheckRun>} [overrides]
 * @returns {GitHubCheckRun}
 */
function createCheck(overrides = {}) {
  return {
    name: 'test',
    state: 'completed',
    conclusion: 'success',
    bucket: 'pass',
    ...overrides,
  };
}

/**
 * @param {object} options
 * @param {GitHubPullRequest} options.pullRequest
 * @param {GitHubPullRequestReviewContext} [options.reviewContext]
 * @param {Map<string, GitHubCheckRun[]>} [options.checksByRef]
 * @returns {{
 *   updatedBodies: UpdatePullRequestBodyOptions[];
 *   pullRequestLabelsAdded: EditLabelsOptions[];
 *   pullRequestLabelsRemoved: EditLabelsOptions[];
 *   comments: CommentOnPullRequestOptions[];
 *   readyPullRequests: number[];
 *   setPullRequest: (pullRequest: GitHubPullRequest) => void;
 *   setChecksForRef: (ref: string, checks: GitHubCheckRun[]) => void;
 *   client: import('../../github/types.js').GitHubClient;
 * }}
 */
function createFakeGitHub({
  pullRequest,
  reviewContext = createReviewContext(),
  checksByRef = new Map(),
}) {
  let currentPullRequest = pullRequest;
  const currentChecksByRef = new Map(checksByRef);
  /** @type {UpdatePullRequestBodyOptions[]} */
  const updatedBodies = [];
  /** @type {EditLabelsOptions[]} */
  const pullRequestLabelsAdded = [];
  /** @type {EditLabelsOptions[]} */
  const pullRequestLabelsRemoved = [];
  /** @type {CommentOnPullRequestOptions[]} */
  const comments = [];
  /** @type {number[]} */
  const readyPullRequests = [];

  return {
    updatedBodies,
    pullRequestLabelsAdded,
    pullRequestLabelsRemoved,
    comments,
    readyPullRequests,
    setPullRequest(nextPullRequest) {
      currentPullRequest = nextPullRequest;
    },
    setChecksForRef(ref, checks) {
      currentChecksByRef.set(ref, checks);
    },
    client: {
      async ensureLabels() {
        return {
          created: [],
          updated: [],
          alreadyCorrect: [],
        };
      },
      async getIssue() {
        return createIssue();
      },
      async getPullRequest() {
        return currentPullRequest;
      },
      async getPullRequestChecks() {
        throw new Error('getPullRequestChecks was not expected in this test.');
      },
      async getPullRequestChecksForRef(ref) {
        return currentChecksByRef.get(ref) ?? [];
      },
      async getPullRequestReviewContext() {
        return reviewContext;
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
      async markPullRequestReadyForReview(number) {
        readyPullRequests.push(number);
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
 * @returns {{ calls: CodexRunOptions[], runner: import('../../runner/types.js').CodexRunner }}
 */
function createFakeCodexRunner() {
  /** @type {CodexRunOptions[]} */
  const calls = [];

  return {
    calls,
    runner: {
      async run(options) {
        calls.push(options);
        throw new Error('codexRunner.run was not expected in this test.');
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
 * @returns {Promise<{ root: string, originDir: string, workDir: string }>}
 */
async function createTemporaryRepository() {
  const root = await mkdtemp(join(tmpdir(), 'pullops-pr-prepare-merge-'));
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
  await git(workDir, ['checkout', '-b', 'pullops/issue-42']);
  await writeFile(join(workDir, 'src/feature.js'), 'export const value = 42;\n');
  await git(workDir, ['add', '--all']);
  await git(workDir, ['commit', '-m', 'wip: update feature']);
  await writeFile(join(workDir, 'src/feature.test.js'), 'assert.equal(value, 42);\n');
  await git(workDir, ['rm', 'src/old.js']);
  await git(workDir, ['add', '--all']);
  await git(workDir, ['commit', '-m', 'wip: add coverage']);
  await git(workDir, ['push', '-u', 'origin', 'pullops/issue-42']);

  return { root, originDir, workDir };
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
 * @param {string} workDir
 * @returns {Promise<string>}
 */
async function readTreeHash(workDir) {
  return await gitOutput(workDir, ['rev-parse', 'HEAD^{tree}']);
}

/**
 * @param {string} workDir
 * @returns {Promise<string>}
 */
async function readHeadSha(workDir) {
  return await gitOutput(workDir, ['rev-parse', 'HEAD']);
}

/**
 * @param {string} body
 * @param {string} prefix
 * @returns {string}
 */
function readMarker(body, prefix) {
  const pattern = new RegExp(`^${escapeRegExp(prefix)}\\s*(.+?)\\s*$`, 'im');
  const value = body.match(pattern)?.[1]?.trim();
  assert.ok(value !== undefined, `Expected body to include ${prefix}`);
  return value;
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
