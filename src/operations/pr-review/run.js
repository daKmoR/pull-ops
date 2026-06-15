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
import { filterCommentsToDiffAnchors } from './anchors.js';
import { validatePrReviewOutput } from './output.js';
import { buildPrReviewPrompt } from './prompt.js';
import { readPullOpsPullRequestState, updatePullRequestBodyForReview } from './prBody.js';

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

  let rawOutput;

  try {
    rawOutput = await context.codexRunner.run({
      cwd: context.cwd,
      command: context.config.runner.command,
      model: context.model,
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

  return await finalizePreparedPrReview(context, preparation, rawOutput);
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

  try {
    await writeCodexActionPrompt(
      context,
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
export async function runPrReviewCodexActionFinalize(context) {
  if (context.runnerRan === false) {
    return createSkippedCodexActionOutput(context);
  }

  const preparation = await preparePrReview(context);
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

  return await finalizePreparedPrReview(context, preparation, rawOutput);
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<PrReviewPreparation>}
 */
async function preparePrReview(context) {
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
          updateBody: true,
          reviewCycle: state.reviewCycles.current,
          maxReviewCycles: state.reviewCycles.max,
        }),
      };
    }
  }

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
 * @param {PrReviewPreparation & { ready: true }} preparation
 * @param {unknown} rawOutput
 * @returns {Promise<Record<string, unknown>>}
 */
async function finalizePreparedPrReview(context, preparation, rawOutput) {
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
        reviewedTreeHash,
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
 * @param {ReviewResultStatus} status
 * @returns {Promise<void>}
 */
async function transitionPullRequestLabels(context, pullRequest, status) {
  const state = readPullOpsPullRequestState(pullRequest.body);
  await context.githubClient.removeLabelsFromPullRequest({
    number: pullRequest.number,
    labels: [PULL_OPS_OPERATION_LABELS.prReview, ...PULL_OPS_STATUS_LABEL_NAMES],
  });

  await context.githubClient.addLabelsToPullRequest({
    number: pullRequest.number,
    labels: [
      status === 'approved' && state.lastOperation === PULL_OPS_OPERATION_LABELS.prFinalize
        ? PULL_OPS_STATUS_LABELS.done
        : status === 'approved'
          ? PULL_OPS_OPERATION_LABELS.prFinalize
          : PULL_OPS_OPERATION_LABELS.prAddressReview,
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
      PULL_OPS_OPERATION_LABELS.prReview,
      PULL_OPS_STATUS_LABELS.inProgress,
      PULL_OPS_STATUS_LABELS.failed,
      PULL_OPS_STATUS_LABELS.prepared,
      PULL_OPS_STATUS_LABELS.done,
    ],
  });
  await context.githubClient.commentOnPullRequest({
    number: pullRequest.number,
    body: ['PullOps could not complete `pullops run pr-review`.', '', `Reason: ${reason}`].join(
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
