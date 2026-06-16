import {
  PULL_OPS_OPERATION_LABELS,
  PULL_OPS_PR_OPERATION_LABELS,
  PULL_OPS_STATUS_LABEL_NAMES,
  PULL_OPS_STATUS_LABELS,
} from '../../labels/pullOpsLabels.js';
import { createIssueBranchName, createParentBranchName } from '../branchNames.js';
import { getParentIssueNumber, isIssueDone, parseIssueDependencies } from '../issueDependencies.js';
import { readPullOpsPullRequestState } from '../pr-review/prBody.js';
import { runPrdPrepare } from '../prd-prepare/run.js';

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../../github/types.js').GitHubCheckRun} GitHubCheckRun
 * @typedef {import('../../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('../../github/types.js').GitHubIssueReference} GitHubIssueReference
 * @typedef {import('../../github/types.js').GitHubPullRequest} GitHubPullRequest
 */

/** @typedef {'auto-advance' | 'auto-complete'} PrdAutomationMode */

/** @type {ReadonlySet<string>} */
const ACTIVE_CHILD_ISSUE_LABELS = new Set([
  PULL_OPS_OPERATION_LABELS.issueImplement,
  PULL_OPS_STATUS_LABELS.inProgress,
]);

/** @type {ReadonlySet<string>} */
const ACTIVE_PULL_OPS_PR_LABELS = new Set([
  ...PULL_OPS_PR_OPERATION_LABELS,
  ...PULL_OPS_STATUS_LABEL_NAMES,
]);

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runPrdAutoAdvance(context) {
  assertIssueTarget(context, 'prd-auto-advance');
  const issue = await context.githubClient.getIssue(context.target.number);
  return await coordinatePrdAutomation(context, {
    parentIssue: issue,
    mode: 'auto-advance',
  });
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runPrdAutoComplete(context) {
  assertIssueTarget(context, 'prd-auto-complete');
  const issue = await context.githubClient.getIssue(context.target.number);
  return await coordinatePrdAutomation(context, {
    parentIssue: issue,
    mode: 'auto-complete',
  });
}

/**
 * Resume whichever PRD automation mode is active on a Parent Issue.
 *
 * @param {OperationRunnerContext} context
 * @param {number} parentIssueNumber
 * @returns {Promise<Record<string, unknown>>}
 */
export async function resumePrdAutomationForParentIssue(context, parentIssueNumber) {
  const parentIssue = await context.githubClient.getIssue(parentIssueNumber);
  const mode = readPrdAutomationMode(parentIssue.labels);

  if (mode === undefined) {
    return {
      status: 'skipped',
      summary: `PRD issue #${parentIssue.number} has no active PRD automation mode label.`,
      issue: parentIssue.number,
    };
  }

  return await coordinatePrdAutomation(context, { parentIssue, mode });
}

/**
 * @param {OperationRunnerContext} context
 * @param {{ parentIssue: GitHubIssue, mode: PrdAutomationMode }} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function coordinatePrdAutomation(context, { parentIssue, mode }) {
  if (parentIssue.state !== 'OPEN') {
    return {
      status: 'skipped',
      summary: `PRD issue #${parentIssue.number} is ${parentIssue.state.toLowerCase()}.`,
      issue: parentIssue.number,
      mode,
    };
  }

  const parentIssueNumber = getParentIssueNumber(parentIssue);
  if (parentIssueNumber !== undefined) {
    return await blockPrdAutomation(context, parentIssue, {
      reason: [
        `Issue #${parentIssue.number} is already part of parent issue #${parentIssueNumber}.`,
        'PRD automation can only run on a Parent Issue.',
      ].join(' '),
      mode,
    });
  }

  const parentBranchName = createParentBranchName({
    branchPrefix: context.config.branchPrefix,
    parentNumber: parentIssue.number,
  });
  const preparation = await ensurePrdPrepared(context, parentIssue);
  const childIssues = await readChildIssues(context, parentIssue);
  const children = [];

  for (const childIssue of childIssues) {
    children.push(
      await coordinateChildIssue(context, {
        parentIssue,
        parentBranchName,
        childIssue,
        mode,
      }),
    );
  }

  const parentPullRequest = await requestParentReviewIfComplete(context, {
    parentBranchName,
    childIssues,
  });

  return {
    status: 'accepted',
    summary: summarizePrdAutomation({
      mode,
      parentIssue,
      children,
      parentPullRequest,
    }),
    mode,
    issue: {
      number: parentIssue.number,
      url: parentIssue.url,
    },
    preparation,
    children,
    parentPullRequest,
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubIssue} parentIssue
 * @returns {Promise<Record<string, unknown>>}
 */
async function ensurePrdPrepared(context, parentIssue) {
  return await runPrdPrepare({
    ...context,
    operation: 'prd-prepare',
    target: {
      type: 'issue',
      number: parentIssue.number,
    },
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubIssue} parentIssue
 * @returns {Promise<GitHubIssue[]>}
 */
async function readChildIssues(context, parentIssue) {
  /** @type {Map<number, GitHubIssueReference>} */
  const references = new Map();
  for (const childIssue of parentIssue.subIssues) {
    references.set(childIssue.number, childIssue);
  }

  if (context.githubClient.findIssuesByBodyReference !== undefined) {
    const bodyReferences = await context.githubClient.findIssuesByBodyReference({
      fieldName: 'Part of',
      issueNumber: parentIssue.number,
    });
    for (const reference of bodyReferences) {
      if (reference.number !== parentIssue.number && !references.has(reference.number)) {
        references.set(reference.number, reference);
      }
    }
  }

  /** @type {GitHubIssue[]} */
  const childIssues = [];
  for (const reference of references.values()) {
    const childIssue = await context.githubClient.getIssue(reference.number);
    if (getParentIssueNumber(childIssue) === parentIssue.number) {
      childIssues.push(childIssue);
    }
  }

  return childIssues;
}

/**
 * @param {OperationRunnerContext} context
 * @param {object} options
 * @param {GitHubIssue} options.parentIssue
 * @param {string} options.parentBranchName
 * @param {GitHubIssue} options.childIssue
 * @param {PrdAutomationMode} options.mode
 * @returns {Promise<Record<string, unknown>>}
 */
async function coordinateChildIssue(context, { parentIssue, parentBranchName, childIssue, mode }) {
  if (childIssue.state !== 'OPEN') {
    return childResult(childIssue, 'closed', `Child issue #${childIssue.number} is closed.`);
  }

  const parentIssueNumber = getParentIssueNumber(childIssue);
  if (parentIssueNumber !== parentIssue.number) {
    return childResult(
      childIssue,
      'skipped',
      `Issue #${childIssue.number} is not part of PRD issue #${parentIssue.number}.`,
    );
  }

  const blockingDependencies = await findBlockingDependencies(context, childIssue);
  if (blockingDependencies.length > 0) {
    return childResult(
      childIssue,
      'blocked',
      `Child issue #${childIssue.number} is blocked by ${formatIssueNumbers(
        blockingDependencies,
      )}.`,
      {
        blockedBy: blockingDependencies.map(issue => issue.number),
      },
    );
  }

  const childBranchName = createIssueBranchName({
    branchPrefix: context.config.branchPrefix,
    parentNumber: parentIssue.number,
    issueNumber: childIssue.number,
  });
  const pullRequest = await context.githubClient.findOpenPullRequestByHead(childBranchName);

  if (pullRequest !== undefined) {
    return await coordinateChildPullRequest(context, {
      childIssue,
      parentIssue,
      parentBranchName,
      pullRequest,
      mode,
    });
  }

  if (hasAnyLabel(childIssue.labels, ACTIVE_CHILD_ISSUE_LABELS)) {
    return childResult(
      childIssue,
      'already-active',
      `Child issue #${childIssue.number} already has active PullOps issue automation.`,
      { labels: childIssue.labels },
    );
  }

  if (childIssue.labels.includes(PULL_OPS_STATUS_LABELS.failed)) {
    return childResult(
      childIssue,
      'failed',
      `Child issue #${childIssue.number} has failed PullOps automation and needs human attention.`,
      { labels: childIssue.labels },
    );
  }

  await context.githubClient.addLabelsToIssue({
    number: childIssue.number,
    labels: [PULL_OPS_OPERATION_LABELS.issueImplement],
  });

  return childResult(
    childIssue,
    'started',
    `Started implementation for unblocked child issue #${childIssue.number}.`,
    { branch: childBranchName },
  );
}

/**
 * @param {OperationRunnerContext} context
 * @param {object} options
 * @param {GitHubIssue} options.childIssue
 * @param {GitHubIssue} options.parentIssue
 * @param {string} options.parentBranchName
 * @param {GitHubPullRequest} options.pullRequest
 * @param {PrdAutomationMode} options.mode
 * @returns {Promise<Record<string, unknown>>}
 */
async function coordinateChildPullRequest(
  context,
  { childIssue, parentIssue, parentBranchName, pullRequest, mode },
) {
  if (pullRequest.baseRefName !== parentBranchName) {
    return childPullRequestResult(
      childIssue,
      pullRequest,
      'skipped',
      `Child PR #${pullRequest.number} does not target ${parentBranchName}.`,
    );
  }

  if (hasAnyLabel(pullRequest.labels ?? [], ACTIVE_PULL_OPS_PR_LABELS)) {
    return childPullRequestResult(
      childIssue,
      pullRequest,
      'already-active',
      `Child PR #${pullRequest.number} already has active PullOps PR automation.`,
      { labels: pullRequest.labels ?? [] },
    );
  }

  const state = readPullOpsPullRequestState(pullRequest.body);
  if (!state.managed || state.sourceIssueNumber !== childIssue.number) {
    return childPullRequestResult(
      childIssue,
      pullRequest,
      'skipped',
      `Child PR #${pullRequest.number} is not the PullOps-managed PR for child issue #${childIssue.number}.`,
    );
  }

  if (mode === 'auto-complete' && isFinalizedForRebase(state)) {
    return await mergeFinalizedChildPullRequest(context, {
      childIssue,
      parentIssue,
      pullRequest,
      finalizedHeadSha: state.finalizedHeadSha,
    });
  }

  const nextOperation = chooseNextPullRequestOperation({
    body: pullRequest.body,
    state,
  });
  if (nextOperation !== undefined) {
    await context.githubClient.addLabelsToPullRequest({
      number: pullRequest.number,
      labels: [nextOperation],
    });
    return childPullRequestResult(
      childIssue,
      pullRequest,
      'resumed',
      `Resumed child PR #${pullRequest.number} with ${nextOperation}.`,
      { nextOperation },
    );
  }

  return childPullRequestResult(
    childIssue,
    pullRequest,
    isFinalizedForRebase(state) ? 'ready-for-human-merge' : 'waiting',
    isFinalizedForRebase(state)
      ? `Child PR #${pullRequest.number} is finalized for human merge.`
      : `Child PR #${pullRequest.number} is waiting for human attention.`,
  );
}

/**
 * @param {OperationRunnerContext} context
 * @param {object} options
 * @param {GitHubIssue} options.childIssue
 * @param {GitHubIssue} options.parentIssue
 * @param {GitHubPullRequest} options.pullRequest
 * @param {string} options.finalizedHeadSha
 * @returns {Promise<Record<string, unknown>>}
 */
async function mergeFinalizedChildPullRequest(
  context,
  { childIssue, parentIssue, pullRequest, finalizedHeadSha },
) {
  if (context.githubClient.mergePullRequest === undefined) {
    return childPullRequestResult(
      childIssue,
      pullRequest,
      'blocked',
      'GitHub client cannot merge pull requests.',
    );
  }

  if (pullRequest.isDraft) {
    return childPullRequestResult(
      childIssue,
      pullRequest,
      'waiting',
      `Child PR #${pullRequest.number} is still a draft.`,
    );
  }

  const checks = await context.githubClient.getPullRequestChecksForRef(finalizedHeadSha);
  const checkState = classifyChecks(checks);
  if (checkState === 'pending') {
    return childPullRequestResult(
      childIssue,
      pullRequest,
      'waiting',
      `Child PR #${pullRequest.number} is waiting for finalized-head checks.`,
      { checks: checks.length },
    );
  }

  if (checkState === 'failed') {
    await context.githubClient.addLabelsToPullRequest({
      number: pullRequest.number,
      labels: [PULL_OPS_OPERATION_LABELS.prFixCi],
    });
    return childPullRequestResult(
      childIssue,
      pullRequest,
      'routed-to-ci-repair',
      `Child PR #${pullRequest.number} finalized-head checks failed; routed to CI repair.`,
      { checks: checks.length },
    );
  }

  await context.githubClient.mergePullRequest({
    number: pullRequest.number,
    method: 'rebase',
  });

  return childPullRequestResult(
    childIssue,
    pullRequest,
    'merged',
    `Merged finalized child PR #${pullRequest.number} into PRD issue #${parentIssue.number}.`,
    { mergeMethod: 'rebase' },
  );
}

/**
 * @param {OperationRunnerContext} context
 * @param {{ parentBranchName: string, childIssues: GitHubIssue[] }} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function requestParentReviewIfComplete(context, { parentBranchName, childIssues }) {
  const openChildIssues = childIssues.filter(childIssue => childIssue.state !== 'CLOSED');
  if (openChildIssues.length > 0) {
    return {
      status: 'waiting',
      openChildIssues: openChildIssues.map(childIssue => childIssue.number),
    };
  }

  const pullRequest = await context.githubClient.findOpenPullRequestByHead(parentBranchName);
  if (pullRequest === undefined) {
    return {
      status: 'missing',
      branch: parentBranchName,
    };
  }

  if (hasAnyLabel(pullRequest.labels ?? [], ACTIVE_PULL_OPS_PR_LABELS)) {
    return {
      status: 'already-active',
      pullRequest: formatPullRequest(pullRequest),
      labels: pullRequest.labels ?? [],
    };
  }

  await context.githubClient.addLabelsToPullRequest({
    number: pullRequest.number,
    labels: [PULL_OPS_OPERATION_LABELS.prReview],
  });

  return {
    status: 'review-requested',
    pullRequest: formatPullRequest(pullRequest),
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubIssue} issue
 * @returns {Promise<GitHubIssue[]>}
 */
async function findBlockingDependencies(context, issue) {
  const dependencyNumbers = parseIssueDependencies(issue.body).blockedBy;
  /** @type {GitHubIssue[]} */
  const blockingDependencies = [];

  for (const dependencyNumber of dependencyNumbers) {
    const dependency = await context.githubClient.getIssue(dependencyNumber);
    if (!isIssueDone(dependency)) {
      blockingDependencies.push(dependency);
    }
  }

  return blockingDependencies;
}

/**
 * @param {{ body: string, state: import('../pr-review/prBody.types.js').PullOpsPullRequestState }} options
 * @returns {string | undefined}
 */
function chooseNextPullRequestOperation({ body, state }) {
  const status = readPullOpsBodyLine(body, 'Status:');

  if (isFinalizedForRebase(state)) {
    return undefined;
  }

  if (state.reviewedTreeHash !== undefined || status === 'Review approved') {
    return PULL_OPS_OPERATION_LABELS.prFinalize;
  }

  if (status === 'Changes requested') {
    return PULL_OPS_OPERATION_LABELS.prAddressReview;
  }

  if (
    status === 'Review feedback addressed' ||
    status === 'Draft automation' ||
    state.lastOperation === PULL_OPS_OPERATION_LABELS.issueImplement ||
    state.lastOperation === PULL_OPS_OPERATION_LABELS.prAddressReview
  ) {
    return PULL_OPS_OPERATION_LABELS.prReview;
  }

  return undefined;
}

/**
 * @param {import('../pr-review/prBody.types.js').PullOpsPullRequestState} state
 * @returns {state is import('../pr-review/prBody.types.js').PullOpsPullRequestState & { finalizedHeadSha: string, finalizedTreeHash: string }}
 */
function isFinalizedForRebase(state) {
  return (
    state.finalizedHeadSha !== undefined &&
    state.finalizedTreeHash !== undefined &&
    state.mergeMethod === 'rebase'
  );
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
 * @param {string[] | undefined} labels
 * @returns {PrdAutomationMode | undefined}
 */
function readPrdAutomationMode(labels) {
  if (labels?.includes(PULL_OPS_OPERATION_LABELS.prdAutoComplete)) {
    return 'auto-complete';
  }

  if (labels?.includes(PULL_OPS_OPERATION_LABELS.prdAutoAdvance)) {
    return 'auto-advance';
  }

  return undefined;
}

/**
 * @param {string[]} labels
 * @param {ReadonlySet<string>} candidates
 * @returns {boolean}
 */
function hasAnyLabel(labels, candidates) {
  return labels.some(label => candidates.has(label));
}

/**
 * @param {string} body
 * @param {string} prefix
 * @returns {string | undefined}
 */
function readPullOpsBodyLine(body, prefix) {
  const pattern = new RegExp(`^${escapeRegExp(prefix)}\\s*(.+?)\\s*$`, 'im');
  return pattern.exec(body)?.[1];
}

/**
 * @param {GitHubIssue} issue
 * @param {string} status
 * @param {string} summary
 * @param {Record<string, unknown>} [extra]
 * @returns {Record<string, unknown>}
 */
function childResult(issue, status, summary, extra = {}) {
  return {
    issue: {
      number: issue.number,
      url: issue.url,
    },
    status,
    summary,
    ...extra,
  };
}

/**
 * @param {GitHubIssue} issue
 * @param {GitHubPullRequest} pullRequest
 * @param {string} status
 * @param {string} summary
 * @param {Record<string, unknown>} [extra]
 * @returns {Record<string, unknown>}
 */
function childPullRequestResult(issue, pullRequest, status, summary, extra = {}) {
  return childResult(issue, status, summary, {
    pullRequest: formatPullRequest(pullRequest),
    ...extra,
  });
}

/**
 * @param {GitHubPullRequest} pullRequest
 * @returns {{ number: number, url: string, baseBranch: string | undefined, headBranch: string }}
 */
function formatPullRequest(pullRequest) {
  return {
    number: pullRequest.number,
    url: pullRequest.url,
    baseBranch: pullRequest.baseRefName,
    headBranch: pullRequest.headRefName,
  };
}

/**
 * @param {object} options
 * @param {PrdAutomationMode} options.mode
 * @param {GitHubIssue} options.parentIssue
 * @param {Record<string, unknown>[]} options.children
 * @param {Record<string, unknown>} options.parentPullRequest
 * @returns {string}
 */
function summarizePrdAutomation({ mode, parentIssue, children, parentPullRequest }) {
  const started = countChildrenByStatus(children, 'started');
  const resumed = countChildrenByStatus(children, 'resumed');
  const merged = countChildrenByStatus(children, 'merged');
  const blocked = countChildrenByStatus(children, 'blocked');
  const parts = [
    `Ran PRD ${mode} for issue #${parentIssue.number}.`,
    `${started} child issue(s) started.`,
    `${resumed} child PR(s) resumed.`,
  ];

  if (mode === 'auto-complete') {
    parts.push(`${merged} finalized child PR(s) merged.`);
  }

  if (blocked > 0) {
    parts.push(`${blocked} child issue(s) blocked by dependencies.`);
  }

  if (parentPullRequest.status === 'review-requested') {
    parts.push('Requested umbrella PR review.');
  }

  return parts.join(' ');
}

/**
 * @param {Record<string, unknown>[]} children
 * @param {string} status
 * @returns {number}
 */
function countChildrenByStatus(children, status) {
  return children.filter(child => child.status === status).length;
}

/**
 * @param {GitHubIssue[]} issues
 * @returns {string}
 */
function formatIssueNumbers(issues) {
  return issues.map(issue => `#${issue.number}`).join(', ');
}

/**
 * @param {string | undefined} value
 * @returns {string}
 */
function normalize(value) {
  return value === undefined ? '' : value.toLowerCase();
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubIssue} issue
 * @param {{ reason: string, mode: PrdAutomationMode }} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function blockPrdAutomation(context, issue, { reason, mode }) {
  await context.githubClient.addLabelsToIssue({
    number: issue.number,
    labels: [PULL_OPS_STATUS_LABELS.blocked],
  });
  await context.githubClient.removeLabelsFromIssue({
    number: issue.number,
    labels: [
      PULL_OPS_STATUS_LABELS.inProgress,
      PULL_OPS_STATUS_LABELS.failed,
      PULL_OPS_STATUS_LABELS.prepared,
      PULL_OPS_STATUS_LABELS.done,
    ],
  });
  await context.githubClient.commentOnIssue({
    number: issue.number,
    body: [`PullOps could not complete \`pullops run prd-${mode}\`.`, '', `Reason: ${reason}`].join(
      '\n',
    ),
  });

  return {
    status: 'blocked',
    summary: reason,
    mode,
    issue: issue.number,
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {string} operationName
 * @returns {asserts context is OperationRunnerContext & { target: { type: 'issue', number: number } }}
 */
function assertIssueTarget(context, operationName) {
  if (context.target.type !== 'issue') {
    throw new Error(`${operationName} requires an issue target.`);
  }
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
