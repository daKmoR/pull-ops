import { classifyCheckState } from '../checks/checkState.js';
import {
  PULL_OPS_OPERATION_LABELS,
  PULL_OPS_STALE_STATUS_LABEL_NAMES,
  PULL_OPS_STATUS_LABELS,
} from '../labels/pullOpsLabels.js';
import {
  isFinalizedForRebase,
  readManagedPrState,
  requestManagedPrReview,
  resumeManagedPrWorkflow,
} from '../managed-pr/ManagedPrState.js';
import {
  createIssueBranchName,
  createParentBranchName,
  parseChildIssueBranchName,
} from '../operations/branchNames.js';
import { isIssueDone, parseIssueDependencies } from '../operations/issueDependencies.js';
import {
  createPrdPreparePullRequestBodyForIssue,
  runPrdPrepare,
} from '../operations/prd-prepare/run.js';

/**
 * @typedef {import('../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('../github/types.js').GitHubIssueReference} GitHubIssueReference
 * @typedef {import('../github/types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('./childCoordination.types.js').ChildAutomationResult} ChildAutomationResult
 * @typedef {import('./childCoordination.types.js').ChildIssueCloseResult} ChildIssueCloseResult
 * @typedef {import('./childCoordination.types.js').ChildIssuePrFacts} ChildIssuePrFacts
 * @typedef {import('./childCoordination.types.js').IssueWorkTarget} IssueWorkTarget
 * @typedef {import('./childCoordination.types.js').ParentIssueFacts} ParentIssueFacts
 * @typedef {import('./childCoordination.types.js').ParentReviewResult} ParentReviewResult
 * @typedef {import('./childCoordination.types.js').PrdAutomationMode} PrdAutomationMode
 * @typedef {import('./childCoordination.types.js').PrdAutomationResult} PrdAutomationResult
 */

/** @type {ReadonlySet<string>} */
const ACTIVE_CHILD_ISSUE_LABELS = new Set([PULL_OPS_OPERATION_LABELS.issueImplement]);

/**
 * @param {OperationRunnerContext} context
 * @param {{ parentIssueNumber: number, mode: PrdAutomationMode }} options
 * @returns {Promise<PrdAutomationResult>}
 */
export async function coordinatePrdAutomation(context, { parentIssueNumber, mode }) {
  const parentIssue = await context.githubClient.getIssue(parentIssueNumber);
  return await coordinateParentIssue(context, { parentIssue, mode });
}

/**
 * @param {OperationRunnerContext} context
 * @param {number} parentIssueNumber
 * @returns {Promise<PrdAutomationResult>}
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

  return await coordinateParentIssue(context, { parentIssue, mode });
}

/**
 * @param {OperationRunnerContext} context
 * @param {{ issueNumber: number }} options
 * @returns {Promise<IssueWorkTarget>}
 */
export async function readIssueWorkTarget(context, { issueNumber }) {
  const issue = await context.githubClient.getIssue(issueNumber);
  const parentIssueNumber = getNativeParentIssueNumber(issue);
  const branchName = createIssueBranchName({
    branchPrefix: context.config.branchPrefix,
    issueNumber: issue.number,
    parentNumber: parentIssueNumber,
  });
  const baseBranch =
    parentIssueNumber === undefined
      ? context.config.baseBranch
      : createParentBranchName({
          branchPrefix: context.config.branchPrefix,
          parentNumber: parentIssueNumber,
        });

  return {
    issue,
    parentIssueNumber,
    branchName,
    baseBranch,
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {{ issue: GitHubIssue }} options
 * @returns {Promise<GitHubIssue[]>}
 */
export async function readBlockingDependencies(context, { issue }) {
  return await findBlockingDependencies(context, issue);
}

/**
 * @param {OperationRunnerContext} context
 * @param {{ pullRequestNumber: number }} options
 * @returns {Promise<ChildIssueCloseResult>}
 */
export async function closeMergedChildIssuePullRequest(context, { pullRequestNumber }) {
  const pullRequest = await context.githubClient.getPullRequest(pullRequestNumber);
  if (pullRequest.isCrossRepository === true) {
    return skipped(pullRequest, `PR #${pullRequest.number} is not a same-repository PR.`);
  }

  const childBranch = parseChildIssueBranchName({
    branchPrefix: context.config.branchPrefix,
    branchName: pullRequest.headRefName,
  });

  if (childBranch === undefined) {
    return skipped(pullRequest, `PR #${pullRequest.number} is not a PRD child issue PR.`);
  }

  const expectedBaseBranch = createParentBranchName({
    branchPrefix: context.config.branchPrefix,
    parentNumber: childBranch.parentNumber,
  });

  if (pullRequest.baseRefName !== expectedBaseBranch) {
    return skipped(
      pullRequest,
      `PR #${pullRequest.number} does not target expected PRD branch ${expectedBaseBranch}.`,
    );
  }

  if (!isMergedPullRequest(pullRequest)) {
    return skipped(pullRequest, `PR #${pullRequest.number} is not merged.`);
  }

  const issue = await context.githubClient.getIssue(childBranch.issueNumber);
  const actualParentIssueNumber = getNativeParentIssueNumber(issue);

  if (actualParentIssueNumber !== childBranch.parentNumber) {
    return skipped(
      pullRequest,
      [
        `Issue #${issue.number} is not part of PRD issue #${childBranch.parentNumber}.`,
        'PullOps will not close it from this child PR.',
      ].join(' '),
    );
  }

  const alreadyClosed = issue.state === 'CLOSED';
  if (!alreadyClosed) {
    await closeChildIssue(context, {
      issue,
      pullRequest,
      expectedBaseBranch,
    });
  }

  const prdAutomation = await resumePrdAutomationForParentIssue(context, childBranch.parentNumber);
  const parentPullRequest = await requestUmbrellaReviewIfComplete(context, {
    parentIssueNumber: childBranch.parentNumber,
  });

  return {
    status: 'accepted',
    summary: alreadyClosed
      ? `Child issue #${issue.number} is already closed.`
      : `Closed child issue #${issue.number} after PR #${pullRequest.number} merged into ${expectedBaseBranch}.`,
    issue: {
      number: issue.number,
      url: issue.url,
    },
    pullRequest: formatPullRequest(pullRequest),
    prdAutomation,
    parentPullRequest,
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {{ parentIssueNumber: number }} options
 * @returns {Promise<ParentIssueFacts>}
 */
export async function readParentIssueFacts(context, { parentIssueNumber }) {
  const parentIssue = await context.githubClient.getIssue(parentIssueNumber);
  const childIssues = parentIssue.subIssues;
  return {
    parentIssue,
    childIssues,
    closedChildIssues: childIssues.filter(isClosedIssueReference),
    openChildIssues: childIssues.filter(childIssue => !isClosedIssueReference(childIssue)),
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {{ sourceIssueNumber: number }} options
 * @returns {Promise<ChildIssuePrFacts | undefined>}
 */
export async function readChildIssuePrFacts(context, { sourceIssueNumber }) {
  const sourceIssue = await context.githubClient.getIssue(sourceIssueNumber);
  const parentIssueNumber = getNativeParentIssueNumber(sourceIssue);

  if (parentIssueNumber === undefined) {
    return undefined;
  }

  return {
    sourceIssue,
    parentIssueNumber,
    expectedBaseBranch: createParentBranchName({
      branchPrefix: context.config.branchPrefix,
      parentNumber: parentIssueNumber,
    }),
    expectedChildBranch: createIssueBranchName({
      branchPrefix: context.config.branchPrefix,
      parentNumber: parentIssueNumber,
      issueNumber: sourceIssue.number,
    }),
  };
}

/**
 * @param {GitHubIssue} issue
 * @returns {number | undefined}
 */
export function getNativeParentIssueNumber(issue) {
  return issue.parent?.number;
}

/**
 * @param {OperationRunnerContext} context
 * @param {{ parentIssue: GitHubIssue, mode: PrdAutomationMode }} options
 * @returns {Promise<PrdAutomationResult>}
 */
async function coordinateParentIssue(context, { parentIssue, mode }) {
  if (parentIssue.state !== 'OPEN') {
    return {
      status: 'skipped',
      summary: `PRD issue #${parentIssue.number} is ${parentIssue.state.toLowerCase()}.`,
      issue: parentIssue.number,
      mode,
    };
  }

  const parentIssueNumber = getNativeParentIssueNumber(parentIssue);
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
  const childIssues = await readNativeChildIssues(context, parentIssue);
  /** @type {ChildAutomationResult[]} */
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

  const parentPullRequest = await requestUmbrellaReviewIfComplete(context, {
    parentIssue,
    parentIssueNumber: parentIssue.number,
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
async function readNativeChildIssues(context, parentIssue) {
  /** @type {GitHubIssue[]} */
  const childIssues = [];

  for (const reference of parentIssue.subIssues) {
    const childIssue = await context.githubClient.getIssue(reference.number);
    if (getNativeParentIssueNumber(childIssue) === parentIssue.number) {
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
 * @returns {Promise<ChildAutomationResult>}
 */
async function coordinateChildIssue(context, { parentIssue, parentBranchName, childIssue, mode }) {
  if (childIssue.state !== 'OPEN') {
    return childResult(childIssue, 'closed', `Child issue #${childIssue.number} is closed.`);
  }

  const parentIssueNumber = getNativeParentIssueNumber(childIssue);
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

  if (childIssue.labels.includes(PULL_OPS_STATUS_LABELS.humanRequired)) {
    return childResult(
      childIssue,
      'human-required',
      `Child issue #${childIssue.number} needs human attention before PullOps automation can continue.`,
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
 * @returns {Promise<ChildAutomationResult>}
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

  const state = readManagedPrState(pullRequest.body);
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

  const workflow = await resumeManagedPrWorkflow({
    githubClient: context.githubClient,
    pullRequest,
  });

  if (workflow.status === 'resumed') {
    return childPullRequestResult(
      childIssue,
      pullRequest,
      'resumed',
      `Resumed child PR #${pullRequest.number} with ${workflow.nextOperation}.`,
      { nextOperation: workflow.nextOperation },
    );
  }

  if (workflow.status === 'already-active') {
    return childPullRequestResult(
      childIssue,
      pullRequest,
      'already-active',
      `Child PR #${pullRequest.number} already has active PullOps PR automation.`,
      { labels: workflow.labels ?? [] },
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
 * @returns {Promise<ChildAutomationResult>}
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
  const checkState = classifyCheckState(checks);
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
 * @param {{
 *   parentIssue?: GitHubIssue,
 *   parentIssueNumber: number,
 *   parentBranchName?: string,
 *   childIssues?: GitHubIssue[],
 * }} options
 * @returns {Promise<ParentReviewResult>}
 */
async function requestUmbrellaReviewIfComplete(
  context,
  { parentIssue, parentIssueNumber, parentBranchName, childIssues },
) {
  const resolvedParentIssue =
    parentIssue ??
    (childIssues === undefined
      ? await context.githubClient.getIssue(parentIssueNumber)
      : undefined);
  const children = childIssues ?? resolvedParentIssue?.subIssues ?? [];
  if (children.length === 0) {
    return {
      status: 'waiting-for-child-issues',
      ...(resolvedParentIssue === undefined
        ? {}
        : {
            issue: {
              number: resolvedParentIssue.number,
              url: resolvedParentIssue.url,
            },
          }),
    };
  }

  const openChildIssues = children.filter(childIssue => childIssue.state !== 'CLOSED');
  if (openChildIssues.length > 0) {
    return {
      status: 'waiting',
      ...(resolvedParentIssue === undefined
        ? {}
        : {
            issue: {
              number: resolvedParentIssue.number,
              url: resolvedParentIssue.url,
            },
          }),
      openChildIssues: openChildIssues.map(childIssue => childIssue.number),
    };
  }

  const branchName =
    parentBranchName ??
    createParentBranchName({
      branchPrefix: context.config.branchPrefix,
      parentNumber: parentIssueNumber,
    });
  const pullRequest = await context.githubClient.findOpenPullRequestByHead(branchName);
  if (pullRequest === undefined) {
    return {
      status: 'missing',
      branch: branchName,
    };
  }

  let reviewPullRequest = pullRequest;
  if (resolvedParentIssue !== undefined) {
    const refreshedBody = await createPrdPreparePullRequestBodyForIssue(context, {
      issue: resolvedParentIssue,
      branchName,
    });
    await context.githubClient.updatePullRequestBody({
      number: pullRequest.number,
      body: refreshedBody,
    });
    reviewPullRequest = {
      ...pullRequest,
      body: refreshedBody,
    };
  }

  return await requestManagedPrReview({
    githubClient: context.githubClient,
    pullRequest: reviewPullRequest,
  });
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
 * @param {OperationRunnerContext} context
 * @param {{ issue: GitHubIssue, pullRequest: GitHubPullRequest, expectedBaseBranch: string }} options
 * @returns {Promise<void>}
 */
async function closeChildIssue(context, { issue, pullRequest, expectedBaseBranch }) {
  await context.githubClient.closeIssue({
    number: issue.number,
    comment: [
      `PullOps closed this Child Issue because PR #${pullRequest.number} merged into`,
      `the PRD branch \`${expectedBaseBranch}\`.`,
    ].join(' '),
  });
  await context.githubClient.removeLabelsFromIssue({
    number: issue.number,
    labels: [
      PULL_OPS_OPERATION_LABELS.issueImplement,
      PULL_OPS_STATUS_LABELS.humanRequired,
      ...PULL_OPS_STALE_STATUS_LABEL_NAMES,
    ],
  });
}

/**
 * @param {GitHubIssueReference} issue
 * @returns {boolean}
 */
function isClosedIssueReference(issue) {
  return issue.state === 'CLOSED';
}

/**
 * @param {GitHubPullRequest} pullRequest
 * @param {string} summary
 * @returns {ChildIssueCloseResult}
 */
function skipped(pullRequest, summary) {
  return {
    status: 'skipped',
    summary,
    pullRequest: formatPullRequest(pullRequest),
  };
}

/**
 * @param {GitHubPullRequest} pullRequest
 * @returns {boolean}
 */
function isMergedPullRequest(pullRequest) {
  return pullRequest.state === 'MERGED' || pullRequest.mergedAt !== undefined;
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
 * @param {GitHubIssue} issue
 * @param {string} status
 * @param {string} summary
 * @param {Partial<ChildAutomationResult>} [extra]
 * @returns {ChildAutomationResult}
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
 * @param {Partial<ChildAutomationResult>} [extra]
 * @returns {ChildAutomationResult}
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
 * @param {ChildAutomationResult[]} options.children
 * @param {ParentReviewResult} options.parentPullRequest
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

  if (parentPullRequest.status === 'waiting-for-child-issues') {
    parts.push('Waiting for Child Issues.');
  }

  return parts.join(' ');
}

/**
 * @param {ChildAutomationResult[]} children
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
 * @param {OperationRunnerContext} context
 * @param {GitHubIssue} issue
 * @param {{ reason: string, mode: PrdAutomationMode }} options
 * @returns {Promise<PrdAutomationResult>}
 */
async function blockPrdAutomation(context, issue, { reason, mode }) {
  await context.githubClient.addLabelsToIssue({
    number: issue.number,
    labels: [PULL_OPS_STATUS_LABELS.humanRequired],
  });
  await context.githubClient.removeLabelsFromIssue({
    number: issue.number,
    labels: [
      PULL_OPS_OPERATION_LABELS.prdAutoAdvance,
      PULL_OPS_OPERATION_LABELS.prdAutoComplete,
      ...PULL_OPS_STALE_STATUS_LABEL_NAMES,
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
