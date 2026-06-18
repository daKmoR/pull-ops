import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
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
 * @typedef {import('../../git/types.js').PushBranchOptions} PushBranchOptions
 * @typedef {import('../../runner/types.js').CodexRunOptions} CodexRunOptions
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

  it('02: prepares a Codex Action prompt without invoking the runner', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'pullops-codex-action-'));
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

    const prompt = await readFile(join(outputDirectory, 'codex_prompt.md'), 'utf8');
    assert.match(prompt, /Use the pullops-issue-implement skill/);
    assert.match(prompt, /Implement GitHub Issue #42: Add the first operation/);
    assert.deepEqual(result.codexAction, {
      promptFile: join(outputDirectory, 'codex_prompt.md'),
      outputFile: join(outputDirectory, 'codex_output.json'),
      model: 'gpt-5.5',
      branch: 'pullops/issue-42',
    });
  });

  it('03: finalizes a Codex Action output without invoking the runner', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'pullops-codex-action-'));
    await writeFile(
      join(outputDirectory, 'codex_output.json'),
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
        codexActionOutcome: 'success',
        runnerRan: true,
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
        labels: [
          'pullops:issue:implement',
          'pullops:human-required',
          'pullops:status:in-progress',
          'pullops:status:blocked',
          'pullops:status:prepared',
          'pullops:status:failed',
          'pullops:status:done',
        ],
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

  it('13: blocks an issue when a dependency has only PullOps done status', async () => {
    const issue = createIssue({
      number: 42,
      body: ['Blocked by: #7', '', '## What to build', '', 'Do the thing.'].join('\n'),
    });
    const dependency = createIssue({
      number: 7,
      title: 'Dependency',
      labels: ['pullops:status:done'],
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

  it('15: treats a skipped Codex Action runner as a no-op finalize acknowledgement', async () => {
    const github = createFakeGitHub({ issue: createIssue({ number: 42 }) });
    const git = createFakeGit();
    const codex = createFakeCodexRunner({ output: '{}' });

    const result = await runIssueImplementCodexActionFinalize(
      createContext({
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
        runnerRan: false,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.match(String(result.summary), /prepare did not request a runner step/);
    assert.deepEqual(result.runner, {
      adapter: 'codex-action',
      ran: false,
    });
    assert.equal(codex.calls.length, 0);
    assert.equal(git.commits.length, 0);
    assert.equal(git.pushes.length, 0);
    assert.equal(github.comments.length, 0);
    assert.equal(github.issueLabelsAdded.length, 0);
  });

  it('16: records a failed Codex Action runner before failing finalize', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'pullops-codex-action-failure-'));
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
          codexActionOutcome: 'failure',
          runnerRan: true,
        }),
      ),
      /Codex Action completed with outcome "failure"/,
    );

    assert.equal(codex.calls.length, 0);
    assert.equal(git.commits.length, 0);
    assert.equal(git.pushes.length, 0);
    assert.match(github.comments[0].body, /Codex Action completed with outcome "failure"/);
    assert.deepEqual(github.issueLabelsAdded.at(-1), {
      number: 42,
      labels: ['pullops:human-required'],
    });
    assert.equal(
      await readFile(join(outputDirectory, 'failure_reason.txt'), 'utf8'),
      'Codex Action completed with outcome "failure".\n',
    );
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

  it('19: local dry-run preserves the checked-out PullOps branch when runner output blocks', async () => {
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

  it('20: local dry-run checks out the PullOps branch before blocking a closed issue', async () => {
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

  it('21: local dry-run checks out the PullOps branch before blocking a PRD-looking issue', async () => {
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

  it('22: local dry-run checks out the PullOps branch before blocking a parent issue with children', async () => {
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

  it('23: local dry-run checks out the PullOps branch before blocking an issue with dependencies', async () => {
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

  it('24: local PR publication runs the runner, pushes, opens a managed draft PR, records audit evidence, and avoids trigger labels', async () => {
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
        changes: ['Added local publish behavior.'],
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
      labels: [
        'pullops:issue:implement',
        'pullops:human-required',
        'pullops:status:in-progress',
        'pullops:status:blocked',
        'pullops:status:prepared',
        'pullops:status:failed',
        'pullops:status:done',
      ],
    });

    const metadata = JSON.parse(
      await readFile(join(String(result.localRunRecord), 'metadata.json'), 'utf8'),
    );
    assert.equal(metadata.publicationMode, 'publish');
  });

  it('25: local PR publication publishes a clean prepared branch without rerunning the runner', async () => {
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
    assert.deepEqual(git.checkouts, []);
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

  it('26: local PR publication refuses a dirty worktree before push or GitHub mutation', async () => {
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

  it('27: local PR publication updates an existing managed PR body and records audit evidence without trigger labels', async () => {
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
      currentBranch: 'pullops/issue-42',
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

  it('28: local PR publication reports blocked publish mode for closed issues', async () => {
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
    assert.deepEqual(git.checkouts, []);
    assert.equal(github.createdPullRequests.length, 0);
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
 * @param {{ issue: GitHubIssue, issuesByNumber?: Map<number, GitHubIssue>, existingPullRequest?: GitHubPullRequest }} options
 * @returns {{
 *   createdPullRequests: CreateDraftPullRequestOptions[];
 *   issueLabelsAdded: EditLabelsOptions[];
 *   issueLabelsRemoved: EditLabelsOptions[];
 *   pullRequestLabels: EditLabelsOptions[];
 *   comments: CommentOnIssueOptions[];
 *   pullRequestComments: CommentOnPullRequestOptions[];
 *   updatedPullRequestBodies: import('../../github/types.js').UpdatePullRequestBodyOptions[];
 *   issueLookups: number[];
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
  /** @type {CommentOnPullRequestOptions[]} */
  const pullRequestComments = [];
  /** @type {import('../../github/types.js').UpdatePullRequestBodyOptions[]} */
  const updatedPullRequestBodies = [];
  /** @type {number[]} */
  const issueLookups = [];
  const existingPullRequests = existingPullRequest === undefined ? [] : [existingPullRequest];

  return {
    createdPullRequests,
    issueLabelsAdded,
    issueLabelsRemoved,
    pullRequestLabels,
    comments,
    pullRequestComments,
    updatedPullRequestBodies,
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
 * @param {{
 *   failOn?: (action: string) => boolean,
 *   hasChangesResults?: boolean[],
 *   patch?: string,
 *   currentBranch?: string,
 *   commitsSinceBase?: import('../../git/types.js').GitCommit[],
 * }} [options]
 * @returns {{
 *   branches: CreateBranchOptions[];
 *   fetches: FetchRemoteRefsOptions[];
 *   checkouts: CheckoutPullOpsBranchOptions[];
 *   commits: CommitAllOptions[];
 *   emptyCommits: CommitEmptyOptions[];
 *   pushes: PushBranchOptions[];
 *   client: import('../../git/types.js').GitClient;
 * }}
 */
function createFakeGit({
  failOn = () => false,
  hasChangesResults = [true],
  patch = '',
  currentBranch = 'main',
  commitsSinceBase = [],
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
  /** @type {PushBranchOptions[]} */
  const pushes = [];

  return {
    branches,
    fetches,
    checkouts,
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
      async getCommitsSinceBase() {
        if (failOn('getCommitsSinceBase')) {
          throw new Error('get commits failed');
        }
        return commitsSinceBase;
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
