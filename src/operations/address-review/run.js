import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  PULL_OPS_OPERATION_LABELS,
  PULL_OPS_STATUS_LABEL_NAMES,
  PULL_OPS_STATUS_LABELS,
} from '../../labels/pullOpsLabels.js';
import {
  createSkippedCodexActionOutput,
  getCodexActionFiles,
  readCodexActionOutput,
  writeCodexActionPrompt,
} from '../codexAction.js';
import { collectAddressReviewFeedback } from './feedback.js';
import { validateAddressReviewOutput } from './output.js';
import { buildAddressReviewPrompt } from './prompt.js';
import {
  readPullOpsPullRequestState,
  updatePullRequestBodyForAddressReview,
} from '../review-pr/prBody.js';

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('../../github/types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('../../github/types.js').GitHubPullRequestReviewContext} GitHubPullRequestReviewContext
 * @typedef {import('../../github/types.js').GitHubPullRequestDiff} GitHubPullRequestDiff
 * @typedef {import('./feedback.types.js').AddressReviewFeedbackItem} AddressReviewFeedbackItem
 * @typedef {import('./output.types.js').AddressedFeedback} AddressedFeedback
 * @typedef {import('./output.types.js').ReasonedFeedback} ReasonedFeedback
 * @typedef {import('./output.types.js').CompletedAddressReviewOutput} CompletedAddressReviewOutput
 * @typedef {import('./run.types.js').AddressReviewPreparation} AddressReviewPreparation
 */

export const GITHUB_ACTIONS_BOT_AUTHOR = {
  name: 'github-actions[bot]',
  email: '41898282+github-actions[bot]@users.noreply.github.com',
};

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runAddressReview(context) {
  const preparation = await prepareAddressReview(context);
  if (!preparation.ready) {
    return preparation.output;
  }

  let rawOutput;

  try {
    rawOutput = await context.codexRunner.run({
      cwd: context.cwd,
      command: context.config.runner.command,
      model: context.model,
      prompt: buildAddressReviewPrompt({
        pullRequest: preparation.pullRequest,
        issue: preparation.issue,
        reviewContext: preparation.reviewContext,
        diff: preparation.diff,
        feedbackItems: preparation.feedbackItems,
      }),
    });
  } catch (error) {
    await recordPullRequestFailure(context, preparation.pullRequest, getErrorMessage(error), {
      updateBody: true,
      reviewCycle: preparation.reviewCycle,
      maxReviewCycles: preparation.maxReviewCycles,
    });
    throw error;
  }

  return await finalizePreparedAddressReview(context, preparation, rawOutput);
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runAddressReviewCodexActionPrepare(context) {
  const preparation = await prepareAddressReview(context);
  if (!preparation.ready) {
    return preparation.output;
  }

  try {
    await writeCodexActionPrompt(
      context,
      buildAddressReviewPrompt({
        pullRequest: preparation.pullRequest,
        issue: preparation.issue,
        reviewContext: preparation.reviewContext,
        diff: preparation.diff,
        feedbackItems: preparation.feedbackItems,
      }),
    );
  } catch (error) {
    await recordPullRequestFailure(context, preparation.pullRequest, getErrorMessage(error), {
      updateBody: true,
      reviewCycle: preparation.reviewCycle,
      maxReviewCycles: preparation.maxReviewCycles,
    });
    throw error;
  }

  const files = getCodexActionFiles(context);
  return {
    status: 'accepted',
    summary: `Prepared Codex Action address-review run for PR #${preparation.pullRequest.number}.`,
    pullRequest: {
      number: preparation.pullRequest.number,
      url: preparation.pullRequest.url,
    },
    feedback: {
      items: preparation.feedbackItems.length,
    },
    codexAction: {
      promptFile: files.promptFile,
      outputFile: files.outputFile,
      model: context.model,
      branch: preparation.pullRequest.headRefName,
    },
  };
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runAddressReviewCodexActionFinalize(context) {
  if (context.runnerRan === false) {
    return createSkippedCodexActionOutput(context);
  }

  const preparation = await prepareAddressReview(context);
  if (!preparation.ready) {
    return preparation.output;
  }

  let rawOutput;

  try {
    rawOutput = await readCodexActionOutput(context);
  } catch (error) {
    await recordPullRequestFailure(context, preparation.pullRequest, getErrorMessage(error), {
      updateBody: true,
      reviewCycle: preparation.reviewCycle,
      maxReviewCycles: preparation.maxReviewCycles,
    });
    throw error;
  }

  return await finalizePreparedAddressReview(context, preparation, rawOutput);
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<AddressReviewPreparation>}
 */
async function prepareAddressReview(context) {
  assertPullRequestTarget(context);

  const pullRequest = await context.githubClient.getPullRequest(context.target.number);
  const state = readPullOpsPullRequestState(pullRequest.body);

  if (pullRequest.isCrossRepository === true) {
    return {
      ready: false,
      output: await refusePullRequest(context, pullRequest, {
        reason: `PullOps v1 only addresses review feedback on same-repository PRs. PR #${pullRequest.number} comes from a fork.`,
        updateBody: state.managed,
        reviewCycle: state.reviewCycles.current,
        maxReviewCycles: state.reviewCycles.max,
      }),
    };
  }

  if (!state.managed) {
    return {
      ready: false,
      output: await refusePullRequest(context, pullRequest, {
        reason: `PR #${pullRequest.number} is not a PullOps-managed PR.`,
        updateBody: false,
        reviewCycle: state.reviewCycles.current,
        maxReviewCycles: state.reviewCycles.max,
      }),
    };
  }

  if (!hasPullOpsBranchPrefix(pullRequest.headRefName, context.config.branchPrefix)) {
    return {
      ready: false,
      output: await refusePullRequest(context, pullRequest, {
        reason: `PR #${pullRequest.number} head branch "${pullRequest.headRefName}" does not use the configured PullOps branch prefix.`,
        updateBody: true,
        reviewCycle: state.reviewCycles.current,
        maxReviewCycles: state.reviewCycles.max,
      }),
    };
  }

  if (state.sourceIssueNumber === undefined) {
    return {
      ready: false,
      output: await refusePullRequest(context, pullRequest, {
        reason: `PR #${pullRequest.number} does not include a structured Source: Issue #<number> line.`,
        updateBody: true,
        reviewCycle: state.reviewCycles.current,
        maxReviewCycles: state.reviewCycles.max,
      }),
    };
  }

  if (state.reviewCycles.current >= state.reviewCycles.max) {
    return {
      ready: false,
      output: await blockReviewCycleBudget(context, pullRequest, {
        reviewCycle: state.reviewCycles.current,
        maxReviewCycles: state.reviewCycles.max,
      }),
    };
  }

  const issue = await context.githubClient.getIssue(state.sourceIssueNumber);
  const reviewContext = await context.githubClient.getPullRequestReviewContext(pullRequest.number);
  const diff = await context.githubClient.getPullRequestDiff(pullRequest.number);
  const feedbackItems = collectAddressReviewFeedback(reviewContext);

  return {
    ready: true,
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
 * @param {OperationRunnerContext} context
 * @param {AddressReviewPreparation & { ready: true }} preparation
 * @param {unknown} rawOutput
 * @returns {Promise<Record<string, unknown>>}
 */
async function finalizePreparedAddressReview(context, preparation, rawOutput) {
  const { pullRequest, feedbackItems, reviewCycle, maxReviewCycles } = preparation;
  let failureRecorded = false;

  try {
    const validatedOutput = validateAddressReviewOutput(rawOutput);

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

    const coverage = validateFeedbackCoverage(validatedOutput.value, feedbackItems);
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

    const changesCommitted = await commitAddressReviewChangesIfPresent(
      context,
      pullRequest,
      validatedOutput.value,
    );
    await postAddressReviewResponses(context, pullRequest, feedbackItems, validatedOutput.value);
    await context.githubClient.updatePullRequestBody({
      number: pullRequest.number,
      body: updatePullRequestBodyForAddressReview({
        body: pullRequest.body,
        addressReviewStatus: 'addressed',
        reviewCycle,
        maxReviewCycles,
      }),
    });
    await transitionPullRequestLabelsToReview(context, pullRequest);

    return {
      status: 'accepted',
      summary: `Addressed review feedback on PullOps-managed PR #${pullRequest.number} and returned it to review.`,
      pullRequest: {
        number: pullRequest.number,
        url: pullRequest.url,
      },
      addressReview: {
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
 * @param {CompletedAddressReviewOutput} output
 * @param {AddressReviewFeedbackItem[]} feedbackItems
 * @returns {{ valid: true } | { valid: false, reason: string }}
 */
function validateFeedbackCoverage(output, feedbackItems) {
  const expected = new Set(feedbackItems.map(item => item.id));
  const seen = new Set();

  for (const feedback of [
    ...output.addressed.map(item => ({ feedbackId: item.feedbackId, path: 'addressed' })),
    ...output.declined.map(item => ({ feedbackId: item.feedbackId, path: 'declined' })),
    ...output.deferred.map(item => ({ feedbackId: item.feedbackId, path: 'deferred' })),
  ]) {
    if (!expected.has(feedback.feedbackId)) {
      return {
        valid: false,
        reason: `Operation Output.${feedback.path} references unknown feedbackId "${feedback.feedbackId}".`,
      };
    }

    if (seen.has(feedback.feedbackId)) {
      return {
        valid: false,
        reason: `Feedback item "${feedback.feedbackId}" must be classified exactly once.`,
      };
    }

    seen.add(feedback.feedbackId);
  }

  for (const feedbackId of expected) {
    if (!seen.has(feedbackId)) {
      return {
        valid: false,
        reason: `Feedback item "${feedbackId}" must be classified as addressed, declined, or deferred.`,
      };
    }
  }

  return { valid: true };
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @param {CompletedAddressReviewOutput} output
 * @returns {Promise<boolean>}
 */
async function commitAddressReviewChangesIfPresent(context, pullRequest, output) {
  if (!(await context.gitClient.hasChanges())) {
    return false;
  }

  await context.gitClient.commitAll({
    message: createAddressReviewCommitMessage(pullRequest, output),
    author: GITHUB_ACTIONS_BOT_AUTHOR,
  });
  await context.gitClient.pushBranch({
    branchName: pullRequest.headRefName,
  });

  return true;
}

/**
 * @param {GitHubPullRequest} pullRequest
 * @param {CompletedAddressReviewOutput} output
 * @returns {string}
 */
export function createAddressReviewCommitMessage(pullRequest, output) {
  return [
    `fix(address-review): address feedback for PR #${pullRequest.number}`,
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
 * @param {AddressReviewFeedbackItem[]} feedbackItems
 * @param {CompletedAddressReviewOutput} output
 * @returns {Promise<void>}
 */
async function postAddressReviewResponses(context, pullRequest, feedbackItems, output) {
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
 * @param {Map<string, AddressReviewFeedbackItem>} feedbackById
 * @param {AddressedFeedback | ReasonedFeedback} feedback
 * @returns {AddressReviewFeedbackItem}
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
 * @param {AddressReviewFeedbackItem} feedback
 * @param {{ disposition: 'addressed' | 'declined', body: string }} response
 * @returns {Promise<void>}
 */
async function postFeedbackResponse(context, pullRequest, feedback, response) {
  if (feedback.replyCommentId !== undefined) {
    await context.githubClient.replyToPullRequestReviewComment({
      commentId: feedback.replyCommentId,
      body: [`PullOps ${response.disposition} this feedback.`, '', response.body].join('\n'),
    });
    return;
  }

  await context.githubClient.commentOnPullRequest({
    number: pullRequest.number,
    body: [
      `PullOps ${response.disposition} feedback \`${feedback.id}\` (${formatFeedbackSurface(
        feedback.surface,
      )}).`,
      '',
      response.body,
    ].join('\n'),
  });
}

/**
 * @param {import('./feedback.types.js').AddressReviewFeedbackSurface} surface
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
 * @returns {Promise<void>}
 */
async function transitionPullRequestLabelsToReview(context, pullRequest) {
  await context.githubClient.removeLabelsFromPullRequest({
    number: pullRequest.number,
    labels: [PULL_OPS_OPERATION_LABELS.addressReview, ...PULL_OPS_STATUS_LABEL_NAMES],
  });

  await context.githubClient.addLabelsToPullRequest({
    number: pullRequest.number,
    labels: [PULL_OPS_OPERATION_LABELS.reviewPr],
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

  await recordPullRequestFailure(context, pullRequest, reason, {
    updateBody: true,
    reviewCycle,
    maxReviewCycles,
  });

  return {
    status: 'blocked',
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
 * @param {{ reason: string, updateBody: boolean, reviewCycle: number, maxReviewCycles: number }} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function refusePullRequest(
  context,
  pullRequest,
  { reason, updateBody, reviewCycle, maxReviewCycles },
) {
  await recordPullRequestFailure(context, pullRequest, reason, {
    updateBody,
    reviewCycle,
    maxReviewCycles,
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
  await writeFailureReason(context, reason);

  if (updateBody) {
    await context.githubClient.updatePullRequestBody({
      number: pullRequest.number,
      body: updatePullRequestBodyForAddressReview({
        body: pullRequest.body,
        addressReviewStatus: 'blocked',
        reviewCycle,
        maxReviewCycles,
      }),
    });
  }

  await context.githubClient.addLabelsToPullRequest({
    number: pullRequest.number,
    labels: [PULL_OPS_STATUS_LABELS.blocked],
  });
  await context.githubClient.removeLabelsFromPullRequest({
    number: pullRequest.number,
    labels: [
      PULL_OPS_OPERATION_LABELS.addressReview,
      PULL_OPS_OPERATION_LABELS.reviewPr,
      PULL_OPS_STATUS_LABELS.inProgress,
      PULL_OPS_STATUS_LABELS.failed,
      PULL_OPS_STATUS_LABELS.prepared,
      PULL_OPS_STATUS_LABELS.done,
    ],
  });
  await context.githubClient.commentOnPullRequest({
    number: pullRequest.number,
    body: [
      'PullOps could not complete `pullops run address-review`.',
      '',
      `Reason: ${reason}`,
    ].join('\n'),
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {string} reason
 * @returns {Promise<void>}
 */
async function writeFailureReason(context, reason) {
  if (context.outputDirectory === undefined || context.outputDirectory.trim() === '') {
    return;
  }

  await mkdir(context.outputDirectory, { recursive: true });
  await writeFile(join(context.outputDirectory, 'failure_reason.txt'), `${reason}\n`);
}

/**
 * @param {string} branchName
 * @param {string} branchPrefix
 * @returns {boolean}
 */
function hasPullOpsBranchPrefix(branchName, branchPrefix) {
  const normalizedPrefix =
    branchPrefix
      .split('/')
      .map(part => part.trim())
      .filter(Boolean)
      .join('/') || 'pullops';
  return branchName === normalizedPrefix || branchName.startsWith(`${normalizedPrefix}/`);
}

/**
 * @param {OperationRunnerContext} context
 * @returns {asserts context is OperationRunnerContext & { target: { type: 'pr', number: number } }}
 */
function assertPullRequestTarget(context) {
  if (context.target.type !== 'pr') {
    throw new Error('address-review requires a pull request target.');
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
