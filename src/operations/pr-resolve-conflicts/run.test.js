import assert from 'node:assert/strict';
import { execFile as nodeExecFile } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

import { DEFAULT_PULL_OPS_CONFIG } from '../../config/PullOpsConfig.js';
import { createGitClient } from '../../git/GitClient.js';
import {
  runPrResolveConflicts,
  runPrResolveConflictsCodexActionFinalize,
  runPrResolveConflictsCodexActionPrepare,
} from './run.js';

const execFile = promisify(nodeExecFile);

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('../../github/types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('../../github/types.js').UpdatePullRequestBodyOptions} UpdatePullRequestBodyOptions
 * @typedef {import('../../github/types.js').EditLabelsOptions} EditLabelsOptions
 * @typedef {import('../../github/types.js').CommentOnPullRequestOptions} CommentOnPullRequestOptions
 */

describe('runPrResolveConflicts', () => {
  it('01: resolves multiple real rebase conflict stops and returns the PR to review', async () => {
    const repository = await createTemporaryConflictRepository();
    const github = createFakeGitHub({
      pullRequest: createPullRequest({
        body: createManagedPullRequestBody(),
      }),
      issue: createIssue(),
    });
    const codex = createConflictResolvingCodexRunner(repository.workDir);

    const result = await runPrResolveConflicts(
      createContext({
        repository,
        githubClient: github.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.match(String(result.summary), /Resolved rebase conflicts/);
    assert.equal(codex.prompts.length, 2);
    assert.match(codex.prompts[0], /Conflict pass: 1 \/ 3/);
    assert.match(codex.prompts[1], /Conflict pass: 2 \/ 3/);
    assert.equal(
      await isAncestor(repository.workDir, 'origin/main', 'origin/pullops/issue-42'),
      true,
    );
    assert.equal(
      await gitOutput(repository.workDir, ['show', 'origin/pullops/issue-42:alpha.txt']),
      'base alpha\nfeature alpha',
    );
    assert.equal(
      await gitOutput(repository.workDir, ['show', 'origin/pullops/issue-42:beta.txt']),
      'base beta\nfeature beta',
    );
    assert.equal(await fileExists(join(repository.workDir, '.git', 'rebase-merge')), false);
    assert.equal(await fileExists(join(repository.workDir, '.git', 'rebase-apply')), false);
    assert.match(github.updatedBodies[0].body, /Status: Rebase conflicts resolved/);
    assert.match(github.updatedBodies[0].body, /Last operation: pullops:pr:resolve-conflicts/);
    assert.doesNotMatch(github.updatedBodies[0].body, /Reviewed tree:/);
    assert.deepEqual(github.pullRequestLabelsRemoved, [
      {
        number: 100,
        labels: ['pullops:pr:resolve-conflicts', 'pullops:pr:review', 'pullops:human-required'],
      },
    ]);
    assert.deepEqual(github.pullRequestLabelsAdded, [
      {
        number: 100,
        labels: ['pullops:pr:review'],
      },
    ]);
    assert.equal(github.comments.length, 1);
    assert.match(github.comments[0].body, /<summary>PullOps operation audit<\/summary>/);
    assert.match(github.comments[0].body, /Operation: pullops:pr:resolve-conflicts/);
  });

  it('02: blocks when the conflict resolution budget is exhausted', async () => {
    const repository = await createTemporaryConflictRepository();
    const github = createFakeGitHub({
      pullRequest: createPullRequest({
        body: createManagedPullRequestBody(),
      }),
      issue: createIssue(),
    });
    const codex = createConflictResolvingCodexRunner(repository.workDir);

    const result = await runPrResolveConflicts(
      createContext({
        repository,
        githubClient: github.client,
        codexRunner: codex.runner,
        config: createConfig({ maxConflictResolutionPasses: 1 }),
      }),
    );

    assert.equal(result.status, 'blocked');
    assert.match(String(result.summary), /Conflict resolution budget exhausted/);
    assert.equal(codex.prompts.length, 1);
    assert.equal(await fileExists(join(repository.workDir, '.git', 'rebase-merge')), true);
    assert.equal(
      await isAncestor(repository.workDir, 'origin/main', 'origin/pullops/issue-42'),
      false,
    );
    assert.match(github.updatedBodies[0].body, /Status: Human required/);
    assert.deepEqual(github.pullRequestLabelsAdded, [
      {
        number: 100,
        labels: ['pullops:human-required'],
      },
    ]);
    assert.match(github.comments[0].body, /<summary>PullOps operation audit<\/summary>/);
    assert.match(github.comments[1].body, /Remaining conflicted files: beta.txt/);
  });

  it('03: refuses fork PRs with a clear comment before touching git', async () => {
    const repository = await createTemporaryConflictRepository();
    const headBefore = await gitOutput(repository.workDir, [
      'rev-parse',
      'origin/pullops/issue-42',
    ]);
    const github = createFakeGitHub({
      pullRequest: createPullRequest({
        body: createManagedPullRequestBody(),
        isCrossRepository: true,
      }),
      issue: createIssue(),
    });

    const result = await runPrResolveConflicts(
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
    assert.match(github.comments[0].body, /same-repository PRs/);
  });

  it('04: prepares a waiting external runner handoff for the first conflict pass', async () => {
    const repository = await createTemporaryConflictRepository();
    const outputDirectory = await mkdirTemporaryDirectory('pullops-pr-resolve-external-');
    const github = createFakeGitHub({
      pullRequest: createPullRequest({
        body: createManagedPullRequestBody(),
      }),
      issue: createIssue(),
    });

    const result = await runPrResolveConflictsCodexActionPrepare(
      createContext({
        repository,
        githubClient: github.client,
        outputDirectory,
        phase: 'prepare',
        runnerAdapter: 'external',
      }),
    );

    assert.equal(result.status, 'waiting');
    assert.match(String(result.summary), /Prepared external conflict resolution/);
    assert.deepEqual(result.prResolveConflicts, {
      baseBranch: 'main',
      branchName: 'pullops/issue-42',
      conflictPass: 1,
      maxConflictResolutionPasses: 3,
      conflictedFiles: ['alpha.txt'],
    });

    const prompt = await readFile(join(outputDirectory, 'runner_prompt.md'), 'utf8');
    assert.match(prompt, /Write the final Operation Output JSON to .*runner_output\.json/);
    assert.match(prompt, /Use the pullops-resolve-conflicts skill/);
    assert.match(prompt, /Conflict pass: 1 \/ 3/);

    const runnerJob = assertObject(
      result.runnerJob,
      'Expected the prepared pr-resolve-conflicts result to include a runnerJob payload.',
    );
    assert.equal(Reflect.get(runnerJob, 'cwd'), repository.workDir);
    assert.equal(Reflect.get(runnerJob, 'promptFile'), join(outputDirectory, 'runner_prompt.md'));
    assert.equal(Reflect.get(runnerJob, 'outputFile'), join(outputDirectory, 'runner_output.json'));
    assert.equal(Reflect.get(runnerJob, 'resultFile'), join(outputDirectory, 'runner_result.json'));
    assert.equal(Reflect.get(runnerJob, 'model'), DEFAULT_PULL_OPS_CONFIG.runner.models.high);
    assert.equal(Reflect.get(runnerJob, 'branch'), 'pullops/issue-42');
    assert.equal(Reflect.get(runnerJob, 'workerPrompt'), prompt);
    assert.deepEqual(Reflect.get(runnerJob, 'completeCommand'), {
      argv: [
        'npm',
        'exec',
        '--',
        'pullops',
        'run',
        'pr-resolve-conflicts',
        '--runner',
        'external',
        '--phase',
        'complete',
        '--pr',
        '100',
      ],
      env: {
        npm_config_cache: '/tmp/pullops-npm-cache',
        OUTPUT_DIR: outputDirectory,
      },
    });
  });

  it('05: external complete can hand off a later conflict pass as a waiting runner job', async () => {
    const repository = await createTemporaryConflictRepository();
    const outputDirectory = await mkdirTemporaryDirectory('pullops-pr-resolve-pass-');
    const github = createFakeGitHub({
      pullRequest: createPullRequest({
        body: createManagedPullRequestBody(),
      }),
      issue: createIssue(),
    });

    await runPrResolveConflictsCodexActionPrepare(
      createContext({
        repository,
        githubClient: github.client,
        outputDirectory,
        phase: 'prepare',
        runnerAdapter: 'external',
      }),
    );
    await writeFile(join(repository.workDir, 'alpha.txt'), 'base alpha\nfeature alpha\n');
    await writeFile(
      join(outputDirectory, 'runner_result.json'),
      JSON.stringify({
        schemaVersion: 1,
        status: 'success',
      }),
    );
    await writeFile(
      join(outputDirectory, 'runner_output.json'),
      JSON.stringify({
        status: 'resolved',
        summary: 'Resolved alpha.txt.',
        resolvedFiles: ['alpha.txt'],
        changes: ['Resolved alpha.txt.'],
        testPlan: ['Not run; temporary test repository has no project checks.'],
      }),
    );

    const result = await runPrResolveConflictsCodexActionFinalize(
      createContext({
        repository,
        githubClient: github.client,
        outputDirectory,
        phase: 'complete',
        runnerAdapter: 'external',
      }),
    );

    assert.equal(result.status, 'waiting');
    assert.match(String(result.summary), /pass 2/);
    assert.deepEqual(result.prResolveConflicts, {
      baseBranch: 'main',
      branchName: 'pullops/issue-42',
      conflictPass: 2,
      maxConflictResolutionPasses: 3,
      conflictedFiles: ['beta.txt'],
    });
    assert.equal(github.updatedBodies.length, 0);
    assert.equal(github.pullRequestLabelsAdded.length, 0);
    assert.equal(github.comments.length, 1);
    assert.match(github.comments[0].body, /Operation: pullops:pr:resolve-conflicts/);

    const prompt = await readFile(join(outputDirectory, 'runner_prompt.md'), 'utf8');
    assert.match(prompt, /Conflict pass: 2 \/ 3/);
    const runnerJob = assertObject(
      result.runnerJob,
      'Expected the later conflict pass result to include a runnerJob payload.',
    );
    assert.equal(Reflect.get(runnerJob, 'promptFile'), join(outputDirectory, 'runner_prompt.md'));
    assert.equal(Reflect.get(runnerJob, 'outputFile'), join(outputDirectory, 'runner_output.json'));
    assert.equal(Reflect.get(runnerJob, 'resultFile'), join(outputDirectory, 'runner_result.json'));
    assert.equal(Reflect.get(runnerJob, 'workerPrompt'), prompt);
  });

  it('06: treats skipped external completion as a no-op after prepare needed no worker', async () => {
    const repository = await createTemporaryCleanRebaseRepository();
    const outputDirectory = await mkdirTemporaryDirectory('pullops-pr-resolve-skipped-');
    const github = createFakeGitHub({
      pullRequest: createPullRequest({
        body: createManagedPullRequestBody(),
      }),
      issue: createIssue(),
    });

    const prepareResult = await runPrResolveConflictsCodexActionPrepare(
      createContext({
        repository,
        githubClient: github.client,
        outputDirectory,
        phase: 'prepare',
        runnerAdapter: 'external',
      }),
    );
    assert.equal(prepareResult.status, 'accepted');
    assert.equal(prepareResult.runnerJob, undefined);
    assert.equal(await fileExists(join(outputDirectory, 'runner_prompt.md')), false);

    const bodyUpdatesAfterPrepare = github.updatedBodies.length;
    const labelsAddedAfterPrepare = github.pullRequestLabelsAdded.length;
    const labelsRemovedAfterPrepare = github.pullRequestLabelsRemoved.length;
    const commentsAfterPrepare = github.comments.length;
    await writeFile(
      join(outputDirectory, 'runner_result.json'),
      JSON.stringify({
        schemaVersion: 1,
        status: 'skipped',
      }),
    );

    const result = await runPrResolveConflictsCodexActionFinalize(
      createContext({
        repository,
        githubClient: github.client,
        outputDirectory,
        phase: 'complete',
        runnerAdapter: 'external',
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.match(String(result.summary), /prepare did not request a runner step/);
    assert.deepEqual(result.runner, {
      adapter: 'external',
      status: 'skipped',
    });
    assert.equal(github.updatedBodies.length, bodyUpdatesAfterPrepare);
    assert.equal(github.pullRequestLabelsAdded.length, labelsAddedAfterPrepare);
    assert.equal(github.pullRequestLabelsRemoved.length, labelsRemovedAfterPrepare);
    assert.equal(github.comments.length, commentsAfterPrepare);
  });

  it('07: records a failed external runner before failing complete', async () => {
    const repository = await createTemporaryConflictRepository();
    const outputDirectory = await mkdirTemporaryDirectory('pullops-pr-resolve-failed-');
    await writeFile(
      join(outputDirectory, 'runner_result.json'),
      JSON.stringify({
        schemaVersion: 1,
        status: 'failed',
      }),
    );
    const github = createFakeGitHub({
      pullRequest: createPullRequest({
        body: createManagedPullRequestBody(),
      }),
      issue: createIssue(),
    });

    await assert.rejects(
      runPrResolveConflictsCodexActionFinalize(
        createContext({
          repository,
          githubClient: github.client,
          outputDirectory,
          phase: 'complete',
          runnerAdapter: 'external',
        }),
      ),
      /External runner completed with status "failed"/,
    );

    assert.match(github.updatedBodies[0].body, /Status: Human required/);
    assert.deepEqual(github.pullRequestLabelsAdded.at(-1), {
      number: 100,
      labels: ['pullops:human-required'],
    });
    assert.match(github.comments[0].body, /External runner completed with status "failed"/);
    assert.equal(
      await readFile(join(outputDirectory, 'failure_reason.txt'), 'utf8'),
      'External runner completed with status "failed".\n',
    );
  });

  it('08: records a cancelled external runner before failing complete', async () => {
    const repository = await createTemporaryConflictRepository();
    const outputDirectory = await mkdirTemporaryDirectory('pullops-pr-resolve-cancelled-');
    await writeFile(
      join(outputDirectory, 'runner_result.json'),
      JSON.stringify({
        schemaVersion: 1,
        status: 'cancelled',
      }),
    );
    const github = createFakeGitHub({
      pullRequest: createPullRequest({
        body: createManagedPullRequestBody(),
      }),
      issue: createIssue(),
    });

    await assert.rejects(
      runPrResolveConflictsCodexActionFinalize(
        createContext({
          repository,
          githubClient: github.client,
          outputDirectory,
          phase: 'complete',
          runnerAdapter: 'external',
        }),
      ),
      /External runner completed with status "cancelled"/,
    );

    assert.match(github.updatedBodies[0].body, /Status: Human required/);
    assert.deepEqual(github.pullRequestLabelsAdded.at(-1), {
      number: 100,
      labels: ['pullops:human-required'],
    });
    assert.match(github.comments[0].body, /External runner completed with status "cancelled"/);
    assert.equal(
      await readFile(join(outputDirectory, 'failure_reason.txt'), 'utf8'),
      'External runner completed with status "cancelled".\n',
    );
  });
});

/**
 * @param {unknown} value
 * @param {string} message
 * @returns {object}
 */
function assertObject(value, message) {
  if (typeof value !== 'object' || value === null) {
    assert.fail(message);
  }
  return value;
}

/**
 * @param {object} options
 * @param {{ root: string, originDir: string, seedDir: string, workDir: string }} options.repository
 * @param {import('../../github/types.js').GitHubClient} options.githubClient
 * @param {import('../../runner/types.js').CodexRunner} [options.codexRunner]
 * @param {import('../../config/types.js').PullOpsConfig} [options.config]
 * @param {string} [options.outputDirectory]
 * @param {import('../../cli/types.js').OperationPhase} [options.phase]
 * @param {import('../../runner/types.js').RunnerAdapter} [options.runnerAdapter]
 * @returns {OperationRunnerContext}
 */
function createContext({
  repository,
  githubClient,
  codexRunner = createUnexpectedCodexRunner(),
  config = DEFAULT_PULL_OPS_CONFIG,
  outputDirectory,
  phase = 'run',
  runnerAdapter = 'codex-cli',
}) {
  return {
    operation: 'pr-resolve-conflicts',
    phase,
    runnerAdapter,
    target: {
      type: 'pr',
      number: 100,
    },
    cwd: repository.workDir,
    config,
    modelTier: 'high',
    model: config.runner.models.high,
    githubClient,
    gitClient: createGitClientFor(repository.workDir),
    codexRunner,
    ...(outputDirectory === undefined ? {} : { outputDirectory }),
  };
}

/**
 * @param {{ maxConflictResolutionPasses: number }} options
 * @returns {import('../../config/types.js').PullOpsConfig}
 */
function createConfig({ maxConflictResolutionPasses }) {
  const config = structuredClone(DEFAULT_PULL_OPS_CONFIG);
  config.operations.prResolveConflicts.maxConflictResolutionPasses = maxConflictResolutionPasses;
  return config;
}

/**
 * @param {object} options
 * @param {GitHubPullRequest} options.pullRequest
 * @param {GitHubIssue} options.issue
 * @returns {{
 *   updatedBodies: UpdatePullRequestBodyOptions[];
 *   pullRequestLabelsAdded: EditLabelsOptions[];
 *   pullRequestLabelsRemoved: EditLabelsOptions[];
 *   comments: CommentOnPullRequestOptions[];
 *   client: import('../../github/types.js').GitHubClient;
 * }}
 */
function createFakeGitHub({ pullRequest, issue }) {
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
    title: 'Resolve conflicts',
    url: 'https://github.com/acme/widgets/pull/100',
    headRefName: 'pullops/issue-42',
    baseRefName: 'main',
    body: 'Human-authored PR.',
    isDraft: true,
    isCrossRepository: false,
    labels: ['pullops:pr:resolve-conflicts'],
    ...overrides,
  };
}

/**
 * @returns {GitHubIssue}
 */
function createIssue() {
  return {
    number: 42,
    title: 'Implement conflict-prone feature',
    body: 'Keep the feature behavior while updating from main.',
    state: 'OPEN',
    url: 'https://github.com/acme/widgets/issues/42',
    authorLogin: 'octocat',
    labels: [],
    parent: null,
    subIssues: [],
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
    'Status: Rebase conflicts',
    '',
    '<details>',
    '<summary>PullOps workflow state</summary>',
    '',
    'Source: Issue #42',
    'Review cycles: 1 / 3',
    'Reviewed tree: stale-reviewed-tree',
    'Last operation: pullops:pr:update-branch',
    '',
    '</details>',
  ].join('\n');
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
 * @param {string} cwd
 * @returns {{ prompts: string[], runner: import('../../runner/types.js').CodexRunner }}
 */
function createConflictResolvingCodexRunner(cwd) {
  /** @type {string[]} */
  const prompts = [];

  return {
    prompts,
    runner: {
      async run({ prompt }) {
        prompts.push(prompt);
        const conflictedFiles = (await gitOutput(cwd, ['diff', '--name-only', '--diff-filter=U']))
          .split('\n')
          .filter(Boolean);

        for (const file of conflictedFiles) {
          await resolveFile(cwd, file);
        }

        return JSON.stringify({
          status: 'resolved',
          summary: `Resolved ${conflictedFiles.join(', ')}.`,
          resolvedFiles: conflictedFiles,
          changes: conflictedFiles.map(file => `Resolved ${file}.`),
          testPlan: ['Not run; temporary test repository has no project checks.'],
          followUps: [],
        });
      },
    },
  };
}

/**
 * @returns {import('../../runner/types.js').CodexRunner}
 */
function createUnexpectedCodexRunner() {
  return {
    async run() {
      throw new Error('codexRunner.run was not expected in this test.');
    },
  };
}

/**
 * @param {string} cwd
 * @param {string} file
 * @returns {Promise<void>}
 */
async function resolveFile(cwd, file) {
  if (file === 'alpha.txt') {
    await writeFile(join(cwd, file), 'base alpha\nfeature alpha\n');
    return;
  }

  if (file === 'beta.txt') {
    await writeFile(join(cwd, file), 'base beta\nfeature beta\n');
    return;
  }

  throw new Error(`Unexpected conflicted file ${file}.`);
}

/**
 * @returns {Promise<{ root: string, originDir: string, seedDir: string, workDir: string }>}
 */
async function createTemporaryConflictRepository() {
  const root = await mkdirTemporaryDirectory('pullops-pr-resolve-conflicts-');
  const originDir = join(root, 'origin.git');
  const seedDir = join(root, 'seed');
  const workDir = join(root, 'work');

  await mkdir(originDir, { recursive: true });
  await mkdir(seedDir, { recursive: true });
  await git(originDir, ['init', '--bare']);
  await git(seedDir, ['init', '--initial-branch=main']);
  await configureUser(seedDir);
  await writeFile(join(seedDir, 'alpha.txt'), 'initial alpha\n');
  await writeFile(join(seedDir, 'beta.txt'), 'initial beta\n');
  await git(seedDir, ['add', '--all']);
  await git(seedDir, ['commit', '-m', 'chore: initial commit']);
  await git(seedDir, ['remote', 'add', 'origin', originDir]);
  await git(seedDir, ['push', '-u', 'origin', 'main']);

  await git(seedDir, ['checkout', '-b', 'pullops/issue-42']);
  await writeFile(join(seedDir, 'alpha.txt'), 'feature alpha\n');
  await git(seedDir, ['add', '--all']);
  await git(seedDir, ['commit', '-m', 'feat: update alpha']);
  await writeFile(join(seedDir, 'beta.txt'), 'feature beta\n');
  await git(seedDir, ['add', '--all']);
  await git(seedDir, ['commit', '-m', 'feat: update beta']);
  await git(seedDir, ['push', '-u', 'origin', 'pullops/issue-42']);

  await git(seedDir, ['checkout', 'main']);
  await writeFile(join(seedDir, 'alpha.txt'), 'base alpha\n');
  await writeFile(join(seedDir, 'beta.txt'), 'base beta\n');
  await git(seedDir, ['add', '--all']);
  await git(seedDir, ['commit', '-m', 'chore: update base files']);
  await git(seedDir, ['push', 'origin', 'main']);

  await git(root, ['clone', originDir, workDir]);
  await configureUser(workDir);
  await git(workDir, ['checkout', 'pullops/issue-42']);

  return { root, originDir, seedDir, workDir };
}

/**
 * @returns {Promise<{ root: string, originDir: string, seedDir: string, workDir: string }>}
 */
async function createTemporaryCleanRebaseRepository() {
  const root = await mkdirTemporaryDirectory('pullops-pr-resolve-clean-');
  const originDir = join(root, 'origin.git');
  const seedDir = join(root, 'seed');
  const workDir = join(root, 'work');

  await mkdir(originDir, { recursive: true });
  await mkdir(seedDir, { recursive: true });
  await git(originDir, ['init', '--bare']);
  await git(seedDir, ['init', '--initial-branch=main']);
  await configureUser(seedDir);
  await writeFile(join(seedDir, 'alpha.txt'), 'initial alpha\n');
  await writeFile(join(seedDir, 'beta.txt'), 'initial beta\n');
  await git(seedDir, ['add', '--all']);
  await git(seedDir, ['commit', '-m', 'chore: initial commit']);
  await git(seedDir, ['remote', 'add', 'origin', originDir]);
  await git(seedDir, ['push', '-u', 'origin', 'main']);

  await git(seedDir, ['checkout', '-b', 'pullops/issue-42']);
  await writeFile(join(seedDir, 'alpha.txt'), 'feature alpha\n');
  await git(seedDir, ['add', '--all']);
  await git(seedDir, ['commit', '-m', 'feat: update alpha']);
  await git(seedDir, ['push', '-u', 'origin', 'pullops/issue-42']);

  await git(seedDir, ['checkout', 'main']);
  await writeFile(join(seedDir, 'beta.txt'), 'base beta\n');
  await git(seedDir, ['add', '--all']);
  await git(seedDir, ['commit', '-m', 'chore: update beta']);
  await git(seedDir, ['push', 'origin', 'main']);

  await git(root, ['clone', originDir, workDir]);
  await configureUser(workDir);
  await git(workDir, ['checkout', 'pullops/issue-42']);

  return { root, originDir, seedDir, workDir };
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
