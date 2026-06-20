import { PULL_OPS_OPERATION_LABELS } from '../../labels/pullOpsLabels.js';
import {
  applyManagedPrTransition,
  readManagedPrState,
  refusePrOperationTarget,
} from '../../managed-pr/ManagedPrState.js';
import {
  createSkippedCodexActionOutput,
  getCodexActionFiles,
  readCodexActionOutput,
  writeCodexActionPrompt,
} from '../codexAction.js';
import { hasPullOpsBranchPrefix } from '../branchNames.js';
import { appendOperationAuditFooter } from '../auditComment.js';
import { filterCommentsToDiffAnchors } from './anchors.js';
import { validatePrReviewOutput } from './output.js';
import { buildPrReviewPrompt } from './prompt.js';
import { determinePrReviewMode, resolveReviewModelSelection } from '../reviewSelection.js';

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../../github/types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('../../github/types.js').GitHubPullRequestReviewContext} GitHubPullRequestReviewContext
 * @typedef {import('./output.types.js').CompletedPrReviewOutput} CompletedPrReviewOutput
 * @typedef {import('./output.types.js').ReviewReply} ReviewReply
 * @typedef {import('./output.types.js').ReviewResultStatus} ReviewResultStatus
 * @typedef {import('./run.types.js').PrReviewPreparation} PrReviewPreparation
 */

export const GITHUB_ACTIONS_BOT_AUTHOR = {
  name: 'github-actions[bot]',
  email: '41898282+github-actions[bot]@users.noreply.github.com',
};

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runPrReview(context) {
  const preparation = await preparePrReview(context);
  if (!preparation.ready) {
    return preparation.output;
  }

  const executionContext = withSelectedModel(context, preparation);

  let rawOutput;

  try {
    rawOutput = await context.codexRunner.run({
      cwd: context.cwd,
      command: context.config.runner.command,
      model: executionContext.model,
      prompt: buildPrReviewPrompt({
        pullRequest: preparation.pullRequest,
        issue: preparation.issue,
        reviewContext: preparation.reviewContext,
        diff: preparation.diff,
      }),
    });
  } catch (error) {
    await recordPullRequestFailure(context, preparation.pullRequest, getErrorMessage(error), {
      updateBody: true,
      reviewCycle: preparation.nextReviewCycle,
      maxReviewCycles: preparation.maxReviewCycles,
    });
    throw error;
  }

  return await finalizePreparedPrReview(executionContext, context, preparation, rawOutput);
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runPrReviewCodexActionPrepare(context) {
  const preparation = await preparePrReview(context);
  if (!preparation.ready) {
    return preparation.output;
  }

  const executionContext = withSelectedModel(context, preparation);

  try {
    await writeCodexActionPrompt(
      executionContext,
      buildPrReviewPrompt({
        pullRequest: preparation.pullRequest,
        issue: preparation.issue,
        reviewContext: preparation.reviewContext,
        diff: preparation.diff,
      }),
    );
  } catch (error) {
    await recordPullRequestFailure(context, preparation.pullRequest, getErrorMessage(error), {
      updateBody: true,
      reviewCycle: preparation.nextReviewCycle,
      maxReviewCycles: preparation.maxReviewCycles,
    });
    throw error;
  }

  const files = getCodexActionFiles(context);
  return {
    status: 'accepted',
    summary: `Prepared Codex Action review run for PR #${preparation.pullRequest.number}.`,
    reviewMode: preparation.reviewMode,
    modelTier: preparation.modelTier,
    model: preparation.model,
    pullRequest: {
      number: preparation.pullRequest.number,
      url: preparation.pullRequest.url,
    },
    codexAction: {
      promptFile: files.promptFile,
      outputFile: files.outputFile,
      model: executionContext.model,
      branch: preparation.pullRequest.headRefName,
    },
  };
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runPrReviewCodexActionFinalize(context) {
  if (context.runnerRan === false) {
    return createSkippedCodexActionOutput(context);
  }

  const preparation = await preparePrReview(context);
  if (!preparation.ready) {
    return preparation.output;
  }

  const executionContext = withSelectedModel(context, preparation);

  let rawOutput;

  try {
    rawOutput = await readCodexActionOutput(context);
  } catch (error) {
    await recordPullRequestFailure(context, preparation.pullRequest, getErrorMessage(error), {
      updateBody: true,
      reviewCycle: preparation.nextReviewCycle,
      maxReviewCycles: preparation.maxReviewCycles,
    });
    throw error;
  }

  return await finalizePreparedPrReview(executionContext, context, preparation, rawOutput);
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<PrReviewPreparation>}
 */
async function preparePrReview(context) {
  assertPullRequestTarget(context);

  const pullRequest = await context.githubClient.getPullRequest(context.target.number);
  const state = readManagedPrState(pullRequest.body);

  if (pullRequest.isCrossRepository === true) {
    return {
      ready: false,
      output: await refusePullRequest(context, pullRequest, {
        reason: `PullOps v1 only reviews same-repository PRs. PR #${pullRequest.number} comes from a fork.`,
      }),
    };
  }

  if (!state.managed) {
    return {
      ready: false,
      output: await refusePullRequest(context, pullRequest, {
        reason: `PR #${pullRequest.number} is not a PullOps-managed PR.`,
      }),
    };
  }

  if (
    !hasPullOpsBranchPrefix({
      branchName: pullRequest.headRefName,
      branchPrefix: context.config.branchPrefix,
    })
  ) {
    return {
      ready: false,
      output: await refusePullRequest(context, pullRequest, {
        reason: `PR #${pullRequest.number} head branch "${pullRequest.headRefName}" does not use the configured PullOps branch prefix.`,
      }),
    };
  }

  if (state.sourceIssueNumber === undefined) {
    return {
      ready: false,
      output: await refusePullRequest(context, pullRequest, {
        reason: `PR #${pullRequest.number} does not include a structured Source: Issue #<number> line.`,
      }),
    };
  }

  const issue = await context.githubClient.getIssue(state.sourceIssueNumber);
  if (state.sourceKind === 'parentIssue') {
    const openChildIssues = issue.subIssues.filter(childIssue => !isClosedIssue(childIssue));
    if (openChildIssues.length > 0) {
      return {
        ready: false,
        output: await refusePullRequest(context, pullRequest, {
          reason: [
            `Umbrella PRD PR #${pullRequest.number} is incomplete because native Child Issues`,
            `${formatIssueList(openChildIssues)} remain open.`,
            'Incomplete PRDs cannot be approved.',
          ].join(' '),
        }),
      };
    }
  }

  const reviewMode = determinePrReviewMode(state);
  if (reviewMode === 'blocked') {
    return {
      ready: false,
      output: await blockReviewCycleBudget(context, pullRequest, {
        reviewCycle: state.reviewCycles.current,
        maxReviewCycles: state.reviewCycles.max,
      }),
    };
  }

  const modelSelection = resolveReviewModelSelection(context, 'pr-review', reviewMode);
  const nextReviewCycle =
    reviewMode === 'normal' ? state.reviewCycles.current + 1 : state.reviewCycles.current;

  const reviewContext = await context.githubClient.getPullRequestReviewContext(pullRequest.number);
  const diff = await context.githubClient.getPullRequestDiff(pullRequest.number);

  return {
    ready: true,
    reviewMode,
    modelTier: modelSelection.modelTier,
    model: modelSelection.model,
    pullRequest,
    issue,
    reviewContext,
    diff,
    nextReviewCycle,
    maxReviewCycles: state.reviewCycles.max,
  };
}

/**
 * @param {OperationRunnerContext} executionContext
 * @param {OperationRunnerContext} context
 * @param {PrReviewPreparation & { ready: true }} preparation
 * @param {unknown} rawOutput
 * @returns {Promise<Record<string, unknown>>}
 */
async function finalizePreparedPrReview(executionContext, context, preparation, rawOutput) {
  const { pullRequest, reviewContext, diff, nextReviewCycle, maxReviewCycles } = preparation;
  let failureRecorded = false;

  try {
    const validatedOutput = validatePrReviewOutput(rawOutput);

    if (!validatedOutput.valid) {
      const reason = `Invalid Review Result: ${validatedOutput.reason}`;
      failureRecorded = true;
      await recordPullRequestFailure(context, pullRequest, reason, {
        updateBody: true,
        reviewCycle: nextReviewCycle,
        maxReviewCycles,
      });
      throw new Error(reason);
    }

    if (validatedOutput.value.status === 'blocked') {
      failureRecorded = true;
      await context.githubClient.publishPullRequestReview({
        number: pullRequest.number,
        event: 'COMMENT',
        body: appendOperationAuditFooter(validatedOutput.value.summary, executionContext, {
          operation: PULL_OPS_OPERATION_LABELS.prReview,
        }),
        comments: [],
      });
      await recordPullRequestFailure(context, pullRequest, validatedOutput.value.failureReason, {
        updateBody: true,
        reviewCycle: nextReviewCycle,
        maxReviewCycles,
      });
      return {
        status: 'blocked',
        summary: validatedOutput.value.summary,
        pullRequest: {
          number: pullRequest.number,
          url: pullRequest.url,
        },
      };
    }

    const reviewResult = validatedOutput.value;
    const comments = filterCommentsToDiffAnchors({
      comments: reviewResult.comments,
      patch: diff.patch,
    });
    const replies = filterRepliesToUnresolvedThreads({
      replies: reviewResult.replies,
      reviewContext,
    });
    const directChangesCommitted = await commitDirectReviewChangesIfPresent(
      context,
      pullRequest,
      reviewResult,
    );
    const reviewedTreeHash =
      reviewResult.status === 'approved' ? await context.gitClient.getCurrentTreeHash() : undefined;

    for (const reply of replies.publishable) {
      await context.githubClient.replyToPullRequestReviewComment({
        commentId: reply.commentId,
        body: reply.body,
      });
    }

    await context.githubClient.publishPullRequestReview({
      number: pullRequest.number,
      // PullOps records approved/changes-requested in PR state and labels. A formal
      // GitHub review event is rejected for draft PRs and same-token automation.
      event: 'COMMENT',
      body: appendOperationAuditFooter(reviewResult.summary, executionContext, {
        operation: PULL_OPS_OPERATION_LABELS.prReview,
      }),
      comments: comments.publishable,
    });

    await applyManagedPrTransition({
      githubClient: context.githubClient,
      outputDirectory: context.outputDirectory,
      pullRequest,
      operation: PULL_OPS_OPERATION_LABELS.prReview,
      suppressFollowUpOperationLabels: context.suppressFollowUpOperationLabels,
      outcome:
        reviewResult.status === 'approved'
          ? {
              kind: 'approved',
              reviewCycle: nextReviewCycle,
              maxReviewCycles,
              reviewMode: preparation.reviewMode,
              reviewedTreeHash,
            }
          : {
              kind: 'changes-requested',
              reviewCycle: nextReviewCycle,
              maxReviewCycles,
              reviewMode: preparation.reviewMode,
            },
    });

    return {
      status: 'accepted',
      summary: summarizeReviewResult(pullRequest, reviewResult.status),
      reviewResult: reviewResult.status,
      reviewMode: preparation.reviewMode,
      modelTier: preparation.modelTier,
      model: preparation.model,
      pullRequest: {
        number: pullRequest.number,
        url: pullRequest.url,
      },
      review: {
        comments: {
          published: comments.publishable.length,
          dropped: comments.dropped.length,
        },
        replies: {
          published: replies.publishable.length,
          dropped: replies.dropped.length,
        },
        directChangesCommitted,
      },
    };
  } catch (error) {
    if (!failureRecorded) {
      await recordPullRequestFailure(context, pullRequest, getErrorMessage(error), {
        updateBody: true,
        reviewCycle: nextReviewCycle,
        maxReviewCycles,
      });
    }

    throw error;
  }
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @param {CompletedPrReviewOutput} reviewResult
 * @returns {Promise<boolean>}
 */
async function commitDirectReviewChangesIfPresent(context, pullRequest, reviewResult) {
  if (!(await context.gitClient.hasChanges())) {
    return false;
  }

  await context.gitClient.commitAll({
    message: createPrReviewCommitMessage(pullRequest, reviewResult),
    author: GITHUB_ACTIONS_BOT_AUTHOR,
  });
  await context.gitClient.pushBranch({
    branchName: pullRequest.headRefName,
  });

  return true;
}

/**
 * @param {GitHubPullRequest} pullRequest
 * @param {CompletedPrReviewOutput} reviewResult
 * @returns {string}
 */
export function createPrReviewCommitMessage(pullRequest, reviewResult) {
  return [
    `chore(review): apply review improvements for PR #${pullRequest.number}`,
    '',
    reviewResult.directChanges.length === 0
      ? reviewResult.summary
      : reviewResult.directChanges.map(change => `- ${change}`).join('\n'),
    '',
    `Refs: #${pullRequest.number}`,
  ].join('\n');
}

/**
 * @param {object} options
 * @param {ReviewReply[]} options.replies
 * @param {GitHubPullRequestReviewContext} options.reviewContext
 * @returns {{ publishable: ReviewReply[], dropped: ReviewReply[] }}
 */
function filterRepliesToUnresolvedThreads({ replies, reviewContext }) {
  const unresolvedCommentIds = new Set(
    reviewContext.unresolvedThreads.flatMap(thread =>
      thread.comments.flatMap(comment =>
        comment.databaseId === undefined ? [] : [comment.databaseId],
      ),
    ),
  );

  /** @type {ReviewReply[]} */
  const publishable = [];
  /** @type {ReviewReply[]} */
  const dropped = [];

  for (const reply of replies) {
    if (unresolvedCommentIds.has(reply.commentId)) {
      publishable.push(reply);
      continue;
    }

    dropped.push(reply);
  }

  return { publishable, dropped };
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @param {{ reason: string }} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function refusePullRequest(context, pullRequest, { reason }) {
  await refusePrOperationTarget({
    githubClient: context.githubClient,
    outputDirectory: context.outputDirectory,
    pullRequest,
    operation: PULL_OPS_OPERATION_LABELS.prReview,
    reason,
  });

  return {
    status: 'refused',
    summary: reason,
    pullRequest: {
      number: pullRequest.number,
      url: pullRequest.url,
    },
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @param {string} reason
 * @param {{ updateBody: boolean, reviewCycle: number, maxReviewCycles: number }} options
 * @returns {Promise<void>}
 */
async function recordPullRequestFailure(
  context,
  pullRequest,
  reason,
  { updateBody, reviewCycle, maxReviewCycles },
) {
  if (!updateBody) {
    await refusePrOperationTarget({
      githubClient: context.githubClient,
      outputDirectory: context.outputDirectory,
      pullRequest,
      operation: PULL_OPS_OPERATION_LABELS.prReview,
      reason,
    });
    return;
  }

  await applyManagedPrTransition({
    githubClient: context.githubClient,
    outputDirectory: context.outputDirectory,
    pullRequest,
    operation: PULL_OPS_OPERATION_LABELS.prReview,
    suppressFollowUpOperationLabels: context.suppressFollowUpOperationLabels,
    outcome: {
      kind: 'blocked',
      reason,
      reviewCycle,
      maxReviewCycles,
    },
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @param {{ reviewCycle: number, maxReviewCycles: number }} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function blockReviewCycleBudget(context, pullRequest, { reviewCycle, maxReviewCycles }) {
  const reason = [
    `Review cycle budget exhausted for PR #${pullRequest.number}:`,
    `${reviewCycle} / ${maxReviewCycles} Review Cycles have already run.`,
  ].join(' ');

  await applyManagedPrTransition({
    githubClient: context.githubClient,
    outputDirectory: context.outputDirectory,
    pullRequest,
    operation: PULL_OPS_OPERATION_LABELS.prReview,
    suppressFollowUpOperationLabels: context.suppressFollowUpOperationLabels,
    outcome: {
      kind: 'blocked',
      reason,
      reviewCycle,
      maxReviewCycles,
    },
  });

  return {
    status: 'blocked',
    summary: reason,
    reviewMode: 'blocked',
    pullRequest: {
      number: pullRequest.number,
      url: pullRequest.url,
    },
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {{
 *   modelTier: import('../../config/types.js').ModelTier;
 *   model: string;
 * }} selection
 * @returns {OperationRunnerContext}
 */
function withSelectedModel(context, selection) {
  return {
    ...context,
    modelTier: selection.modelTier,
    model: selection.model,
  };
}

/**
 * @param {GitHubPullRequest} pullRequest
 * @param {ReviewResultStatus} status
 * @returns {string}
 */
function summarizeReviewResult(pullRequest, status) {
  if (status === 'approved') {
    return `Approved PullOps-managed PR #${pullRequest.number}.`;
  }

  return `Requested changes on PullOps-managed PR #${pullRequest.number}.`;
}

/**
 * @param {import('../../github/types.js').GitHubIssueReference} issue
 * @returns {boolean}
 */
function isClosedIssue(issue) {
  return issue.state?.toUpperCase() === 'CLOSED';
}

/**
 * @param {import('../../github/types.js').GitHubIssueReference[]} issues
 * @returns {string}
 */
function formatIssueList(issues) {
  return issues.map(issue => `#${issue.number}`).join(', ');
}

/**
 * @param {OperationRunnerContext} context
 * @returns {asserts context is OperationRunnerContext & { target: { type: 'pr', number: number } }}
 */
function assertPullRequestTarget(context) {
  if (context.target.type !== 'pr') {
    throw new Error('pr-review requires a pull request target.');
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
