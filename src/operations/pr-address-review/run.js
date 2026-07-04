import {
  applyManagedPrTransition,
  readManagedPrState,
  refusePrOperationTarget,
} from '../../managed-pr/ManagedPrState.js';
import { requireOperationCatalogOperationLabelName } from '../operationCatalog.js';
import {
  createExternalRunnerJob,
  createSkippedCodexActionOutput,
  isSkippedExternalRunnerResult,
  readCodexActionOutput,
  writeCodexActionPrompt,
} from '../codexAction.js';
import {
  appendOperationAuditFooter,
  commentOnPullRequestWithOperationAudit,
} from '../auditComment.js';
import { hasPullOpsBranchPrefix } from '../branchNames.js';
import {
  determinePrAddressReviewMode,
  findBlockingPendingHumanFeedbackReviewId,
  resolveReviewModelSelection,
} from '../reviewSelection.js';
import { collectPrAddressReviewFeedback } from './feedback.js';
import { validateAddressReviewFeedbackCoverage } from './feedbackCoverage.js';
import { validatePrAddressReviewOutput } from './output.js';
import { buildAddressPrReviewompt } from './prompt.js';
import { readLocalRunStateRecordFromDirectory } from '../../local-run-state/localRunState.js';
import { GITHUB_ACTIONS_BOT_AUTHOR } from '../githubActionsBot.js';

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('../../github/types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('../../github/types.js').GitHubPullRequestReviewContext} GitHubPullRequestReviewContext
 * @typedef {import('../../github/types.js').GitHubPullRequestDiff} GitHubPullRequestDiff
 * @typedef {import('./feedback.types.js').PrAddressReviewFeedbackItem} PrAddressReviewFeedbackItem
 * @typedef {import('./output.types.js').AddressedFeedback} AddressedFeedback
 * @typedef {import('./output.types.js').ReasonedFeedback} ReasonedFeedback
 * @typedef {import('./output.types.js').CompletedPrAddressReviewOutput} CompletedPrAddressReviewOutput
 * @typedef {import('./run.types.js').AddressPrRevieweparation} AddressPrRevieweparation
 */

const REQUESTED_CHANGE_DISMISSAL_MESSAGE =
  'PullOps handled all actionable feedback associated with this requested-change review.';

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runPrAddressReview(context) {
  const preparation = await preparePrAddressReview(context);
  if (!preparation.ready) {
    return preparation.output;
  }

  const executionContext = withSelectedModel(context, preparation);
  const localRunStateRecord =
    context.localRunRecordDirectory === undefined
      ? undefined
      : await readLocalRunStateRecordFromDirectory(context.localRunRecordDirectory);

  let rawOutput;

  try {
    rawOutput = await context.codexRunner.run({
      cwd: context.cwd,
      command: context.config.runner.command,
      model: executionContext.model,
      prompt: buildAddressPrReviewompt({
        pullRequest: preparation.pullRequest,
        issue: preparation.issue,
        reviewContext: preparation.reviewContext,
        diff: preparation.diff,
        feedbackItems: preparation.feedbackItems,
      }),
      streamOutput: context.suppressRunnerOutput !== true,
      env: localRunStateRecord?.heartbeatEnvironment,
    });
  } catch (error) {
    await recordPullRequestFailure(context, preparation.pullRequest, getErrorMessage(error), {
      updateBody: true,
      reviewCycle: preparation.reviewCycle,
      maxReviewCycles: preparation.maxReviewCycles,
    });
    throw error;
  }

  return await finalizePreparedPrAddressReview(executionContext, context, preparation, rawOutput);
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runPrAddressReviewCodexActionPrepare(context) {
  const preparation = await preparePrAddressReview(context);
  if (!preparation.ready) {
    return preparation.output;
  }

  const executionContext = withSelectedModel(context, preparation);

  let handoff;
  try {
    handoff = await writeCodexActionPrompt(
      executionContext,
      buildAddressPrReviewompt({
        pullRequest: preparation.pullRequest,
        issue: preparation.issue,
        reviewContext: preparation.reviewContext,
        diff: preparation.diff,
        feedbackItems: preparation.feedbackItems,
      }),
      { branch: preparation.pullRequest.headRefName },
    );
  } catch (error) {
    await recordPullRequestFailure(context, preparation.pullRequest, getErrorMessage(error), {
      updateBody: true,
      reviewCycle: preparation.reviewCycle,
      maxReviewCycles: preparation.maxReviewCycles,
    });
    throw error;
  }

  return {
    status: 'waiting',
    summary: `Prepared external pr-address-review run for PR #${preparation.pullRequest.number}.`,
    reviewMode: preparation.reviewMode,
    modelTier: preparation.modelTier,
    model: preparation.model,
    pullRequest: {
      number: preparation.pullRequest.number,
      url: preparation.pullRequest.url,
    },
    feedback: {
      items: preparation.feedbackItems.length,
    },
    runnerJob: createExternalRunnerJob(context, handoff, {
      model: executionContext.model,
      branch: preparation.pullRequest.headRefName,
    }),
  };
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runPrAddressReviewCodexActionFinalize(context) {
  const preparation = await preparePrAddressReview(context);
  if (!preparation.ready) {
    return preparation.output;
  }

  const executionContext = withSelectedModel(context, preparation);

  let rawOutput;

  try {
    rawOutput = await readCodexActionOutput(context);
  } catch (error) {
    if (isSkippedExternalRunnerResult(error)) {
      return createSkippedCodexActionOutput(context);
    }

    await recordPullRequestFailure(context, preparation.pullRequest, getErrorMessage(error), {
      updateBody: true,
      reviewCycle: preparation.reviewCycle,
      maxReviewCycles: preparation.maxReviewCycles,
    });
    throw error;
  }

  return await finalizePreparedPrAddressReview(executionContext, context, preparation, rawOutput);
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<AddressPrRevieweparation>}
 */
async function preparePrAddressReview(context) {
  assertPullRequestTarget(context);

  const pullRequest = await context.githubClient.getPullRequest(context.target.number);
  const state = readManagedPrState(pullRequest.body);

  if (pullRequest.isCrossRepository === true) {
    return {
      ready: false,
      output: await refusePullRequest(context, pullRequest, {
        reason: `PullOps v1 only addresses review feedback on same-repository PRs. PR #${pullRequest.number} comes from a fork.`,
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

  if (
    context.reviewId !== undefined &&
    hasProcessedHumanFeedbackReviewId(state, context.reviewId)
  ) {
    return {
      ready: false,
      output: skipProcessedHumanFeedbackReview(pullRequest, context.reviewId),
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

  const blockingPendingReviewId = findBlockingPendingHumanFeedbackReviewId(state, context.reviewId);
  if (blockingPendingReviewId !== undefined && context.reviewId !== undefined) {
    return {
      ready: false,
      output: await blockPendingHumanFeedbackReview(context, pullRequest, {
        pendingReviewId: blockingPendingReviewId,
        reviewId: context.reviewId,
        reviewCycle: state.reviewCycles.current,
        maxReviewCycles: state.reviewCycles.max,
      }),
    };
  }

  const reviewMode = determinePrAddressReviewMode(state, {
    reviewId: context.reviewId,
  });
  if (reviewMode === 'blocked') {
    return {
      ready: false,
      output: await blockReviewCycleBudget(context, pullRequest, {
        reviewCycle: state.reviewCycles.current,
        maxReviewCycles: state.reviewCycles.max,
      }),
    };
  }

  const modelSelection = resolveReviewModelSelection(context, 'pr-address-review', reviewMode);

  const issue = await context.githubClient.getIssue(state.sourceIssueNumber);
  const reviewContext = await context.githubClient.getPullRequestReviewContext(pullRequest.number);
  const diff = await context.githubClient.getPullRequestDiff(pullRequest.number);
  const feedbackItems = collectPrAddressReviewFeedback(reviewContext);

  return {
    ready: true,
    reviewMode,
    modelTier: modelSelection.modelTier,
    model: modelSelection.model,
    pullRequest,
    issue,
    reviewContext,
    diff,
    feedbackItems,
    reviewCycle: state.reviewCycles.current,
    maxReviewCycles: state.reviewCycles.max,
  };
}

/**
 * @param {import('../../managed-pr/ManagedPrState.types.js').ManagedPrState} state
 * @param {string} reviewId
 * @returns {boolean}
 */
function hasProcessedHumanFeedbackReviewId(state, reviewId) {
  return state.processedHumanFeedbackReviewIds?.includes(reviewId) ?? false;
}

/**
 * @param {GitHubPullRequest} pullRequest
 * @param {string} reviewId
 * @returns {Record<string, unknown>}
 */
function skipProcessedHumanFeedbackReview(pullRequest, reviewId) {
  return {
    status: 'blocked',
    summary: `Trusted requested-change review ${reviewId} on PR #${pullRequest.number} has already been processed; skipping this Human Feedback Response Cycle.`,
    reviewMode: 'blocked',
    pullRequest: {
      number: pullRequest.number,
      url: pullRequest.url,
    },
  };
}

/**
 * @param {OperationRunnerContext} executionContext
 * @param {OperationRunnerContext} context
 * @param {AddressPrRevieweparation & { ready: true }} preparation
 * @param {unknown} rawOutput
 * @returns {Promise<Record<string, unknown>>}
 */
async function finalizePreparedPrAddressReview(executionContext, context, preparation, rawOutput) {
  const { pullRequest, reviewContext, feedbackItems, reviewCycle, maxReviewCycles } = preparation;
  let failureRecorded = false;

  try {
    await commentOnPullRequestWithOperationAudit(executionContext, {
      pullRequestNumber: pullRequest.number,
      operation: requireOperationCatalogOperationLabelName('pr-address-review'),
    });

    const validatedOutput = validatePrAddressReviewOutput(rawOutput);

    if (!validatedOutput.valid) {
      const reason = `Invalid Address Review Output: ${validatedOutput.reason}`;
      failureRecorded = true;
      await recordPullRequestFailure(context, pullRequest, reason, {
        updateBody: true,
        reviewCycle,
        maxReviewCycles,
      });
      throw new Error(reason);
    }

    if (validatedOutput.value.status === 'blocked') {
      failureRecorded = true;
      await recordPullRequestFailure(context, pullRequest, validatedOutput.value.failureReason, {
        updateBody: true,
        reviewCycle,
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

    const coverage = validateAddressReviewFeedbackCoverage(
      validatedOutput.value,
      feedbackItems.map(item => item.id),
    );
    if (!coverage.valid) {
      const reason = `Invalid Address Review Output: ${coverage.reason}`;
      failureRecorded = true;
      await recordPullRequestFailure(context, pullRequest, reason, {
        updateBody: true,
        reviewCycle,
        maxReviewCycles,
      });
      throw new Error(reason);
    }

    const changesCommitted = await commitPrAddressReviewChangesIfPresent(
      context,
      pullRequest,
      validatedOutput.value,
    );
    await postPrAddressReviewResponses(
      executionContext,
      pullRequest,
      feedbackItems,
      validatedOutput.value,
    );
    await resolveHandledReviewThreads(context, feedbackItems, validatedOutput.value);
    await dismissHandledRequestedChangeReviews(
      context,
      reviewContext,
      feedbackItems,
      validatedOutput.value,
    );
    await applyManagedPrTransition({
      githubClient: context.githubClient,
      outputDirectory: context.outputDirectory,
      pullRequest,
      operation: requireOperationCatalogOperationLabelName('pr-address-review'),
      suppressFollowUpOperationLabels: context.suppressFollowUpOperationLabels,
      outcome: {
        kind: 'addressed',
        reviewCycle,
        maxReviewCycles,
        reviewId:
          preparation.reviewMode === 'human-feedback-response' ? context.reviewId : undefined,
      },
    });

    return {
      status: 'accepted',
      summary: `Addressed review feedback on PullOps-managed PR #${pullRequest.number} and returned it to review.`,
      reviewMode: preparation.reviewMode,
      modelTier: preparation.modelTier,
      model: preparation.model,
      pullRequest: {
        number: pullRequest.number,
        url: pullRequest.url,
      },
      prAddressReview: {
        feedback: {
          addressed: validatedOutput.value.addressed.length,
          declined: validatedOutput.value.declined.length,
          deferred: validatedOutput.value.deferred.length,
        },
        changesCommitted,
      },
    };
  } catch (error) {
    if (!failureRecorded) {
      await recordPullRequestFailure(context, pullRequest, getErrorMessage(error), {
        updateBody: true,
        reviewCycle,
        maxReviewCycles,
      });
    }

    throw error;
  }
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @param {CompletedPrAddressReviewOutput} output
 * @returns {Promise<boolean>}
 */
async function commitPrAddressReviewChangesIfPresent(context, pullRequest, output) {
  if (!(await context.gitClient.hasChanges())) {
    return false;
  }

  await context.gitClient.commitAll({
    message: createPrAddressReviewCommitMessage(pullRequest, output),
    author: GITHUB_ACTIONS_BOT_AUTHOR,
  });
  await context.gitClient.pushBranch({
    branchName: pullRequest.headRefName,
  });

  return true;
}

/**
 * @param {GitHubPullRequest} pullRequest
 * @param {CompletedPrAddressReviewOutput} output
 * @returns {string}
 */
export function createPrAddressReviewCommitMessage(pullRequest, output) {
  return [
    `fix(pr-address-review): address feedback for PR #${pullRequest.number}`,
    '',
    output.changes.length === 0
      ? output.summary
      : output.changes.map(change => `- ${change}`).join('\n'),
    '',
    `Refs: #${pullRequest.number}`,
  ].join('\n');
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @param {PrAddressReviewFeedbackItem[]} feedbackItems
 * @param {CompletedPrAddressReviewOutput} output
 * @returns {Promise<void>}
 */
async function postPrAddressReviewResponses(context, pullRequest, feedbackItems, output) {
  const feedbackById = new Map(feedbackItems.map(item => [item.id, item]));

  for (const feedback of output.addressed) {
    await postFeedbackResponse(context, pullRequest, requireFeedback(feedbackById, feedback), {
      disposition: 'addressed',
      body: feedback.response,
    });
  }

  for (const feedback of output.declined) {
    await postFeedbackResponse(context, pullRequest, requireFeedback(feedbackById, feedback), {
      disposition: 'declined',
      body: `Reason: ${feedback.reason}`,
    });
  }
}

/**
 * @param {Map<string, PrAddressReviewFeedbackItem>} feedbackById
 * @param {AddressedFeedback | ReasonedFeedback} feedback
 * @returns {PrAddressReviewFeedbackItem}
 */
function requireFeedback(feedbackById, feedback) {
  const item = feedbackById.get(feedback.feedbackId);
  if (item === undefined) {
    throw new Error(`Unknown feedbackId "${feedback.feedbackId}".`);
  }

  return item;
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @param {PrAddressReviewFeedbackItem} feedback
 * @param {{ disposition: 'addressed' | 'declined', body: string }} response
 * @returns {Promise<void>}
 */
async function postFeedbackResponse(context, pullRequest, feedback, response) {
  const body = appendOperationAuditFooter(
    [`PullOps ${response.disposition} this feedback.`, '', response.body].join('\n'),
    context,
    { operation: requireOperationCatalogOperationLabelName('pr-address-review') },
  );

  if (feedback.replyCommentId !== undefined) {
    await context.githubClient.replyToPullRequestReviewComment({
      commentId: feedback.replyCommentId,
      body,
    });
    return;
  }

  await context.githubClient.commentOnPullRequest({
    number: pullRequest.number,
    body: appendOperationAuditFooter(
      [
        `PullOps ${response.disposition} feedback \`${feedback.id}\` (${formatFeedbackSurface(
          feedback.surface,
        )}).`,
        '',
        response.body,
      ].join('\n'),
      context,
      { operation: requireOperationCatalogOperationLabelName('pr-address-review') },
    ),
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {PrAddressReviewFeedbackItem[]} feedbackItems
 * @param {CompletedPrAddressReviewOutput} output
 * @returns {Promise<void>}
 */
async function resolveHandledReviewThreads(context, feedbackItems, output) {
  const handledIds = collectHandledFeedbackIds(output);
  /** @type {Map<string, PrAddressReviewFeedbackItem[]>} */
  const feedbackItemsByThread = new Map();

  for (const feedback of feedbackItems) {
    if (feedback.reviewThreadId === undefined) {
      continue;
    }

    const threadFeedback = feedbackItemsByThread.get(feedback.reviewThreadId) ?? [];
    threadFeedback.push(feedback);
    feedbackItemsByThread.set(feedback.reviewThreadId, threadFeedback);
  }

  for (const [threadId, threadFeedback] of feedbackItemsByThread) {
    if (threadFeedback.every(feedback => handledIds.has(feedback.id))) {
      await context.githubClient.resolvePullRequestReviewThread(threadId);
    }
  }
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequestReviewContext} reviewContext
 * @param {PrAddressReviewFeedbackItem[]} feedbackItems
 * @param {CompletedPrAddressReviewOutput} output
 * @returns {Promise<void>}
 */
async function dismissHandledRequestedChangeReviews(context, reviewContext, feedbackItems, output) {
  const reviewIds = findHandledRequestedChangeReviewIds(reviewContext, feedbackItems, output);
  if (reviewIds.length === 0) {
    return;
  }

  if (context.githubClient.dismissPullRequestReview === undefined) {
    throw new Error('GitHub client does not support dismissing requested-change reviews.');
  }

  for (const reviewId of reviewIds) {
    await context.githubClient.dismissPullRequestReview({
      reviewId,
      message: REQUESTED_CHANGE_DISMISSAL_MESSAGE,
    });
  }
}

/**
 * @param {GitHubPullRequestReviewContext} reviewContext
 * @param {PrAddressReviewFeedbackItem[]} feedbackItems
 * @param {CompletedPrAddressReviewOutput} output
 * @returns {string[]}
 */
function findHandledRequestedChangeReviewIds(reviewContext, feedbackItems, output) {
  const feedbackIds = new Set(feedbackItems.map(feedback => feedback.id));
  const handledIds = collectHandledFeedbackIds(output);
  /** @type {string[]} */
  const reviewIds = [];

  for (const [index, review] of reviewContext.reviews.entries()) {
    if (review.state !== 'CHANGES_REQUESTED' || review.id === undefined) {
      continue;
    }

    const reviewFeedbackIds = collectRequestedChangeReviewFeedbackIds(review, index, feedbackIds);
    if (
      reviewFeedbackIds.length > 0 &&
      reviewFeedbackIds.every(feedbackId => handledIds.has(feedbackId))
    ) {
      reviewIds.push(review.id);
    }
  }

  return reviewIds;
}

/**
 * @param {CompletedPrAddressReviewOutput} output
 * @returns {Set<string>}
 */
function collectHandledFeedbackIds(output) {
  return new Set([
    ...output.addressed.map(feedback => feedback.feedbackId),
    ...output.declined.map(feedback => feedback.feedbackId),
  ]);
}

/**
 * @param {import('../../github/types.js').GitHubPullRequestReviewSummary} review
 * @param {number} index
 * @param {Set<string>} feedbackIds
 * @returns {string[]}
 */
function collectRequestedChangeReviewFeedbackIds(review, index, feedbackIds) {
  /** @type {string[]} */
  const reviewFeedbackIds = [];
  const summaryFeedbackId = `review:${review.id ?? index + 1}`;

  if (review.body.trim() !== '' && feedbackIds.has(summaryFeedbackId)) {
    reviewFeedbackIds.push(summaryFeedbackId);
  }

  for (const comment of review.comments ?? []) {
    const commentFeedbackId = createReviewCommentFeedbackId(comment);
    if (commentFeedbackId !== undefined && feedbackIds.has(commentFeedbackId)) {
      reviewFeedbackIds.push(commentFeedbackId);
    }
  }

  return [...new Set(reviewFeedbackIds)];
}

/**
 * @param {import('../../github/types.js').GitHubPullRequestComment} comment
 * @returns {string | undefined}
 */
function createReviewCommentFeedbackId(comment) {
  if (comment.databaseId !== undefined) {
    return `thread:${comment.databaseId}`;
  }

  if (comment.id !== undefined) {
    return `thread:${comment.id}`;
  }

  return undefined;
}

/**
 * @param {import('./feedback.types.js').PrAddressReviewFeedbackSurface} surface
 * @returns {string}
 */
function formatFeedbackSurface(surface) {
  if (surface === 'unresolved_inline_thread') {
    return 'unresolved inline review thread';
  }

  if (surface === 'requested_change_summary') {
    return 'requested-change review summary';
  }

  if (surface === 'pullops_review_output') {
    return 'PullOps review output';
  }

  return 'top-level PR comment';
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
    operation: requireOperationCatalogOperationLabelName('pr-address-review'),
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
 * @param {GitHubPullRequest} pullRequest
 * @param {{
 *   pendingReviewId: string,
 *   reviewId: string,
 *   reviewCycle: number,
 *   maxReviewCycles: number
 * }} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function blockPendingHumanFeedbackReview(
  context,
  pullRequest,
  { pendingReviewId, reviewId, reviewCycle, maxReviewCycles },
) {
  const reason = [
    `Human Feedback Response Cycle for review ${pendingReviewId} is still pending validation on PR #${pullRequest.number}.`,
    `Trusted requested-change review ${reviewId} cannot start another Human Feedback Response Cycle until the pending review is processed.`,
  ].join(' ');

  await applyManagedPrTransition({
    githubClient: context.githubClient,
    outputDirectory: context.outputDirectory,
    pullRequest,
    operation: requireOperationCatalogOperationLabelName('pr-address-review'),
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
    operation: requireOperationCatalogOperationLabelName('pr-address-review'),
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
      operation: requireOperationCatalogOperationLabelName('pr-address-review'),
      reason,
    });
    return;
  }

  await applyManagedPrTransition({
    githubClient: context.githubClient,
    outputDirectory: context.outputDirectory,
    pullRequest,
    operation: requireOperationCatalogOperationLabelName('pr-address-review'),
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
 * @returns {asserts context is OperationRunnerContext & { target: { type: 'pr', number: number } }}
 */
function assertPullRequestTarget(context) {
  if (context.target.type !== 'pr') {
    throw new Error('pr-address-review requires a pull request target.');
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
