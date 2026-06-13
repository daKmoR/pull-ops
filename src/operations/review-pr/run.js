import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  PULL_OPS_OPERATION_LABELS,
  PULL_OPS_STATUS_LABEL_NAMES,
  PULL_OPS_STATUS_LABELS,
} from '../../labels/pullOpsLabels.js';
import {
  getCodexActionFiles,
  readCodexActionOutput,
  writeCodexActionPrompt,
} from '../codexAction.js';
import { filterCommentsToDiffAnchors } from './anchors.js';
import { validateReviewPrOutput } from './output.js';
import { buildReviewPrPrompt } from './prompt.js';
import { readPullOpsPullRequestState, updatePullRequestBodyForReview } from './prBody.js';

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../../github/types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('../../github/types.js').GitHubPullRequestReviewContext} GitHubPullRequestReviewContext
 * @typedef {import('./output.js').CompletedReviewPrOutput} CompletedReviewPrOutput
 * @typedef {import('./output.js').ReviewReply} ReviewReply
 * @typedef {import('./output.js').ReviewResultStatus} ReviewResultStatus
 * @typedef {{ ready: false, output: Record<string, unknown> } | {
 *   ready: true;
 *   pullRequest: GitHubPullRequest;
 *   issue: import('../../github/types.js').GitHubIssue;
 *   reviewContext: GitHubPullRequestReviewContext;
 *   diff: import('../../github/types.js').GitHubPullRequestDiff;
 *   nextReviewCycle: number;
 *   maxReviewCycles: number;
 * }} ReviewPrPreparation
 */

export const GITHUB_ACTIONS_BOT_AUTHOR = {
  name: 'github-actions[bot]',
  email: '41898282+github-actions[bot]@users.noreply.github.com',
};

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runReviewPr(context) {
  const preparation = await prepareReviewPr(context);
  if (!preparation.ready) {
    return preparation.output;
  }

  let rawOutput;

  try {
    rawOutput = await context.codexRunner.run({
      cwd: context.cwd,
      command: context.config.runner.command,
      model: context.model,
      prompt: buildReviewPrPrompt({
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

  return await finalizePreparedReviewPr(context, preparation, rawOutput);
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runReviewPrCodexActionPrepare(context) {
  const preparation = await prepareReviewPr(context);
  if (!preparation.ready) {
    return preparation.output;
  }

  try {
    await writeCodexActionPrompt(
      context,
      buildReviewPrPrompt({
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
    pullRequest: {
      number: preparation.pullRequest.number,
      url: preparation.pullRequest.url,
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
export async function runReviewPrCodexActionFinalize(context) {
  const preparation = await prepareReviewPr(context);
  if (!preparation.ready) {
    return preparation.output;
  }

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

  return await finalizePreparedReviewPr(context, preparation, rawOutput);
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<ReviewPrPreparation>}
 */
async function prepareReviewPr(context) {
  assertPullRequestTarget(context);

  const pullRequest = await context.githubClient.getPullRequest(context.target.number);
  const state = readPullOpsPullRequestState(pullRequest.body);

  if (pullRequest.isCrossRepository === true) {
    return {
      ready: false,
      output: await refusePullRequest(context, pullRequest, {
        reason: `PullOps v1 only reviews same-repository PRs. PR #${pullRequest.number} comes from a fork.`,
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

  const issue = await context.githubClient.getIssue(state.sourceIssueNumber);
  const reviewContext = await context.githubClient.getPullRequestReviewContext(pullRequest.number);
  const diff = await context.githubClient.getPullRequestDiff(pullRequest.number);

  return {
    ready: true,
    pullRequest,
    issue,
    reviewContext,
    diff,
    nextReviewCycle: state.reviewCycles.current + 1,
    maxReviewCycles: state.reviewCycles.max,
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {ReviewPrPreparation & { ready: true }} preparation
 * @param {unknown} rawOutput
 * @returns {Promise<Record<string, unknown>>}
 */
async function finalizePreparedReviewPr(context, preparation, rawOutput) {
  const { pullRequest, reviewContext, diff, nextReviewCycle, maxReviewCycles } = preparation;
  let failureRecorded = false;

  try {
    const validatedOutput = validateReviewPrOutput(rawOutput);

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

    for (const reply of replies.publishable) {
      await context.githubClient.replyToPullRequestReviewComment({
        commentId: reply.commentId,
        body: reply.body,
      });
    }

    await context.githubClient.publishPullRequestReview({
      number: pullRequest.number,
      event: reviewResult.status === 'approved' ? 'APPROVE' : 'REQUEST_CHANGES',
      body: reviewResult.summary,
      comments: comments.publishable,
    });

    await context.githubClient.updatePullRequestBody({
      number: pullRequest.number,
      body: updatePullRequestBodyForReview({
        body: pullRequest.body,
        reviewStatus: reviewResult.status,
        reviewCycle: nextReviewCycle,
        maxReviewCycles,
      }),
    });
    await transitionPullRequestLabels(context, pullRequest, reviewResult.status);

    return {
      status: 'accepted',
      summary: summarizeReviewResult(pullRequest, reviewResult.status),
      reviewResult: reviewResult.status,
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
 * @param {CompletedReviewPrOutput} reviewResult
 * @returns {Promise<boolean>}
 */
async function commitDirectReviewChangesIfPresent(context, pullRequest, reviewResult) {
  if (!(await context.gitClient.hasChanges())) {
    return false;
  }

  await context.gitClient.commitAll({
    message: createReviewPrCommitMessage(pullRequest, reviewResult),
    author: GITHUB_ACTIONS_BOT_AUTHOR,
  });
  await context.gitClient.pushBranch({
    branchName: pullRequest.headRefName,
  });

  return true;
}

/**
 * @param {GitHubPullRequest} pullRequest
 * @param {CompletedReviewPrOutput} reviewResult
 * @returns {string}
 */
export function createReviewPrCommitMessage(pullRequest, reviewResult) {
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
 * @param {ReviewResultStatus} status
 * @returns {Promise<void>}
 */
async function transitionPullRequestLabels(context, pullRequest, status) {
  await context.githubClient.removeLabelsFromPullRequest({
    number: pullRequest.number,
    labels: [PULL_OPS_OPERATION_LABELS.reviewPr, ...PULL_OPS_STATUS_LABEL_NAMES],
  });

  await context.githubClient.addLabelsToPullRequest({
    number: pullRequest.number,
    labels: [
      status === 'approved'
        ? PULL_OPS_OPERATION_LABELS.prepareMerge
        : PULL_OPS_OPERATION_LABELS.addressReview,
    ],
  });
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
      body: updatePullRequestBodyForReview({
        body: pullRequest.body,
        reviewStatus: 'blocked',
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
      PULL_OPS_OPERATION_LABELS.reviewPr,
      PULL_OPS_STATUS_LABELS.inProgress,
      PULL_OPS_STATUS_LABELS.failed,
      PULL_OPS_STATUS_LABELS.prepared,
      PULL_OPS_STATUS_LABELS.done,
    ],
  });
  await context.githubClient.commentOnPullRequest({
    number: pullRequest.number,
    body: ['PullOps could not complete `pullops run review-pr`.', '', `Reason: ${reason}`].join(
      '\n',
    ),
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
    throw new Error('review-pr requires a pull request target.');
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
