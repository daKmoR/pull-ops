import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { DEFAULT_PULL_OPS_CONFIG } from '../../config/PullOpsConfig.js';
import {
  GITHUB_ACTIONS_BOT_AUTHOR,
  runPrFixCi,
  runPrFixCiCodexActionFinalize,
  runPrFixCiCodexActionPrepare,
} from './run.js';

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('../../github/types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('../../github/types.js').GitHubPullRequestReviewContext} GitHubPullRequestReviewContext
 * @typedef {import('../../github/types.js').GitHubPullRequestDiff} GitHubPullRequestDiff
 * @typedef {import('../../github/types.js').GitHubCheckRun} GitHubCheckRun
 * @typedef {import('../../github/types.js').UpdatePullRequestBodyOptions} UpdatePullRequestBodyOptions
 * @typedef {import('../../github/types.js').EditLabelsOptions} EditLabelsOptions
 * @typedef {import('../../github/types.js').CommentOnPullRequestOptions} CommentOnPullRequestOptions
 * @typedef {import('../../git/types.js').CommitAllOptions} CommitAllOptions
 * @typedef {import('../../git/types.js').PushBranchOptions} PushBranchOptions
 * @typedef {import('../../runner/types.js').CodexRunOptions} CodexRunOptions
 */

describe('runPrFixCi', () => {
  it('01: automatically fixes actionable checks on a managed draft PR and returns it to review', async () => {
    const github = createFakeGitHub({
      pullRequest: createPullRequest(),
      checks: [createFailedCheck({ name: 'ESLint lint' })],
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const git = createFakeGit({ hasChanges: true });
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'fixed',
        summary: 'Fixed the lint failure.',
        classifications: [
          {
            checkId: 'check-1',
            classification: 'lint',
            rationale: 'ESLint reported an unused variable.',
          },
        ],
        safetyChecks: {
          weakenedTests: false,
          deletedAssertions: false,
          bypassedChecks: false,
          secretOrInfrastructureWorkaround: false,
        },
        changes: ['Removed the unused variable.'],
        testPlan: ['npm run lint'],
      }),
    });

    const result = await runPrFixCi(
      createContext({
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(codex.calls.length, 1);
    assert.match(codex.calls[0].prompt, /Use the pullops-pr-fix-ci skill/);
    assert.match(codex.calls[0].prompt, /checkId `check-1`/);
    assert.match(codex.calls[0].prompt, /Classification: lint/);
    assert.deepEqual(git.commits, [
      {
        message: [
          'fix(ci): repair failures for PR #100',
          '',
          '- Removed the unused variable.',
          '',
          'Refs: #100',
        ].join('\n'),
        author: GITHUB_ACTIONS_BOT_AUTHOR,
      },
    ]);
    assert.deepEqual(git.pushes, [{ branchName: 'pullops/issue-42' }]);
    assert.match(github.updatedBodies[0].body, /Status: CI fixed/);
    assert.match(github.updatedBodies[0].body, /CI fix cycles: 1 \/ 2/);
    assert.match(github.updatedBodies[0].body, /Last operation: pullops:pr:fix-ci/);
    assert.equal(github.comments.length, 1);
    assert.match(github.comments[0].body, /<summary>PullOps operation audit<\/summary>/);
    assert.match(github.comments[0].body, /Operation: pullops:pr:fix-ci/);
    assert.deepEqual(github.pullRequestLabelsRemoved, [
      {
        number: 100,
        labels: ['pullops:pr:fix-ci', 'pullops:pr:review', 'pullops:human-required'],
      },
    ]);
    assert.deepEqual(github.pullRequestLabelsAdded, [
      {
        number: 100,
        labels: ['pullops:pr:review'],
      },
    ]);
    assert.deepEqual(result.prFixCi, {
      checks: {
        failed: 1,
        classifications: {
          lint: 1,
        },
      },
      changesCommitted: true,
    });
  });

  it('02: supports explicit manual pr-fix-ci on a non-managed same-repository PR', async () => {
    const github = createFakeGitHub({
      pullRequest: createPullRequest({
        body: 'Human-authored PR.',
        headRefName: 'human/fix-lint',
        isDraft: false,
        labels: ['pullops:pr:fix-ci'],
      }),
      checks: [createFailedCheck({ name: 'Prettier formatting' })],
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const git = createFakeGit({ hasChanges: true });
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'fixed',
        summary: 'Formatted the changed file.',
        classifications: [
          {
            checkId: 'check-1',
            classification: 'formatting',
            rationale: 'Prettier reported a formatting diff.',
          },
        ],
        safetyChecks: {
          weakenedTests: false,
          deletedAssertions: false,
          bypassedChecks: false,
          secretOrInfrastructureWorkaround: false,
        },
        changes: ['Formatted src/example.js.'],
        testPlan: ['npm run format -- --check'],
      }),
    });

    const result = await runPrFixCi(
      createContext({
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(github.updatedBodies.length, 0);
    assert.deepEqual(github.pullRequestLabelsAdded, []);
    assert.deepEqual(github.pullRequestLabelsRemoved, [
      {
        number: 100,
        labels: ['pullops:pr:fix-ci', 'pullops:human-required'],
      },
    ]);
    assert.deepEqual(git.pushes, [{ branchName: 'human/fix-lint' }]);
  });

  it('03: skips automatic pr-fix-ci on a non-managed PR without mutating it', async () => {
    const github = createFakeGitHub({
      pullRequest: createPullRequest({
        body: 'Human-authored PR.',
        headRefName: 'human/fix-lint',
        isDraft: false,
        labels: [],
      }),
      checks: [createFailedCheck({ name: 'ESLint lint' })],
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const git = createFakeGit({ hasChanges: true });
    const codex = createFakeCodexRunner({ output: '{}' });

    const result = await runPrFixCi(
      createContext({
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.match(String(result.summary), /not a PullOps-managed draft PR/);
    assert.equal(codex.calls.length, 0);
    assert.equal(git.commits.length, 0);
    assert.equal(github.updatedBodies.length, 0);
    assert.equal(github.comments.length, 0);
    assert.deepEqual(github.pullRequestLabelsAdded, []);
    assert.deepEqual(github.pullRequestLabelsRemoved, []);
  });

  it('04: blocks without running Codex when the CI fix cycle budget is exhausted', async () => {
    const github = createFakeGitHub({
      pullRequest: createPullRequest({
        body: createPullRequestBody({ ciFixCycles: '2 / 2' }),
      }),
      checks: [createFailedCheck({ name: 'Unit tests' })],
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const codex = createFakeCodexRunner({ output: '{}' });

    const result = await runPrFixCi(
      createContext({
        githubClient: github.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'blocked');
    assert.match(String(result.summary), /CI fix cycle budget exhausted/);
    assert.equal(codex.calls.length, 0);
    assert.match(github.updatedBodies[0].body, /Status: Human required/);
    assert.match(github.updatedBodies[0].body, /CI fix cycles: 2 \/ 2/);
    assert.match(github.comments[0].body, /2 \/ 2 CI Fix Cycles have already run/);
    assert.deepEqual(github.pullRequestLabelsAdded, [
      {
        number: 100,
        labels: ['pullops:human-required'],
      },
    ]);
  });

  it('05: blocks non-actionable secret, flaky, or environment failures before running Codex', async () => {
    const github = createFakeGitHub({
      pullRequest: createPullRequest(),
      checks: [createFailedCheck({ name: 'Deploy with missing secret token' })],
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const git = createFakeGit({ hasChanges: true });
    const codex = createFakeCodexRunner({ output: '{}' });

    const result = await runPrFixCi(
      createContext({
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'blocked');
    assert.equal(codex.calls.length, 0);
    assert.equal(git.commits.length, 0);
    assert.match(github.comments[0].body, /classified as secret/);
    assert.deepEqual(github.pullRequestLabelsAdded, [
      {
        number: 100,
        labels: ['pullops:human-required'],
      },
    ]);
  });

  it('06: refuses unsafe fix output before committing or pushing', async () => {
    const github = createFakeGitHub({
      pullRequest: createPullRequest(),
      checks: [createFailedCheck({ name: 'Unit tests' })],
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const git = createFakeGit({ hasChanges: true });
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'fixed',
        summary: 'Made the tests pass by deleting assertions.',
        classifications: [
          {
            checkId: 'check-1',
            classification: 'test',
            rationale: 'The unit test check failed.',
          },
        ],
        safetyChecks: {
          weakenedTests: false,
          deletedAssertions: true,
          bypassedChecks: false,
          secretOrInfrastructureWorkaround: false,
        },
        changes: ['Deleted failing assertions.'],
        testPlan: ['npm test'],
      }),
    });

    const result = await runPrFixCi(
      createContext({
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'blocked');
    assert.equal(git.commits.length, 0);
    assert.equal(git.pushes.length, 0);
    assert.match(github.comments[0].body, /<summary>PullOps operation audit<\/summary>/);
    assert.match(github.comments[1].body, /unsafe repair actions/);
    assert.match(github.updatedBodies[0].body, /Status: Human required/);
    assert.match(github.updatedBodies[0].body, /CI fix cycles: 1 \/ 2/);
  });

  it('07: automatically fixes failed checks on a ready finalized managed PR', async () => {
    const github = createFakeGitHub({
      pullRequest: createPullRequest({
        body: createPullRequestBody({
          status: 'Ready for human merge',
          lastOperation: 'pullops:pr:finalize',
          finalizedTreeHash: 'tree-finalized',
          finalizedHeadSha: 'head-finalized',
          mergeMethod: 'rebase',
        }),
        isDraft: false,
      }),
      checks: [createFailedCheck({ name: 'Unit tests' })],
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const git = createFakeGit({ hasChanges: true });
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'fixed',
        summary: 'Fixed the failing test.',
        classifications: [
          {
            checkId: 'check-1',
            classification: 'test',
            rationale: 'The unit test check failed.',
          },
        ],
        safetyChecks: {
          weakenedTests: false,
          deletedAssertions: false,
          bypassedChecks: false,
          secretOrInfrastructureWorkaround: false,
        },
        changes: ['Updated the failing test expectation.'],
        testPlan: ['npm test'],
      }),
    });

    const result = await runPrFixCi(
      createContext({
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(codex.calls.length, 1);
    assert.deepEqual(git.pushes, [{ branchName: 'pullops/issue-42' }]);
    assert.match(github.updatedBodies[0].body, /Status: CI fixed/);
    assert.match(github.updatedBodies[0].body, /Last operation: pullops:pr:fix-ci/);
    assert.doesNotMatch(github.updatedBodies[0].body, /Reviewed tree:/);
    assert.doesNotMatch(github.updatedBodies[0].body, /Finalized tree:/);
    assert.doesNotMatch(github.updatedBodies[0].body, /Finalized head:/);
    assert.doesNotMatch(github.updatedBodies[0].body, /Merge method:/);
  });

  it('08: prepares a waiting external runner handoff without invoking the runner', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'pullops-pr-fix-ci-external-'));
    const github = createFakeGitHub({
      pullRequest: createPullRequest(),
      checks: [createFailedCheck({ name: 'ESLint lint' })],
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const git = createFakeGit({ hasChanges: true });
    const codex = createFakeCodexRunner({ output: '{}' });

    const result = await runPrFixCiCodexActionPrepare(
      createContext({
        phase: 'prepare',
        runnerAdapter: 'external',
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
        outputDirectory,
      }),
    );

    assert.equal(result.status, 'waiting');
    assert.equal(codex.calls.length, 0);

    const prompt = await readFile(join(outputDirectory, 'runner_prompt.md'), 'utf8');
    assert.match(prompt, /Write the final Operation Output JSON to .*runner_output\.json/);
    assert.match(prompt, /Do not write .*runner_result\.json/);
    assert.match(prompt, /Use the pullops-pr-fix-ci skill/);
    assert.match(prompt, /checkId `check-1`/);

    const runnerJob = assertObject(
      result.runnerJob,
      'Expected the prepared pr-fix-ci result to include a runnerJob payload.',
    );
    assert.equal(Reflect.get(runnerJob, 'cwd'), '/workspace');
    assert.equal(Reflect.get(runnerJob, 'promptFile'), join(outputDirectory, 'runner_prompt.md'));
    assert.equal(Reflect.get(runnerJob, 'outputFile'), join(outputDirectory, 'runner_output.json'));
    assert.equal(Reflect.get(runnerJob, 'resultFile'), join(outputDirectory, 'runner_result.json'));
    assert.equal(Reflect.get(runnerJob, 'model'), DEFAULT_PULL_OPS_CONFIG.runner.models.mid);
    assert.equal(Reflect.get(runnerJob, 'branch'), 'pullops/issue-42');
    assert.equal(Reflect.get(runnerJob, 'workerPrompt'), prompt);
    const completionCommands = assertObject(
      Reflect.get(runnerJob, 'completionCommands'),
      'Expected runnerJob to include completionCommands.',
    );
    assert.deepEqual(Reflect.get(completionCommands, 'cancelled'), {
      argv: [
        'npm',
        'exec',
        '--',
        'pullops',
        'runner-result',
        '--status',
        'cancelled',
        '--file',
        join(outputDirectory, 'runner_result.json'),
      ],
      env: {
        npm_config_cache: '/tmp/pullops-npm-cache',
      },
    });
    assert.deepEqual(Reflect.get(runnerJob, 'completeCommand'), {
      argv: [
        'npm',
        'exec',
        '--',
        'pullops',
        'run',
        'pr-fix-ci',
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

  it('09: completes an external runner output without invoking the runner', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'pullops-pr-fix-ci-complete-'));
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
        status: 'fixed',
        summary: 'Fixed the lint failure.',
        classifications: [
          {
            checkId: 'check-1',
            classification: 'lint',
            rationale: 'ESLint reported an unused variable.',
          },
        ],
        safetyChecks: {
          weakenedTests: false,
          deletedAssertions: false,
          bypassedChecks: false,
          secretOrInfrastructureWorkaround: false,
        },
        changes: ['Removed the unused variable.'],
        testPlan: ['npm run lint'],
      }),
    );
    const github = createFakeGitHub({
      pullRequest: createPullRequest(),
      checks: [createFailedCheck({ name: 'ESLint lint' })],
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const git = createFakeGit({ hasChanges: true });
    const codex = createFakeCodexRunner({ output: '{}' });

    const result = await runPrFixCiCodexActionFinalize(
      createContext({
        phase: 'complete',
        runnerAdapter: 'external',
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
        outputDirectory,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(codex.calls.length, 0);
    assert.deepEqual(git.commits, [
      {
        message: [
          'fix(ci): repair failures for PR #100',
          '',
          '- Removed the unused variable.',
          '',
          'Refs: #100',
        ].join('\n'),
        author: GITHUB_ACTIONS_BOT_AUTHOR,
      },
    ]);
    assert.deepEqual(git.pushes, [{ branchName: 'pullops/issue-42' }]);
    assert.match(github.updatedBodies[0].body, /Status: CI fixed/);
  });

  it('10: treats skipped external completion as a no-op when prepare requested no worker', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'pullops-pr-fix-ci-skipped-'));
    await writeFile(
      join(outputDirectory, 'runner_result.json'),
      JSON.stringify({
        schemaVersion: 1,
        status: 'skipped',
      }),
    );
    const github = createFakeGitHub({
      pullRequest: createPullRequest(),
      checks: [],
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const git = createFakeGit({ hasChanges: true });
    const codex = createFakeCodexRunner({ output: '{}' });

    const result = await runPrFixCiCodexActionFinalize(
      createContext({
        phase: 'complete',
        runnerAdapter: 'external',
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
        outputDirectory,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.match(String(result.summary), /prepare did not request a runner step/);
    assert.deepEqual(result.runner, {
      adapter: 'external',
      status: 'skipped',
    });
    assert.equal(codex.calls.length, 0);
    assert.equal(git.commits.length, 0);
    assert.equal(git.pushes.length, 0);
    assert.equal(github.updatedBodies.length, 0);
    assert.equal(github.comments.length, 0);
    assert.deepEqual(github.pullRequestLabelsAdded, []);
    assert.deepEqual(github.pullRequestLabelsRemoved, []);
  });

  it('11: rejects skipped external completion when prepare requested a worker', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'pullops-pr-fix-ci-bad-skip-'));
    await writeFile(join(outputDirectory, 'runner_prompt.md'), 'Run the worker.\n');
    await writeFile(
      join(outputDirectory, 'runner_result.json'),
      JSON.stringify({
        schemaVersion: 1,
        status: 'skipped',
      }),
    );
    const github = createFakeGitHub({
      pullRequest: createPullRequest(),
      checks: [createFailedCheck({ name: 'ESLint lint' })],
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const git = createFakeGit({ hasChanges: true });
    const codex = createFakeCodexRunner({ output: '{}' });

    await assert.rejects(
      runPrFixCiCodexActionFinalize(
        createContext({
          phase: 'complete',
          runnerAdapter: 'external',
          githubClient: github.client,
          gitClient: git.client,
          codexRunner: codex.runner,
          outputDirectory,
        }),
      ),
      /External runner result is skipped even though prepare requested a runner step/,
    );

    assert.equal(codex.calls.length, 0);
    assert.equal(git.commits.length, 0);
    assert.equal(git.pushes.length, 0);
    assert.match(github.comments[0].body, /External runner result is skipped/);
    assert.deepEqual(github.pullRequestLabelsAdded.at(-1), {
      number: 100,
      labels: ['pullops:human-required'],
    });
    assert.equal(
      await readFile(join(outputDirectory, 'failure_reason.txt'), 'utf8'),
      'External runner result is skipped even though prepare requested a runner step.\n',
    );
  });

  it('12: records a cancelled external runner before failing complete', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'pullops-pr-fix-ci-cancelled-'));
    await writeFile(
      join(outputDirectory, 'runner_result.json'),
      JSON.stringify({
        schemaVersion: 1,
        status: 'cancelled',
      }),
    );
    const github = createFakeGitHub({
      pullRequest: createPullRequest(),
      checks: [createFailedCheck({ name: 'ESLint lint' })],
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const git = createFakeGit({ hasChanges: true });
    const codex = createFakeCodexRunner({ output: '{}' });

    await assert.rejects(
      runPrFixCiCodexActionFinalize(
        createContext({
          phase: 'complete',
          runnerAdapter: 'external',
          githubClient: github.client,
          gitClient: git.client,
          codexRunner: codex.runner,
          outputDirectory,
        }),
      ),
      /External runner completed with status "cancelled"/,
    );

    assert.equal(codex.calls.length, 0);
    assert.equal(git.commits.length, 0);
    assert.equal(git.pushes.length, 0);
    assert.match(github.comments[0].body, /External runner completed with status "cancelled"/);
    assert.deepEqual(github.pullRequestLabelsAdded.at(-1), {
      number: 100,
      labels: ['pullops:human-required'],
    });
    assert.equal(
      await readFile(join(outputDirectory, 'failure_reason.txt'), 'utf8'),
      'External runner completed with status "cancelled".\n',
    );
  });

  it('13: records a failed external runner before failing complete', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'pullops-pr-fix-ci-failed-'));
    await writeFile(
      join(outputDirectory, 'runner_result.json'),
      JSON.stringify({
        schemaVersion: 1,
        status: 'failed',
      }),
    );
    const github = createFakeGitHub({
      pullRequest: createPullRequest(),
      checks: [createFailedCheck({ name: 'ESLint lint' })],
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const git = createFakeGit({ hasChanges: true });
    const codex = createFakeCodexRunner({ output: '{}' });

    await assert.rejects(
      runPrFixCiCodexActionFinalize(
        createContext({
          phase: 'complete',
          runnerAdapter: 'external',
          githubClient: github.client,
          gitClient: git.client,
          codexRunner: codex.runner,
          outputDirectory,
        }),
      ),
      /External runner completed with status "failed"/,
    );

    assert.equal(codex.calls.length, 0);
    assert.equal(git.commits.length, 0);
    assert.equal(git.pushes.length, 0);
    assert.match(github.comments[0].body, /External runner completed with status "failed"/);
    assert.deepEqual(github.pullRequestLabelsAdded.at(-1), {
      number: 100,
      labels: ['pullops:human-required'],
    });
    assert.equal(
      await readFile(join(outputDirectory, 'failure_reason.txt'), 'utf8'),
      'External runner completed with status "failed".\n',
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
 * @param {Partial<OperationRunnerContext>} overrides
 * @returns {OperationRunnerContext}
 */
function createContext(overrides = {}) {
  return {
    operation: 'pr-fix-ci',
    phase: 'run',
    runnerAdapter: 'codex-cli',
    target: {
      type: 'pr',
      number: 100,
    },
    cwd: '/workspace',
    config: DEFAULT_PULL_OPS_CONFIG,
    modelTier: 'mid',
    model: DEFAULT_PULL_OPS_CONFIG.runner.models.mid,
    githubClient: createFakeGitHub({
      pullRequest: createPullRequest(),
      checks: [createFailedCheck({ name: 'Unit tests' })],
      reviewContext: createReviewContext(),
      diff: createDiff(),
    }).client,
    gitClient: createFakeGit({ hasChanges: false }).client,
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
    title: 'Implement #42: Add review automation',
    url: 'https://github.com/acme/widgets/pull/100',
    headRefName: 'pullops/issue-42',
    baseRefName: 'main',
    body: createPullRequestBody(),
    isDraft: true,
    isCrossRepository: false,
    labels: [],
    ...overrides,
  };
}

/**
 * @param {{
 *   ciFixCycles?: string,
 *   status?: string,
 *   lastOperation?: string,
 *   finalizedTreeHash?: string,
 *   finalizedHeadSha?: string,
 *   mergeMethod?: string,
 * }} [options]
 * @returns {string}
 */
function createPullRequestBody({
  ciFixCycles = '0 / 2',
  status = 'Draft automation',
  lastOperation = 'pullops:pr:review',
  finalizedTreeHash,
  finalizedHeadSha,
  mergeMethod,
} = {}) {
  return [
    '## Summary',
    '',
    'Implemented the issue.',
    '',
    '## PullOps',
    '',
    'Managed: yes',
    `Status: ${status}`,
    '',
    '<details>',
    '<summary>PullOps workflow state</summary>',
    '',
    'Review cycles: 1 / 3',
    `CI fix cycles: ${ciFixCycles}`,
    'Source: Issue #42',
    ...(finalizedTreeHash === undefined ? [] : [`Finalized tree: ${finalizedTreeHash}`]),
    ...(finalizedHeadSha === undefined ? [] : [`Finalized head: ${finalizedHeadSha}`]),
    ...(mergeMethod === undefined ? [] : [`Merge method: ${mergeMethod}`]),
    `Last operation: ${lastOperation}`,
    '',
    '</details>',
  ].join('\n');
}

/**
 * @returns {GitHubIssue}
 */
function createIssue() {
  return {
    number: 42,
    title: 'Add review automation',
    body: '## What to build\n\nReview PullOps-managed PRs.',
    state: 'OPEN',
    url: 'https://github.com/acme/widgets/issues/42',
    authorLogin: 'maintainer',
    labels: [],
    parent: null,
    subIssues: [],
  };
}

/**
 * @param {Partial<GitHubCheckRun>} [overrides]
 * @returns {GitHubCheckRun}
 */
function createFailedCheck(overrides = {}) {
  return {
    name: 'Unit tests',
    workflowName: 'CI',
    bucket: 'fail',
    conclusion: 'failure',
    detailsUrl: 'https://github.com/acme/widgets/actions/runs/1',
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
        path: 'src/example.js',
        additions: 1,
        deletions: 0,
      },
    ],
  };
}

/**
 * @returns {GitHubPullRequestDiff}
 */
function createDiff() {
  return {
    patch: [
      'diff --git a/src/example.js b/src/example.js',
      '--- a/src/example.js',
      '+++ b/src/example.js',
      '@@ -1,2 +1,3 @@',
      ' const a = 1;',
      '+const b = 2;',
      ' const c = 3;',
    ].join('\n'),
  };
}

/**
 * @param {object} options
 * @param {GitHubPullRequest} options.pullRequest
 * @param {GitHubCheckRun[]} options.checks
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
function createFakeGitHub({ pullRequest, checks, reviewContext, diff }) {
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
        return createIssue();
      },
      async getPullRequest() {
        return pullRequest;
      },
      async getPullRequestChecks() {
        return checks;
      },
      async getPullRequestChecksForRef() {
        throw new Error('getPullRequestChecksForRef was not expected in this test.');
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
 * @param {{ hasChanges: boolean }} options
 * @returns {{
 *   commits: CommitAllOptions[];
 *   pushes: PushBranchOptions[];
 *   client: import('../../git/types.js').GitClient;
 * }}
 */
function createFakeGit({ hasChanges }) {
  /** @type {CommitAllOptions[]} */
  const commits = [];
  /** @type {PushBranchOptions[]} */
  const pushes = [];

  return {
    commits,
    pushes,
    client: {
      async createBranch() {
        throw new Error('createBranch was not expected in this test.');
      },
      async hasChanges() {
        return hasChanges;
      },
      async commitAll(options) {
        commits.push(options);
      },
      async commitEmpty() {
        throw new Error('commitEmpty was not expected in this test.');
      },
      async pushBranch(options) {
        pushes.push(options);
      },
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
