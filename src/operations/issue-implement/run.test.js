import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { DEFAULT_PULL_OPS_CONFIG } from '../../config/PullOpsConfig.js';
import { createIssueImplementBranchName } from './branch.js';
import {
  GITHUB_ACTIONS_BOT_AUTHOR,
  runIssueImplement,
  runIssueImplementCodexActionFinalize,
  runIssueImplementCodexActionPrepare,
} from './run.js';

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('../../github/types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('../../github/types.js').CreateDraftPullRequestOptions} CreateDraftPullRequestOptions
 * @typedef {import('../../github/types.js').EditLabelsOptions} EditLabelsOptions
 * @typedef {import('../../github/types.js').CommentOnIssueOptions} CommentOnIssueOptions
 * @typedef {import('../../github/types.js').CommentOnPullRequestOptions} CommentOnPullRequestOptions
 * @typedef {import('../../git/types.js').CreateBranchOptions} CreateBranchOptions
 * @typedef {import('../../git/types.js').FetchRemoteRefsOptions} FetchRemoteRefsOptions
 * @typedef {import('../../git/types.js').CheckoutPullOpsBranchOptions} CheckoutPullOpsBranchOptions
 * @typedef {import('../../git/types.js').CommitAllOptions} CommitAllOptions
 * @typedef {import('../../git/types.js').CommitEmptyOptions} CommitEmptyOptions
 * @typedef {import('../../git/types.js').GetChangedFilesSinceBaseOptions} GetChangedFilesSinceBaseOptions
 * @typedef {import('../../git/types.js').GetCommitsSinceBaseOptions} GetCommitsSinceBaseOptions
 * @typedef {import('../../git/types.js').GitPushWithLeaseResult} GitPushWithLeaseResult
 * @typedef {import('../../git/types.js').PushBranchOptions} PushBranchOptions
 * @typedef {import('../../git/types.js').PushBranchWithLeaseOptions} PushBranchWithLeaseOptions
 * @typedef {import('../../git/types.js').ResetHardToRevisionOptions} ResetHardToRevisionOptions
 * @typedef {import('../../runner/types.js').CodexRunOptions} CodexRunOptions
 * @typedef {import('../../config/types.js').PullOpsConfig} PullOpsConfig
 */

describe('runIssueImplement', () => {
  it('01: creates a deterministic branch, validates runner output, commits, pushes, and opens a managed draft PR', async () => {
    const issue = createIssue({ number: 42, title: 'Add the first operation' });
    const github = createFakeGitHub({ issue });
    const git = createFakeGit();
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'implemented',
        summary: 'Implemented the first operation.',
        changes: ['Added operation orchestration.', 'Covered the command seam with tests.'],
        testPlan: ['npm test -- src/operations/issue-implement/run.test.js'],
      }),
    });

    const result = await runIssueImplement(
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
    assert.equal(codex.calls[0].model, 'gpt-5.5');
    assert.match(codex.calls[0].prompt, /Use the pullops-issue-implement skill/);
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
    assert.match(github.createdPullRequests[0].body, /^## PullOps$/m);
    assert.match(github.createdPullRequests[0].body, /^Managed: yes$/m);
    assert.doesNotMatch(github.createdPullRequests[0].body, /Managed PR: yes/);
    assert.match(github.createdPullRequests[0].body, /Status: Draft automation/);
    assert.match(
      github.createdPullRequests[0].body,
      /<summary>PullOps workflow state<\/summary>[\s\S]*Review cycles: 0 \/ 3/,
    );
    assert.match(github.createdPullRequests[0].body, /^## PullOps Link Summary$/m);
    assert.match(github.createdPullRequests[0].body, /^Kind: Concrete Issue PR$/m);
    assert.match(github.createdPullRequests[0].body, /^Source Issue: #42$/m);
    assert.match(github.createdPullRequests[0].body, /^Closes: #42$/m);
    assert.doesNotMatch(github.createdPullRequests[0].body, /^## Traceability$/m);
    assert.doesNotMatch(github.createdPullRequests[0].body, /^Branch:/m);
    assert.doesNotMatch(github.createdPullRequests[0].body, /Triggered by:/);
    assert.doesNotMatch(github.createdPullRequests[0].body, /Model tier:/);
    assert.doesNotMatch(github.createdPullRequests[0].body, /Model:/);
    assert.deepEqual(github.pullRequestComments, [
      {
        number: 100,
        body: [
          'Implemented the first operation.',
          '',
          '---',
          '',
          '<details>',
          '<summary>PullOps operation audit</summary>',
          '',
          'Operation: pullops:issue:implement',
          'Trigger actor: @octocat',
          'Model tier: high',
          'Model: gpt-5.5',
          'Context used: unknown',
          '</details>',
        ].join('\n'),
      },
    ]);
    assert.deepEqual(github.pullRequestLabels, [
      {
        number: 100,
        labels: ['pullops:pr:review'],
      },
    ]);
    assert.deepEqual(github.issueLabelsAdded, []);
  });

  it('02: prepares an external runner handoff without invoking the runner', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'pullops-external-runner-'));
    const issue = createIssue({ number: 42, title: 'Add the first operation' });
    const github = createFakeGitHub({ issue });
    const git = createFakeGit();
    const codex = createFakeCodexRunner({ output: '{}' });

    const result = await runIssueImplementCodexActionPrepare(
      createContext({
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
        outputDirectory,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(codex.calls.length, 0);
    assert.deepEqual(git.branches, [
      {
        branchName: 'pullops/issue-42',
        baseBranch: 'main',
      },
    ]);

    const prompt = await readFile(join(outputDirectory, 'runner_prompt.md'), 'utf8');
    assert.match(prompt, /Write the final Operation Output JSON to .*runner_output\.json/);
    assert.match(prompt, /Use the pullops-issue-implement skill/);
    assert.match(prompt, /Implement GitHub Issue #42: Add the first operation/);
    const runnerJob = /** @type {any} */ (result.runnerJob);
    assert.equal(runnerJob.cwd, '/workspace');
    assert.equal(runnerJob.promptFile, join(outputDirectory, 'runner_prompt.md'));
    assert.equal(runnerJob.outputFile, join(outputDirectory, 'runner_output.json'));
    assert.equal(runnerJob.resultFile, join(outputDirectory, 'runner_result.json'));
    assert.equal(runnerJob.model, 'gpt-5.5');
    assert.equal(runnerJob.branch, 'pullops/issue-42');
    assert.equal(runnerJob.workerPrompt, prompt);
    assert.deepEqual(runnerJob.completionCommands.success, {
      argv: [
        'npm',
        'exec',
        'pullops',
        '--',
        'runner-result',
        '--status',
        'success',
        '--file',
        join(outputDirectory, 'runner_result.json'),
      ],
      env: {},
    });
  });

  it('03: completes an external runner output without invoking the runner', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'pullops-external-runner-'));
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
        status: 'implemented',
        summary: 'Implemented the first operation.',
        changes: ['Added operation orchestration.'],
        testPlan: ['npm test -- src/operations/issue-implement/run.test.js'],
      }),
    );

    const issue = createIssue({ number: 42, title: 'Add the first operation' });
    const github = createFakeGitHub({ issue });
    const git = createFakeGit();
    const codex = createFakeCodexRunner({ output: '{}' });

    const result = await runIssueImplementCodexActionFinalize(
      createContext({
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
        outputDirectory,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(codex.calls.length, 0);
    assert.deepEqual(git.branches, []);
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
    assert.equal(github.createdPullRequests[0].headBranch, 'pullops/issue-42');
  });

  it('04: implements a manually selected child issue against the parent branch', async () => {
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
        testPlan: ['npm test -- src/operations/issue-implement/run.test.js'],
      }),
    });

    const result = await runIssueImplement(
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
        branchName: 'pullops/prd-1-issue-42',
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
    assert.equal(github.createdPullRequests[0].headBranch, 'pullops/prd-1-issue-42');
    assert.match(github.createdPullRequests[0].body, /^Kind: Child Issue PR$/m);
    assert.match(github.createdPullRequests[0].body, /^Source Issue: #42$/m);
    assert.match(github.createdPullRequests[0].body, /^Umbrella PR: pending$/m);
    assert.doesNotMatch(github.createdPullRequests[0].body, /Closes #42/);
    assert.doesNotMatch(github.createdPullRequests[0].body, /Refs #42/);
    assert.doesNotMatch(github.createdPullRequests[0].body, /Part of #1/);
  });

  it('05: links an existing umbrella PR from a child issue PR body', async () => {
    const issue = createIssue({
      number: 42,
      title: 'Do one child task',
      parent: {
        number: 1,
        title: 'PRD',
        relationshipSource: 'native',
      },
    });
    const github = createFakeGitHub({
      issue,
      existingPullRequest: {
        number: 7,
        title: 'Umbrella PR',
        url: 'https://github.com/acme/widgets/pull/7',
        headRefName: 'pullops/prd-1',
        body: '',
        isDraft: true,
      },
    });
    const git = createFakeGit();
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'implemented',
        summary: 'Implemented the selected child issue.',
        changes: ['Added the selected behavior.'],
        testPlan: ['npm test -- src/operations/issue-implement/run.test.js'],
      }),
    });

    await runIssueImplement(
      createContext({
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(github.createdPullRequests.length, 1);
    assert.match(github.createdPullRequests[0].body, /^Umbrella PR: #7$/m);
  });

  it('06: blocks a PRD-looking issue without native GitHub child issues', async () => {
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

    const result = await runIssueImplement(
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

  it('07: blocks a parent issue with children without implementing child issues', async () => {
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

    const result = await runIssueImplement(
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

  it('08: refuses closed issues before creating a branch', async () => {
    const issue = createIssue({
      number: 42,
      body: 'Blocked by: #999',
      state: 'CLOSED',
    });
    const github = createFakeGitHub({ issue });
    const git = createFakeGit();
    const codex = createFakeCodexRunner({ output: '{}' });

    const result = await runIssueImplement(
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

  it('09: refuses when the deterministic PullOps branch already has an open implementation PR', async () => {
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

    const result = await runIssueImplement(
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
        labels: ['pullops:issue:implement', 'pullops:human-required'],
      },
    ]);
  });

  it('10: records invalid Operation Output before committing, pushing, or opening a PR', async () => {
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
      runIssueImplement(
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
      labels: ['pullops:human-required'],
    });
    assert.equal(
      await readFile(join(outputDirectory, 'failure_reason.txt'), 'utf8'),
      'Invalid Operation Output: Operation Output.testPlan must be an array.\n',
    );
  });

  it('11: records unexpected git or GitHub failures after valid runner output', async () => {
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
      runIssueImplement(
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
      labels: ['pullops:human-required'],
    });
  });

  it('12: blocks an issue when a dependency is not done', async () => {
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

    const result = await runIssueImplement(
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
    assert.deepEqual(github.issueLabelsAdded, []);
  });

  it('13: blocks an issue when a dependency is still open with human attention required', async () => {
    const issue = createIssue({
      number: 42,
      body: ['Blocked by: #7', '', '## What to build', '', 'Do the thing.'].join('\n'),
    });
    const dependency = createIssue({
      number: 7,
      title: 'Dependency',
      labels: ['pullops:human-required'],
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

    const result = await runIssueImplement(
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
  });

  it('14: uses the configured Branch Prefix for deterministic branch names', () => {
    assert.equal(
      createIssueImplementBranchName({
        branchPrefix: 'automation/pullops/',
        issueNumber: 123,
      }),
      'automation/pullops/issue-123',
    );
    assert.equal(
      createIssueImplementBranchName({
        branchPrefix: 'automation/pullops/',
        parentNumber: 10,
        issueNumber: 123,
      }),
      'automation/pullops/prd-10-issue-123',
    );
  });

  it('15: treats a skipped external runner as a no-op complete acknowledgement', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'pullops-external-runner-skipped-'));
    await writeFile(
      join(outputDirectory, 'runner_result.json'),
      JSON.stringify({
        schemaVersion: 1,
        status: 'skipped',
      }),
    );
    const github = createFakeGitHub({ issue: createIssue({ number: 42 }) });
    const git = createFakeGit();
    const codex = createFakeCodexRunner({ output: '{}' });

    const result = await runIssueImplementCodexActionFinalize(
      createContext({
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
    assert.equal(github.comments.length, 0);
    assert.equal(github.issueLabelsAdded.length, 0);
  });

  it('16: records a failed external runner before failing complete', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'pullops-external-runner-failure-'));
    await writeFile(
      join(outputDirectory, 'runner_result.json'),
      JSON.stringify({
        schemaVersion: 1,
        status: 'failed',
      }),
    );
    const github = createFakeGitHub({ issue: createIssue({ number: 42 }) });
    const git = createFakeGit();
    const codex = createFakeCodexRunner({ output: '{}' });

    await assert.rejects(
      runIssueImplementCodexActionFinalize(
        createContext({
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
    assert.deepEqual(github.issueLabelsAdded.at(-1), {
      number: 42,
      labels: ['pullops:human-required'],
    });
    assert.equal(
      await readFile(join(outputDirectory, 'failure_reason.txt'), 'utf8'),
      'External runner completed with status "failed".\n',
    );
  });

  it('16b: treats missing or malformed external runner results as contract errors', async () => {
    for (const { resultText, expected } of [
      {
        resultText: undefined,
        expected: /missing runner_result\.json/,
      },
      {
        resultText: '{not json',
        expected: /invalid runner_result\.json/,
      },
    ]) {
      const outputDirectory = await mkdtemp(join(tmpdir(), 'pullops-external-runner-contract-'));
      if (resultText !== undefined) {
        await writeFile(join(outputDirectory, 'runner_result.json'), resultText);
      }
      await writeFile(
        join(outputDirectory, 'runner_output.json'),
        JSON.stringify({
          status: 'implemented',
          summary: 'This output must not be trusted before runner_result.json is valid.',
          changes: ['Should not matter.'],
          testPlan: ['Should not matter.'],
        }),
      );

      const github = createFakeGitHub({ issue: createIssue({ number: 42 }) });
      const git = createFakeGit();

      await assert.rejects(
        runIssueImplementCodexActionFinalize(
          createContext({
            githubClient: github.client,
            gitClient: git.client,
            outputDirectory,
          }),
        ),
        expected,
      );

      assert.equal(git.commits.length, 0);
      assert.equal(git.pushes.length, 0);
      assert.match(github.comments[0].body, expected);
    }
  });

  it('17: local dry-run refuses a dirty worktree before reading GitHub issue state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-local-dirty-'));
    const github = createFakeGitHub({ issue: createIssue({ number: 42, labels: [] }) });
    const git = createFakeGit({ hasChangesResults: [true] });
    const codex = createFakeCodexRunner({ output: '{}' });

    await assert.rejects(
      runIssueImplement(
        createContext({
          cwd,
          publicationMode: 'dry-run',
          githubClient: github.client,
          gitClient: git.client,
          codexRunner: codex.runner,
        }),
      ),
      /requires a clean worktree/,
    );

    assert.equal(codex.calls.length, 0);
    assert.deepEqual(git.fetches, []);
    assert.deepEqual(git.checkouts, []);
    assert.deepEqual(github.issueLookups, []);
    assert.equal(github.comments.length, 0);
    assert.equal(github.issueLabelsAdded.length, 0);
    const [recordName] = await readdir(join(cwd, '.pullops', 'runs'));
    assert.match(recordName, /issue-implement-42$/);
    const state = JSON.parse(
      await readFile(join(cwd, '.pullops', 'runs', recordName, 'state.json'), 'utf8'),
    );
    assert.equal(state.status, 'failed');
    assert.match(
      await readFile(join(cwd, '.pullops', 'runs', recordName, 'failure-reason.txt'), 'utf8'),
      /clean worktree/,
    );
  });

  it('18: local dry-run fetches refs, checks out the PullOps branch, records artifacts, and commits without GitHub mutations', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-local-dry-run-'));
    const issue = createIssue({ number: 42, title: 'Add the first operation', labels: [] });
    const github = createFakeGitHub({ issue });
    const git = createFakeGit({
      hasChangesResults: [false, true],
      patch: 'diff --git a/src/file.js b/src/file.js\n',
    });
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'implemented',
        summary: 'Implemented locally.',
        changes: ['Changed code.'],
        testPlan: ['npm test -- src/operations/issue-implement/run.test.js'],
      }),
    });
    /** @type {PullOpsConfig} */
    const config = {
      ...DEFAULT_PULL_OPS_CONFIG,
      runner: {
        ...DEFAULT_PULL_OPS_CONFIG.runner,
        command: 'custom-runner exec',
        models: {
          ...DEFAULT_PULL_OPS_CONFIG.runner.models,
          high: 'gpt-local-high',
        },
      },
    };

    const result = await runIssueImplement(
      createContext({
        cwd,
        config,
        model: 'gpt-local-high',
        publicationMode: 'dry-run',
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(result.publicationMode, 'dry-run');
    assert.equal(result.branch, 'pullops/issue-42');
    assert.deepEqual(git.fetches, [
      {
        requiredBranchNames: ['main'],
        optionalBranchNames: ['pullops/issue-42'],
      },
    ]);
    assert.deepEqual(git.checkouts, [{ branchName: 'pullops/issue-42', baseBranch: 'main' }]);
    assert.deepEqual(git.pushes, []);
    assert.equal(codex.calls[0].cwd, cwd);
    assert.equal(codex.calls[0].command, 'custom-runner exec');
    assert.equal(codex.calls[0].model, 'gpt-local-high');
    assert.deepEqual(github.createdPullRequests, []);
    assert.deepEqual(github.issueLabelsAdded, []);
    assert.deepEqual(github.issueLabelsRemoved, []);
    assert.deepEqual(github.pullRequestLabels, []);
    assert.deepEqual(github.comments, []);
    assert.deepEqual(github.pullRequestComments, []);
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

    const runRecord = String(result.localRunRecord);
    assert.match(runRecord, /\.pullops\/runs\/.+issue-implement-42$/);
    const state = JSON.parse(await readFile(join(runRecord, 'state.json'), 'utf8'));
    const call = codex.calls[0];
    assert(call);
    const env = call.env;
    assert(env);
    assert.equal(env.PULLOPS_RUN_STATE_PATH, join(runRecord, 'state.json'));
    assert.equal(env.PULLOPS_HEARTBEAT_COMMAND, 'npm exec -- pullops heartbeat');
    assert.equal(env.PULLOPS_HEARTBEAT_TOKEN, state.heartbeatToken);
    assert.equal(env.PULLOPS_HEARTBEAT_INTERVAL_MS, String(state.heartbeatIntervalMs));
    assert.equal(env.npm_config_cache, join(runRecord, 'npm-cache'));
    assert.equal(state.status, 'accepted');
    assert.equal(state.phase, 'run');
    assert.equal(state.lastEvent.status, 'accepted');
    assert.deepEqual(state.childRuns, []);
    assert.match(await readFile(join(runRecord, 'prompt.md'), 'utf8'), /Issue #42/);
    assert.match(
      await readFile(join(runRecord, 'raw-runner-output.txt'), 'utf8'),
      /Implemented locally/,
    );
    assert.match(await readFile(join(runRecord, 'validated-output.json'), 'utf8'), /Changed code/);
    assert.equal(
      await readFile(join(runRecord, 'working-tree.patch'), 'utf8'),
      'diff --git a/src/file.js b/src/file.js\n',
    );
  });

  it('19: local dry-run child issue fetches the repository base and uses the local PRD branch as the branch base', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-local-child-dry-run-'));
    const issue = createIssue({
      number: 42,
      title: 'Implement a PRD child issue locally',
      labels: [],
      parent: {
        number: 1,
        title: 'PRD',
        relationshipSource: 'native',
      },
    });
    const github = createFakeGitHub({ issue });
    const git = createFakeGit({
      hasChangesResults: [false, true],
      patch: 'diff --git a/src/file.js b/src/file.js\n',
    });
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'implemented',
        summary: 'Implemented a PRD child locally.',
        changes: ['Changed child issue code.'],
        testPlan: ['npm test -- src/operations/issue-implement/run.test.js'],
      }),
    });

    const result = await runIssueImplement(
      createContext({
        cwd,
        publicationMode: 'dry-run',
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.deepEqual(git.fetches, [
      {
        requiredBranchNames: ['main'],
        optionalBranchNames: ['pullops/prd-1', 'pullops/prd-1-issue-42'],
      },
    ]);
    assert.deepEqual(git.checkouts, [
      {
        branchName: 'pullops/prd-1-issue-42',
        baseBranch: 'pullops/prd-1',
      },
    ]);
  });

  it('20: local dry-run preserves the checked-out PullOps branch when runner output blocks', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-local-blocked-'));
    const github = createFakeGitHub({ issue: createIssue({ number: 42, labels: [] }) });
    const git = createFakeGit({ hasChangesResults: [false] });
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'blocked',
        summary: 'Need maintainer input.',
        failureReason: 'The issue lacks enough detail.',
      }),
    });

    const result = await runIssueImplement(
      createContext({
        cwd,
        publicationMode: 'dry-run',
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'blocked');
    assert.equal(result.branch, 'pullops/issue-42');
    assert.deepEqual(git.checkouts, [{ branchName: 'pullops/issue-42', baseBranch: 'main' }]);
    assert.deepEqual(git.commits, []);
    assert.deepEqual(git.pushes, []);
    assert.equal(github.comments.length, 0);
    assert.equal(github.issueLabelsAdded.length, 0);
    assert.match(
      await readFile(join(String(result.localRunRecord), 'failure-reason.txt'), 'utf8'),
      /lacks enough detail/,
    );
  });

  it('21: local dry-run checks out the PullOps branch before blocking a closed issue', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-local-closed-'));
    const github = createFakeGitHub({
      issue: createIssue({ number: 42, state: 'CLOSED', labels: [] }),
    });
    const git = createFakeGit({ hasChangesResults: [false] });
    const codex = createFakeCodexRunner({ output: '{}' });

    const result = await runIssueImplement(
      createContext({
        cwd,
        publicationMode: 'dry-run',
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'blocked');
    assert.equal(result.branch, 'pullops/issue-42');
    assert.equal(result.baseBranch, 'main');
    assert.equal(codex.calls.length, 0);
    assert.deepEqual(git.fetches, [
      {
        requiredBranchNames: ['main'],
        optionalBranchNames: ['pullops/issue-42'],
      },
    ]);
    assert.deepEqual(git.checkouts, [{ branchName: 'pullops/issue-42', baseBranch: 'main' }]);
  });

  it('22: local dry-run checks out the PullOps branch before blocking a PRD-looking issue', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-local-prd-'));
    const github = createFakeGitHub({
      issue: createIssue({
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
      }),
    });
    const git = createFakeGit({ hasChangesResults: [false] });
    const codex = createFakeCodexRunner({ output: '{}' });

    const result = await runIssueImplement(
      createContext({
        cwd,
        publicationMode: 'dry-run',
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
    assert.equal(result.branch, 'pullops/issue-1');
    assert.equal(result.baseBranch, 'main');
    assert.equal(codex.calls.length, 0);
    assert.deepEqual(git.fetches, [
      {
        requiredBranchNames: ['main'],
        optionalBranchNames: ['pullops/issue-1'],
      },
    ]);
    assert.deepEqual(git.checkouts, [{ branchName: 'pullops/issue-1', baseBranch: 'main' }]);
  });

  it('23: local dry-run checks out the PullOps branch before blocking a parent issue with children', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-local-parent-'));
    const github = createFakeGitHub({
      issue: createIssue({
        number: 1,
        title: 'PRD: Dogfood PullOps workflow kit',
        subIssues: [
          {
            number: 4,
            title: 'Implement a Child Issue',
            relationshipSource: 'native',
          },
        ],
      }),
    });
    const git = createFakeGit({ hasChangesResults: [false] });
    const codex = createFakeCodexRunner({ output: '{}' });

    const result = await runIssueImplement(
      createContext({
        cwd,
        publicationMode: 'dry-run',
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
    assert.equal(result.branch, 'pullops/issue-1');
    assert.equal(result.baseBranch, 'main');
    assert.equal(codex.calls.length, 0);
    assert.deepEqual(git.fetches, [
      {
        requiredBranchNames: ['main'],
        optionalBranchNames: ['pullops/issue-1'],
      },
    ]);
    assert.deepEqual(git.checkouts, [{ branchName: 'pullops/issue-1', baseBranch: 'main' }]);
  });

  it('24: local dry-run checks out the PullOps branch before blocking an issue with dependencies', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-local-deps-'));
    const issue = createIssue({
      number: 42,
      body: ['Blocked by: #7', '', '## What to build', '', 'Do the thing.'].join('\n'),
      labels: [],
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
    const git = createFakeGit({ hasChangesResults: [false] });
    const codex = createFakeCodexRunner({ output: '{}' });

    const result = await runIssueImplement(
      createContext({
        cwd,
        publicationMode: 'dry-run',
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'blocked');
    assert.equal(result.branch, 'pullops/issue-42');
    assert.equal(result.baseBranch, 'main');
    assert.equal(codex.calls.length, 0);
    assert.deepEqual(git.fetches, [
      {
        requiredBranchNames: ['main'],
        optionalBranchNames: ['pullops/issue-42'],
      },
    ]);
    assert.deepEqual(git.checkouts, [{ branchName: 'pullops/issue-42', baseBranch: 'main' }]);
  });

  it('25: local PR publication runs the runner, pushes, opens a managed draft PR, records audit evidence, and avoids trigger labels', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-local-publish-'));
    const issue = createIssue({ number: 42, title: 'Add local PR publication', labels: [] });
    const github = createFakeGitHub({ issue });
    const git = createFakeGit({
      currentBranch: 'main',
      hasChangesResults: [false, true, false],
      patch: 'diff --git a/src/file.js b/src/file.js\n',
    });
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'implemented',
        summary: 'Implemented local PR publication.',
        changes: ['Added local publish behavior.', '', '  '],
        testPlan: ['npm test -- src/operations/issue-implement/run.test.js'],
      }),
    });

    const result = await runIssueImplement(
      createContext({
        cwd,
        executionBackend: 'local',
        publicationMode: 'publish',
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
        triggerActor: 'local-user',
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(result.publicationMode, 'publish');
    assert.equal(codex.calls.length, 1);
    assert.deepEqual(git.fetches, [
      {
        requiredBranchNames: ['main'],
        optionalBranchNames: ['pullops/issue-42'],
      },
    ]);
    assert.deepEqual(git.checkouts, [{ branchName: 'pullops/issue-42', baseBranch: 'main' }]);
    assert.deepEqual(git.pushes, [{ branchName: 'pullops/issue-42' }]);
    assert.equal(github.createdPullRequests.length, 1);
    assert.match(github.createdPullRequests[0].body, /^## PullOps$/m);
    assert.match(github.createdPullRequests[0].body, /^Managed: yes$/m);
    assert.match(github.createdPullRequests[0].body, /Status: Draft automation/);
    assert.match(github.createdPullRequests[0].body, /^## PullOps Link Summary$/m);
    assert.match(github.createdPullRequests[0].body, /^Source Issue: #42$/m);
    assert.deepEqual(github.pullRequestLabels, []);
    assert.deepEqual(github.issueLabelsAdded, []);
    assert.deepEqual(github.pullRequestComments, [
      {
        number: 100,
        body: [
          'Implemented local PR publication.',
          '',
          '---',
          '',
          '<details>',
          '<summary>PullOps operation audit</summary>',
          '',
          'Operation: pullops:issue:implement',
          'Trigger actor: @local-user',
          'Model tier: high',
          'Model: gpt-5.5',
          'Context used: unknown',
          '</details>',
        ].join('\n'),
      },
    ]);
    assert.deepEqual(github.issueLabelsRemoved.at(-1), {
      number: 42,
      labels: ['pullops:issue:implement', 'pullops:human-required'],
    });

    const metadata = JSON.parse(
      await readFile(join(String(result.localRunRecord), 'metadata.json'), 'utf8'),
    );
    assert.equal(metadata.publicationMode, 'publish');
    const validatedOutput = JSON.parse(
      await readFile(join(String(result.localRunRecord), 'validated-output.json'), 'utf8'),
    );
    assert.deepEqual(validatedOutput.changes, ['Added local publish behavior.']);
  });

  it('26: local PR publication publishes a clean prepared branch without rerunning the runner', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-local-prepared-publish-'));
    const issue = createIssue({ number: 42, title: 'Publish prepared branch', labels: [] });
    const github = createFakeGitHub({ issue });
    const git = createFakeGit({
      currentBranch: 'pullops/issue-42',
      hasChangesResults: [false, false],
      commitsSinceBase: [
        {
          sha: 'abc123',
          subject: 'feat(issue): implement #42',
          body: 'Refs: #42',
          files: ['src/file.js'],
        },
      ],
    });
    const codex = createFakeCodexRunner({ output: '{}' });

    const result = await runIssueImplement(
      createContext({
        cwd,
        executionBackend: 'local',
        publicationMode: 'publish',
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(result.preparedBranch, true);
    assert.equal(codex.calls.length, 0);
    assert.deepEqual(git.checkouts, [{ branchName: 'pullops/issue-42', baseBranch: 'main' }]);
    assert.deepEqual(git.pushes, [{ branchName: 'pullops/issue-42' }]);
    assert.equal(github.createdPullRequests.length, 1);
    assert.match(
      github.createdPullRequests[0].body,
      /Published local commit: feat\(issue\): implement #42/,
    );
    assert.match(github.createdPullRequests[0].body, /^## PullOps Link Summary$/m);
    assert.deepEqual(github.pullRequestLabels, []);
    assert.equal(github.pullRequestComments.length, 1);
  });

  it('27: local PR publication refuses a dirty worktree before push or GitHub mutation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-local-publish-dirty-'));
    const github = createFakeGitHub({ issue: createIssue({ number: 42, labels: [] }) });
    const git = createFakeGit({ hasChangesResults: [true] });
    const codex = createFakeCodexRunner({ output: '{}' });

    await assert.rejects(
      runIssueImplement(
        createContext({
          cwd,
          executionBackend: 'local',
          publicationMode: 'publish',
          githubClient: github.client,
          gitClient: git.client,
          codexRunner: codex.runner,
        }),
      ),
      /requires a clean worktree/,
    );

    assert.equal(codex.calls.length, 0);
    assert.deepEqual(git.pushes, []);
    assert.deepEqual(git.fetches, []);
    assert.deepEqual(github.issueLookups, []);
    assert.equal(github.createdPullRequests.length, 0);
    assert.equal(github.pullRequestComments.length, 0);
    assert.equal(github.issueLabelsAdded.length, 0);
    assert.equal(github.issueLabelsRemoved.length, 0);
  });

  it('28: local PR publication updates an existing managed PR body and records audit evidence without trigger labels', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-local-update-pr-'));
    const issue = createIssue({ number: 42, title: 'Update existing PR', labels: [] });
    const github = createFakeGitHub({
      issue,
      existingPullRequest: {
        number: 7,
        title: 'Existing PR',
        url: 'https://github.com/acme/widgets/pull/7',
        headRefName: 'pullops/issue-42',
        body: 'old body',
        isDraft: true,
      },
    });
    const git = createFakeGit({
      currentBranch: 'main',
      hasChangesResults: [false, false],
      commitsSinceBase: [
        {
          sha: 'def456',
          subject: 'feat(issue): update existing PR',
          body: 'Refs: #42',
          files: ['src/file.js'],
        },
      ],
    });
    const codex = createFakeCodexRunner({ output: '{}' });

    const result = await runIssueImplement(
      createContext({
        cwd,
        executionBackend: 'local',
        publicationMode: 'publish',
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    const output = /** @type {{ status: string, pullRequest: { number: number } }} */ (result);
    assert.equal(output.status, 'accepted');
    assert.equal(output.pullRequest.number, 7);
    assert.equal(codex.calls.length, 0);
    assert.equal(github.createdPullRequests.length, 0);
    assert.equal(github.updatedPullRequestBodies.length, 1);
    assert.equal(github.updatedPullRequestBodies[0].number, 7);
    assert.match(github.updatedPullRequestBodies[0].body, /^## PullOps$/m);
    assert.match(github.updatedPullRequestBodies[0].body, /^Managed: yes$/m);
    assert.match(github.updatedPullRequestBodies[0].body, /^## PullOps Link Summary$/m);
    assert.deepEqual(github.pullRequestLabels, []);
    assert.deepEqual(
      github.pullRequestComments.map(comment => comment.number),
      [7],
    );
  });

  it('29: local PR publication checks out the PullOps branch before reporting blocked publish mode', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-local-publish-closed-'));
    const github = createFakeGitHub({
      issue: createIssue({ number: 42, state: 'CLOSED', labels: [] }),
    });
    const git = createFakeGit({ hasChangesResults: [false] });
    const codex = createFakeCodexRunner({ output: '{}' });

    const result = await runIssueImplement(
      createContext({
        cwd,
        executionBackend: 'local',
        publicationMode: 'publish',
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'blocked');
    assert.equal(result.publicationMode, 'publish');
    assert.equal(result.branch, 'pullops/issue-42');
    assert.equal(result.baseBranch, 'main');
    assert.equal(codex.calls.length, 0);
    assert.deepEqual(git.fetches, [
      {
        requiredBranchNames: ['main'],
        optionalBranchNames: ['pullops/issue-42'],
      },
    ]);
    assert.deepEqual(git.checkouts, [{ branchName: 'pullops/issue-42', baseBranch: 'main' }]);
    assert.equal(github.createdPullRequests.length, 0);
  });

  it('30: local dry-run finalized runs ordered follow-up operations and keeps GitHub unmutated', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-local-finalized-dry-run-'));
    const issue = createIssue({
      number: 42,
      title: 'Finalize locally',
      labels: [],
      parent: {
        number: 1,
        title: 'PRD',
        relationshipSource: 'native',
      },
    });
    const github = createFakeGitHub({
      issue,
      existingPullRequests: [
        {
          number: 7,
          title: 'Umbrella PR',
          url: 'https://github.com/acme/widgets/pull/7',
          headRefName: 'pullops/prd-1',
          body: '',
          isDraft: true,
        },
      ],
    });
    const git = createFakeGit({
      hasChangesResults: [false, true, false, false],
      changedFilesSinceBase: ['src/file.js'],
      currentTreeHash: 'tree-finalized',
      currentHeadSha: 'head-finalized',
    });
    /** @type {PullOpsConfig} */
    const config = {
      ...DEFAULT_PULL_OPS_CONFIG,
      runner: {
        ...DEFAULT_PULL_OPS_CONFIG.runner,
        models: {
          high: 'model-high',
          mid: 'model-mid',
          low: 'model-low',
        },
      },
      operations: {
        ...DEFAULT_PULL_OPS_CONFIG.operations,
        prReview: {
          modelTier: 'low',
          escalationModelTier: 'high',
          humanFeedbackResponseModelTier: 'high',
        },
        prAddressReview: {
          modelTier: 'mid',
          escalationModelTier: 'high',
          humanFeedbackResponseModelTier: 'high',
        },
        prFinalize: {
          ...DEFAULT_PULL_OPS_CONFIG.operations.prFinalize,
          modelTier: 'low',
        },
      },
    };
    const codex = createFakeCodexRunner({
      output: [
        JSON.stringify({
          status: 'implemented',
          summary: 'Implemented local finalized dry-run.',
          changes: ['Added behavior.'],
          testPlan: ['node --test src/operations/issue-implement/run.test.js'],
        }),
        JSON.stringify({
          status: 'changes_requested',
          summary: 'Needs a small fix.',
          comments: [{ path: 'src/file.js', line: 1, body: 'Tighten this.' }],
          replies: [],
          directChanges: [],
          followUps: [],
        }),
        JSON.stringify({
          status: 'addressed',
          summary: 'Addressed review.',
          addressed: [
            { feedbackId: 'local-review-summary:1', response: 'Applied the requested follow-up.' },
            { feedbackId: 'local-review-comment:1', response: 'Tightened this.' },
          ],
          declined: [],
          deferred: [],
          changes: ['Tightened implementation.'],
          testPlan: ['node --test src/operations/issue-implement/run.test.js'],
          followUps: [],
        }),
        JSON.stringify({
          status: 'approved',
          summary: 'Ready.',
          comments: [],
          replies: [],
          directChanges: [],
          followUps: [],
        }),
        JSON.stringify({
          status: 'planned',
          summary: 'Finalize the branch.',
          commitPlan: {
            commits: [
              {
                header: 'feat(issue): implement #42',
                body: ['Finalize local issue implementation.'],
                footers: ['Closes #42'],
                files: ['src/file.js'],
              },
            ],
          },
          followUps: [],
        }),
      ],
    });

    const result = await runIssueImplement(
      createContext({
        cwd,
        config,
        executionBackend: 'local',
        publicationMode: 'dry-run',
        runGoal: 'finalized',
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
        model: 'model-high',
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(result.runGoal, 'finalized');
    assert.deepEqual(
      codex.calls.map(call => call.prompt.match(/Use the ([^ ]+) skill/)?.[1]),
      [
        'pullops-issue-implement',
        'pullops-pr-review',
        'pullops-pr-address-review',
        'pullops-pr-review',
        'pullops-pr-finalize',
      ],
    );
    assert.deepEqual(
      codex.calls.map(call => call.model),
      ['model-high', 'model-low', 'model-mid', 'model-low', 'model-low'],
    );
    assert.deepEqual(git.pushes, []);
    assert.deepEqual(git.forcePushes, []);
    assert.equal(git.rewrites.length, 1);
    assert.equal(git.rewrites[0].push, false);
    assert.equal(github.createdPullRequests.length, 0);
    assert.equal(github.pullRequestComments.length, 0);
    assert.deepEqual(github.readyPullRequests, []);
    assert.match(codex.calls[2].prompt, /Local Run Record:/);
    assert.match(codex.calls[2].prompt, /Issue #42: Finalize locally/);
    assert.match(codex.calls[2].prompt, /Pull request body:/);
    assert.match(codex.calls[2].prompt, /Actionable PR Feedback:/);
    assert.match(codex.calls[2].prompt, /Tighten this\./);
    assert.match(codex.calls[2].prompt, /01-pr-review-evidence\.json/);
    assert.match(codex.calls[4].prompt, /Changed files since base:/);
    assert.match(codex.calls[4].prompt, /Prior local follow-up evidence:/);

    const localRunRecord = String(result.localRunRecord);
    const reviewComments = JSON.parse(
      await readFile(join(localRunRecord, 'review-comments.json'), 'utf8'),
    );
    assert.deepEqual(reviewComments, [{ path: 'src/file.js', line: 1, body: 'Tighten this.' }]);
    const ciFollowUp = JSON.parse(
      await readFile(join(localRunRecord, 'ci-follow-up.json'), 'utf8'),
    );
    assert.deepEqual(ciFollowUp, {
      mode: 'await-hosted-checks',
      status: 'pending-publication',
      operation: 'pr:fix-ci',
      finalizedHeadSha: 'head-finalized',
      finalizedTreeHash: 'tree-finalized',
      branch: 'pullops/prd-1-issue-42',
      publicationMode: 'dry-run',
      reason:
        'Local finalized runs cannot observe hosted checks for the finalized head before publication.',
    });
    const finalizedBody = await readFile(join(localRunRecord, 'finalized-pr-body.md'), 'utf8');
    assert.match(finalizedBody, /Status: Ready for human merge/);
    assert.match(finalizedBody, /^Umbrella PR: #7$/m);
  });

  it('31: local dry-run finalized reuses a prepared local branch without rerunning implement', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-local-finalized-prepared-dry-run-'));
    const issue = createIssue({ number: 42, title: 'Finalize prepared branch', labels: [] });
    const github = createFakeGitHub({ issue });
    const git = createFakeGit({
      currentBranch: 'pullops/issue-42',
      hasChangesResults: [false, false],
      commitsSinceBase: [
        {
          sha: 'abc123',
          subject: 'feat(issue): implement #42',
          body: 'Refs: #42',
          files: ['README.md'],
        },
      ],
      changedFilesSinceBase: ['README.md'],
      currentTreeHash: 'tree-finalized',
      currentHeadSha: 'head-finalized',
    });
    const codex = createFakeCodexRunner({
      output: [
        JSON.stringify({
          status: 'approved',
          summary: 'Prepared branch is ready.',
          comments: [],
          replies: [],
          directChanges: [],
          followUps: [],
        }),
        JSON.stringify({
          status: 'planned',
          summary: 'Finalize the prepared branch.',
          commitPlan: {
            commits: [
              {
                header: 'feat(issue): implement #42',
                body: ['Finalize prepared local issue implementation.'],
                footers: ['Closes #42'],
                files: ['README.md'],
              },
            ],
          },
          followUps: [],
        }),
      ],
    });

    const result = await runIssueImplement(
      createContext({
        cwd,
        executionBackend: 'local',
        publicationMode: 'dry-run',
        runGoal: 'finalized',
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(result.preparedBranch, true);
    assert.equal(result.runGoal, 'finalized');
    assert.deepEqual(
      codex.calls.map(call => call.prompt.match(/Use the ([^ ]+) skill/)?.[1]),
      ['pullops-pr-review', 'pullops-pr-finalize'],
    );
    assert.deepEqual(git.checkouts, [{ branchName: 'pullops/issue-42', baseBranch: 'main' }]);
    assert.deepEqual(git.commits, []);
    assert.equal(git.rewrites.length, 1);
    assert.equal(git.rewrites[0].push, false);
    assert.deepEqual(git.pushes, []);
    assert.deepEqual(github.createdPullRequests, []);

    const localRunRecord = String(result.localRunRecord);
    const output = JSON.parse(
      await readFile(join(localRunRecord, 'validated-output.json'), 'utf8'),
    );
    assert.deepEqual(output.changes, ['Published local commit: feat(issue): implement #42']);
    const finalizedBody = await readFile(join(localRunRecord, 'finalized-pr-body.md'), 'utf8');
    assert.match(finalizedBody, /Status: Ready for human merge/);
    assert.match(finalizedBody, /^Closes: #42$/m);
  });

  it('32: local finalized PR publication delays GitHub mutation and marks the PR ready', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-local-finalized-publish-'));
    const issue = createIssue({
      number: 42,
      title: 'Publish finalized PR',
      labels: [],
      parent: {
        number: 1,
        title: 'PRD',
        relationshipSource: 'native',
      },
    });
    const github = createFakeGitHub({
      issue,
      existingPullRequests: [
        {
          number: 7,
          title: 'Umbrella PR',
          url: 'https://github.com/acme/widgets/pull/7',
          headRefName: 'pullops/prd-1',
          body: '',
          isDraft: true,
        },
      ],
    });
    const git = createFakeGit({
      hasChangesResults: [false, true, false, false],
      changedFilesSinceBase: ['src/file.js'],
      currentTreeHash: 'tree-finalized',
      currentHeadSha: 'head-finalized',
    });
    const codex = createFakeCodexRunner({
      output: [
        JSON.stringify({
          status: 'implemented',
          summary: 'Implemented finalized publication.',
          changes: ['Added delayed publication.'],
          testPlan: ['node --test src/operations/issue-implement/run.test.js'],
        }),
        JSON.stringify({
          status: 'approved',
          summary: 'Ready.',
          comments: [],
          replies: [],
          directChanges: [],
          followUps: [],
        }),
        JSON.stringify({
          status: 'planned',
          summary: 'Finalize the branch.',
          commitPlan: {
            commits: [
              {
                header: 'feat(issue): implement #42',
                body: ['Finalize local issue implementation.'],
                footers: ['Closes #42'],
                files: ['src/file.js'],
              },
            ],
          },
          followUps: [],
        }),
      ],
    });

    const result = await runIssueImplement(
      createContext({
        cwd,
        executionBackend: 'local',
        publicationMode: 'publish',
        runGoal: 'finalized',
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    const output = /** @type {{ status: string, pullRequest: { draft: boolean } }} */ (result);
    assert.equal(output.status, 'accepted');
    assert.equal(output.pullRequest.draft, false);
    assert.equal(github.createdPullRequests.length, 1);
    assert.match(github.createdPullRequests[0].body, /Status: Ready for human merge/);
    assert.match(github.createdPullRequests[0].body, /^Umbrella PR: #7$/m);
    assert.deepEqual(github.readyPullRequests, [100]);
    assert.deepEqual(github.pullRequestLabels, []);
    assert.deepEqual(git.pushes, []);
    assert.deepEqual(git.forcePushes, [{ branchName: 'pullops/prd-1-issue-42' }]);
    assert.equal(git.rewrites.length, 1);
    assert.equal(git.rewrites[0].push, false);
    assert.equal(codex.calls.length, 3);
  });

  it('32b: local finalized PR publication recreates missing run state before terminal recording', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-local-finalized-missing-state-'));
    const issue = createIssue({
      number: 42,
      title: 'Publish finalized PR',
      labels: [],
      parent: {
        number: 1,
        title: 'PRD',
        relationshipSource: 'native',
      },
    });
    const github = createFakeGitHub({
      issue,
      existingPullRequests: [
        {
          number: 7,
          title: 'Umbrella PR',
          url: 'https://github.com/acme/widgets/pull/7',
          headRefName: 'pullops/prd-1',
          body: '',
          isDraft: true,
        },
      ],
    });
    const git = createFakeGit({
      currentBranch: 'main',
      hasChangesResults: [false, true, false, false],
      changedFilesSinceBase: ['src/file.js'],
      currentTreeHash: 'tree-finalized',
      currentHeadSha: 'head-finalized',
    });
    git.client.pushBranchWithLease = async options => {
      git.forcePushes.push(options);
      const runDirectoryNames = await readdir(join(cwd, '.pullops', 'runs'));
      const runDirectoryName = runDirectoryNames.find(name => name.endsWith('issue-implement-42'));
      assert(runDirectoryName);
      await rm(join(cwd, '.pullops', 'runs', runDirectoryName, 'state.json'), { force: true });
      return {
        status: 'pushed',
        headSha: 'head-finalized',
        treeHash: 'tree-finalized',
      };
    };
    const codex = createFakeCodexRunner({
      output: [
        JSON.stringify({
          status: 'implemented',
          summary: 'Implemented finalized publication.',
          changes: ['Added delayed publication.'],
          testPlan: ['node --test src/operations/issue-implement/run.test.js'],
        }),
        JSON.stringify({
          status: 'approved',
          summary: 'Ready.',
          comments: [],
          replies: [],
          directChanges: [],
          followUps: [],
        }),
        JSON.stringify({
          status: 'planned',
          summary: 'Finalize the branch.',
          commitPlan: {
            commits: [
              {
                header: 'feat(issue): implement #42',
                body: ['Finalize local issue implementation.'],
                footers: ['Closes #42'],
                files: ['src/file.js'],
              },
            ],
          },
          followUps: [],
        }),
      ],
    });

    const result = await runIssueImplement(
      createContext({
        cwd,
        executionBackend: 'local',
        publicationMode: 'publish',
        runGoal: 'finalized',
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    const state = JSON.parse(
      await readFile(join(String(result.localRunRecord), 'state.json'), 'utf8'),
    );
    assert.equal(state.status, 'accepted');
    assert.equal(state.lastEvent.status, 'accepted');
  });

  it('33: local finalized PR publication reuses a successful finalized dry-run record', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-local-finalized-publish-existing-'));
    const previousRunRecord = join(
      cwd,
      '.pullops',
      'runs',
      '2026-06-18T120000000Z-issue-implement-42',
    );
    await mkdir(previousRunRecord, { recursive: true });
    await writeFile(
      join(previousRunRecord, 'metadata.json'),
      `${JSON.stringify(
        {
          operation: 'pullops:issue:implement',
          operationReference: 'issue:implement',
          target: {
            type: 'issue',
            number: 42,
          },
          branch: 'pullops/issue-42',
          baseBranch: 'main',
          publicationMode: 'dry-run',
          runGoal: 'finalized',
          modelTier: 'high',
          model: 'gpt-5.5',
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(previousRunRecord, 'validated-output.json'),
      `${JSON.stringify(
        {
          status: 'implemented',
          summary: 'Implemented finalized dry-run.',
          changes: ['Added the finalized behavior.'],
          testPlan: ['node --test src/operations/issue-implement/run.test.js'],
          followUps: [],
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(previousRunRecord, 'finalized-pr-body.md'),
      [
        '## PullOps',
        '',
        'Managed: yes',
        'Status: Ready for human merge',
        '',
        '## PullOps Link Summary',
        '',
        'Kind: Concrete Issue PR',
        'Source Issue: #42',
        'Closes: #42',
        '',
      ].join('\n'),
    );
    await writeFile(
      join(previousRunRecord, 'ci-follow-up.json'),
      `${JSON.stringify(
        {
          mode: 'await-hosted-checks',
          status: 'pending-publication',
          operation: 'pr:fix-ci',
          finalizedHeadSha: 'head-finalized',
          finalizedTreeHash: 'tree-finalized',
          branch: 'pullops/issue-42',
          publicationMode: 'dry-run',
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(previousRunRecord, 'follow-up-operations.json'),
      `${JSON.stringify(['pr:review', 'pr:finalize'], null, 2)}\n`,
    );
    await writeFile(
      join(previousRunRecord, '01-pr-review-evidence.json'),
      `${JSON.stringify(
        {
          operation: 'pr:review',
          output: {
            status: 'approved',
            summary: 'Prepared branch passed local review.',
            comments: [],
            replies: [],
            directChanges: [],
            followUps: [],
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(previousRunRecord, '02-pr-finalize-evidence.json'),
      `${JSON.stringify(
        {
          operation: 'pr:finalize',
          output: {
            status: 'planned',
            summary: 'Finalized the reviewed branch.',
            commitPlan: {
              commits: [
                {
                  header: 'feat(issue): implement #42',
                  body: ['Finalize prepared local issue implementation.'],
                  footers: ['Closes #42'],
                  files: ['README.md'],
                },
              ],
            },
            followUps: [],
          },
        },
        null,
        2,
      )}\n`,
    );

    const issue = createIssue({ number: 42, title: 'Publish finalized dry-run', labels: [] });
    const github = createFakeGitHub({ issue });
    const git = createFakeGit({
      currentBranch: 'main',
      hasChangesResults: [false, false],
      commitsSinceBase: [
        {
          sha: 'abc123',
          subject: 'feat(issue): implement #42',
          body: 'Refs: #42',
          files: ['README.md'],
        },
      ],
      currentTreeHash: 'tree-finalized',
      currentHeadSha: 'head-finalized',
    });
    const codex = createFakeCodexRunner({ output: [] });

    const result = await runIssueImplement(
      createContext({
        cwd,
        executionBackend: 'local',
        publicationMode: 'publish',
        runGoal: 'finalized',
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(result.preparedBranch, true);
    assert.equal(result.reusedLocalRunRecord, previousRunRecord);
    assert.equal(codex.calls.length, 0);
    assert.deepEqual(git.checkouts, [{ branchName: 'pullops/issue-42', baseBranch: 'main' }]);
    assert.deepEqual(git.rewrites, []);
    assert.deepEqual(git.forcePushes, [{ branchName: 'pullops/issue-42' }]);
    assert.equal(github.createdPullRequests.length, 1);
    assert.match(github.createdPullRequests[0].body, /Status: Ready for human merge/);
    assert.doesNotMatch(github.createdPullRequests[0].body, /Published local commit/);
    assert.deepEqual(github.readyPullRequests, [100]);
    assert.deepEqual(
      github.pullRequestComments.map(comment => ({
        number: comment.number,
        summary: comment.body.split('\n')[0],
        operation: comment.body.match(/^Operation: (.+)$/m)?.[1],
      })),
      [
        {
          number: 100,
          summary: 'Implemented finalized dry-run.',
          operation: 'pullops:issue:implement',
        },
        {
          number: 100,
          summary: 'Prepared branch passed local review.',
          operation: 'pullops:pr:review',
        },
        {
          number: 100,
          summary: 'Finalized the reviewed branch.',
          operation: 'pullops:pr:finalize',
        },
      ],
    );

    const publishRunRecord = String(result.localRunRecord);
    assert.notEqual(publishRunRecord, previousRunRecord);
    assert.equal(
      await readFile(join(publishRunRecord, 'reused-local-run-record.txt'), 'utf8'),
      `${previousRunRecord}\n`,
    );
  });

  it('34: local finalized runs continue past three review cycles before approval', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-local-finalized-fourth-review-'));
    const issue = createIssue({ number: 42, title: 'Approve after repeated local review' });
    const github = createFakeGitHub({ issue });
    const git = createFakeGit({
      hasChangesResults: [false, true, false, false, false, false, false, false, false, false],
      changedFilesSinceBase: ['src/file.js'],
      currentTreeHash: 'tree-finalized',
      currentHeadSha: 'head-finalized',
    });
    /** @param {number} cycle */
    const createReviewOutput = cycle =>
      JSON.stringify({
        status: 'changes_requested',
        summary: `Review ${cycle}.`,
        comments: [],
        replies: [],
        directChanges: [],
        followUps: [],
      });
    /** @param {number} cycle */
    const createAddressOutput = cycle =>
      JSON.stringify({
        status: 'addressed',
        summary: `Addressed review ${cycle}.`,
        addressed: [
          {
            feedbackId: 'local-review-summary:1',
            response: `Applied review ${cycle}.`,
          },
        ],
        declined: [],
        deferred: [],
        changes: [],
        testPlan: [],
        followUps: [],
      });
    const codex = createFakeCodexRunner({
      output: [
        JSON.stringify({
          status: 'implemented',
          summary: 'Implemented with several review passes.',
          changes: ['Changed code.'],
          testPlan: ['node --test src/operations/issue-implement/run.test.js'],
        }),
        createReviewOutput(1),
        createAddressOutput(1),
        createReviewOutput(2),
        createAddressOutput(2),
        createReviewOutput(3),
        createAddressOutput(3),
        JSON.stringify({
          status: 'approved',
          summary: 'Fourth review approved.',
          comments: [],
          replies: [],
          directChanges: [],
          followUps: [],
        }),
        JSON.stringify({
          status: 'planned',
          summary: 'Finalize the branch.',
          commitPlan: {
            commits: [
              {
                header: 'feat(issue): implement #42',
                body: ['Finalize local issue implementation.'],
                footers: ['Closes #42'],
                files: ['src/file.js'],
              },
            ],
          },
          followUps: [],
        }),
      ],
    });

    const result = await runIssueImplement(
      createContext({
        cwd,
        executionBackend: 'local',
        publicationMode: 'dry-run',
        runGoal: 'finalized',
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.deepEqual(
      codex.calls.map(call => call.prompt.match(/Use the ([^ ]+) skill/)?.[1]),
      [
        'pullops-issue-implement',
        'pullops-pr-review',
        'pullops-pr-address-review',
        'pullops-pr-review',
        'pullops-pr-address-review',
        'pullops-pr-review',
        'pullops-pr-address-review',
        'pullops-pr-review',
        'pullops-pr-finalize',
      ],
    );
    assert.equal(git.rewrites.length, 1);
  });

  it('35: local finalized runs block when the generous review guard is exhausted', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-local-finalized-blocked-'));
    const issue = createIssue({ number: 42, title: 'Block exhausted reviews', labels: [] });
    const github = createFakeGitHub({ issue });
    const git = createFakeGit({
      hasChangesResults: [false, true, ...Array(40).fill(false)],
    });
    const exhaustedCycleOutputs = [];
    for (let cycle = 1; cycle <= 12; cycle += 1) {
      exhaustedCycleOutputs.push(
        JSON.stringify({
          status: 'changes_requested',
          summary: `Review ${cycle}.`,
          comments: [],
          replies: [],
          directChanges: [],
          followUps: [],
        }),
      );
      if (cycle < 12) {
        exhaustedCycleOutputs.push(
          JSON.stringify({
            status: 'addressed',
            summary: `Addressed review ${cycle}.`,
            addressed: [
              {
                feedbackId: 'local-review-summary:1',
                response: `Applied review ${cycle}.`,
              },
            ],
            declined: [],
            deferred: [],
            changes: [],
            testPlan: [],
            followUps: [],
          }),
        );
      }
    }
    const codex = createFakeCodexRunner({
      output: [
        JSON.stringify({
          status: 'implemented',
          summary: 'Implemented with review issues.',
          changes: ['Changed code.'],
          testPlan: ['node --test src/operations/issue-implement/run.test.js'],
        }),
        ...exhaustedCycleOutputs,
      ],
    });

    const result = await runIssueImplement(
      createContext({
        cwd,
        executionBackend: 'local',
        publicationMode: 'dry-run',
        runGoal: 'finalized',
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'blocked');
    assert.match(String(result.summary), /Review Cycles are exhausted \(12 \/ 12\)/);
    assert.equal(result.branch, 'pullops/issue-42');
    assert.equal(result.baseBranch, 'main');
    assert.deepEqual(git.pushes, []);
    assert.equal(github.createdPullRequests.length, 0);
    assert.equal(codex.calls.length, 24);
    assert.match(
      await readFile(join(String(result.localRunRecord), 'failure-reason.txt'), 'utf8'),
      /Review Cycles are exhausted \(12 \/ 12\)/,
    );
  });

  it('36: local finalized approval commits direct review changes before finalization continues', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-local-finalized-review-direct-changes-'));
    const issue = createIssue({ number: 42, title: 'Commit review-owned changes locally' });
    const github = createFakeGitHub({ issue });
    const git = createFakeGit({
      hasChangesResults: [false, true, true],
      patch: 'diff --git a/src/file.js b/src/file.js\n+review change\n',
      changedFilesSinceBase: ['src/file.js'],
      currentTreeHash: 'tree-finalized',
      currentHeadSha: 'head-finalized',
    });
    const codex = createFakeCodexRunner({
      output: [
        JSON.stringify({
          status: 'implemented',
          summary: 'Implemented local finalized dry-run.',
          changes: ['Added behavior.'],
          testPlan: ['node --test src/operations/issue-implement/run.test.js'],
        }),
        JSON.stringify({
          status: 'approved',
          summary: 'Ready after a tiny review-owned fix.',
          comments: [],
          replies: [],
          directChanges: ['Normalized a local coding-standards issue.'],
          followUps: [],
        }),
        JSON.stringify({
          status: 'planned',
          summary: 'Finalize the branch.',
          commitPlan: {
            commits: [
              {
                header: 'feat(issue): implement #42',
                body: ['Finalize local issue implementation.'],
                footers: ['Closes #42'],
                files: ['src/file.js'],
              },
            ],
          },
          followUps: [],
        }),
      ],
    });

    const result = await runIssueImplement(
      createContext({
        cwd,
        executionBackend: 'local',
        publicationMode: 'dry-run',
        runGoal: 'finalized',
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.deepEqual(git.commits, [
      {
        message: [
          'feat(issue): implement #42',
          '',
          'Implement Commit review-owned changes locally.',
          '',
          'Refs: #42',
        ].join('\n'),
        author: GITHUB_ACTIONS_BOT_AUTHOR,
      },
      {
        message: [
          'chore(review): apply local review improvements for #42',
          '',
          '- Normalized a local coding-standards issue.',
          '',
          'Refs: #42',
        ].join('\n'),
        author: GITHUB_ACTIONS_BOT_AUTHOR,
      },
    ]);
  });

  it('37: local finalized runs block when address-review omits local feedback coverage', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-local-finalized-address-coverage-'));
    const issue = createIssue({ number: 42, title: 'Cover every local feedback item', labels: [] });
    const github = createFakeGitHub({ issue });
    const git = createFakeGit({
      hasChangesResults: [false, true, false],
      changedFilesSinceBase: ['src/file.js'],
      currentTreeHash: 'tree-finalized',
      currentHeadSha: 'head-finalized',
    });
    const codex = createFakeCodexRunner({
      output: [
        JSON.stringify({
          status: 'implemented',
          summary: 'Implemented local finalized dry-run.',
          changes: ['Added behavior.'],
          testPlan: ['node --test src/operations/issue-implement/run.test.js'],
        }),
        JSON.stringify({
          status: 'changes_requested',
          summary: 'Needs a small fix.',
          comments: [{ path: 'src/file.js', line: 1, body: 'Tighten this.' }],
          replies: [],
          directChanges: [],
          followUps: [],
        }),
        JSON.stringify({
          status: 'addressed',
          summary: 'Addressed review.',
          addressed: [],
          declined: [],
          deferred: [],
          changes: ['Tightened implementation.'],
          testPlan: ['node --test src/operations/issue-implement/run.test.js'],
          followUps: [],
        }),
      ],
    });

    const result = await runIssueImplement(
      createContext({
        cwd,
        executionBackend: 'local',
        publicationMode: 'dry-run',
        runGoal: 'finalized',
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'blocked');
    assert.match(
      String(result.summary),
      /Invalid Address Review Output: Feedback item "local-review-summary:1" must be classified/,
    );
    assert.equal(codex.calls.length, 3);
    assert.match(
      await readFile(join(String(result.localRunRecord), 'failure-reason.txt'), 'utf8'),
      /local-review-summary:1/,
    );
    assert.deepEqual(
      git.commits.map(commit => commit.message),
      [
        [
          'feat(issue): implement #42',
          '',
          'Implement Cover every local feedback item.',
          '',
          'Refs: #42',
        ].join('\n'),
        ['fix(issue): address review for #42', '', 'Refs: #42'].join('\n'),
      ],
    );
  });

  it('38: local finalized tree mismatch restores the reviewed head before blocking', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-local-finalized-tree-mismatch-'));
    const issue = createIssue({ number: 42, title: 'Restore reviewed head on finalize mismatch' });
    const github = createFakeGitHub({ issue });
    const git = createFakeGit({
      hasChangesResults: [false, true, false],
      changedFilesSinceBase: ['src/file.js'],
      currentTreeHash: 'tree-reviewed',
      currentHeadSha: 'head-reviewed',
      rewrittenTreeHash: 'tree-rewritten',
      rewrittenHeadSha: 'head-rewritten',
    });
    const codex = createFakeCodexRunner({
      output: [
        JSON.stringify({
          status: 'implemented',
          summary: 'Implemented local finalized dry-run.',
          changes: ['Added behavior.'],
          testPlan: ['node --test src/operations/issue-implement/run.test.js'],
        }),
        JSON.stringify({
          status: 'approved',
          summary: 'Ready.',
          comments: [],
          replies: [],
          directChanges: [],
          followUps: [],
        }),
        JSON.stringify({
          status: 'planned',
          summary: 'Finalize the branch.',
          commitPlan: {
            commits: [
              {
                header: 'feat(issue): implement #42',
                body: ['Finalize local issue implementation.'],
                footers: ['Closes #42'],
                files: ['src/file.js'],
              },
            ],
          },
          followUps: [],
        }),
      ],
    });

    const result = await runIssueImplement(
      createContext({
        cwd,
        executionBackend: 'local',
        publicationMode: 'dry-run',
        runGoal: 'finalized',
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'blocked');
    assert.match(
      String(result.summary),
      /Finalized tree tree-rewritten did not match reviewed tree/,
    );
    assert.deepEqual(git.hardResets, [{ revision: 'head-reviewed' }]);
    assert.equal(github.createdPullRequests.length, 0);
  });

  it('39: local finalized rewrite failures restore the reviewed head and return a blocked result', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-local-finalized-rewrite-failure-'));
    const issue = createIssue({ number: 42, title: 'Restore reviewed head on rewrite failure' });
    const github = createFakeGitHub({ issue });
    const git = createFakeGit({
      failOn(step) {
        return step === 'rewriteBranchWithCommitPlan';
      },
      hasChangesResults: [false, true, false],
      changedFilesSinceBase: ['src/file.js'],
      currentTreeHash: 'tree-reviewed',
      currentHeadSha: 'head-reviewed',
    });
    const codex = createFakeCodexRunner({
      output: [
        JSON.stringify({
          status: 'implemented',
          summary: 'Implemented local finalized dry-run.',
          changes: ['Added behavior.'],
          testPlan: ['node --test src/operations/issue-implement/run.test.js'],
        }),
        JSON.stringify({
          status: 'approved',
          summary: 'Ready.',
          comments: [],
          replies: [],
          directChanges: [],
          followUps: [],
        }),
        JSON.stringify({
          status: 'planned',
          summary: 'Finalize the branch.',
          commitPlan: {
            commits: [
              {
                header: 'feat(issue): implement #42',
                body: ['Finalize local issue implementation.'],
                footers: ['Closes #42'],
                files: ['src/file.js'],
              },
            ],
          },
          followUps: [],
        }),
      ],
    });

    const result = await runIssueImplement(
      createContext({
        cwd,
        executionBackend: 'local',
        publicationMode: 'dry-run',
        runGoal: 'finalized',
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'blocked');
    assert.match(
      String(result.summary),
      /Failed to rewrite the finalized branch: rewrite with commit plan failed/,
    );
    assert.deepEqual(git.hardResets, [{ revision: 'head-reviewed' }]);
    assert.match(
      await readFile(join(String(result.localRunRecord), 'failure-reason.txt'), 'utf8'),
      /Failed to rewrite the finalized branch/,
    );
    assert.equal(github.createdPullRequests.length, 0);
  });

  it('40: local finalized child dry-runs prefer the local PRD base branch', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-local-finalized-child-base-'));
    const issue = createIssue({
      number: 42,
      title: 'Finalize child locally',
      parent: {
        number: 1,
        title: 'PRD',
        relationshipSource: 'native',
      },
    });
    const github = createFakeGitHub({ issue });
    const git = createFakeGit({
      hasChangesResults: [false, true, false],
      changedFilesSinceBase: ['smoking.md'],
      currentTreeHash: 'tree-finalized',
      currentHeadSha: 'head-finalized',
    });
    const codex = createFakeCodexRunner({
      output: [
        JSON.stringify({
          status: 'implemented',
          summary: 'Implemented local finalized child dry-run.',
          changes: ['Added child behavior.'],
          testPlan: ['node --test src/operations/issue-implement/run.test.js'],
          followUps: [],
        }),
        JSON.stringify({
          status: 'approved',
          summary: 'Ready.',
          comments: [],
          replies: [],
          directChanges: [],
          followUps: [],
        }),
        JSON.stringify({
          status: 'planned',
          summary: 'Finalize the branch.',
          commitPlan: {
            commits: [
              {
                header: 'feat(issue): implement #42',
                body: ['Finalize local child implementation.'],
                footers: ['Refs: #42', 'PRD: #1'],
                files: ['smoking.md'],
              },
            ],
          },
          followUps: [],
        }),
      ],
    });

    const result = await runIssueImplement(
      createContext({
        cwd,
        executionBackend: 'local',
        publicationMode: 'dry-run',
        runGoal: 'finalized',
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(result.baseBranch, 'pullops/prd-1');
    assert.deepEqual(git.rebases, [
      {
        branchName: 'pullops/prd-1-issue-42',
        baseBranch: 'pullops/prd-1',
        committer: GITHUB_ACTIONS_BOT_AUTHOR,
        preferLocalBase: true,
      },
    ]);
    assert.deepEqual(git.changedFileRequests, [
      { baseBranch: 'pullops/prd-1', preferLocalBase: true },
      { baseBranch: 'pullops/prd-1', preferLocalBase: true },
      { baseBranch: 'pullops/prd-1', preferLocalBase: true },
    ]);
    assert.deepEqual(git.commitListRequests, [
      { baseBranch: 'pullops/prd-1', preferLocalBase: true },
      { baseBranch: 'pullops/prd-1', preferLocalBase: true },
      { baseBranch: 'pullops/prd-1', preferLocalBase: true },
    ]);
    assert.equal(git.rewrites.length, 1);
    assert.equal(git.rewrites[0].baseBranch, 'pullops/prd-1');
    assert.equal(git.rewrites[0].preferLocalBase, true);
    assert.equal(git.rewrites[0].push, false);
    assert.deepEqual(git.pushes, []);
    assert.equal(github.createdPullRequests.length, 0);
  });

  it('41: local finalized PR publication reports stale branch leases as blocked publication', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-local-finalized-publish-stale-lease-'));
    const issue = createIssue({
      number: 42,
      title: 'Publish finalized PR',
      labels: [],
      parent: {
        number: 1,
        title: 'PRD',
        relationshipSource: 'native',
      },
    });
    const github = createFakeGitHub({
      issue,
      existingPullRequests: [
        {
          number: 7,
          title: 'Umbrella PR',
          url: 'https://github.com/acme/widgets/pull/7',
          headRefName: 'pullops/prd-1',
          body: '',
          isDraft: true,
        },
      ],
    });
    const git = createFakeGit({
      hasChangesResults: [false, true, false, false],
      changedFilesSinceBase: ['src/file.js'],
      currentTreeHash: 'tree-finalized',
      currentHeadSha: 'head-finalized',
      pushBranchWithLeaseResults: [{ status: 'stale-lease' }],
    });
    const codex = createFakeCodexRunner({
      output: [
        JSON.stringify({
          status: 'implemented',
          summary: 'Implemented finalized publication.',
          changes: ['Added delayed publication.'],
          testPlan: ['node --test src/operations/issue-implement/run.test.js'],
        }),
        JSON.stringify({
          status: 'approved',
          summary: 'Ready.',
          comments: [],
          replies: [],
          directChanges: [],
          followUps: [],
        }),
        JSON.stringify({
          status: 'planned',
          summary: 'Finalize the branch.',
          commitPlan: {
            commits: [
              {
                header: 'feat(issue): implement #42',
                body: ['Finalize local issue implementation.'],
                footers: ['Refs: #42', 'PRD: #1'],
                files: ['src/file.js'],
              },
            ],
          },
          followUps: [],
        }),
      ],
    });

    const result = await runIssueImplement(
      createContext({
        cwd,
        executionBackend: 'local',
        publicationMode: 'publish',
        runGoal: 'finalized',
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'blocked');
    assert.equal(result.branch, 'pullops/prd-1-issue-42');
    assert.equal(result.baseBranch, 'pullops/prd-1');
    assert.equal(result.blockedPhase, 'publication');
    assert.equal(result.blockedOperation, 'issue:implement');
    assert.match(String(result.summary), /Remote branch pullops\/prd-1-issue-42 changed/);
    assert.equal(github.createdPullRequests.length, 0);
    assert.deepEqual(github.readyPullRequests, []);
    assert.deepEqual(git.forcePushes, [{ branchName: 'pullops/prd-1-issue-42' }]);
    assert.match(
      await readFile(join(String(result.localRunRecord), 'failure-reason.txt'), 'utf8'),
      /Remote branch pullops\/prd-1-issue-42 changed/,
    );
  });
});

/**
 * @param {Partial<OperationRunnerContext>} overrides
 * @returns {OperationRunnerContext}
 */
function createContext(overrides = {}) {
  return {
    operation: 'issue-implement',
    phase: 'run',
    runnerAdapter: 'codex-cli',
    runGoal: 'operation',
    target: {
      type: 'issue',
      number: 42,
    },
    cwd: '/workspace',
    config: DEFAULT_PULL_OPS_CONFIG,
    modelTier: 'high',
    model: 'gpt-5.5',
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
 * @param {{
 *   issue: GitHubIssue,
 *   issuesByNumber?: Map<number, GitHubIssue>,
 *   existingPullRequest?: GitHubPullRequest,
 *   existingPullRequests?: GitHubPullRequest[],
 * }} options
 * @returns {{
 *   createdPullRequests: CreateDraftPullRequestOptions[];
 *   issueLabelsAdded: EditLabelsOptions[];
 *   issueLabelsRemoved: EditLabelsOptions[];
 *   pullRequestLabels: EditLabelsOptions[];
 *   comments: CommentOnIssueOptions[];
 *   pullRequestComments: CommentOnPullRequestOptions[];
 *   updatedPullRequestBodies: import('../../github/types.js').UpdatePullRequestBodyOptions[];
 *   readyPullRequests: number[];
 *   issueLookups: number[];
 *   client: import('../../github/types.js').GitHubClient;
 * }}
 */
function createFakeGitHub({
  issue,
  issuesByNumber = new Map([[issue.number, issue]]),
  existingPullRequest,
  existingPullRequests = existingPullRequest === undefined ? [] : [existingPullRequest],
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
  /** @type {CommentOnPullRequestOptions[]} */
  const pullRequestComments = [];
  /** @type {import('../../github/types.js').UpdatePullRequestBodyOptions[]} */
  const updatedPullRequestBodies = [];
  /** @type {number[]} */
  const readyPullRequests = [];
  /** @type {number[]} */
  const issueLookups = [];
  return {
    createdPullRequests,
    issueLabelsAdded,
    issueLabelsRemoved,
    pullRequestLabels,
    comments,
    pullRequestComments,
    updatedPullRequestBodies,
    readyPullRequests,
    issueLookups,
    client: {
      async ensureLabels() {
        return {
          created: [],
          updated: [],
          alreadyCorrect: [],
        };
      },
      async getIssue(number) {
        issueLookups.push(number);
        const foundIssue = issuesByNumber.get(number);
        if (foundIssue === undefined) {
          throw new Error(`Unexpected issue lookup: #${number}`);
        }
        return foundIssue;
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
      async findOpenPullRequestByHead(headBranch) {
        return existingPullRequests.find(pullRequest => pullRequest.headRefName === headBranch);
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
      async closeIssue() {
        throw new Error('closeIssue was not expected in this test.');
      },
      async commentOnPullRequest(options) {
        pullRequestComments.push(options);
      },
      async updatePullRequestBody(options) {
        updatedPullRequestBodies.push(options);
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
      async resolvePullRequestReviewThread() {
        throw new Error('resolvePullRequestReviewThread was not expected in this test.');
      },
    },
  };
}

/**
 * @param {{
 *   failOn?: (action: string) => boolean,
 *   hasChangesResults?: boolean[],
 *   patch?: string,
 *   currentBranch?: string,
 *   commitsSinceBase?: import('../../git/types.js').GitCommit[],
 *   changedFilesSinceBase?: string[],
 *   currentTreeHash?: string,
 *   currentHeadSha?: string,
 *   rewrittenTreeHash?: string,
 *   rewrittenHeadSha?: string,
 *   pushBranchWithLeaseResults?: GitPushWithLeaseResult[],
 * }} [options]
 * @returns {{
 *   branches: CreateBranchOptions[];
 *   fetches: FetchRemoteRefsOptions[];
 *   checkouts: CheckoutPullOpsBranchOptions[];
 *   commits: CommitAllOptions[];
 *   emptyCommits: CommitEmptyOptions[];
 *   rebases: import('../../git/types.js').RebaseExistingBranchOntoBaseOptions[];
 *   changedFileRequests: GetChangedFilesSinceBaseOptions[];
 *   commitListRequests: GetCommitsSinceBaseOptions[];
 *   pushes: PushBranchOptions[];
 *   forcePushes: PushBranchWithLeaseOptions[];
 *   hardResets: ResetHardToRevisionOptions[];
 *   rewrites: import('../../git/types.js').RewriteBranchWithCommitPlanOptions[];
 *   client: import('../../git/types.js').GitClient;
 * }}
 */
function createFakeGit({
  failOn = () => false,
  hasChangesResults = [true],
  patch = '',
  currentBranch = 'main',
  commitsSinceBase = [],
  changedFilesSinceBase = ['src/file.js'],
  currentTreeHash = 'tree-current',
  currentHeadSha = 'head-current',
  rewrittenTreeHash = currentTreeHash,
  rewrittenHeadSha = currentHeadSha,
  pushBranchWithLeaseResults = [],
} = {}) {
  /** @type {CreateBranchOptions[]} */
  const branches = [];
  /** @type {FetchRemoteRefsOptions[]} */
  const fetches = [];
  /** @type {CheckoutPullOpsBranchOptions[]} */
  const checkouts = [];
  /** @type {CommitAllOptions[]} */
  const commits = [];
  /** @type {CommitEmptyOptions[]} */
  const emptyCommits = [];
  /** @type {import('../../git/types.js').RebaseExistingBranchOntoBaseOptions[]} */
  const rebases = [];
  /** @type {GetChangedFilesSinceBaseOptions[]} */
  const changedFileRequests = [];
  /** @type {GetCommitsSinceBaseOptions[]} */
  const commitListRequests = [];
  /** @type {PushBranchOptions[]} */
  const pushes = [];
  /** @type {PushBranchWithLeaseOptions[]} */
  const forcePushes = [];
  /** @type {ResetHardToRevisionOptions[]} */
  const hardResets = [];
  /** @type {import('../../git/types.js').RewriteBranchWithCommitPlanOptions[]} */
  const rewrites = [];

  return {
    branches,
    fetches,
    checkouts,
    commits,
    emptyCommits,
    rebases,
    changedFileRequests,
    commitListRequests,
    pushes,
    forcePushes,
    hardResets,
    rewrites,
    client: {
      async createBranch(options) {
        if (failOn('createBranch')) {
          throw new Error('create branch failed');
        }
        branches.push(options);
      },
      async fetchRemoteRefs(options) {
        if (failOn('fetchRemoteRefs')) {
          throw new Error('fetch failed');
        }
        fetches.push(options);
      },
      async checkoutPullOpsBranch(options) {
        if (failOn('checkoutPullOpsBranch')) {
          throw new Error('checkout failed');
        }
        checkouts.push(options);
      },
      async getCurrentBranch() {
        if (failOn('getCurrentBranch')) {
          throw new Error('current branch failed');
        }
        return currentBranch;
      },
      async hasChanges() {
        if (failOn('hasChanges')) {
          throw new Error('status failed');
        }
        const next = hasChangesResults.shift();
        return next ?? hasChangesResults.at(-1) ?? true;
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
      async readWorkingTreePatch() {
        return patch;
      },
      async pushBranch(options) {
        if (failOn('pushBranch')) {
          throw new Error('push failed');
        }
        pushes.push(options);
      },
      async rebaseBranchOntoBase() {
        throw new Error('rebaseBranchOntoBase was not expected in this test.');
      },
      async rebaseExistingBranchOntoBase(options) {
        if (failOn('rebaseExistingBranchOntoBase')) {
          return {
            status: 'conflicts',
            conflictedFiles: ['src/conflicted.js'],
          };
        }
        rebases.push(options);
        return {
          status: 'rebased',
          headSha: currentHeadSha,
          treeHash: currentTreeHash,
        };
      },
      async pushBranchWithLease(options) {
        if (failOn('pushBranchWithLease')) {
          throw new Error('push with lease failed');
        }
        forcePushes.push(options);
        const nextResult = pushBranchWithLeaseResults.shift();
        if (nextResult !== undefined) {
          return nextResult;
        }

        return {
          status: 'pushed',
          headSha: currentHeadSha,
          treeHash: currentTreeHash,
        };
      },
      async getCurrentHeadSha() {
        return currentHeadSha;
      },
      async getCurrentTreeHash() {
        return currentTreeHash;
      },
      async resetHardToRevision(options) {
        if (failOn('resetHardToRevision')) {
          throw new Error('reset hard failed');
        }
        hardResets.push(options);
      },
      async getChangedFilesSinceBase(options) {
        changedFileRequests.push(options);
        return changedFilesSinceBase;
      },
      async getCommitsSinceBase(options) {
        if (failOn('getCommitsSinceBase')) {
          throw new Error('get commits failed');
        }
        commitListRequests.push(options);
        return commitsSinceBase;
      },
      async rewriteBranchWithCommitPlan(options) {
        if (failOn('rewriteBranchWithCommitPlan')) {
          throw new Error('rewrite with commit plan failed');
        }
        rewrites.push(options);
        return {
          headSha: rewrittenHeadSha,
          treeHash: rewrittenTreeHash,
        };
      },
    },
  };
}

/**
 * @param {{ output: unknown | unknown[] }} options
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
        if (Array.isArray(output)) {
          const next = output.shift();
          if (next === undefined) {
            throw new Error('Unexpected Codex runner call.');
          }
          return next;
        }

        return output;
      },
    },
  };
}
