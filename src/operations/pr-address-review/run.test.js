import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { DEFAULT_PULL_OPS_CONFIG } from '../../config/PullOpsConfig.js';
import { GITHUB_ACTIONS_BOT_AUTHOR, runPrAddressReview } from './run.js';

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('../../github/types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('../../github/types.js').GitHubPullRequestReviewContext} GitHubPullRequestReviewContext
 * @typedef {import('../../github/types.js').GitHubPullRequestDiff} GitHubPullRequestDiff
 * @typedef {import('../../github/types.js').ReplyToPullRequestReviewCommentOptions} ReplyToPullRequestReviewCommentOptions
 * @typedef {import('../../github/types.js').UpdatePullRequestBodyOptions} UpdatePullRequestBodyOptions
 * @typedef {import('../../github/types.js').EditLabelsOptions} EditLabelsOptions
 * @typedef {import('../../github/types.js').CommentOnPullRequestOptions} CommentOnPullRequestOptions
 * @typedef {import('../../github/types.js').DismissPullRequestReviewOptions} DismissPullRequestReviewOptions
 * @typedef {import('../../git/types.js').CommitAllOptions} CommitAllOptions
 * @typedef {import('../../git/types.js').PushBranchOptions} PushBranchOptions
 * @typedef {import('../../runner/types.js').CodexRunOptions} CodexRunOptions
 */

describe('runPrAddressReview', () => {
  it('01: addresses inline threads, requested-change summaries, PullOps review output, and top-level comments before returning to review', async () => {
    const github = createFakeGitHub({
      pullRequest: createPullRequest(),
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const git = createFakeGit({ hasChanges: true });
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'addressed',
        summary: 'Addressed all review feedback.',
        addressed: [
          {
            feedbackId: 'thread:9001',
            response: 'Updated the implementation to cover the inline concern.',
          },
          {
            feedbackId: 'review:PRR_requested',
            response: 'Updated the docs requested by the review summary.',
          },
          {
            feedbackId: 'pullops-pr-review:PRR_pullops',
            response: 'Added the missing regression test noted by PullOps review.',
          },
          {
            feedbackId: 'comment:7001',
            response: 'Clarified the behavior requested in the top-level comment.',
          },
        ],
        declined: [],
        deferred: [],
        changes: ['Adjusted implementation, docs, and regression coverage.'],
        testPlan: ['node --test src/operations/pr-address-review/run.test.js'],
      }),
    });

    const result = await runPrAddressReview(
      createContext({
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(result.reviewMode, 'normal');
    assert.equal(result.modelTier, 'mid');
    assert.equal(result.model, DEFAULT_PULL_OPS_CONFIG.runner.models.mid);
    assert.equal(codex.calls.length, 1);
    assert.match(codex.calls[0].prompt, /Use the pullops-pr-address-review skill/);
    assert.match(codex.calls[0].prompt, /feedbackId `thread:9001`/);
    assert.match(codex.calls[0].prompt, /requested-change review summary/);
    assert.match(codex.calls[0].prompt, /PullOps review output/);
    assert.match(codex.calls[0].prompt, /top-level PR comment/);
    assert.deepEqual(git.commits, [
      {
        message: [
          'fix(pr-address-review): address feedback for PR #100',
          '',
          '- Adjusted implementation, docs, and regression coverage.',
          '',
          'Refs: #100',
        ].join('\n'),
        author: GITHUB_ACTIONS_BOT_AUTHOR,
      },
    ]);
    assert.deepEqual(git.pushes, [{ branchName: 'pullops/issue-42' }]);
    assert.equal(github.replies[0].commentId, 9001);
    assert.match(github.replies[0].body, /PullOps addressed this feedback\./);
    assert.match(
      github.replies[0].body,
      /Updated the implementation to cover the inline concern\./,
    );
    assert.match(github.replies[0].body, /<summary>PullOps operation audit<\/summary>/);
    assert.deepEqual(github.resolvedReviewThreads, ['PRRT_1']);
    assert.deepEqual(github.dismissedReviews, [
      {
        reviewId: 'PRR_requested',
        message:
          'PullOps handled all actionable feedback associated with this requested-change review.',
      },
    ]);
    assert.equal(github.comments.length, 4);
    assert.match(github.comments[0].body, /<summary>PullOps operation audit<\/summary>/);
    assert.match(github.comments[0].body, /Operation: pullops:pr:address-review/);
    assert.match(github.comments[1].body, /PullOps addressed feedback `review:PRR_requested`/);
    assert.match(github.comments[1].body, /<summary>PullOps operation audit<\/summary>/);
    assert.match(
      github.comments[2].body,
      /PullOps addressed feedback `pullops-pr-review:PRR_pullops`/,
    );
    assert.match(github.comments[2].body, /<summary>PullOps operation audit<\/summary>/);
    assert.match(github.comments[3].body, /PullOps addressed feedback `comment:7001`/);
    assert.match(github.comments[3].body, /<summary>PullOps operation audit<\/summary>/);
    assert.match(github.updatedBodies[0].body, /Status: Review feedback addressed/);
    assert.match(github.updatedBodies[0].body, /Review cycles: 1 \/ 3/);
    assert.match(github.updatedBodies[0].body, /Last operation: pullops:pr:address-review/);
    assert.deepEqual(github.pullRequestLabelsRemoved, [
      {
        number: 100,
        labels: [
          'pullops:pr:address-review',
          'pullops:pr:review',
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
        labels: ['pullops:pr:review'],
      },
    ]);
    assert.deepEqual(result.prAddressReview, {
      feedback: {
        addressed: 4,
        declined: 0,
        deferred: 0,
      },
      changesCommitted: true,
    });
  });

  it('02: dismisses requested-change reviews whose inline feedback was addressed', async () => {
    const github = createFakeGitHub({
      pullRequest: createPullRequest(),
      reviewContext: createReviewContext({
        comments: [],
        reviews: [
          {
            id: 'PRR_inline_requested',
            state: 'CHANGES_REQUESTED',
            body: '',
            authorLogin: 'maintainer',
            comments: [
              {
                databaseId: 9001,
                body: 'Please make the smoke-test failure valid JavaScript.',
                authorLogin: 'maintainer',
                path: 'src/example.js',
              },
            ],
          },
        ],
        unresolvedThreads: [
          {
            id: 'PRRT_1',
            isResolved: false,
            comments: [
              {
                databaseId: 9001,
                body: 'Please make the smoke-test failure valid JavaScript.',
                authorLogin: 'maintainer',
                path: 'src/example.js',
              },
            ],
          },
        ],
      }),
      diff: createDiff(),
    });
    const git = createFakeGit({ hasChanges: false });
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'addressed',
        summary: 'Addressed the requested change.',
        addressed: [
          {
            feedbackId: 'thread:9001',
            response: 'Changed the smoke-test failure to valid JavaScript.',
          },
        ],
        declined: [],
        deferred: [],
        changes: [],
        testPlan: ['node --test src/operations/pr-address-review/run.test.js'],
      }),
    });

    const result = await runPrAddressReview(
      createContext({
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.deepEqual(github.resolvedReviewThreads, ['PRRT_1']);
    assert.deepEqual(github.dismissedReviews, [
      {
        reviewId: 'PRR_inline_requested',
        message:
          'PullOps handled all actionable feedback associated with this requested-change review.',
      },
    ]);
  });

  it('03: resolves and dismisses requested-change reviews whose inline feedback was declined', async () => {
    const github = createFakeGitHub({
      pullRequest: createPullRequest(),
      reviewContext: createReviewContext({
        comments: [],
        reviews: [
          {
            id: 'PRR_inline_requested',
            state: 'CHANGES_REQUESTED',
            body: '',
            authorLogin: 'maintainer',
            comments: [
              {
                databaseId: 9001,
                body: 'Please add a Bible page-word list.',
                authorLogin: 'maintainer',
                path: 'README.md',
              },
            ],
          },
        ],
        unresolvedThreads: [
          {
            id: 'PRRT_1',
            isResolved: false,
            comments: [
              {
                databaseId: 9001,
                body: 'Please add a Bible page-word list.',
                authorLogin: 'maintainer',
                path: 'README.md',
              },
            ],
          },
        ],
      }),
      diff: createDiff(),
    });
    const git = createFakeGit({ hasChanges: false });
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'addressed',
        summary: 'Declined the requested change as non-actionable for this PR.',
        addressed: [],
        declined: [
          {
            feedbackId: 'thread:9001',
            reason:
              'Bible page numbering depends on a specific edition and is unrelated to this PR.',
          },
        ],
        deferred: [],
        changes: [],
        testPlan: ['node --test src/operations/pr-address-review/run.test.js'],
      }),
    });

    const result = await runPrAddressReview(
      createContext({
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(github.replies[0].commentId, 9001);
    assert.match(github.replies[0].body, /PullOps declined this feedback\./);
    assert.deepEqual(github.resolvedReviewThreads, ['PRRT_1']);
    assert.deepEqual(github.dismissedReviews, [
      {
        reviewId: 'PRR_inline_requested',
        message:
          'PullOps handled all actionable feedback associated with this requested-change review.',
      },
    ]);
  });

  it('04: posts declined feedback responses, defers stale feedback without responding, and returns to review without requiring code changes', async () => {
    const github = createFakeGitHub({
      pullRequest: createPullRequest(),
      reviewContext: createReviewContext({
        comments: [
          {
            databaseId: 7001,
            body: 'Please rename the public option.',
            authorLogin: 'maintainer',
          },
          {
            databaseId: 7002,
            body: 'This comment predates the latest review.',
            authorLogin: 'maintainer',
          },
        ],
        reviews: [],
      }),
      diff: createDiff(),
    });
    const git = createFakeGit({ hasChanges: false });
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'addressed',
        summary: 'Declined one request and deferred one stale comment.',
        addressed: [],
        declined: [
          {
            feedbackId: 'thread:9001',
            reason: 'The requested inline change would break the linked issue behavior.',
          },
          {
            feedbackId: 'comment:7001',
            reason: 'The public option name is already documented and released.',
          },
        ],
        deferred: [
          {
            feedbackId: 'comment:7002',
            reason: 'The comment is stale after the latest review cycle.',
          },
        ],
        changes: [],
        testPlan: [],
      }),
    });

    const result = await runPrAddressReview(
      createContext({
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(git.commits.length, 0);
    assert.equal(git.pushes.length, 0);
    assert.equal(github.replies[0].commentId, 9001);
    assert.match(github.replies[0].body, /PullOps declined this feedback\./);
    assert.match(
      github.replies[0].body,
      /Reason: The requested inline change would break the linked issue behavior\./,
    );
    assert.match(github.replies[0].body, /<summary>PullOps operation audit<\/summary>/);
    assert.equal(github.comments.length, 2);
    assert.match(github.comments[0].body, /<summary>PullOps operation audit<\/summary>/);
    assert.match(github.comments[1].body, /PullOps declined feedback `comment:7001`/);
    assert.match(github.comments[1].body, /<summary>PullOps operation audit<\/summary>/);
    assert.doesNotMatch(github.comments[1].body, /7002/);
    assert.deepEqual(github.resolvedReviewThreads, ['PRRT_1']);
    assert.deepEqual(github.dismissedReviews, []);
    assert.deepEqual(github.pullRequestLabelsAdded, [
      {
        number: 100,
        labels: ['pullops:pr:review'],
      },
    ]);
    assert.deepEqual(result.prAddressReview, {
      feedback: {
        addressed: 0,
        declined: 2,
        deferred: 1,
      },
      changesCommitted: false,
    });
  });

  it('05: blocks without running Codex when the review cycle budget is exhausted', async () => {
    const github = createFakeGitHub({
      pullRequest: createPullRequest({
        body: createPullRequestBody({ reviewCycles: '3 / 3' }),
      }),
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const codex = createFakeCodexRunner({ output: '{}' });

    const result = await runPrAddressReview(
      createContext({
        githubClient: github.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'blocked');
    assert.equal(result.reviewMode, 'blocked');
    assert.match(String(result.summary), /Review cycle budget exhausted/);
    assert.equal(codex.calls.length, 0);
    assert.match(github.updatedBodies[0].body, /Status: Human required/);
    assert.match(github.comments[0].body, /3 \/ 3 Review Cycles have already run/);
    assert.match(github.updatedBodies[0].body, /Escalation review cycles: 1 \/ 1/);
    assert.match(github.updatedBodies[0].body, /Human feedback response cycles: 0/);
    assert.match(github.updatedBodies[0].body, /Processed human feedback review ids: none/);
    assert.match(github.updatedBodies[0].body, /Pending human feedback review id: none/);
    assert.deepEqual(github.pullRequestLabelsAdded, [
      {
        number: 100,
        labels: ['pullops:human-required'],
      },
    ]);
  });

  it('06: records invalid output before posting responses, committing, or pushing', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'pullops-pr-address-review-failure-'));
    const github = createFakeGitHub({
      pullRequest: createPullRequest(),
      reviewContext: createReviewContext({
        reviews: [],
      }),
      diff: createDiff(),
    });
    const git = createFakeGit({ hasChanges: true });
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'addressed',
        summary: 'Only classified one feedback item.',
        addressed: [
          {
            feedbackId: 'thread:9001',
            response: 'Handled the inline comment.',
          },
        ],
        declined: [],
        deferred: [],
        changes: ['A change that must not be committed after invalid output.'],
        testPlan: ['Not run.'],
      }),
    });

    await assert.rejects(
      runPrAddressReview(
        createContext({
          githubClient: github.client,
          gitClient: git.client,
          codexRunner: codex.runner,
          outputDirectory,
        }),
      ),
      /Feedback item "comment:7001" must be classified as addressed, declined, or deferred/,
    );

    assert.equal(github.replies.length, 0);
    assert.equal(git.commits.length, 0);
    assert.equal(git.pushes.length, 0);
    assert.equal(github.comments.length, 2);
    assert.match(github.comments[0].body, /<summary>PullOps operation audit<\/summary>/);
    assert.match(github.comments[1].body, /Invalid Address Review Output/);
    assert.match(github.updatedBodies[0].body, /Status: Human required/);
    assert.equal(
      await readFile(join(outputDirectory, 'failure_reason.txt'), 'utf8'),
      [
        'Invalid Address Review Output: Feedback item "comment:7001" must be classified as addressed, declined, or deferred.',
        '',
      ].join('\n'),
    );
  });

  it('07: uses the escalation model tier when the review budget is exhausted and the escalation marker is present', async () => {
    const config = structuredClone(DEFAULT_PULL_OPS_CONFIG);
    config.runner.models = {
      high: 'gpt-special-high',
      mid: 'gpt-special-mid',
      low: 'gpt-special-low',
    };
    config.operations.prAddressReview = {
      modelTier: 'low',
      escalationModelTier: 'high',
      humanFeedbackResponseModelTier: 'mid',
    };

    const github = createFakeGitHub({
      pullRequest: createPullRequest({
        body: createSpecialPullRequestBody({
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
        status: 'addressed',
        summary: 'Addressed the feedback with the escalation review model.',
        addressed: [
          {
            feedbackId: 'thread:9001',
            response: 'Adjusted the implementation to satisfy the feedback.',
          },
          {
            feedbackId: 'review:PRR_requested',
            response: 'Updated the docs requested by the review summary.',
          },
          {
            feedbackId: 'pullops-pr-review:PRR_pullops',
            response: 'Added the regression coverage requested by PullOps review.',
          },
          {
            feedbackId: 'comment:7001',
            response: 'Clarified the top-level behavior requested in the comment.',
          },
        ],
        declined: [],
        deferred: [],
        changes: [],
        testPlan: [],
      }),
    });

    const result = await runPrAddressReview(
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
    assert.match(github.replies[0].body, /Model tier: high/);
    assert.match(github.replies[0].body, /Model: gpt-special-high/);
    assert.match(github.updatedBodies[0].body, /Review cycles: 3 \/ 3/);
  });

  it('08: uses the human feedback response review mode and model tier for a trusted requested-change review', async () => {
    const github = createFakeGitHub({
      pullRequest: createPullRequest(),
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const git = createFakeGit({ hasChanges: false });
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'addressed',
        summary: 'Addressed all review feedback.',
        addressed: [
          {
            feedbackId: 'thread:9001',
            response: 'Updated the implementation to cover the inline concern.',
          },
          {
            feedbackId: 'review:PRR_requested',
            response: 'Updated the docs requested by the review summary.',
          },
          {
            feedbackId: 'pullops-pr-review:PRR_pullops',
            response: 'Added the missing regression test noted by PullOps review.',
          },
          {
            feedbackId: 'comment:7001',
            response: 'Clarified the behavior requested in the top-level comment.',
          },
        ],
        declined: [],
        deferred: [],
        changes: [],
        testPlan: ['node --test src/operations/pr-address-review/run.test.js'],
      }),
    });

    const result = await runPrAddressReview(
      createContext({
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
        reviewId: 'PRR_requested',
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(result.reviewMode, 'human-feedback-response');
    assert.equal(result.modelTier, 'high');
    assert.equal(result.model, DEFAULT_PULL_OPS_CONFIG.runner.models.high);
    assert.equal(codex.calls[0].model, DEFAULT_PULL_OPS_CONFIG.runner.models.high);
    assert.match(github.updatedBodies[0].body, /Pending human feedback review id: PRR_requested/);
  });

  it('09: does not block a trusted requested-change review when ordinary and escalation review budget are exhausted', async () => {
    const github = createFakeGitHub({
      pullRequest: createPullRequest({
        body: createSpecialPullRequestBody({
          reviewCycles: '3 / 3',
          includeEscalationReviewCycles: false,
        }),
      }),
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const git = createFakeGit({ hasChanges: false });
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'addressed',
        summary: 'Addressed all review feedback.',
        addressed: [
          {
            feedbackId: 'thread:9001',
            response: 'Updated the implementation to cover the inline concern.',
          },
          {
            feedbackId: 'review:PRR_requested',
            response: 'Updated the docs requested by the review summary.',
          },
          {
            feedbackId: 'pullops-pr-review:PRR_pullops',
            response: 'Added the missing regression test noted by PullOps review.',
          },
          {
            feedbackId: 'comment:7001',
            response: 'Clarified the behavior requested in the top-level comment.',
          },
        ],
        declined: [],
        deferred: [],
        changes: [],
        testPlan: ['node --test src/operations/pr-address-review/run.test.js'],
      }),
    });

    const result = await runPrAddressReview(
      createContext({
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
        reviewId: 'PRR_requested',
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(result.reviewMode, 'human-feedback-response');
    assert.equal(result.modelTier, 'high');
    assert.equal(result.model, DEFAULT_PULL_OPS_CONFIG.runner.models.high);
    assert.equal(codex.calls[0].model, DEFAULT_PULL_OPS_CONFIG.runner.models.high);
    assert.match(github.updatedBodies[0].body, /Review cycles: 3 \/ 3/);
    assert.match(github.updatedBodies[0].body, /Escalation review cycles: 1 \/ 1/);
    assert.match(github.updatedBodies[0].body, /Pending human feedback review id: PRR_requested/);
  });

  it('10: skips an already processed trusted requested-change review id without rerunning Codex', async () => {
    const github = createFakeGitHub({
      pullRequest: createPullRequest({
        body: createSpecialPullRequestBody({
          reviewCycles: '3 / 3',
          escalationReviewCycles: '1 / 1',
          humanFeedbackResponseCycles: 1,
          processedHumanFeedbackReviewIds: 'PRR_requested',
        }),
      }),
      reviewContext: createReviewContext(),
      diff: createDiff(),
    });
    const git = createFakeGit({ hasChanges: false });
    const codex = createFakeCodexRunner({
      output: JSON.stringify({
        status: 'addressed',
        summary: 'This output should not be used.',
        addressed: [],
        declined: [],
        deferred: [],
        changes: [],
        testPlan: [],
      }),
    });

    const result = await runPrAddressReview(
      createContext({
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
        reviewId: 'PRR_requested',
      }),
    );

    assert.equal(result.status, 'blocked');
    assert.equal(result.reviewMode, 'blocked');
    assert.match(
      String(result.summary),
      /Trusted requested-change review PRR_requested on PR #100 has already been processed/,
    );
    assert.equal(codex.calls.length, 0);
    assert.equal(github.updatedBodies.length, 0);
    assert.equal(github.pullRequestLabelsAdded.length, 0);
    assert.equal(github.comments.length, 0);
  });
});

/**
 * @param {Partial<OperationRunnerContext>} overrides
 * @returns {OperationRunnerContext}
 */
function createContext(overrides = {}) {
  return {
    operation: 'pr-address-review',
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
    ...overrides,
  };
}

/**
 * @param {{ reviewCycles?: string }} [options]
 * @returns {string}
 */
function createPullRequestBody({ reviewCycles = '1 / 3' } = {}) {
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
    'Source: Issue #42',
    'Last operation: pullops:pr:review',
    '',
    '</details>',
  ].join('\n');
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
 * }} [options]
 * @returns {string}
 */
function createSpecialPullRequestBody({
  reviewCycles = '3 / 3',
  escalationReviewCycles = '0 / 1',
  humanFeedbackResponseCycles = 0,
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
          `Human feedback response cycles: ${humanFeedbackResponseCycles}`,
          `Processed human feedback review ids: ${processedHumanFeedbackReviewIds}`,
          `Pending human feedback review id: ${pendingHumanFeedbackReviewId}`,
        ]
      : []),
    'Source: Issue #42',
    'Last operation: pullops:pr:review',
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
 * @param {Partial<GitHubPullRequestReviewContext>} [overrides]
 * @returns {GitHubPullRequestReviewContext}
 */
function createReviewContext(overrides = {}) {
  return {
    comments: [
      {
        databaseId: 7001,
        body: 'Please clarify how this works from the top-level conversation.',
        authorLogin: 'maintainer',
      },
      {
        databaseId: 7002,
        body: [
          'PullOps ran `pullops:issue:implement`.',
          '',
          '---',
          '',
          '<details>',
          '<summary>PullOps operation audit</summary>',
          '',
          'Operation: pullops:issue:implement',
          'Trigger actor: @github-actions[bot]',
          'Model tier: high',
          'Model: gpt-5.5',
          'Context used: unknown',
          '</details>',
        ].join('\n'),
        authorLogin: 'pullops-bot',
      },
    ],
    reviews: [
      {
        id: 'PRR_requested',
        state: 'CHANGES_REQUESTED',
        body: 'Please update the docs for this behavior.',
        authorLogin: 'reviewer',
      },
      {
        id: 'PRR_pullops',
        state: 'COMMENTED',
        body: 'PullOps review found missing regression coverage.',
        authorLogin: 'github-actions[bot]',
      },
    ],
    unresolvedThreads: [
      {
        id: 'PRRT_1',
        isResolved: false,
        comments: [
          {
            id: 'PRRC_1',
            databaseId: 9001,
            body: 'Existing unresolved inline feedback.',
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
    ...overrides,
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
 * @param {GitHubPullRequestReviewContext} options.reviewContext
 * @param {GitHubPullRequestDiff} options.diff
 * @returns {{
 *   replies: ReplyToPullRequestReviewCommentOptions[];
 *   updatedBodies: UpdatePullRequestBodyOptions[];
 *   pullRequestLabelsAdded: EditLabelsOptions[];
 *   pullRequestLabelsRemoved: EditLabelsOptions[];
 *   comments: CommentOnPullRequestOptions[];
 *   resolvedReviewThreads: string[];
 *   dismissedReviews: DismissPullRequestReviewOptions[];
 *   client: import('../../github/types.js').GitHubClient;
 * }}
 */
function createFakeGitHub({ pullRequest, reviewContext, diff }) {
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
  /** @type {string[]} */
  const resolvedReviewThreads = [];
  /** @type {DismissPullRequestReviewOptions[]} */
  const dismissedReviews = [];

  return {
    replies,
    updatedBodies,
    pullRequestLabelsAdded,
    pullRequestLabelsRemoved,
    comments,
    resolvedReviewThreads,
    dismissedReviews,
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
      async publishPullRequestReview() {
        throw new Error('publishPullRequestReview was not expected in this test.');
      },
      async replyToPullRequestReviewComment(options) {
        replies.push(options);
      },
      async resolvePullRequestReviewThread(threadId) {
        resolvedReviewThreads.push(threadId);
      },
      async dismissPullRequestReview(options) {
        dismissedReviews.push(options);
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
