import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { DEFAULT_PULL_OPS_CONFIG } from '../../config/PullOpsConfig.js';
import {
  GITHUB_ACTIONS_BOT_AUTHOR,
  runPrReview,
  runPrReviewCodexActionFinalize,
  runPrReviewCodexActionPrepare,
} from './run.js';
import { runPrAddressReview } from '../pr-address-review/run.js';

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('../../github/types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('../../github/types.js').GitHubPullRequestReviewContext} GitHubPullRequestReviewContext
 * @typedef {import('../../github/types.js').GitHubPullRequestDiff} GitHubPullRequestDiff
 * @typedef {import('../../github/types.js').PublishPullRequestReviewOptions} PublishPullRequestReviewOptions
 * @typedef {import('../../github/types.js').ReplyToPullRequestReviewCommentOptions} ReplyToPullRequestReviewCommentOptions
 * @typedef {import('../../github/types.js').UpdatePullRequestBodyOptions} UpdatePullRequestBodyOptions
 * @typedef {import('../../github/types.js').CreateIssueOptions} CreateIssueOptions
 * @typedef {import('../../github/types.js').UpdateIssueOptions} UpdateIssueOptions
 * @typedef {import('../../github/types.js').EditLabelsOptions} EditLabelsOptions
 * @typedef {import('../../github/types.js').CommentOnPullRequestOptions} CommentOnPullRequestOptions
 * @typedef {import('../../git/types.js').CommitAllOptions} CommitAllOptions
 * @typedef {import('../../git/types.js').PushBranchOptions} PushBranchOptions
 * @typedef {import('../../runner/types.js').CodexRunOptions} CodexRunOptions
 */

describe('runPrReview', () => {
  it('01: accepts an approved managed same-repository PR, publishes valid comments and replies, drops invalid anchors, and updates PR state', async () => {
    const github = createFakeGitHub({
      pullRequest: createPullRequest(),
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const git = createFakeGit({ hasChanges: false });
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'approved',
        summary: 'The PR satisfies the issue and coding standards.',
        comments: [
          {
            path: 'src/example.js',
            line: 2,
            body: 'This new line is clear.',
          },
          {
            path: 'src/example.js',
            line: 99,
            body: 'This line is not in the diff.',
          },
          {
            path: 'src/missing.js',
            line: 1,
            body: 'This path is not in the diff.',
          },
        ],
        replies: [
          {
            commentId: 9001,
            body: 'This unresolved thread is now accounted for.',
          },
          {
            commentId: 9999,
            body: 'This reply target is not unresolved.',
          },
        ],
      }),
    });

    const result = await runPrReview(
      createContext({
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(result.reviewResult, 'approved');
    assert.equal(codex.calls.length, 1);
    assert.match(codex.calls[0].prompt, /Use the pullops-pr-review skill/);
    assert.match(codex.calls[0].prompt, /Coding Standards Pass/);
    assert.equal(github.publishedReviews.length, 1);
    assert.equal(github.publishedReviews[0].number, 100);
    assert.equal(github.publishedReviews[0].event, 'COMMENT');
    assert.match(
      github.publishedReviews[0].body,
      /^The PR satisfies the issue and coding standards\./,
    );
    assert.match(github.publishedReviews[0].body, /<summary>PullOps operation audit<\/summary>/);
    assert.match(github.publishedReviews[0].body, /Operation: pullops:pr:review/);
    assert.deepEqual(github.publishedReviews[0].comments, [
      {
        path: 'src/example.js',
        line: 2,
        body: 'This new line is clear.',
      },
    ]);
    assert.deepEqual(github.replies, [
      {
        commentId: 9001,
        body: 'This unresolved thread is now accounted for.',
      },
    ]);
    assert.match(github.updatedBodies[0].body, /Status: Review approved/);
    assert.match(github.updatedBodies[0].body, /Review cycles: 2 \/ 3/);
    assert.match(github.updatedBodies[0].body, /Reviewed tree: reviewed-tree-123/);
    assert.match(github.updatedBodies[0].body, /Last operation: pullops:pr:review/);
    assert.deepEqual(github.pullRequestLabelsRemoved, [
      {
        number: 100,
        labels: ['pullops:pr:review', 'pullops:pr:finalize', 'pullops:human-required'],
      },
    ]);
    assert.deepEqual(github.pullRequestLabelsAdded, [
      {
        number: 100,
        labels: ['pullops:pr:finalize'],
      },
    ]);
    const review = /** @type {{
      comments: { published: number, dropped: number };
      replies: { published: number, dropped: number };
      directChangesCommitted: boolean;
    }} */ (result.review);
    assert.deepEqual(review, {
      comments: {
        published: 1,
        dropped: 2,
      },
      replies: {
        published: 1,
        dropped: 1,
      },
      directChangesCommitted: false,
    });
  });

  it('02: requests changes, commits direct review improvements, pushes the PR branch, and hands off to pr-address-review', async () => {
    const pullRequestWithStaleMarkers = createPullRequest({
      body: [
        createPullRequest().body,
        'Reviewed tree: stale-reviewed-tree',
        'Finalized tree: stale-finalized-tree',
        'Finalized head: stale-finalized-head',
        'Merge method: rebase',
      ].join('\n'),
    });
    const github = createFakeGitHub({
      pullRequest: pullRequestWithStaleMarkers,
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const git = createFakeGit({ hasChanges: true });
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'changes_requested',
        summary: 'The PR needs one implementation fix.',
        comments: [],
        directChanges: ['Normalized a local coding-standards issue found during review.'],
      }),
    });

    const result = await runPrReview(
      createContext({
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.reviewResult, 'changes_requested');
    assert.deepEqual(git.commits, [
      {
        message: [
          'chore(review): apply review improvements for PR #100',
          '',
          '- Normalized a local coding-standards issue found during review.',
          '',
          'Refs: #100',
        ].join('\n'),
        author: GITHUB_ACTIONS_BOT_AUTHOR,
      },
    ]);
    assert.deepEqual(git.pushes, [{ branchName: 'pullops/issue-42' }]);
    assert.equal(github.publishedReviews[0].event, 'COMMENT');
    assert.match(github.updatedBodies[0].body, /Status: Changes requested/);
    assert.doesNotMatch(github.updatedBodies[0].body, /Reviewed tree:/);
    assert.doesNotMatch(github.updatedBodies[0].body, /Finalized tree:/);
    assert.doesNotMatch(github.updatedBodies[0].body, /Finalized head:/);
    assert.doesNotMatch(github.updatedBodies[0].body, /Merge method:/);
    assert.deepEqual(github.pullRequestLabelsAdded, [
      {
        number: 100,
        labels: ['pullops:pr:address-review'],
      },
    ]);
    const review = /** @type {{ directChangesCommitted: boolean }} */ (result.review);
    assert.equal(review.directChangesCommitted, true);
  });

  it('03: prepares an external runner prompt without invoking the runner', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'pullops-external-runner-'));
    const github = createFakeGitHub({
      pullRequest: createPullRequest(),
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const codex = createFakeCodexRunner({ output: '{}' });

    const result = await runPrReviewCodexActionPrepare(
      createContext({
        githubClient: github.client,
        codexRunner: codex.runner,
        outputDirectory,
      }),
    );

    assert.equal(result.status, 'waiting');
    assert.equal(result.reviewMode, 'normal');
    assert.equal(result.modelTier, 'high');
    assert.equal(result.model, 'gpt-5.5');
    assert.equal(codex.calls.length, 0);

    const prompt = await readFile(join(outputDirectory, 'runner_prompt.md'), 'utf8');
    assert.match(prompt, /ensure the checkout .* is on branch `pullops\/issue-42`/);
    assert.match(prompt, /Use the pullops-pr-review skill/);
    assert.match(prompt, /Review PullOps-managed PR #100/);
    const runnerJob = /** @type {any} */ (result.runnerJob);
    assert.equal(runnerJob.promptFile, join(outputDirectory, 'runner_prompt.md'));
    assert.equal(runnerJob.outputFile, join(outputDirectory, 'runner_output.json'));
    assert.equal(runnerJob.resultFile, join(outputDirectory, 'runner_result.json'));
    assert.equal(runnerJob.model, 'gpt-5.5');
    assert.equal(runnerJob.branch, 'pullops/issue-42');
    assert.equal(runnerJob.workerPrompt, prompt);
    assert.deepEqual(runnerJob.completionCommands.failed, {
      argv: [
        'npm',
        'exec',
        '--',
        'pullops',
        'runner-result',
        '--status',
        'failed',
        '--file',
        join(outputDirectory, 'runner_result.json'),
      ],
      env: {
        npm_config_cache: '/tmp/pullops-npm-cache',
      },
    });
  });

  it('04: completes an external runner output without invoking the runner', async () => {
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
        status: 'approved',
        summary: 'The PR satisfies the issue and coding standards.',
        comments: [],
        replies: [],
      }),
    );

    const github = createFakeGitHub({
      pullRequest: createPullRequest(),
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const git = createFakeGit({ hasChanges: false });
    const codex = createFakeCodexRunner({ output: '{}' });

    const result = await runPrReviewCodexActionFinalize(
      createContext({
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
        outputDirectory,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(result.reviewResult, 'approved');
    assert.equal(codex.calls.length, 0);
    assert.equal(github.publishedReviews.length, 1);
    assert.equal(github.publishedReviews[0].event, 'COMMENT');
    assert.match(github.updatedBodies[0].body, /Status: Review approved/);
  });

  it('05: records a blocked Review Result with an audited GitHub review body', async () => {
    const github = createFakeGitHub({
      pullRequest: createPullRequest(),
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'blocked',
        summary: 'Review could not complete.',
        failureReason: 'The diff context was incomplete.',
      }),
    });

    const result = await runPrReview(
      createContext({
        githubClient: github.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'blocked');
    assert.equal(github.publishedReviews.length, 1);
    assert.match(github.publishedReviews[0].body, /^Review could not complete\./);
    assert.match(github.publishedReviews[0].body, /<summary>PullOps operation audit<\/summary>/);
    assert.match(github.publishedReviews[0].body, /Operation: pullops:pr:review/);
    assert.match(github.updatedBodies[0].body, /Status: Human required/);
    assert.match(github.updatedBodies[0].body, /Review cycles: 2 \/ 3/);
    assert.deepEqual(github.pullRequestLabelsAdded, [
      {
        number: 100,
        labels: ['pullops:human-required'],
      },
    ]);
    assert.match(github.comments[0].body, /The diff context was incomplete/);
  });

  it('06: records invalid Review Result before publishing reviews, replies, commits, or pushes', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'pullops-pr-review-failure-'));
    const github = createFakeGitHub({
      pullRequest: createPullRequest(),
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const git = createFakeGit({ hasChanges: true });
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'changes_requested',
        summary: 'Needs changes.',
        comments: [
          {
            path: 'src/example.js',
            line: '2',
            body: 'Line must be numeric.',
          },
        ],
      }),
    });

    await assert.rejects(
      runPrReview(
        createContext({
          githubClient: github.client,
          gitClient: git.client,
          codexRunner: codex.runner,
          outputDirectory,
        }),
      ),
      /Invalid Review Result: Operation Output\.comments\[0\]\.line must be a positive integer\./,
    );

    assert.equal(github.publishedReviews.length, 0);
    assert.equal(github.replies.length, 0);
    assert.equal(git.commits.length, 0);
    assert.equal(git.pushes.length, 0);
    assert.match(github.updatedBodies[0].body, /Status: Human required/);
    assert.equal(
      await readFile(join(outputDirectory, 'failure_reason.txt'), 'utf8'),
      'Invalid Review Result: Operation Output.comments[0].line must be a positive integer.\n',
    );
  });

  it('07: refuses forked PRs without running Codex', async () => {
    const github = createFakeGitHub({
      pullRequest: createPullRequest({ isCrossRepository: true }),
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const codex = createFakeCodexRunner({ output: '{}' });

    const result = await runPrReview(
      createContext({
        githubClient: github.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'refused');
    assert.match(String(result.summary), /same-repository PRs/);
    assert.equal(codex.calls.length, 0);
    assert.deepEqual(github.pullRequestLabelsAdded, [
      {
        number: 100,
        labels: ['pullops:human-required'],
      },
    ]);
  });

  it('08: treats a skipped external runner as a no-op complete acknowledgement', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'pullops-pr-review-external-skipped-'));
    await writeFile(
      join(outputDirectory, 'runner_result.json'),
      JSON.stringify({
        schemaVersion: 1,
        status: 'skipped',
      }),
    );
    const github = createFakeGitHub({
      pullRequest: createPullRequest(),
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const git = createFakeGit({ hasChanges: true });
    const codex = createFakeCodexRunner({ output: '{}' });

    const result = await runPrReviewCodexActionFinalize(
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
    assert.equal(github.updatedBodies.length, 0);
  });

  it('09: records a failed external runner before failing complete', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'pullops-pr-review-external-failure-'));
    await writeFile(
      join(outputDirectory, 'runner_result.json'),
      JSON.stringify({
        schemaVersion: 1,
        status: 'failed',
      }),
    );
    const github = createFakeGitHub({
      pullRequest: createPullRequest(),
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const git = createFakeGit({ hasChanges: true });
    const codex = createFakeCodexRunner({ output: '{}' });

    await assert.rejects(
      runPrReviewCodexActionFinalize(
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
    assert.deepEqual(github.pullRequestLabelsAdded.at(-1), {
      number: 100,
      labels: ['pullops:human-required'],
    });
    assert.equal(
      await readFile(join(outputDirectory, 'failure_reason.txt'), 'utf8'),
      'External runner completed with status "failed".\n',
    );
  });

  it('10: publishes external runner approval as a non-blocking review comment when GitHub rejects formal automation reviews', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'pullops-pr-review-formal-review-'));
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
        status: 'approved',
        summary: 'The README change matches issue #15.',
        comments: [],
        replies: [],
      }),
    );

    const github = createFakeGitHub({
      pullRequest: createPullRequest(),
      reviewContext: createReviewContext(),
      diff: createDiff(),
      rejectFormalReviewEvents: true,
    });

    const result = await runPrReviewCodexActionFinalize(
      createContext({
        githubClient: github.client,
        outputDirectory,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(result.reviewResult, 'approved');
    assert.equal(github.publishedReviews.length, 1);
    assert.equal(github.publishedReviews[0].number, 100);
    assert.equal(github.publishedReviews[0].event, 'COMMENT');
    assert.match(github.publishedReviews[0].body, /^The README change matches issue #15\./);
    assert.match(github.publishedReviews[0].body, /<summary>PullOps operation audit<\/summary>/);
    assert.deepEqual(github.publishedReviews[0].comments, []);
    assert.match(github.updatedBodies[0].body, /Status: Review approved/);
  });

  it('11: keeps the PR ready for human merge when final review approves after pr-finalize', async () => {
    const github = createFakeGitHub({
      pullRequest: createPullRequest({
        body: [
          '## Summary',
          '',
          'Prepared for final review.',
          '',
          '## PullOps',
          '',
          'Managed: yes',
          'Status: Prepared for final review',
          '',
          '<details>',
          '<summary>PullOps workflow state</summary>',
          '',
          'Review cycles: 2 / 3',
          'Source: Issue #42',
          'Last operation: pullops:pr:finalize',
          '',
          '</details>',
        ].join('\n'),
      }),
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'approved',
        summary: 'The prepared PR is ready for human review.',
        comments: [],
        replies: [],
      }),
    });

    const result = await runPrReview(
      createContext({
        githubClient: github.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.deepEqual(github.pullRequestLabelsAdded, []);
    assert.match(github.updatedBodies[0].body, /Status: Ready for human merge/);
  });

  it('12: refuses incomplete Umbrella PRD PRs before Codex can approve them', async () => {
    const github = createFakeGitHub({
      issue: createIssue({
        number: 7,
        title: 'PRD: Parent workflow',
        subIssues: [
          {
            number: 42,
            title: 'Implement child workflow',
            state: 'OPEN',
            relationshipSource: 'native',
          },
        ],
      }),
      pullRequest: createPullRequest({
        title: 'Prepare #7: PRD: Parent workflow',
        headRefName: 'pullops/prd-7',
        baseRefName: 'main',
        body: [
          '## Summary',
          '',
          'Prepared an umbrella branch.',
          '',
          '## PullOps',
          '',
          'Managed: yes',
          'Status: Draft parent preparation',
          '',
          '<details>',
          '<summary>PullOps workflow state</summary>',
          '',
          'Review cycles: 0 / 3',
          'Source: Parent Issue #7',
          'Last operation: pullops:prd:prepare',
          '',
          '</details>',
        ].join('\n'),
      }),
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'approved',
        summary: 'This should not run.',
        comments: [],
        replies: [],
      }),
    });

    const result = await runPrReview(
      createContext({
        githubClient: github.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'refused');
    assert.equal(codex.calls.length, 0);
    assert.equal(github.publishedReviews.length, 0);
    assert.match(github.updatedBodies[0].body, /Status: Human required/);
    assert.match(github.comments[0].body, /native Child Issues #42 remain open/);
    assert.match(github.comments[0].body, /Incomplete PRDs cannot be approved/);
  });

  it('13: uses the human feedback response model tier when a pending special-cycle marker is present', async () => {
    const config = structuredClone(DEFAULT_PULL_OPS_CONFIG);
    config.runner.models = {
      high: 'gpt-special-high',
      mid: 'gpt-special-mid',
      low: 'gpt-special-low',
    };
    config.operations.prReview = {
      modelTier: 'low',
      escalationModelTier: 'high',
      humanFeedbackResponseModelTier: 'mid',
    };

    const github = createFakeGitHub({
      pullRequest: createPullRequest({
        body: createSpecialReviewBody({
          reviewCycles: '3 / 3',
          escalationReviewCycles: '0 / 1',
          processedHumanFeedbackReviewIds: 'none',
          pendingHumanFeedbackReviewId: 'review-123',
        }),
      }),
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const git = createFakeGit({ hasChanges: false });
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'approved',
        summary: 'The PR satisfies the human feedback response.',
        comments: [],
        replies: [],
      }),
    });

    const result = await runPrReview(
      createContext({
        config,
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(result.reviewMode, 'human-feedback-response');
    assert.equal(result.modelTier, 'mid');
    assert.equal(result.model, 'gpt-special-mid');
    assert.equal(codex.calls[0].model, 'gpt-special-mid');
    assert.match(github.publishedReviews[0].body, /Model tier: mid/);
    assert.match(github.publishedReviews[0].body, /Model: gpt-special-mid/);
    assert.match(github.updatedBodies[0].body, /Review cycles: 3 \/ 3/);
    assert.match(github.updatedBodies[0].body, /Escalation review cycles: 0 \/ 1/);
    assert.match(github.updatedBodies[0].body, /Human feedback response cycles: 1/);
    assert.match(github.updatedBodies[0].body, /Processed human feedback review ids: review-123/);
    assert.match(github.updatedBodies[0].body, /Pending human feedback review id: none/);
  });

  it('14: uses the escalation model tier after the normal review budget is exhausted and the escalation marker is present', async () => {
    const config = structuredClone(DEFAULT_PULL_OPS_CONFIG);
    config.runner.models = {
      high: 'gpt-special-high',
      mid: 'gpt-special-mid',
      low: 'gpt-special-low',
    };
    config.operations.prReview = {
      modelTier: 'low',
      escalationModelTier: 'high',
      humanFeedbackResponseModelTier: 'mid',
    };

    const github = createFakeGitHub({
      pullRequest: createPullRequest({
        body: createSpecialReviewBody({
          reviewCycles: '3 / 3',
          escalationReviewCycles: '0 / 1',
        }),
      }),
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const git = createFakeGit({ hasChanges: false });
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'approved',
        summary: 'The PR satisfies the escalation review.',
        comments: [],
        replies: [],
      }),
    });

    const result = await runPrReview(
      createContext({
        config,
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(result.reviewMode, 'escalation');
    assert.equal(result.modelTier, 'high');
    assert.equal(result.model, 'gpt-special-high');
    assert.equal(codex.calls[0].model, 'gpt-special-high');
    assert.match(github.publishedReviews[0].body, /Model tier: high/);
    assert.match(github.publishedReviews[0].body, /Model: gpt-special-high/);
    assert.match(github.updatedBodies[0].body, /Review cycles: 3 \/ 3/);
    assert.match(github.updatedBodies[0].body, /Escalation review cycles: 1 \/ 1/);
  });

  it('15: blocks when the normal review budget is exhausted and no special-cycle marker is present', async () => {
    const github = createFakeGitHub({
      pullRequest: createPullRequest({
        body: createSpecialReviewBody({
          reviewCycles: '3 / 3',
          includeEscalationReviewCycles: false,
          includeHumanFeedbackMarkers: false,
        }),
      }),
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const codex = createFakeCodexRunner({ output: '{}' });

    const result = await runPrReview(
      createContext({
        githubClient: github.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'blocked');
    assert.equal(result.reviewMode, 'blocked');
    assert.equal(codex.calls.length, 0);
    assert.match(String(result.summary), /Review cycle budget exhausted/);
    assert.match(github.updatedBodies[0].body, /Status: Human required/);
    assert.match(github.updatedBodies[0].body, /Escalation review cycles: 1 \/ 1/);
    assert.match(github.updatedBodies[0].body, /Human feedback response cycles: 0/);
    assert.match(github.updatedBodies[0].body, /Processed human feedback review ids: none/);
    assert.match(github.updatedBodies[0].body, /Pending human feedback review id: none/);
  });

  it('16: keeps the escalation cycle available across address-review until the validating review completes', async () => {
    const config = structuredClone(DEFAULT_PULL_OPS_CONFIG);
    config.runner.models = {
      high: 'gpt-special-high',
      mid: 'gpt-special-mid',
      low: 'gpt-special-low',
    };
    config.operations.prReview = {
      modelTier: 'low',
      escalationModelTier: 'high',
      humanFeedbackResponseModelTier: 'mid',
    };
    config.operations.prAddressReview = {
      modelTier: 'low',
      escalationModelTier: 'high',
      humanFeedbackResponseModelTier: 'mid',
    };

    const reviewContext = createReviewContext();
    const diff = createDiff();

    const firstGithub = createFakeGitHub({
      pullRequest: createPullRequest({
        body: createSpecialReviewBody({
          reviewCycles: '3 / 3',
          escalationReviewCycles: '0 / 1',
          includeHumanFeedbackMarkers: false,
        }),
      }),
      reviewContext,
      diff,
    });
    const firstCodex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'changes_requested',
        summary: 'The PR needs one more change before the escalation follow-up.',
        comments: [],
        directChanges: [],
      }),
    });

    const firstResult = await runPrReview(
      createContext({
        config,
        githubClient: firstGithub.client,
        codexRunner: firstCodex.runner,
      }),
    );

    assert.equal(firstResult.reviewMode, 'escalation');
    assert.equal(firstResult.modelTier, 'high');
    assert.equal(firstResult.model, 'gpt-special-high');
    assert.equal(firstCodex.calls[0].model, 'gpt-special-high');
    assert.match(firstGithub.updatedBodies[0].body, /Review cycles: 3 \/ 3/);
    assert.match(firstGithub.updatedBodies[0].body, /Escalation review cycles: 0 \/ 1/);
    assert.deepEqual(firstGithub.pullRequestLabelsAdded, [
      {
        number: 100,
        labels: ['pullops:pr:address-review'],
      },
    ]);

    const secondGithub = createFakeGitHub({
      pullRequest: createPullRequest({
        body: firstGithub.updatedBodies[0].body,
      }),
      reviewContext,
      diff,
    });
    const secondCodex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'addressed',
        summary: 'Addressed the remaining review feedback.',
        addressed: [
          {
            feedbackId: 'thread:9001',
            response: 'Updated the implementation to cover the inline concern.',
          },
          {
            feedbackId: 'comment:1',
            response: 'Clarified the behavior requested in the top-level comment.',
          },
        ],
        declined: [],
        deferred: [],
        changes: [],
        testPlan: [],
      }),
    });

    const secondResult = await runPrAddressReview(
      createContext({
        operation: 'pr-address-review',
        config,
        githubClient: secondGithub.client,
        codexRunner: secondCodex.runner,
      }),
    );

    assert.equal(secondResult.reviewMode, 'escalation');
    assert.equal(secondResult.modelTier, 'high');
    assert.equal(secondResult.model, 'gpt-special-high');
    assert.equal(secondCodex.calls[0].model, 'gpt-special-high');
    assert.match(secondGithub.updatedBodies[0].body, /Review cycles: 3 \/ 3/);
    assert.match(secondGithub.updatedBodies[0].body, /Escalation review cycles: 0 \/ 1/);
    assert.deepEqual(secondGithub.pullRequestLabelsAdded, [
      {
        number: 100,
        labels: ['pullops:pr:review'],
      },
    ]);

    const thirdGithub = createFakeGitHub({
      pullRequest: createPullRequest({
        body: secondGithub.updatedBodies[0].body,
      }),
      reviewContext,
      diff,
    });
    const thirdCodex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'approved',
        summary: 'The PR satisfies the escalation review.',
        comments: [],
        replies: [],
      }),
    });

    const thirdResult = await runPrReview(
      createContext({
        config,
        githubClient: thirdGithub.client,
        codexRunner: thirdCodex.runner,
      }),
    );

    assert.equal(thirdResult.reviewMode, 'escalation');
    assert.equal(thirdResult.modelTier, 'high');
    assert.equal(thirdResult.model, 'gpt-special-high');
    assert.equal(thirdCodex.calls[0].model, 'gpt-special-high');
    assert.match(thirdGithub.updatedBodies[0].body, /Review cycles: 3 \/ 3/);
    assert.match(thirdGithub.updatedBodies[0].body, /Escalation review cycles: 1 \/ 1/);
    assert.deepEqual(thirdGithub.pullRequestLabelsAdded, [
      {
        number: 100,
        labels: ['pullops:pr:finalize'],
      },
    ]);
  });

  it('17: blocks after the escalation cycle is exhausted and no other special cycle applies', async () => {
    const github = createFakeGitHub({
      pullRequest: createPullRequest({
        body: createSpecialReviewBody({
          reviewCycles: '3 / 3',
          escalationReviewCycles: '1 / 1',
          includeHumanFeedbackMarkers: false,
        }),
      }),
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const codex = createFakeCodexRunner({ output: '{}' });

    const result = await runPrReview(
      createContext({
        githubClient: github.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'blocked');
    assert.equal(result.reviewMode, 'blocked');
    assert.equal(codex.calls.length, 0);
    assert.match(String(result.summary), /Review cycle budget exhausted/);
    assert.match(github.updatedBodies[0].body, /Escalation review cycles: 1 \/ 1/);
    assert.match(github.updatedBodies[0].body, /Status: Human required/);
  });

  it('18: counts a distinct human feedback review id separately after an earlier one was already processed', async () => {
    const config = structuredClone(DEFAULT_PULL_OPS_CONFIG);
    config.runner.models = {
      high: 'gpt-special-high',
      mid: 'gpt-special-mid',
      low: 'gpt-special-low',
    };
    config.operations.prReview = {
      modelTier: 'low',
      escalationModelTier: 'high',
      humanFeedbackResponseModelTier: 'mid',
    };

    const github = createFakeGitHub({
      pullRequest: createPullRequest({
        body: createSpecialReviewBody({
          reviewCycles: '3 / 3',
          escalationReviewCycles: '0 / 1',
          humanFeedbackResponseCycles: 1,
          processedHumanFeedbackReviewIds: 'review-111',
          pendingHumanFeedbackReviewId: 'review-222',
        }),
      }),
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const git = createFakeGit({ hasChanges: false });
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'approved',
        summary: 'The PR satisfies the next human feedback response.',
        comments: [],
        replies: [],
      }),
    });

    const result = await runPrReview(
      createContext({
        config,
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(result.reviewMode, 'human-feedback-response');
    assert.equal(result.modelTier, 'mid');
    assert.equal(result.model, 'gpt-special-mid');
    assert.equal(codex.calls[0].model, 'gpt-special-mid');
    assert.match(github.updatedBodies[0].body, /Human feedback response cycles: 2/);
    assert.match(
      github.updatedBodies[0].body,
      /Processed human feedback review ids: review-111, review-222/,
    );
    assert.match(github.updatedBodies[0].body, /Pending human feedback review id: none/);
  });

  it('19: creates labeled review follow-up issues for an approved escalation review and records their numbers before finalize', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-review-follow-up-'));
    const github = createFakeGitHub({
      pullRequest: createPullRequest({
        body: createSpecialReviewBody({
          reviewCycles: '3 / 3',
          escalationReviewCycles: '0 / 1',
          includeHumanFeedbackMarkers: false,
        }),
      }),
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const git = createFakeGit({ hasChanges: false });
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'approved',
        summary: 'The PR satisfies the escalation review.',
        comments: [],
        replies: [],
        directChanges: [],
        reviewFollowUpIssues: [
          {
            title: 'Capture a later cleanup task.',
            body: 'Standalone follow-up issue body.',
          },
          {
            title: 'Document a remaining edge case.',
            body: 'Second follow-up issue body.',
          },
        ],
        followUps: ['Audit-only note that should not create an issue.'],
      }),
    });

    const result = await runPrReview(
      createContext({
        cwd,
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(result.reviewMode, 'escalation');
    assert.equal(github.createdIssueInputs.length, 2);
    assert.deepEqual(
      github.createdIssueInputs.map(issue => issue.labels),
      [undefined, undefined],
    );
    assert.deepEqual(github.issueLabelAdds, [
      {
        number: 501,
        labels: ['needs-triage'],
      },
      {
        number: 502,
        labels: ['needs-triage'],
      },
    ]);
    assert.deepEqual(
      github.createdIssueInputs.map(issue => issue.title),
      ['Capture a later cleanup task.', 'Document a remaining edge case.'],
    );
    assert.match(github.createdIssueInputs[0].body, /^<!-- PullOps publication marker:/m);
    assert.match(github.createdIssueInputs[0].body, /^## What to build$/m);
    assert.match(github.createdIssueInputs[0].body, /^## Acceptance criteria$/m);
    assert.match(
      github.createdIssueInputs[0].body,
      /- Maintainer triages this Review Follow-up Issue\./,
    );
    assert.match(
      github.createdIssueInputs[0].body,
      /<summary>PullOps publication audit<\/summary>/,
    );
    assert.match(
      github.createdIssueInputs[0].body,
      /Source review: \[Escalation Review Cycle on PR #100\]\(https:\/\/github\.com\/acme\/widgets\/pull\/100\)/,
    );
    assert.match(
      github.createdIssueInputs[0].body,
      /Source PR: #100 \(https:\/\/github\.com\/acme\/widgets\/pull\/100\)/,
    );
    assert.match(
      github.createdIssueInputs[0].body,
      /Source issue: #42 \(https:\/\/github\.com\/acme\/widgets\/issues\/42\)/,
    );
    assert.match(github.createdIssueInputs[0].body, /Standalone follow-up issue body\./);
    assert.match(github.createdIssueInputs[1].body, /Second follow-up issue body\./);
    assert.deepEqual(
      github.createdIssues.map(issue => issue.number),
      [501, 502],
    );
    assert.ok(
      github.updatedBodies.some(update =>
        update.body.includes('Review follow-up issue numbers: #501, #502'),
      ),
    );
    const latestUpdate = github.updatedBodies.at(-1);
    assert.ok(latestUpdate);
    assert.match(latestUpdate.body, /Status: Review approved/);
    assert.match(latestUpdate.body, /Review follow-up issue numbers: #501, #502/);
    assert.deepEqual(github.pullRequestLabelsAdded, [
      {
        number: 100,
        labels: ['pullops:pr:finalize'],
      },
    ]);
  });

  it('20: avoids duplicate review follow-up issue publication when numbers are already recorded', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-review-follow-up-recorded-'));
    const bodyWithRecordedFollowUps = createSpecialReviewBody({
      reviewCycles: '3 / 3',
      escalationReviewCycles: '0 / 1',
      includeHumanFeedbackMarkers: false,
    }).replace(
      'Last operation: pullops:issue:implement',
      [
        'Review follow-up issue numbers: #501, #502',
        'Last operation: pullops:issue:implement',
      ].join('\n'),
    );
    const github = createFakeGitHub({
      pullRequest: createPullRequest({
        body: bodyWithRecordedFollowUps,
      }),
      existingIssues: [
        createPublishedConcreteIssue({
          number: 501,
          title: 'Capture a later cleanup task.',
          whatToBuild: 'Standalone follow-up issue body.',
          labels: ['needs-triage'],
        }),
        createPublishedConcreteIssue({
          number: 502,
          title: 'Document a remaining edge case.',
          whatToBuild: 'Second follow-up issue body.',
          labels: ['needs-triage'],
        }),
      ],
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'approved',
        summary: 'The PR satisfies the escalation review.',
        comments: [],
        replies: [],
        directChanges: [],
        reviewFollowUpIssues: [
          {
            title: 'Capture a later cleanup task.',
            body: 'Standalone follow-up issue body.',
          },
          {
            title: 'Document a remaining edge case.',
            body: 'Second follow-up issue body.',
          },
        ],
      }),
    });

    const result = await runPrReview(
      createContext({
        cwd,
        githubClient: github.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(github.createdIssueInputs.length, 0);
    assert.deepEqual(
      github.updatedIssueInputs.map(issue => issue.number),
      [501, 502],
    );
    assert.deepEqual(github.issueLabelAdds, []);
    assert.ok(
      github.updatedBodies.some(update =>
        update.body.includes('Review follow-up issue numbers: #501, #502'),
      ),
    );
    assert.deepEqual(github.pullRequestLabelsAdded, [
      {
        number: 100,
        labels: ['pullops:pr:finalize'],
      },
    ]);
  });

  it('21: rejects recorded follow-up issue numbers without matching proposals before finalize', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-review-follow-up-unmatched-recorded-'));
    const bodyWithRecordedFollowUps = createSpecialReviewBody({
      reviewCycles: '3 / 3',
      escalationReviewCycles: '0 / 1',
      includeHumanFeedbackMarkers: false,
    }).replace(
      'Last operation: pullops:issue:implement',
      [
        'Review follow-up issue numbers: #501, #502',
        'Last operation: pullops:issue:implement',
      ].join('\n'),
    );
    const github = createFakeGitHub({
      pullRequest: createPullRequest({
        body: bodyWithRecordedFollowUps,
      }),
      existingIssues: [
        createPublishedConcreteIssue({
          number: 501,
          title: 'Capture a later cleanup task.',
          whatToBuild: 'Standalone follow-up issue body.',
          labels: ['needs-triage'],
        }),
        createPublishedConcreteIssue({
          number: 502,
          title: 'Document a remaining edge case.',
          whatToBuild: 'Second follow-up issue body.',
        }),
      ],
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'approved',
        summary: 'The PR satisfies the escalation review.',
        comments: [],
        replies: [],
        directChanges: [],
        reviewFollowUpIssues: [
          {
            title: 'Capture a later cleanup task.',
            body: 'Standalone follow-up issue body.',
          },
        ],
      }),
    });

    await assert.rejects(
      runPrReview(
        createContext({
          cwd,
          githubClient: github.client,
          codexRunner: codex.runner,
        }),
      ),
      /Cannot finalize review follow-up issue publication because recorded issue #502 has no matching reviewFollowUpIssues proposal\./,
    );

    assert.equal(github.createdIssueInputs.length, 0);
    assert.deepEqual(
      github.updatedIssueInputs.map(issue => issue.number),
      [501],
    );
    assert.equal(github.publishedReviews.length, 0);
    const latestUpdate = github.updatedBodies.at(-1);
    assert.ok(latestUpdate);
    assert.match(latestUpdate.body, /Status: Human required/);
    assert.match(latestUpdate.body, /Review follow-up issue numbers: #501, #502/);
    assert.deepEqual(github.pullRequestLabelsAdded, [
      {
        number: 100,
        labels: ['pullops:human-required'],
      },
    ]);
  });

  it('22: rejects malformed review follow-up issue proposals before mutating GitHub state', async () => {
    const github = createFakeGitHub({
      pullRequest: createPullRequest({
        body: createSpecialReviewBody({
          reviewCycles: '3 / 3',
          escalationReviewCycles: '0 / 1',
          includeHumanFeedbackMarkers: false,
        }),
      }),
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'approved',
        summary: 'The PR satisfies the escalation review.',
        comments: [],
        replies: [],
        directChanges: [],
        reviewFollowUpIssues: [
          {
            title: 'Capture a later cleanup task.',
          },
        ],
      }),
    });

    await assert.rejects(
      runPrReview(
        createContext({
          githubClient: github.client,
          codexRunner: codex.runner,
        }),
      ),
      /Invalid Review Result: Operation Output\.reviewFollowUpIssues\[0\]\.body must be a non-empty string\./,
    );

    assert.equal(github.createdIssueInputs.length, 0);
    assert.deepEqual(github.issueLabelAdds, []);
    assert.equal(github.publishedReviews.length, 0);
    assert.match(github.updatedBodies[0].body, /Status: Human required/);
    assert.deepEqual(github.pullRequestLabelsAdded, [
      {
        number: 100,
        labels: ['pullops:human-required'],
      },
    ]);
  });

  it('23: records a GitHub issue creation failure before finalizing the review', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-review-follow-up-failure-'));
    const github = createFakeGitHub({
      pullRequest: createPullRequest({
        body: createSpecialReviewBody({
          reviewCycles: '3 / 3',
          escalationReviewCycles: '0 / 1',
          includeHumanFeedbackMarkers: false,
        }),
      }),
      reviewContext: createReviewContext(),
      diff: createDiff(),
      failCreateIssue: true,
    });
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'approved',
        summary: 'The PR satisfies the escalation review.',
        comments: [],
        replies: [],
        directChanges: [],
        reviewFollowUpIssues: [
          {
            title: 'Capture a later cleanup task.',
            body: 'Standalone follow-up issue body.',
          },
        ],
      }),
    });

    await assert.rejects(
      runPrReview(
        createContext({
          cwd,
          githubClient: github.client,
          codexRunner: codex.runner,
        }),
      ),
      /Failed to create GitHub issue "Capture a later cleanup task\.": GitHub issue creation failed\./,
    );

    assert.equal(github.createdIssueInputs.length, 0);
    assert.equal(github.createdIssues.length, 0);
    assert.deepEqual(github.issueLabelAdds, []);
    assert.equal(github.publishedReviews.length, 0);
    assert.match(github.updatedBodies[0].body, /Status: Human required/);
    assert.deepEqual(github.pullRequestLabelsAdded, [
      {
        number: 100,
        labels: ['pullops:human-required'],
      },
    ]);
  });

  it('24: records a partially created follow-up issue number before failing and reuses it on retry', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-review-follow-up-partial-failure-'));
    const reviewBody = createSpecialReviewBody({
      reviewCycles: '3 / 3',
      escalationReviewCycles: '0 / 1',
      includeHumanFeedbackMarkers: false,
    });
    const reviewOutput = JSON.stringify({
      status: 'approved',
      summary: 'The PR satisfies the escalation review.',
      comments: [],
      replies: [],
      directChanges: [],
      reviewFollowUpIssues: [
        {
          title: 'Capture a later cleanup task.',
          body: 'Standalone follow-up issue body.',
        },
      ],
    });
    const firstGithub = createFakeGitHub({
      pullRequest: createPullRequest({
        body: reviewBody,
      }),
      reviewContext: createReviewContext(),
      diff: createDiff(),
      failAddIssueLabel: true,
    });

    await assert.rejects(
      runPrReview(
        createContext({
          cwd,
          githubClient: firstGithub.client,
          codexRunner: createFakeCodexRunner({ output: reviewOutput }).runner,
        }),
      ),
      /Failed to publish review follow-up issue "Capture a later cleanup task\.": Failed to sync triage labels for the created issue\./,
    );

    assert.equal(firstGithub.createdIssueInputs.length, 1);
    assert.deepEqual(
      firstGithub.createdIssues.map(issue => issue.number),
      [501],
    );
    assert.deepEqual(firstGithub.issueLabelAdds, [
      {
        number: 501,
        labels: ['needs-triage'],
      },
    ]);
    assert.equal(firstGithub.publishedReviews.length, 0);
    const firstFailureUpdate = firstGithub.updatedBodies.at(-1);
    assert.ok(firstFailureUpdate);
    assert.match(firstFailureUpdate.body, /Status: Human required/);
    assert.match(firstFailureUpdate.body, /Review follow-up issue numbers: #501/);

    const retryGithub = createFakeGitHub({
      pullRequest: createPullRequest({
        body: firstFailureUpdate.body,
      }),
      existingIssues: firstGithub.createdIssues,
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });

    const retryResult = await runPrReview(
      createContext({
        cwd,
        githubClient: retryGithub.client,
        codexRunner: createFakeCodexRunner({ output: reviewOutput }).runner,
      }),
    );

    assert.equal(retryResult.status, 'accepted');
    assert.equal(retryGithub.createdIssueInputs.length, 0);
    assert.equal(retryGithub.updatedIssueInputs.length, 1);
    assert.equal(retryGithub.updatedIssueInputs[0].number, 501);
    assert.match(retryGithub.updatedIssueInputs[0].body, /Standalone follow-up issue body\./);
    assert.deepEqual(retryGithub.issueLabelAdds, [
      {
        number: 501,
        labels: ['needs-triage'],
      },
    ]);
    const retryLatestUpdate = retryGithub.updatedBodies.at(-1);
    assert.ok(retryLatestUpdate);
    assert.match(retryLatestUpdate.body, /Status: Review approved/);
    assert.match(retryLatestUpdate.body, /Review follow-up issue numbers: #501/);
  });

  it('25: records earlier follow-up issue numbers before a later proposal fails and publishes remaining proposals on retry', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-review-follow-up-multi-failure-'));
    const reviewBody = createSpecialReviewBody({
      reviewCycles: '3 / 3',
      escalationReviewCycles: '0 / 1',
      includeHumanFeedbackMarkers: false,
    });
    const reviewOutput = JSON.stringify({
      status: 'approved',
      summary: 'The PR satisfies the escalation review.',
      comments: [],
      replies: [],
      directChanges: [],
      reviewFollowUpIssues: [
        {
          title: 'Capture a later cleanup task.',
          body: 'Standalone follow-up issue body.',
        },
        {
          title: 'Document a remaining edge case.',
          body: 'Second follow-up issue body.',
        },
      ],
    });
    const firstGithub = createFakeGitHub({
      pullRequest: createPullRequest({
        body: reviewBody,
      }),
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const baseCreateIssue = firstGithub.client.createIssue;
    if (typeof baseCreateIssue !== 'function') {
      throw new Error('Expected the fake GitHub client to support issue creation.');
    }
    const createIssue = baseCreateIssue.bind(firstGithub.client);
    let createIssueCalls = 0;
    firstGithub.client.createIssue = async options => {
      createIssueCalls += 1;
      if (createIssueCalls === 2) {
        throw new Error(
          `Failed to create GitHub issue "${options.title}": GitHub issue creation failed.`,
        );
      }

      return await createIssue(options);
    };

    await assert.rejects(
      runPrReview(
        createContext({
          cwd,
          githubClient: firstGithub.client,
          codexRunner: createFakeCodexRunner({ output: reviewOutput }).runner,
        }),
      ),
      /Failed to publish review follow-up issue "Document a remaining edge case\.": Failed to create GitHub issue "Document a remaining edge case\.": GitHub issue creation failed\./,
    );

    assert.equal(firstGithub.createdIssueInputs.length, 1);
    assert.deepEqual(
      firstGithub.createdIssues.map(issue => issue.number),
      [501],
    );
    assert.deepEqual(firstGithub.issueLabelAdds, [
      {
        number: 501,
        labels: ['needs-triage'],
      },
    ]);
    assert.equal(firstGithub.publishedReviews.length, 0);
    const firstFailureUpdate = firstGithub.updatedBodies.at(-1);
    assert.ok(firstFailureUpdate);
    assert.match(firstFailureUpdate.body, /Status: Human required/);
    assert.match(firstFailureUpdate.body, /Review follow-up issue numbers: #501/);

    const retryGithub = createFakeGitHub({
      pullRequest: createPullRequest({
        body: firstFailureUpdate.body,
      }),
      existingIssues: firstGithub.createdIssues,
      reviewContext: createReviewContext(),
      diff: createDiff(),
      nextCreatedIssueNumber: 502,
    });

    const retryResult = await runPrReview(
      createContext({
        cwd,
        githubClient: retryGithub.client,
        codexRunner: createFakeCodexRunner({ output: reviewOutput }).runner,
      }),
    );

    assert.equal(retryResult.status, 'accepted');
    assert.equal(retryGithub.updatedIssueInputs.length, 1);
    assert.equal(retryGithub.updatedIssueInputs[0].number, 501);
    assert.equal(retryGithub.createdIssueInputs.length, 1);
    assert.equal(retryGithub.createdIssueInputs[0].title, 'Document a remaining edge case.');
    assert.deepEqual(retryGithub.issueLabelAdds, [
      {
        number: 502,
        labels: ['needs-triage'],
      },
    ]);
    const retryLatestUpdate = retryGithub.updatedBodies.at(-1);
    assert.ok(retryLatestUpdate);
    assert.match(retryLatestUpdate.body, /Status: Review approved/);
    assert.match(retryLatestUpdate.body, /Review follow-up issue numbers: #501, #502/);
  });

  it('26: preserves later recorded follow-up issue numbers when earlier reconciliation fails', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-review-follow-up-recorded-failure-'));
    const reviewBody = createSpecialReviewBody({
      reviewCycles: '3 / 3',
      escalationReviewCycles: '0 / 1',
      includeHumanFeedbackMarkers: false,
    }).replace('\n\n</details>', '\nReview follow-up issue numbers: #501, #502\n\n</details>');
    const reviewOutput = JSON.stringify({
      status: 'approved',
      summary: 'The PR satisfies the escalation review.',
      comments: [],
      replies: [],
      directChanges: [],
      reviewFollowUpIssues: [
        {
          title: 'Capture a later cleanup task.',
          body: 'Standalone follow-up issue body.',
        },
        {
          title: 'Document a remaining edge case.',
          body: 'Second follow-up issue body.',
        },
      ],
    });
    const recordedIssues = [
      createPublishedConcreteIssue({
        number: 501,
        title: 'Capture a later cleanup task.',
        whatToBuild: 'Standalone follow-up issue body.',
      }),
      createPublishedConcreteIssue({
        number: 502,
        title: 'Document a remaining edge case.',
        whatToBuild: 'Second follow-up issue body.',
      }),
    ];
    const firstGithub = createFakeGitHub({
      pullRequest: createPullRequest({
        body: reviewBody,
      }),
      existingIssues: recordedIssues,
      reviewContext: createReviewContext(),
      diff: createDiff(),
      failAddIssueLabel: true,
    });

    await assert.rejects(
      runPrReview(
        createContext({
          cwd,
          githubClient: firstGithub.client,
          codexRunner: createFakeCodexRunner({ output: reviewOutput }).runner,
        }),
      ),
      /Failed to publish review follow-up issue "Capture a later cleanup task\.": Failed to sync triage labels for the created issue\./,
    );

    assert.equal(firstGithub.createdIssueInputs.length, 0);
    assert.equal(firstGithub.updatedIssueInputs.length, 1);
    assert.equal(firstGithub.updatedIssueInputs[0].number, 501);
    assert.deepEqual(firstGithub.issueLabelAdds, [
      {
        number: 501,
        labels: ['needs-triage'],
      },
    ]);
    const firstFailureUpdate = firstGithub.updatedBodies.at(-1);
    assert.ok(firstFailureUpdate);
    assert.match(firstFailureUpdate.body, /Status: Human required/);
    assert.match(firstFailureUpdate.body, /Review follow-up issue numbers: #501, #502/);

    const retryGithub = createFakeGitHub({
      pullRequest: createPullRequest({
        body: firstFailureUpdate.body,
      }),
      existingIssues: recordedIssues,
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });

    const retryResult = await runPrReview(
      createContext({
        cwd,
        githubClient: retryGithub.client,
        codexRunner: createFakeCodexRunner({ output: reviewOutput }).runner,
      }),
    );

    assert.equal(retryResult.status, 'accepted');
    assert.equal(retryGithub.createdIssueInputs.length, 0);
    assert.deepEqual(
      retryGithub.updatedIssueInputs.map(issue => issue.number),
      [501, 502],
    );
    assert.deepEqual(retryGithub.issueLabelAdds, [
      {
        number: 501,
        labels: ['needs-triage'],
      },
      {
        number: 502,
        labels: ['needs-triage'],
      },
    ]);
    const retryLatestUpdate = retryGithub.updatedBodies.at(-1);
    assert.ok(retryLatestUpdate);
    assert.match(retryLatestUpdate.body, /Status: Review approved/);
    assert.match(retryLatestUpdate.body, /Review follow-up issue numbers: #501, #502/);
  });

  it('27: ignores partial human-feedback markers during validation and falls back to escalation mode', async () => {
    const config = structuredClone(DEFAULT_PULL_OPS_CONFIG);
    config.runner.models = {
      high: 'gpt-special-high',
      mid: 'gpt-special-mid',
      low: 'gpt-special-low',
    };
    config.operations.prReview = {
      modelTier: 'low',
      escalationModelTier: 'high',
      humanFeedbackResponseModelTier: 'mid',
    };

    const github = createFakeGitHub({
      pullRequest: createPullRequest({
        body: [
          createSpecialReviewBody({
            reviewCycles: '3 / 3',
            escalationReviewCycles: '0 / 1',
            includeHumanFeedbackResponseCycles: false,
            includeProcessedHumanFeedbackReviewIds: false,
            pendingHumanFeedbackReviewId: 'review-123',
          }),
          '',
          '## Summary Notes',
          '',
          'Human feedback response cycles: 0',
          'Processed human feedback review ids: none',
        ].join('\n'),
      }),
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const git = createFakeGit({ hasChanges: false });
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'approved',
        summary: 'The PR satisfies the escalation review.',
        comments: [],
        replies: [],
      }),
    });

    const result = await runPrReview(
      createContext({
        config,
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(result.reviewMode, 'escalation');
    assert.equal(result.modelTier, 'high');
    assert.equal(result.model, 'gpt-special-high');
    assert.equal(codex.calls[0].model, 'gpt-special-high');
    assert.match(github.publishedReviews[0].body, /Model tier: high/);
    assert.match(github.publishedReviews[0].body, /Model: gpt-special-high/);
    assert.match(github.updatedBodies[0].body, /Escalation review cycles: 1 \/ 1/);
    assert.match(github.updatedBodies[0].body, /Human feedback response cycles: 0/);
    assert.match(github.updatedBodies[0].body, /Processed human feedback review ids: none/);
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
    target: {
      type: 'pr',
      number: 100,
    },
    cwd: '/workspace',
    config: createGitHubPullOpsConfig(),
    modelTier: 'high',
    model: 'gpt-5.5',
    githubClient: createFakeGitHub({
      pullRequest: createPullRequest(),
      reviewContext: createReviewContext(),
      diff: createDiff(),
    }).client,
    gitClient: createFakeGit({ hasChanges: false }).client,
    codexRunner: createFakeCodexRunner({ output: '{}' }).runner,
    ...overrides,
  };
}

/**
 * @returns {import('../../config/types.js').PullOpsConfig}
 */
function createGitHubPullOpsConfig() {
  const config = structuredClone(DEFAULT_PULL_OPS_CONFIG);
  config.issueStore.provider = 'github';
  return config;
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
    body: [
      '## Summary',
      '',
      'Implemented the issue.',
      '',
      '## PullOps',
      '',
      'Managed: yes',
      'Status: Draft automation',
      '',
      '<details>',
      '<summary>PullOps workflow state</summary>',
      '',
      'Review cycles: 1 / 3',
      'Source: Issue #42',
      'Last operation: pullops:issue:implement',
      '',
      '</details>',
    ].join('\n'),
    isDraft: true,
    isCrossRepository: false,
    ...overrides,
  };
}

/**
 * @param {{
 *   reviewCycles?: string;
 *   escalationReviewCycles?: string;
 *   humanFeedbackResponseCycles?: number;
 *   processedHumanFeedbackReviewIds?: string;
 *   pendingHumanFeedbackReviewId?: string;
 *   includeEscalationReviewCycles?: boolean;
 *   includeHumanFeedbackMarkers?: boolean;
 *   includeHumanFeedbackResponseCycles?: boolean;
 *   includeProcessedHumanFeedbackReviewIds?: boolean;
 *   includePendingHumanFeedbackReviewId?: boolean;
 * }} [options]
 * @returns {string}
 */
function createSpecialReviewBody({
  reviewCycles = '3 / 3',
  escalationReviewCycles = '0 / 1',
  humanFeedbackResponseCycles = 0,
  processedHumanFeedbackReviewIds = 'none',
  pendingHumanFeedbackReviewId = 'none',
  includeEscalationReviewCycles = true,
  includeHumanFeedbackMarkers,
  includeHumanFeedbackResponseCycles = true,
  includeProcessedHumanFeedbackReviewIds = true,
  includePendingHumanFeedbackReviewId = true,
} = {}) {
  const resolvedIncludeHumanFeedbackResponseCycles =
    includeHumanFeedbackMarkers ?? includeHumanFeedbackResponseCycles;
  const resolvedIncludeProcessedHumanFeedbackReviewIds =
    includeHumanFeedbackMarkers ?? includeProcessedHumanFeedbackReviewIds;
  const resolvedIncludePendingHumanFeedbackReviewId =
    includeHumanFeedbackMarkers ?? includePendingHumanFeedbackReviewId;

  return [
    '## Summary',
    '',
    'Implemented the issue.',
    '',
    '## PullOps',
    '',
    'Managed: yes',
    'Status: Changes requested',
    '',
    '<details>',
    '<summary>PullOps workflow state</summary>',
    '',
    `Review cycles: ${reviewCycles}`,
    ...(includeEscalationReviewCycles
      ? [`Escalation review cycles: ${escalationReviewCycles}`]
      : []),
    ...(resolvedIncludeHumanFeedbackResponseCycles ||
    resolvedIncludeProcessedHumanFeedbackReviewIds ||
    resolvedIncludePendingHumanFeedbackReviewId
      ? [
          ...(resolvedIncludeHumanFeedbackResponseCycles
            ? [`Human feedback response cycles: ${humanFeedbackResponseCycles}`]
            : []),
          ...(resolvedIncludeProcessedHumanFeedbackReviewIds
            ? [`Processed human feedback review ids: ${processedHumanFeedbackReviewIds}`]
            : []),
          ...(resolvedIncludePendingHumanFeedbackReviewId
            ? [`Pending human feedback review id: ${pendingHumanFeedbackReviewId}`]
            : []),
        ]
      : []),
    'Source: Issue #42',
    'Last operation: pullops:issue:implement',
    '',
    '</details>',
  ].join('\n');
}

/**
 * @param {Partial<GitHubIssue>} [overrides]
 * @returns {GitHubIssue}
 */
function createIssue(overrides = {}) {
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
    ...overrides,
  };
}

/**
 * @param {{
 *   number: number;
 *   title: string;
 *   whatToBuild: string;
 *   labels?: string[];
 * }} options
 * @returns {GitHubIssue}
 */
function createPublishedConcreteIssue({ number, title, whatToBuild, labels = [] }) {
  return createIssue({
    number,
    title,
    body: [
      '<!-- PullOps publication marker: {"schemaVersion":1,"provider":"github","kind":"concrete-issue"} -->',
      '',
      '## What to build',
      '',
      whatToBuild,
      '',
      '## Acceptance criteria',
      '',
      '- Maintainer triages this Review Follow-up Issue.',
      '',
    ].join('\n'),
    labels,
  });
}

/**
 * @param {GitHubIssue} issue
 * @returns {GitHubIssue}
 */
function cloneIssue(issue) {
  return {
    ...issue,
    labels: [...issue.labels],
    parent: issue.parent === null ? null : { ...issue.parent },
    subIssues: issue.subIssues.map(subIssue => ({ ...subIssue })),
  };
}

/**
 * @returns {GitHubPullRequestReviewContext}
 */
function createReviewContext() {
  return {
    comments: [
      {
        body: 'Please review this change.',
        authorLogin: 'maintainer',
      },
    ],
    reviews: [
      {
        id: 'R_1',
        state: 'COMMENTED',
        body: 'Earlier review summary.',
        authorLogin: 'reviewer',
      },
    ],
    unresolvedThreads: [
      {
        isResolved: false,
        comments: [
          {
            id: 'PRRC_1',
            databaseId: 9001,
            body: 'Existing unresolved feedback.',
            authorLogin: 'reviewer',
            path: 'src/example.js',
            line: 2,
          },
        ],
      },
    ],
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
 * @param {GitHubIssue} [options.issue]
 * @param {GitHubIssue[]} [options.existingIssues]
 * @param {GitHubPullRequestReviewContext} options.reviewContext
 * @param {GitHubPullRequestDiff} options.diff
 * @param {boolean} [options.failCreateIssue]
 * @param {boolean} [options.failAddIssueLabel]
 * @param {number} [options.nextCreatedIssueNumber]
 * @param {boolean} [options.rejectFormalReviewEvents]
 * @returns {{
 *   publishedReviews: PublishPullRequestReviewOptions[];
 *   replies: ReplyToPullRequestReviewCommentOptions[];
 *   updatedBodies: UpdatePullRequestBodyOptions[];
 *   createdIssueInputs: CreateIssueOptions[];
 *   updatedIssueInputs: UpdateIssueOptions[];
 *   createdIssues: GitHubIssue[];
 *   issueLabelAdds: EditLabelsOptions[];
 *   issueLabelRemovals: EditLabelsOptions[];
 *   pullRequestLabelsAdded: EditLabelsOptions[];
 *   pullRequestLabelsRemoved: EditLabelsOptions[];
 *   comments: CommentOnPullRequestOptions[];
 *   client: import('../../github/types.js').GitHubClient;
 * }}
 */
function createFakeGitHub({
  pullRequest,
  issue = createIssue(),
  existingIssues = [],
  reviewContext,
  diff,
  failCreateIssue = false,
  failAddIssueLabel = false,
  nextCreatedIssueNumber = 501,
  rejectFormalReviewEvents = false,
}) {
  /** @type {PublishPullRequestReviewOptions[]} */
  const publishedReviews = [];
  /** @type {ReplyToPullRequestReviewCommentOptions[]} */
  const replies = [];
  /** @type {UpdatePullRequestBodyOptions[]} */
  const updatedBodies = [];
  /** @type {CreateIssueOptions[]} */
  const createdIssueInputs = [];
  /** @type {UpdateIssueOptions[]} */
  const updatedIssueInputs = [];
  /** @type {GitHubIssue[]} */
  const createdIssues = [];
  /** @type {EditLabelsOptions[]} */
  const issueLabelAdds = [];
  /** @type {EditLabelsOptions[]} */
  const issueLabelRemovals = [];
  /** @type {EditLabelsOptions[]} */
  const pullRequestLabelsAdded = [];
  /** @type {EditLabelsOptions[]} */
  const pullRequestLabelsRemoved = [];
  /** @type {CommentOnPullRequestOptions[]} */
  const comments = [];
  const issueStore = new Map(
    [issue, ...existingIssues].map(currentIssue => [currentIssue.number, cloneIssue(currentIssue)]),
  );

  return {
    publishedReviews,
    replies,
    updatedBodies,
    createdIssueInputs,
    updatedIssueInputs,
    createdIssues,
    issueLabelAdds,
    issueLabelRemovals,
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
      async getIssue(number) {
        const currentIssue = issueStore.get(number);
        if (currentIssue === undefined) {
          throw new Error(`getIssue was not expected for issue #${number} in this test.`);
        }

        return cloneIssue(currentIssue);
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
      async createIssue(options) {
        if (failCreateIssue) {
          throw new Error(
            `Failed to create GitHub issue "${options.title}": GitHub issue creation failed.`,
          );
        }

        createdIssueInputs.push(options);
        const issueNumber = nextCreatedIssueNumber + createdIssues.length;
        const createdIssue = {
          number: issueNumber,
          title: options.title,
          body: options.body,
          state: 'OPEN',
          url: `https://github.com/acme/widgets/issues/${issueNumber}`,
          authorLogin: 'github-actions[bot]',
          labels: options.labels ?? [],
          parent: null,
          subIssues: [],
        };
        createdIssues.push(createdIssue);
        issueStore.set(issueNumber, createdIssue);
        return cloneIssue(createdIssue);
      },
      async updateIssue(options) {
        updatedIssueInputs.push(options);
        const currentIssue = issueStore.get(options.number);
        if (currentIssue === undefined) {
          throw new Error(
            `updateIssue was not expected for issue #${options.number} in this test.`,
          );
        }

        const updatedIssue = {
          ...currentIssue,
          title: options.title,
          body: options.body,
        };
        issueStore.set(options.number, updatedIssue);
        return cloneIssue(updatedIssue);
      },
      async addLabelsToIssue(options) {
        issueLabelAdds.push(options);
        if (failAddIssueLabel) {
          throw new Error('Failed to sync triage labels for the created issue.');
        }

        const currentIssue = issueStore.get(options.number);
        if (currentIssue !== undefined) {
          currentIssue.labels = [...new Set([...currentIssue.labels, ...options.labels])];
        }
      },
      async removeLabelsFromIssue(options) {
        issueLabelRemovals.push(options);
        const currentIssue = issueStore.get(options.number);
        if (currentIssue !== undefined) {
          currentIssue.labels = currentIssue.labels.filter(
            label => !options.labels.includes(label),
          );
        }
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
      async publishPullRequestReview(options) {
        if (rejectFormalReviewEvents && options.event !== 'COMMENT') {
          throw new Error(`GitHub rejected formal review event ${options.event}.`);
        }

        publishedReviews.push(options);
      },
      async replyToPullRequestReviewComment(options) {
        replies.push(options);
      },
      async resolvePullRequestReviewThread() {
        throw new Error('resolvePullRequestReviewThread was not expected in this test.');
      },
    },
  };
}

/**
 * @param {{ hasChanges: boolean, headSha?: string, treeHash?: string }} options
 * @returns {{
 *   commits: CommitAllOptions[];
 *   pushes: PushBranchOptions[];
 *   client: import('../../git/types.js').GitClient;
 * }}
 */
function createFakeGit({
  hasChanges,
  headSha = 'reviewed-head-123',
  treeHash = 'reviewed-tree-123',
}) {
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
        return headSha;
      },
      async getCurrentTreeHash() {
        return treeHash;
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
