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

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('../../github/types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('../../github/types.js').GitHubPullRequestReviewContext} GitHubPullRequestReviewContext
 * @typedef {import('../../github/types.js').GitHubPullRequestDiff} GitHubPullRequestDiff
 * @typedef {import('../../github/types.js').PublishPullRequestReviewOptions} PublishPullRequestReviewOptions
 * @typedef {import('../../github/types.js').ReplyToPullRequestReviewCommentOptions} ReplyToPullRequestReviewCommentOptions
 * @typedef {import('../../github/types.js').UpdatePullRequestBodyOptions} UpdatePullRequestBodyOptions
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
        labels: [
          'pullops:pr:review',
          'pullops:pr:finalize',
          'pullops:human-required',
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

  it('03: prepares a Codex Action prompt without invoking the runner', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'pullops-codex-action-'));
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

    assert.equal(result.status, 'accepted');
    assert.equal(result.reviewMode, 'normal');
    assert.equal(result.modelTier, 'high');
    assert.equal(result.model, 'gpt-5.5');
    assert.equal(codex.calls.length, 0);

    const prompt = await readFile(join(outputDirectory, 'codex_prompt.md'), 'utf8');
    assert.match(prompt, /Use the pullops-pr-review skill/);
    assert.match(prompt, /Review PullOps-managed PR #100/);
    assert.deepEqual(result.codexAction, {
      promptFile: join(outputDirectory, 'codex_prompt.md'),
      outputFile: join(outputDirectory, 'codex_output.json'),
      model: 'gpt-5.5',
      branch: 'pullops/issue-42',
    });
  });

  it('04: finalizes a Codex Action output without invoking the runner', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'pullops-codex-action-'));
    await writeFile(
      join(outputDirectory, 'codex_output.json'),
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
        codexActionOutcome: 'success',
        runnerRan: true,
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

  it('08: treats a skipped Codex Action runner as a no-op finalize acknowledgement', async () => {
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
    assert.equal(github.updatedBodies.length, 0);
  });

  it('09: records a failed Codex Action runner before failing finalize', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'pullops-pr-review-codex-failure-'));
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
    assert.deepEqual(github.pullRequestLabelsAdded.at(-1), {
      number: 100,
      labels: ['pullops:human-required'],
    });
    assert.equal(
      await readFile(join(outputDirectory, 'failure_reason.txt'), 'utf8'),
      'Codex Action completed with outcome "failure".\n',
    );
  });

  it('10: publishes Codex Action approval as a non-blocking review comment when GitHub rejects formal automation reviews', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'pullops-pr-review-formal-review-'));
    await writeFile(
      join(outputDirectory, 'codex_output.json'),
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
        codexActionOutcome: 'success',
        runnerRan: true,
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
    config: DEFAULT_PULL_OPS_CONFIG,
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
 *   processedHumanFeedbackReviewIds?: string;
 *   pendingHumanFeedbackReviewId?: string;
 *   includeEscalationReviewCycles?: boolean;
 *   includeHumanFeedbackMarkers?: boolean;
 * }} [options]
 * @returns {string}
 */
function createSpecialReviewBody({
  reviewCycles = '3 / 3',
  escalationReviewCycles = '0 / 1',
  processedHumanFeedbackReviewIds = 'none',
  pendingHumanFeedbackReviewId = 'none',
  includeEscalationReviewCycles = true,
  includeHumanFeedbackMarkers = true,
} = {}) {
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
    ...(includeHumanFeedbackMarkers
      ? [
          'Human feedback response cycles: 0',
          `Processed human feedback review ids: ${processedHumanFeedbackReviewIds}`,
          `Pending human feedback review id: ${pendingHumanFeedbackReviewId}`,
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
 * @param {GitHubPullRequestReviewContext} options.reviewContext
 * @param {GitHubPullRequestDiff} options.diff
 * @param {boolean} [options.rejectFormalReviewEvents]
 * @returns {{
 *   publishedReviews: PublishPullRequestReviewOptions[];
 *   replies: ReplyToPullRequestReviewCommentOptions[];
 *   updatedBodies: UpdatePullRequestBodyOptions[];
 *   pullRequestLabelsAdded: EditLabelsOptions[];
 *   pullRequestLabelsRemoved: EditLabelsOptions[];
 *   comments: CommentOnPullRequestOptions[];
 *   client: import('../../github/types.js').GitHubClient;
 * }}
 */
function createFakeGitHub({
  pullRequest,
  issue = createIssue(),
  reviewContext,
  diff,
  rejectFormalReviewEvents = false,
}) {
  /** @type {PublishPullRequestReviewOptions[]} */
  const publishedReviews = [];
  /** @type {ReplyToPullRequestReviewCommentOptions[]} */
  const replies = [];
  /** @type {UpdatePullRequestBodyOptions[]} */
  const updatedBodies = [];
  /** @type {EditLabelsOptions[]} */
  const pullRequestLabelsAdded = [];
  /** @type {EditLabelsOptions[]} */
  const pullRequestLabelsRemoved = [];
  /** @type {CommentOnPullRequestOptions[]} */
  const comments = [];

  return {
    publishedReviews,
    replies,
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
