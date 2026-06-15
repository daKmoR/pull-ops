import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  PULL_OPS_OPERATION_LABELS,
  PULL_OPS_STATUS_LABEL_NAMES,
  PULL_OPS_STATUS_LABELS,
} from '../../labels/pullOpsLabels.js';
import { createSkippedCodexActionOutput } from '../codexAction.js';
import { readPullOpsPullRequestState } from '../pr-review/prBody.js';
import {
  updatePullRequestBodyForPrPrepareMerge,
  updatePullRequestBodyForPrPrepareMergeFailure,
  updatePullRequestBodyForPrPrepareMergeReroute,
} from './prBody.js';

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../../github/types.js').GitHubCheckRun} GitHubCheckRun
 * @typedef {import('../../github/types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('../../github/types.js').GitHubPullRequestReviewContext} GitHubPullRequestReviewContext
 * @typedef {import('./run.types.js').PrPrepareMergePreparation} PrPrepareMergePreparation
 */

export const GITHUB_ACTIONS_BOT_AUTHOR = {
  name: 'github-actions[bot]',
  email: '41898282+github-actions[bot]@users.noreply.github.com',
};

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runPrPrepareMerge(context) {
  const preparation = await preparePrPrepareMerge(context);
  if (!preparation.ready) {
    return preparation.output;
  }

  return await completePrPrepareMerge(context, preparation);
}

/**
 * `pr-prepare-merge` is deterministic. In a Codex Action workflow, the prepare
 * phase does the work and the runner step should be skipped by workflow glue.
 *
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runPrPrepareMergeCodexActionPrepare(context) {
  return await runPrPrepareMerge(context);
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runPrPrepareMergeCodexActionFinalize(context) {
  if (context.runnerRan === false) {
    return createSkippedCodexActionOutput(context);
  }

  return await runPrPrepareMerge(context);
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<PrPrepareMergePreparation>}
 */
async function preparePrPrepareMerge(context) {
  assertPullRequestTarget(context);

  const pullRequest = await context.githubClient.getPullRequest(context.target.number);
  const state = readPullOpsPullRequestState(pullRequest.body);

  if (pullRequest.isCrossRepository === true) {
    return {
      ready: false,
      output: await refusePullRequest(
        context,
        pullRequest,
        `PullOps v1 only prepares same-repository PRs for merge. PR #${pullRequest.number} comes from a fork.`,
        { updateBody: state.managed },
      ),
    };
  }

  if (!state.managed) {
    return {
      ready: false,
      output: await refusePullRequest(
        context,
        pullRequest,
        `PR #${pullRequest.number} is not a PullOps-managed PR.`,
        { updateBody: false },
      ),
    };
  }

  if (!hasPullOpsBranchPrefix(pullRequest.headRefName, context.config.branchPrefix)) {
    return {
      ready: false,
      output: await refusePullRequest(
        context,
        pullRequest,
        `PR #${pullRequest.number} head branch "${pullRequest.headRefName}" does not use the configured PullOps branch prefix.`,
        { updateBody: true },
      ),
    };
  }

  if (state.sourceIssueNumber === undefined || state.sourceKind === undefined) {
    return {
      ready: false,
      output: await refusePullRequest(
        context,
        pullRequest,
        `PR #${pullRequest.number} does not include a structured Source: Issue #<number> line.`,
        { updateBody: true },
      ),
    };
  }

  const baseBranch = pullRequest.baseRefName ?? context.config.baseBranch;
  if (state.sourceKind !== 'issue' || baseBranch !== context.config.baseBranch) {
    return {
      ready: false,
      output: await refusePullRequest(
        context,
        pullRequest,
        [
          `PR #${pullRequest.number} is not a standalone Concrete Issue PR targeting`,
          `the default branch "${context.config.baseBranch}".`,
          `Source kind: ${state.sourceKind}; base branch: ${baseBranch}.`,
        ].join(' '),
        { updateBody: true },
      ),
    };
  }

  const currentTreeHash = await readCurrentTreeHash(context, pullRequest);
  const currentHeadSha = await readCurrentHeadSha(context, pullRequest);

  if (state.preparedTreeHash !== undefined && state.preparedHeadSha !== undefined) {
    if (currentTreeHash !== state.preparedTreeHash) {
      return {
        ready: false,
        output: await routeOrBlockChangedTree(context, pullRequest, {
          currentTreeHash,
          expectedTreeHash: state.preparedTreeHash,
          reviewCycle: state.reviewCycles.current,
          maxReviewCycles: state.reviewCycles.max,
        }),
      };
    }

    return {
      ready: true,
      mode: 'prepared',
      pullRequest,
      sourceIssueNumber: state.sourceIssueNumber,
      baseBranch,
      currentTreeHash,
      preparedTreeHash: state.preparedTreeHash,
      preparedHeadSha: currentHeadSha,
    };
  }

  if (state.reviewedTreeHash === undefined) {
    return {
      ready: false,
      output: await refusePullRequest(
        context,
        pullRequest,
        `PR #${pullRequest.number} does not include a Reviewed tree marker from an approved PullOps review.`,
        { updateBody: true },
      ),
    };
  }

  if (currentTreeHash !== state.reviewedTreeHash) {
    return {
      ready: false,
      output: await routeOrBlockChangedTree(context, pullRequest, {
        currentTreeHash,
        expectedTreeHash: state.reviewedTreeHash,
        reviewCycle: state.reviewCycles.current,
        maxReviewCycles: state.reviewCycles.max,
      }),
    };
  }

  const reviewedHeadChecks = await context.githubClient.getPullRequestChecksForRef(currentHeadSha);
  const reviewedHeadCheckState = classifyChecks(reviewedHeadChecks);
  if (reviewedHeadCheckState === 'absent') {
    return {
      ready: false,
      output: await blockPullRequest(
        context,
        pullRequest,
        `PR #${pullRequest.number} has no checks on reviewed head ${currentHeadSha}. PullOps will not rewrite history without reviewed-head checks.`,
      ),
    };
  }

  if (reviewedHeadCheckState === 'pending') {
    return {
      ready: false,
      output: waitForChecks(pullRequest, {
        checkedRef: currentHeadSha,
        stage: 'reviewed-head',
        checks: reviewedHeadChecks,
      }),
    };
  }

  if (reviewedHeadCheckState === 'failed') {
    return {
      ready: false,
      output: await routePullRequestToPrFixCi(
        context,
        pullRequest,
        `Reviewed-head checks failed for PR #${pullRequest.number} at ${currentHeadSha}.`,
      ),
    };
  }

  const reviewContext = await context.githubClient.getPullRequestReviewContext(pullRequest.number);
  const blockingFeedback = findBlockingFeedback(reviewContext);
  if (blockingFeedback.length > 0) {
    return {
      ready: false,
      output: await blockPullRequest(
        context,
        pullRequest,
        [
          `PR #${pullRequest.number} still has unresolved actionable review feedback:`,
          blockingFeedback.join('; '),
        ].join(' '),
      ),
    };
  }

  const changedFiles = await readChangedFiles(context, pullRequest, { baseBranch });
  if (changedFiles.length === 0) {
    return {
      ready: false,
      output: await refusePullRequest(
        context,
        pullRequest,
        `PR #${pullRequest.number} has no changed files to prepare for merge.`,
        { updateBody: true },
      ),
    };
  }

  return {
    ready: true,
    mode: 'rewrite',
    pullRequest,
    sourceIssueNumber: state.sourceIssueNumber,
    baseBranch,
    currentTreeHash,
    reviewedTreeHash: state.reviewedTreeHash,
    changedFiles,
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {PrPrepareMergePreparation & { ready: true }} preparation
 * @returns {Promise<Record<string, unknown>>}
 */
async function completePrPrepareMerge(context, preparation) {
  if (preparation.mode === 'prepared') {
    return await completePreparedHeadChecks(context, preparation.pullRequest, {
      sourceIssueNumber: preparation.sourceIssueNumber,
      preparedTreeHash: preparation.preparedTreeHash,
      preparedHeadSha: preparation.preparedHeadSha,
      body: preparation.pullRequest.body,
    });
  }

  const rewriteResult = await context.gitClient.rewriteBranchWithCommitPlan({
    baseBranch: preparation.baseBranch,
    branchName: preparation.pullRequest.headRefName,
    commits: [
      {
        message: createPrPrepareMergeCommitMessage(preparation.sourceIssueNumber),
        files: preparation.changedFiles,
      },
    ],
    author: GITHUB_ACTIONS_BOT_AUTHOR,
  });

  if (rewriteResult.treeHash !== preparation.reviewedTreeHash) {
    const reason = [
      `Prepared tree ${rewriteResult.treeHash} did not match reviewed tree`,
      `${preparation.reviewedTreeHash} for PR #${preparation.pullRequest.number}.`,
    ].join(' ');
    await recordPullRequestFailure(context, preparation.pullRequest, reason);
    throw new Error(reason);
  }

  const preparedBody = updatePullRequestBodyForPrPrepareMerge({
    body: preparation.pullRequest.body,
    sourceIssueNumber: preparation.sourceIssueNumber,
    preparedTreeHash: rewriteResult.treeHash,
    preparedHeadSha: rewriteResult.headSha,
  });
  await context.githubClient.updatePullRequestBody({
    number: preparation.pullRequest.number,
    body: preparedBody,
  });

  return await completePreparedHeadChecks(context, preparation.pullRequest, {
    sourceIssueNumber: preparation.sourceIssueNumber,
    preparedTreeHash: rewriteResult.treeHash,
    preparedHeadSha: rewriteResult.headSha,
    body: preparedBody,
  });
}

/**
 * @param {number} sourceIssueNumber
 * @returns {string}
 */
export function createPrPrepareMergeCommitMessage(sourceIssueNumber) {
  return [
    `feat(issue): implement #${sourceIssueNumber}`,
    '',
    `Prepare standalone Concrete Issue #${sourceIssueNumber} for rebase merge.`,
    '',
    `Closes #${sourceIssueNumber}`,
  ].join('\n');
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @param {object} options
 * @param {number} options.sourceIssueNumber
 * @param {string} options.preparedTreeHash
 * @param {string} options.preparedHeadSha
 * @param {string} options.body
 * @returns {Promise<Record<string, unknown>>}
 */
async function completePreparedHeadChecks(
  context,
  pullRequest,
  { sourceIssueNumber, preparedTreeHash, preparedHeadSha, body },
) {
  const checks = await context.githubClient.getPullRequestChecksForRef(preparedHeadSha);
  const checkState = classifyChecks(checks);

  if (checkState === 'absent' || checkState === 'pending') {
    return waitForChecks(pullRequest, {
      checkedRef: preparedHeadSha,
      stage: 'prepared-head',
      checks,
    });
  }

  if (checkState === 'failed') {
    return await routePullRequestToPrFixCi(
      context,
      pullRequest,
      `Prepared-head checks failed for PR #${pullRequest.number} at ${preparedHeadSha}.`,
    );
  }

  await context.githubClient.updatePullRequestBody({
    number: pullRequest.number,
    body: updatePullRequestBodyForPrPrepareMerge({
      body,
      sourceIssueNumber,
      preparedTreeHash,
      preparedHeadSha,
      status: 'ready',
    }),
  });

  if (pullRequest.isDraft) {
    await context.githubClient.markPullRequestReadyForReview(pullRequest.number);
  }

  await context.githubClient.removeLabelsFromPullRequest({
    number: pullRequest.number,
    labels: [PULL_OPS_OPERATION_LABELS.prPrepareMerge, ...PULL_OPS_STATUS_LABEL_NAMES],
  });

  return {
    status: 'accepted',
    summary: `Prepared PullOps-managed PR #${pullRequest.number} for human rebase merge.`,
    pullRequest: {
      number: pullRequest.number,
      url: pullRequest.url,
    },
    prPrepareMerge: {
      commits: 1,
      preparedTree: preparedTreeHash,
      preparedHead: preparedHeadSha,
      mergeMethod: 'rebase',
      readyForReview: true,
    },
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @returns {Promise<string>}
 */
async function readCurrentTreeHash(context, pullRequest) {
  try {
    return await context.gitClient.getCurrentTreeHash();
  } catch (error) {
    await recordPullRequestFailure(context, pullRequest, getErrorMessage(error));
    throw error;
  }
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @returns {Promise<string>}
 */
async function readCurrentHeadSha(context, pullRequest) {
  if (pullRequest.headSha !== undefined) {
    return pullRequest.headSha;
  }

  try {
    return await context.gitClient.getCurrentHeadSha();
  } catch (error) {
    await recordPullRequestFailure(context, pullRequest, getErrorMessage(error));
    throw error;
  }
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @param {{ baseBranch: string }} options
 * @returns {Promise<string[]>}
 */
async function readChangedFiles(context, pullRequest, { baseBranch }) {
  try {
    return await context.gitClient.getChangedFilesSinceBase({ baseBranch });
  } catch (error) {
    await recordPullRequestFailure(context, pullRequest, getErrorMessage(error));
    throw error;
  }
}

/**
 * @param {GitHubCheckRun[]} checks
 * @returns {'absent' | 'pending' | 'failed' | 'passed'}
 */
function classifyChecks(checks) {
  if (checks.length === 0) {
    return 'absent';
  }

  if (checks.some(isFailedCheck)) {
    return 'failed';
  }

  if (checks.some(isPendingCheck)) {
    return 'pending';
  }

  return 'passed';
}

/**
 * @param {GitHubCheckRun} check
 * @returns {boolean}
 */
function isFailedCheck(check) {
  const bucket = normalize(check.bucket);
  const conclusion = normalize(check.conclusion);
  const state = normalize(check.state);
  return (
    bucket === 'fail' ||
    ['failure', 'timed_out', 'action_required', 'startup_failure', 'cancelled'].includes(
      conclusion,
    ) ||
    ['failure', 'failed', 'error', 'timed_out', 'cancelled'].includes(state)
  );
}

/**
 * @param {GitHubCheckRun} check
 * @returns {boolean}
 */
function isPendingCheck(check) {
  const bucket = normalize(check.bucket);
  const state = normalize(check.state);
  return (
    bucket === 'pending' ||
    ['pending', 'queued', 'requested', 'waiting', 'in_progress'].includes(state) ||
    (!isPassingCheck(check) && !isFailedCheck(check))
  );
}

/**
 * @param {GitHubCheckRun} check
 * @returns {boolean}
 */
function isPassingCheck(check) {
  const bucket = normalize(check.bucket);
  const conclusion = normalize(check.conclusion);
  const state = normalize(check.state);
  return (
    bucket === 'pass' ||
    ['success', 'neutral', 'skipped'].includes(conclusion) ||
    state === 'success'
  );
}

/**
 * @param {string | undefined} value
 * @returns {string}
 */
function normalize(value) {
  return value === undefined ? '' : value.toLowerCase();
}

/**
 * @param {GitHubPullRequestReviewContext} reviewContext
 * @returns {string[]}
 */
function findBlockingFeedback(reviewContext) {
  const unresolvedFileThreads = reviewContext.unresolvedThreads.filter(thread =>
    thread.comments.some(comment => comment.path !== undefined),
  );
  const requestedChangeReviews = findUnsupersededRequestedChangeReviews(reviewContext);

  return [
    ...unresolvedFileThreads.map(thread => {
      const firstComment = thread.comments.find(comment => comment.path !== undefined);
      const location =
        firstComment?.path === undefined
          ? 'an unresolved file thread'
          : `${firstComment.path}${firstComment.line === undefined ? '' : `:${firstComment.line}`}`;
      return `unresolved file review thread at ${location}`;
    }),
    ...requestedChangeReviews.map(review => {
      const author =
        review.authorLogin === null || review.authorLogin.trim() === ''
          ? 'unknown reviewer'
          : `@${review.authorLogin}`;
      return `unsuperseded requested-change review by ${author}`;
    }),
  ];
}

/**
 * @param {GitHubPullRequestReviewContext} reviewContext
 * @returns {import('../../github/types.js').GitHubPullRequestReviewSummary[]}
 */
function findUnsupersededRequestedChangeReviews(reviewContext) {
  const latestReviewByAuthor = new Map();
  const orderedReviews = reviewContext.reviews
    .map((review, index) => ({ review, index }))
    .sort((left, right) => compareReviews(left, right));

  for (const { review } of orderedReviews) {
    const author = review.authorLogin ?? `review-${review.id ?? latestReviewByAuthor.size}`;
    if (review.state === 'CHANGES_REQUESTED' || review.state === 'APPROVED') {
      latestReviewByAuthor.set(author, review);
    }
  }

  return [...latestReviewByAuthor.values()].filter(review => review.state === 'CHANGES_REQUESTED');
}

/**
 * @param {{ review: import('../../github/types.js').GitHubPullRequestReviewSummary, index: number }} left
 * @param {{ review: import('../../github/types.js').GitHubPullRequestReviewSummary, index: number }} right
 * @returns {number}
 */
function compareReviews(left, right) {
  if (left.review.submittedAt !== undefined && right.review.submittedAt !== undefined) {
    return left.review.submittedAt.localeCompare(right.review.submittedAt);
  }

  return left.index - right.index;
}

/**
 * @param {GitHubPullRequest} pullRequest
 * @param {{ checkedRef: string, stage: 'reviewed-head' | 'prepared-head', checks: GitHubCheckRun[] }} options
 * @returns {Record<string, unknown>}
 */
function waitForChecks(pullRequest, { checkedRef, stage, checks }) {
  return {
    status: 'accepted',
    summary: `Waiting for ${stage} checks on PR #${pullRequest.number} at ${checkedRef}.`,
    pullRequest: {
      number: pullRequest.number,
      url: pullRequest.url,
    },
    prPrepareMerge: {
      waiting: true,
      stage,
      checkedRef,
      checks: checks.length,
    },
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @param {{ currentTreeHash: string, expectedTreeHash: string, reviewCycle: number, maxReviewCycles: number }} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function routeOrBlockChangedTree(
  context,
  pullRequest,
  { currentTreeHash, expectedTreeHash, reviewCycle, maxReviewCycles },
) {
  const reason = [
    `PR #${pullRequest.number} tree changed after approval.`,
    `Expected ${expectedTreeHash}; found ${currentTreeHash}.`,
  ].join(' ');

  if (reviewCycle < maxReviewCycles) {
    return await routePullRequestToReview(context, pullRequest, reason);
  }

  return await blockPullRequest(
    context,
    pullRequest,
    `${reason} Review Cycles are exhausted (${reviewCycle} / ${maxReviewCycles}).`,
  );
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @param {string} reason
 * @returns {Promise<Record<string, unknown>>}
 */
async function routePullRequestToReview(context, pullRequest, reason) {
  await writeFailureReason(context, reason);
  await context.githubClient.updatePullRequestBody({
    number: pullRequest.number,
    body: updatePullRequestBodyForPrPrepareMergeReroute({
      body: pullRequest.body,
    }),
  });
  await context.githubClient.removeLabelsFromPullRequest({
    number: pullRequest.number,
    labels: [PULL_OPS_OPERATION_LABELS.prPrepareMerge, ...PULL_OPS_STATUS_LABEL_NAMES],
  });
  await context.githubClient.addLabelsToPullRequest({
    number: pullRequest.number,
    labels: [PULL_OPS_OPERATION_LABELS.prReview],
  });
  await context.githubClient.commentOnPullRequest({
    number: pullRequest.number,
    body: [
      'PullOps routed `pullops run pr-prepare-merge` back to review.',
      '',
      `Reason: ${reason}`,
    ].join('\n'),
  });

  return {
    status: 'accepted',
    summary: `Routed PR #${pullRequest.number} back to PullOps review.`,
    pullRequest: {
      number: pullRequest.number,
      url: pullRequest.url,
    },
    prPrepareMerge: {
      routedTo: PULL_OPS_OPERATION_LABELS.prReview,
      reason,
    },
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @param {string} reason
 * @returns {Promise<Record<string, unknown>>}
 */
async function routePullRequestToPrFixCi(context, pullRequest, reason) {
  await writeFailureReason(context, reason);
  await context.githubClient.removeLabelsFromPullRequest({
    number: pullRequest.number,
    labels: [PULL_OPS_OPERATION_LABELS.prPrepareMerge, ...PULL_OPS_STATUS_LABEL_NAMES],
  });
  await context.githubClient.addLabelsToPullRequest({
    number: pullRequest.number,
    labels: [PULL_OPS_OPERATION_LABELS.prFixCi],
  });
  await context.githubClient.commentOnPullRequest({
    number: pullRequest.number,
    body: [
      'PullOps routed `pullops run pr-prepare-merge` to CI repair.',
      '',
      `Reason: ${reason}`,
    ].join('\n'),
  });

  return {
    status: 'accepted',
    summary: `Routed PR #${pullRequest.number} to PullOps CI repair.`,
    pullRequest: {
      number: pullRequest.number,
      url: pullRequest.url,
    },
    prPrepareMerge: {
      routedTo: PULL_OPS_OPERATION_LABELS.prFixCi,
      reason,
    },
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @param {string} reason
 * @returns {Promise<Record<string, unknown>>}
 */
async function blockPullRequest(context, pullRequest, reason) {
  await recordPullRequestFailure(context, pullRequest, reason);

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
 * @param {string} reason
 * @param {{ updateBody: boolean }} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function refusePullRequest(context, pullRequest, reason, { updateBody }) {
  await recordPullRequestFailure(context, pullRequest, reason, { updateBody });

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
 * @param {{ updateBody?: boolean }} [options]
 * @returns {Promise<void>}
 */
async function recordPullRequestFailure(context, pullRequest, reason, { updateBody = true } = {}) {
  await writeFailureReason(context, reason);

  if (updateBody) {
    await context.githubClient.updatePullRequestBody({
      number: pullRequest.number,
      body: updatePullRequestBodyForPrPrepareMergeFailure({
        body: pullRequest.body,
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
      PULL_OPS_OPERATION_LABELS.prPrepareMerge,
      PULL_OPS_STATUS_LABELS.inProgress,
      PULL_OPS_STATUS_LABELS.failed,
      PULL_OPS_STATUS_LABELS.prepared,
      PULL_OPS_STATUS_LABELS.done,
    ],
  });
  await context.githubClient.commentOnPullRequest({
    number: pullRequest.number,
    body: [
      'PullOps could not complete `pullops run pr-prepare-merge`.',
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
    throw new Error('pr-prepare-merge requires a pull request target.');
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
