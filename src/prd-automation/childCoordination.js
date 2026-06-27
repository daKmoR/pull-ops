import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { classifyCheckState } from '../checks/checkState.js';
import {
  PULL_OPS_OPERATION_LABELS,
  PULL_OPS_STALE_STATUS_LABEL_NAMES,
  PULL_OPS_STATUS_LABELS,
} from '../labels/pullOpsLabels.js';
import {
  hasActiveManagedPrWorkflow,
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
import { GITHUB_ACTIONS_BOT_AUTHOR } from '../operations/githubActionsBot.js';
import {
  createLocalPrdAutoCompleteChildProgressEvent,
  createLocalPrdAutoCompleteParentWaitingEvent,
  createLocalPrdAutoCompletePhaseCompletedEvent,
} from '../operations/prd-automation/eventStream.js';
import { isIssueDone, parseIssueDependencies } from '../operations/issueDependencies.js';
import {
  createPrdPreparePullRequestBodyForIssue,
  runPrdPrepare,
} from '../operations/prd-prepare/run.js';
import {
  DEFAULT_LOCAL_RUN_HEARTBEAT_INTERVAL_MS,
  DEFAULT_LOCAL_RUN_LEASE_DURATION_MS,
  LOCAL_RUN_HEARTBEAT_COMMAND,
  createLocalRunLink,
  initializeLocalRunState,
  mapLocalRunResultStatusToTerminalStatus,
  recordLocalRunChildRun,
  recordLocalRunTerminalStatus,
} from '../local-run-state/localRunState.js';
import {
  createLocalPrdRunRecordLocation,
  normalizeOperationReferenceForPath,
} from './localRunRecord.js';

/**
 * @typedef {import('../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('../github/types.js').GitHubIssueReference} GitHubIssueReference
 * @typedef {import('../github/types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('./childCoordination.types.js').ChildAutomationResult} ChildAutomationResult
 * @typedef {import('./childCoordination.types.js').ChildDependencyDecision} ChildDependencyDecision
 * @typedef {import('./childCoordination.types.js').ChildIssueCloseResult} ChildIssueCloseResult
 * @typedef {import('./childCoordination.types.js').ChildIssueRunner} ChildIssueRunner
 * @typedef {import('./childCoordination.types.js').ChildIssuePrFacts} ChildIssuePrFacts
 * @typedef {import('./childCoordination.types.js').IssueWorkTarget} IssueWorkTarget
 * @typedef {import('./childCoordination.types.js').ParentIssueFacts} ParentIssueFacts
 * @typedef {import('./childCoordination.types.js').ParentReviewResult} ParentReviewResult
 * @typedef {import('./childCoordination.types.js').PrdAutomationMode} PrdAutomationMode
 * @typedef {import('./childCoordination.types.js').PrdAutomationResult} PrdAutomationResult
 * @typedef {import('../local-run-state/types.js').LocalRunRecord} LocalRunRecord
 * @typedef {import('../local-run-state/types.js').LocalRunChildRun} LocalRunChildRun
 * @typedef {import('../local-run-state/types.js').LocalRunRunLink} LocalRunRunLink
 * @typedef {'pr-review' | 'pr-address-review' | 'pr-finalize'} PullRequestOperationName
 * @typedef {{
 *   pullRequestNumber: number,
 *   operation: PullRequestOperationName,
 *   parentRun?: LocalRunRunLink,
 * }} PullRequestOperationRequest
 */

/** @type {ReadonlySet<string>} */
const ACTIVE_CHILD_ISSUE_LABELS = new Set([PULL_OPS_OPERATION_LABELS.issueImplement]);

/** @type {ReadonlySet<string>} */
const STALE_STATUS_LABELS = new Set(PULL_OPS_STALE_STATUS_LABEL_NAMES);

// Runaway guard only. Managed PR review/address-review budgets are enforced by
// the PR operations through the managed PR state stored in the pull request body.
const MAX_PUBLISHED_UMBRELLA_PARENT_OPERATION_STEPS = 25;

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
 * @param {object} options
 * @param {number} options.parentIssueNumber
 * @param {ChildIssueRunner} options.runChildIssue
 * @param {(request: PullRequestOperationRequest) => Promise<Record<string, unknown>>} [options.runParentPullRequestOperation]
 * @param {(request: PullRequestOperationRequest) => Promise<Record<string, unknown>>} [options.runChildPullRequestOperation]
 * @returns {Promise<PrdAutomationResult>}
 */
export async function coordinateLocalPrdAutoAdvance(
  context,
  { parentIssueNumber, runChildIssue, runParentPullRequestOperation, runChildPullRequestOperation },
) {
  return await coordinateLocalPrdAutomation(context, {
    parentIssueNumber,
    mode: 'auto-advance',
    runChildIssue,
    runParentPullRequestOperation,
    runChildPullRequestOperation,
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {object} options
 * @param {number} options.parentIssueNumber
 * @param {ChildIssueRunner} options.runChildIssue
 * @param {(request: PullRequestOperationRequest) => Promise<Record<string, unknown>>} [options.runParentPullRequestOperation]
 * @param {(request: PullRequestOperationRequest) => Promise<Record<string, unknown>>} [options.runChildPullRequestOperation]
 * @returns {Promise<PrdAutomationResult>}
 */
export async function coordinateLocalPrdAutoComplete(
  context,
  { parentIssueNumber, runChildIssue, runParentPullRequestOperation, runChildPullRequestOperation },
) {
  return await coordinateLocalPrdAutomation(context, {
    parentIssueNumber,
    mode: 'auto-complete',
    runChildIssue,
    runParentPullRequestOperation,
    runChildPullRequestOperation,
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {object} options
 * @param {number} options.parentIssueNumber
 * @param {PrdAutomationMode} options.mode
 * @param {ChildIssueRunner} options.runChildIssue
 * @param {(request: PullRequestOperationRequest) => Promise<Record<string, unknown>>} [options.runParentPullRequestOperation]
 * @param {(request: PullRequestOperationRequest) => Promise<Record<string, unknown>>} [options.runChildPullRequestOperation]
 * @returns {Promise<PrdAutomationResult>}
 */
async function coordinateLocalPrdAutomation(
  context,
  {
    parentIssueNumber,
    mode,
    runChildIssue,
    runParentPullRequestOperation,
    runChildPullRequestOperation,
  },
) {
  const publicationMode = context.publicationMode ?? 'dry-run';
  const operationReference = readLocalPrdOperationReference(mode);
  const runRecord = await createLocalPrdRunRecord(context, {
    operationReference,
    targetNumber: parentIssueNumber,
    publicationMode,
  });
  const parentRun = runRecord.runLink;

  try {
    await emitLocalPrdAutoCompleteRunStarted(context, parentIssueNumber);
    await emitLocalPrdAutoCompletePhaseStarted(context, parentIssueNumber);
    await requireCleanLocalPrdWorktree(context, runRecord, {
      operationReference,
      parentIssueNumber,
      mode,
      publicationMode,
    });
    const parentIssue = await context.githubClient.getIssue(parentIssueNumber);
    if (parentIssue.state !== 'OPEN') {
      await emitLocalPrdAutoCompletePhaseCompleted(context, [], parentIssue.number);
      return await completeLocalPrdRunRecord(runRecord, {
        status: 'skipped',
        summary: `PRD issue #${parentIssue.number} is ${parentIssue.state.toLowerCase()}.`,
        issue: parentIssue.number,
        mode,
      });
    }

    const nativeParentIssueNumber = getNativeParentIssueNumber(parentIssue);
    if (nativeParentIssueNumber !== undefined) {
      const result = await refuseLocalPrdAutomation(runRecord, parentIssue, {
        reason: [
          `Issue #${parentIssue.number} is already part of parent issue #${nativeParentIssueNumber}.`,
          'PRD automation can only run on a Parent Issue.',
        ].join(' '),
        mode,
        publicationMode,
      });
      await emitLocalPrdAutoCompletePhaseCompleted(context, [], parentIssue.number);
      return await completeLocalPrdRunRecord(runRecord, result);
    }

    const parentBranchName = createParentBranchName({
      branchPrefix: context.config.branchPrefix,
      parentNumber: parentIssue.number,
    });
    const preparation = await prepareLocalPrdAutomation(context, parentIssue, {
      parentBranchName,
      publicationMode,
    });
    const childIssues = await readNativeChildIssues(context, parentIssue);
    /** @type {ChildAutomationResult[]} */
    const children = [];
    /** @type {number[]} */
    let virtualCompletedChildren = [];
    let preserveInspectableBranchState = false;
    const completeThroughDependencyFrontiers =
      mode === 'auto-complete' && context.runGoal !== 'operation';

    if (publicationMode === 'publish') {
      await checkoutLocalPrdBase(context, { parentBranchName });
    }

    if (completeThroughDependencyFrontiers && publicationMode === 'dry-run') {
      const dryRun = await coordinateLocalAutoCompleteDryRunChildren(context, {
        parentIssue,
        parentBranchName,
        childIssues,
        parentRun,
        runChildIssue,
      });
      children.push(...dryRun.children);
      virtualCompletedChildren = dryRun.virtualCompletedChildren;
      preserveInspectableBranchState = dryRun.preserveInspectableBranchState;
    } else if (completeThroughDependencyFrontiers && publicationMode === 'publish') {
      const published = await coordinateLocalAutoCompletePublishChildren(context, {
        parentIssue,
        parentBranchName,
        childIssues,
        parentRun,
        runChildIssue,
        runChildPullRequestOperation,
      });
      children.push(...published.children);
      preserveInspectableBranchState = published.preserveInspectableBranchState;
    } else {
      for (const childIssue of childIssues) {
        await emitLocalPrdAutoCompleteChildStarted(context, childIssue);
        const localResult = await coordinateLocalChildIssue(context, {
          parentIssue,
          parentBranchName,
          childIssue,
          parentRun,
          mode: completeThroughDependencyFrontiers ? mode : 'auto-advance',
          publicationMode,
          runChildIssue,
          runChildPullRequestOperation,
        });
        await recordLocalPrdChildResult(context, children, localResult.child);
        preserveInspectableBranchState =
          preserveInspectableBranchState || shouldPreserveInspectableBranchState(localResult.child);

        if (
          publicationMode === 'publish' &&
          localResult.restorePrdBase &&
          !preserveInspectableBranchState
        ) {
          await checkoutLocalPrdBase(context, { parentBranchName });
        }

        if (completeThroughDependencyFrontiers && localResult.stop) {
          break;
        }
      }
    }

    const refreshedPreparation =
      publicationMode === 'publish' && didIntegrateChildWork(children)
        ? await ensurePrdPrepared(context, parentIssue, { forceRefresh: true })
        : preparation;

    if (publicationMode === 'publish' && !preserveInspectableBranchState) {
      await checkoutLocalPrdBase(context, { parentBranchName });
    }

    const parentReviewFacts =
      completeThroughDependencyFrontiers && publicationMode === 'dry-run'
        ? createLocalDryRunParentReviewFacts({ parentIssue, childIssues, children })
        : { parentIssue, childIssues };
    const parentPullRequest =
      completeThroughDependencyFrontiers &&
      publicationMode === 'publish' &&
      !preserveInspectableBranchState
        ? await completePublishedLocalUmbrellaPullRequest(context, {
            parentIssue,
            parentIssueNumber: parentIssue.number,
            parentBranchName,
            childIssues,
            parentRun,
            runParentPullRequestOperation,
          })
        : await requestUmbrellaReviewIfComplete(context, {
            parentIssue: parentReviewFacts.parentIssue,
            parentIssueNumber: parentIssue.number,
            parentBranchName,
            childIssues: parentReviewFacts.childIssues,
            requestReview: false,
          });

    await emitLocalPrdAutoCompletePhaseCompleted(context, children, parentIssue.number);
    await emitLocalPrdAutoCompleteParentWaiting(context, parentPullRequest);

    return await completeLocalPrdRunRecord(runRecord, {
      status: 'accepted',
      summary: summarizeLocalPrdAutomation({
        mode,
        parentIssue,
        children,
        publicationMode,
      }),
      mode,
      issue: {
        number: parentIssue.number,
        url: parentIssue.url,
      },
      preparation: refreshedPreparation,
      children,
      parentPullRequest,
      publicationMode,
      branch: parentBranchName,
      virtualCompletedChildren,
      remainingBlockedChildren: children
        .filter(child => child.status === 'blocked')
        .map(child => child.issue.number),
      localNextSteps: buildLocalNextSteps({ mode, children, publicationMode, parentPullRequest }),
    });
  } catch (error) {
    await writeLocalPrdRunArtifact(runRecord, 'error.txt', `${getErrorMessage(error)}\n`);
    const terminalStatus = readKnownLocalPrdRunBoundaryTerminalStatus(error) ?? 'failed';
    await recordLocalRunTerminalStatus({
      statePath: runRecord.statePath,
      status: terminalStatus,
      summary: getErrorMessage(error),
      phase: 'run',
    });
    throw attachLocalRunRecordToError(error, runRecord.directory);
  }
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
 * @param {{ forceRefresh?: boolean }} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
async function ensurePrdPrepared(context, parentIssue, { forceRefresh = false } = {}) {
  const branchName = createParentBranchName({
    branchPrefix: context.config.branchPrefix,
    parentNumber: parentIssue.number,
  });
  const existingPullRequest = await context.githubClient.findOpenPullRequestByHead(branchName);
  const existingState =
    existingPullRequest === undefined ? undefined : readManagedPrState(existingPullRequest.body);
  if (
    existingPullRequest !== undefined &&
    existingState !== undefined &&
    !forceRefresh &&
    (isFinalizedForRebase(existingState) ||
      selectLocalParentPullRequestOperation(existingPullRequest) !== 'pr-review')
  ) {
    return {
      status: 'accepted',
      summary: `Umbrella PR #${existingPullRequest.number} for parent issue #${parentIssue.number} is already prepared.`,
      issue: {
        number: parentIssue.number,
        url: parentIssue.url,
      },
      pullRequest: {
        number: existingPullRequest.number,
        url: existingPullRequest.url,
        branch: branchName,
        draft: existingPullRequest.isDraft,
      },
    };
  }

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
 * @param {ChildAutomationResult[]} children
 * @returns {boolean}
 */
function didIntegrateChildWork(children) {
  return children.some(child => child.status === 'merged');
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubIssue} parentIssue
 * @param {{ parentBranchName: string, publicationMode: 'dry-run' | 'publish' }} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function prepareLocalPrdAutomation(
  context,
  parentIssue,
  { parentBranchName, publicationMode },
) {
  if (publicationMode === 'publish') {
    return await ensurePrdPrepared(context, parentIssue);
  }

  await checkoutLocalPrdBase(context, { parentBranchName });
  return await inspectLocalPrdPreparation(context, parentIssue, parentBranchName);
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubIssue} parentIssue
 * @param {string} parentBranchName
 * @returns {Promise<Record<string, unknown>>}
 */
async function inspectLocalPrdPreparation(context, parentIssue, parentBranchName) {
  const existingPullRequest =
    await context.githubClient.findOpenPullRequestByHead(parentBranchName);
  if (existingPullRequest !== undefined) {
    return {
      status: 'accepted',
      summary: `Inspected existing umbrella PR #${existingPullRequest.number} for parent issue #${parentIssue.number} without GitHub mutations.`,
      issue: {
        number: parentIssue.number,
        url: parentIssue.url,
      },
      pullRequest: {
        number: existingPullRequest.number,
        url: existingPullRequest.url,
        branch: parentBranchName,
        draft: existingPullRequest.isDraft,
      },
    };
  }

  return {
    status: 'accepted',
    summary: `Prepared local PRD automation context for parent issue #${parentIssue.number} without GitHub mutations.`,
    issue: {
      number: parentIssue.number,
      url: parentIssue.url,
    },
    branch: parentBranchName,
    publicationMode: 'dry-run',
  };
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
    return childResult({
      issue: childIssue,
      status: 'closed',
      summary: `Child issue #${childIssue.number} is closed.`,
    });
  }

  const parentIssueNumber = getNativeParentIssueNumber(childIssue);
  if (parentIssueNumber !== parentIssue.number) {
    return childResult({
      issue: childIssue,
      status: 'skipped',
      summary: `Issue #${childIssue.number} is not part of PRD issue #${parentIssue.number}.`,
    });
  }

  const blockingDependencies = await findBlockingDependencies(context, childIssue);
  if (blockingDependencies.length > 0) {
    return childResult({
      issue: childIssue,
      status: 'blocked',
      summary: `Child issue #${childIssue.number} is blocked by ${formatIssueNumbers(
        blockingDependencies,
      )}.`,
      extra: {
        blockedBy: blockingDependencies.map(issue => issue.number),
      },
    });
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
    return childResult({
      issue: childIssue,
      status: 'already-active',
      summary: `Child issue #${childIssue.number} already has active PullOps issue automation.`,
      extra: { labels: childIssue.labels },
    });
  }

  if (childIssue.labels.includes(PULL_OPS_STATUS_LABELS.humanRequired)) {
    return childResult({
      issue: childIssue,
      status: 'human-required',
      summary: `Child issue #${childIssue.number} needs human attention before PullOps automation can continue.`,
      extra: { labels: childIssue.labels },
    });
  }

  await context.githubClient.addLabelsToIssue({
    number: childIssue.number,
    labels: [PULL_OPS_OPERATION_LABELS.issueImplement],
  });

  return childResult({
    issue: childIssue,
    status: 'started',
    summary: `Started implementation for unblocked child issue #${childIssue.number}.`,
    extra: { branch: childBranchName },
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {object} options
 * @param {GitHubIssue} options.parentIssue
 * @param {string} options.parentBranchName
 * @param {GitHubIssue[]} options.childIssues
 * @param {LocalRunRunLink} options.parentRun
 * @param {ChildIssueRunner} options.runChildIssue
 * @returns {Promise<{
 *   children: ChildAutomationResult[],
 *   virtualCompletedChildren: number[],
 *   preserveInspectableBranchState: boolean,
 * }>}
 */
async function coordinateLocalAutoCompleteDryRunChildren(
  context,
  { parentIssue, parentBranchName, childIssues, parentRun, runChildIssue },
) {
  /** @type {ChildAutomationResult[]} */
  const children = [];
  /** @type {Set<number>} */
  const pendingIssueNumbers = new Set(childIssues.map(childIssue => childIssue.number));
  /** @type {Set<number>} */
  const virtualCompletedIssueNumbers = new Set();
  /** @type {ChildAutomationResult | undefined} */
  let localBlocker;
  let preserveInspectableBranchState = false;

  while (pendingIssueNumbers.size > 0 && localBlocker === undefined) {
    let progressed = false;

    for (const childIssue of childIssues) {
      if (!pendingIssueNumbers.has(childIssue.number)) {
        continue;
      }

      const dependencyFacts = await readChildDependencyDecision(context, {
        issue: childIssue,
        virtualCompletedIssueNumbers,
      });
      if (
        shouldDeferLocalAutoCompleteChild({
          parentIssue,
          childIssue,
          dependencyFacts,
        })
      ) {
        continue;
      }

      await emitLocalPrdAutoCompleteChildStarted(context, childIssue);
      const alreadyIntegrated = await readAlreadyIntegratedLocalDryRunChild(context, {
        parentIssue,
        parentBranchName,
        childIssue,
        dependencyFacts,
      });
      if (alreadyIntegrated !== undefined) {
        await recordObservedLocalPrdChildRun(context, {
          parentRun,
          childIssue,
          child: alreadyIntegrated,
        });
        await recordLocalDryRunChildResult(context, {
          children,
          pendingIssueNumbers,
          virtualCompletedIssueNumbers,
          child: alreadyIntegrated,
        });
        progressed = true;
        continue;
      }

      const localResult = await coordinateLocalChildIssue(context, {
        parentIssue,
        parentBranchName,
        parentRun,
        childIssue,
        mode: 'auto-complete',
        publicationMode: 'dry-run',
        runChildIssue,
        dependencyFacts,
      });

      await recordLocalDryRunChildResult(context, {
        children,
        pendingIssueNumbers,
        virtualCompletedIssueNumbers,
        child: localResult.child,
      });
      preserveInspectableBranchState =
        preserveInspectableBranchState || shouldPreserveInspectableBranchState(localResult.child);
      progressed = true;

      if (localResult.stop) {
        localBlocker = localResult.child;
        break;
      }
    }

    if (!progressed) {
      break;
    }
  }

  for (const childIssue of childIssues) {
    if (!pendingIssueNumbers.has(childIssue.number)) {
      continue;
    }

    const dependencyFacts = await readChildDependencyDecision(context, {
      issue: childIssue,
      virtualCompletedIssueNumbers,
    });
    const child =
      dependencyFacts.blockingDependencies.length > 0
        ? blockedByDependencyChildResult(childIssue, dependencyFacts)
        : blockedByLocalAutoCompletePhaseResult(childIssue, localBlocker);
    await emitLocalPrdAutoCompleteChildStarted(context, childIssue);
    await recordObservedLocalPrdChildRun(context, {
      parentRun,
      childIssue,
      child,
    });
    await recordLocalDryRunChildResult(context, {
      children,
      pendingIssueNumbers,
      virtualCompletedIssueNumbers,
      child,
    });
  }

  return {
    children,
    virtualCompletedChildren: [...virtualCompletedIssueNumbers],
    preserveInspectableBranchState,
  };
}

/**
 * @param {object} options
 * @param {GitHubIssue} options.parentIssue
 * @param {GitHubIssue[]} options.childIssues
 * @param {ChildAutomationResult[]} options.children
 * @returns {{ parentIssue: GitHubIssue, childIssues: GitHubIssue[] }}
 */
function createLocalDryRunParentReviewFacts({ parentIssue, childIssues, children }) {
  const completedIssueNumbers = new Set(
    children.filter(isLocalDryRunVirtualCompletion).map(child => child.issue.number),
  );

  return {
    parentIssue: {
      ...parentIssue,
      subIssues: parentIssue.subIssues.map(reference =>
        completedIssueNumbers.has(reference.number)
          ? {
              ...reference,
              state: 'CLOSED',
            }
          : reference,
      ),
    },
    childIssues: childIssues.map(childIssue =>
      completedIssueNumbers.has(childIssue.number)
        ? {
            ...childIssue,
            state: 'CLOSED',
          }
        : childIssue,
    ),
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {object} options
 * @param {GitHubIssue} options.parentIssue
 * @param {string} options.parentBranchName
 * @param {GitHubIssue[]} options.childIssues
 * @param {LocalRunRunLink} options.parentRun
 * @param {ChildIssueRunner} options.runChildIssue
 * @param {(request: PullRequestOperationRequest) => Promise<Record<string, unknown>>} [options.runChildPullRequestOperation]
 * @returns {Promise<{
 *   children: ChildAutomationResult[],
 *   preserveInspectableBranchState: boolean,
 * }>}
 */
async function coordinateLocalAutoCompletePublishChildren(
  context,
  {
    parentIssue,
    parentBranchName,
    childIssues,
    parentRun,
    runChildIssue,
    runChildPullRequestOperation,
  },
) {
  /** @type {ChildAutomationResult[]} */
  const children = [];
  /** @type {Set<number>} */
  const pendingIssueNumbers = new Set(childIssues.map(childIssue => childIssue.number));
  /** @type {ChildAutomationResult | undefined} */
  let localBlocker;
  let preserveInspectableBranchState = false;

  while (pendingIssueNumbers.size > 0 && localBlocker === undefined) {
    let progressed = false;

    for (const childIssue of childIssues) {
      if (!pendingIssueNumbers.has(childIssue.number)) {
        continue;
      }

      const dependencyFacts = await readChildDependencyDecision(context, {
        issue: childIssue,
        virtualCompletedIssueNumbers: new Set(),
      });
      if (
        shouldDeferLocalAutoCompleteChild({
          parentIssue,
          childIssue,
          dependencyFacts,
        })
      ) {
        continue;
      }

      await emitLocalPrdAutoCompleteChildStarted(context, childIssue);
      const localResult = await coordinateLocalChildIssue(context, {
        parentIssue,
        parentBranchName,
        parentRun,
        childIssue,
        mode: 'auto-complete',
        publicationMode: 'publish',
        runChildIssue,
        runChildPullRequestOperation,
        dependencyFacts,
      });
      await recordLocalPrdChildResult(context, children, localResult.child);
      pendingIssueNumbers.delete(childIssue.number);
      preserveInspectableBranchState =
        preserveInspectableBranchState || shouldPreserveInspectableBranchState(localResult.child);
      progressed = true;

      if (localResult.restorePrdBase && !preserveInspectableBranchState) {
        await checkoutLocalPrdBase(context, { parentBranchName });
      }

      if (localResult.stop) {
        localBlocker = localResult.child;
        break;
      }
    }

    if (!progressed) {
      break;
    }
  }

  for (const childIssue of childIssues) {
    if (!pendingIssueNumbers.has(childIssue.number)) {
      continue;
    }

    const dependencyFacts = await readChildDependencyDecision(context, {
      issue: childIssue,
      virtualCompletedIssueNumbers: new Set(),
    });
    const child =
      dependencyFacts.blockingDependencies.length > 0
        ? blockedByDependencyChildResult(childIssue, dependencyFacts)
        : blockedByLocalAutoCompletePhaseResult(childIssue, localBlocker);
    await emitLocalPrdAutoCompleteChildStarted(context, childIssue);
    await recordObservedLocalPrdChildRun(context, {
      parentRun,
      childIssue,
      child,
    });
    await recordLocalPrdChildResult(context, children, child);
    pendingIssueNumbers.delete(childIssue.number);
  }

  return {
    children,
    preserveInspectableBranchState,
  };
}

/**
 * @param {object} options
 * @param {GitHubIssue} options.parentIssue
 * @param {GitHubIssue} options.childIssue
 * @param {{ blockingDependencies: GitHubIssue[] }} options.dependencyFacts
 * @returns {boolean}
 */
function shouldDeferLocalAutoCompleteChild({ parentIssue, childIssue, dependencyFacts }) {
  return (
    childIssue.state === 'OPEN' &&
    getNativeParentIssueNumber(childIssue) === parentIssue.number &&
    dependencyFacts.blockingDependencies.length > 0
  );
}

/**
 * @param {OperationRunnerContext} context
 * @param {ChildAutomationResult[]} children
 * @param {ChildAutomationResult} child
 * @returns {Promise<void>}
 */
async function recordLocalPrdChildResult(context, children, child) {
  children.push(child);
  await emitLocalPrdAutoCompleteChildProgress(context, child);
}

/**
 * @param {LocalRunRunLink | undefined} parentRun
 * @param {LocalRunRunLink} childRunLink
 * @param {Date} startedAt
 * @param {{ status: string, summary: string }} child
 * @returns {Promise<void>}
 */
async function recordLocalPrdChildRunState(parentRun, childRunLink, startedAt, child) {
  if (parentRun === undefined) {
    return;
  }

  await recordLocalRunChildRun({
    statePath: parentRun.statePath,
    childRun: {
      ...childRunLink,
      status: child.status,
      startedAt: startedAt.toISOString(),
      updatedAt: new Date().toISOString(),
      summary: child.summary,
    },
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {object} options
 * @param {LocalRunRunLink | undefined} options.parentRun
 * @param {GitHubIssue} options.childIssue
 * @param {ChildAutomationResult} options.child
 * @returns {Promise<void>}
 */
async function recordObservedLocalPrdChildRun(context, { parentRun, childIssue, child }) {
  if (parentRun === undefined) {
    return;
  }

  const recordedAt = new Date();
  const childRunLink = await createObservedLocalPrdChildRunLink(context, {
    parentRun,
    childIssue,
    child,
    recordedAt,
  });
  await recordLocalPrdChildRunState(parentRun, childRunLink, recordedAt, child);
}

/**
 * @param {OperationRunnerContext} context
 * @param {object} options
 * @param {LocalRunRunLink} options.parentRun
 * @param {GitHubIssue} options.childIssue
 * @param {ChildAutomationResult} options.child
 * @param {Date} options.recordedAt
 * @returns {Promise<LocalRunRunLink>}
 */
async function createObservedLocalPrdChildRunLink(
  context,
  { parentRun, childIssue, child, recordedAt },
) {
  const operationReference = readLocalPrdChildRunOperationReference(child);
  if (typeof child.localRunRecord === 'string' && child.localRunRecord.trim() !== '') {
    return createLocalRunLink({
      runRecordDirectory: child.localRunRecord,
      operationReference,
      target: {
        type: 'issue',
        number: childIssue.number,
      },
    });
  }

  const runRecordDirectory = createLocalPrdRunRecordLocation({
    cwd: context.cwd,
    operationReference,
    targetNumber: childIssue.number,
    createdAt: recordedAt,
  }).directory;
  const stateRecord = await initializeLocalRunState({
    runRecordDirectory,
    operationReference,
    target: {
      type: 'issue',
      number: childIssue.number,
    },
    publicationMode: child.publicationMode ?? context.publicationMode ?? 'dry-run',
    createdAt: recordedAt,
    parentRun,
  });
  await recordLocalRunTerminalStatus({
    statePath: stateRecord.statePath,
    status: mapObservedLocalPrdChildStatusToTerminalStatus(child.status),
    summary: child.summary,
    phase: readObservedLocalPrdChildPhase(child, operationReference),
  });
  return stateRecord.runLink;
}

/**
 * @param {ChildAutomationResult} child
 * @returns {string}
 */
function readLocalPrdChildRunOperationReference(child) {
  if (typeof child.blockedOperation === 'string' && child.blockedOperation.trim() !== '') {
    return child.blockedOperation;
  }

  if (
    typeof child.nextOperation === 'string' &&
    isLocalChildPullRequestOperation(child.nextOperation)
  ) {
    return operationReferenceForPullRequestOperation(child.nextOperation);
  }

  if (child.pullRequest !== undefined) {
    return child.status === 'merged' || child.mergeMethod !== undefined
      ? 'pr:finalize'
      : 'pr:review';
  }

  return 'issue:implement';
}

/**
 * @param {string} status
 * @returns {import('../local-run-state/types.js').LocalRunTerminalStatus}
 */
function mapObservedLocalPrdChildStatusToTerminalStatus(status) {
  if (status === 'blocked' || status === 'human-required') {
    return 'blocked';
  }

  if (status === 'failed') {
    return 'failed';
  }

  if (status === 'refused') {
    return 'refused';
  }

  return 'accepted';
}

/**
 * @param {ChildAutomationResult} child
 * @param {string} operationReference
 * @returns {string}
 */
function readObservedLocalPrdChildPhase(child, operationReference) {
  if (typeof child.blockedPhase === 'string' && child.blockedPhase.trim() !== '') {
    return child.blockedPhase;
  }

  if (operationReference === 'pr:review') {
    return 'review';
  }

  if (operationReference === 'pr:address-review') {
    return 'address-review';
  }

  if (operationReference === 'pr:finalize') {
    return 'finalization';
  }

  return 'run';
}

/**
 * @param {object} options
 * @param {LocalRunRunLink | undefined} options.parentRun
 * @param {LocalRunRunLink} options.childRunLink
 * @param {Date} options.childRunStartedAt
 * @param {ChildAutomationResult} options.child
 * @param {string} options.summary
 * @returns {Promise<ChildAutomationResult>}
 */
async function blockPublishedLocalChildRun({
  parentRun,
  childRunLink,
  childRunStartedAt,
  child,
  summary,
}) {
  const blockedChild = {
    ...child,
    status: 'blocked',
    summary,
  };
  await recordLocalPrdChildRunState(parentRun, childRunLink, childRunStartedAt, blockedChild);
  return blockedChild;
}

/**
 * @param {OperationRunnerContext} context
 * @param {object} options
 * @param {ChildAutomationResult[]} options.children
 * @param {Set<number>} options.pendingIssueNumbers
 * @param {Set<number>} options.virtualCompletedIssueNumbers
 * @param {ChildAutomationResult} options.child
 * @returns {Promise<void>}
 */
async function recordLocalDryRunChildResult(
  context,
  { children, pendingIssueNumbers, virtualCompletedIssueNumbers, child },
) {
  await recordLocalPrdChildResult(context, children, child);
  pendingIssueNumbers.delete(child.issue.number);

  if (isLocalDryRunVirtualCompletion(child)) {
    virtualCompletedIssueNumbers.add(child.issue.number);
  }
}

/**
 * @param {OperationRunnerContext} context
 * @param {object} options
 * @param {GitHubIssue} options.parentIssue
 * @param {string} options.parentBranchName
 * @param {GitHubIssue} options.childIssue
 * @param {{ decision: ChildDependencyDecision }} options.dependencyFacts
 * @returns {Promise<ChildAutomationResult | undefined>}
 */
async function readAlreadyIntegratedLocalDryRunChild(
  context,
  { parentIssue, parentBranchName, childIssue, dependencyFacts },
) {
  if (context.gitClient.hasUnappliedCommitsSinceBase === undefined) {
    return undefined;
  }

  const childBranchName = createIssueBranchName({
    branchPrefix: context.config.branchPrefix,
    parentNumber: parentIssue.number,
    issueNumber: childIssue.number,
  });
  const hasUnappliedCommits = await context.gitClient.hasUnappliedCommitsSinceBase({
    branchName: childBranchName,
    baseBranch: parentBranchName,
    preferLocalBase: true,
  });
  if (hasUnappliedCommits) {
    return undefined;
  }

  return childResult({
    issue: childIssue,
    status: 'dry-run-completed',
    summary: [
      `Child issue #${childIssue.number} already has no unapplied commits relative to`,
      `${parentBranchName}; treating it as completed for local PRD auto-complete.`,
    ].join(' '),
    extra: {
      branch: childBranchName,
      publicationMode: 'dry-run',
      ...createDependencyDecisionExtra(dependencyFacts.decision),
    },
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {object} options
 * @param {GitHubIssue} options.parentIssue
 * @param {string} options.parentBranchName
 * @param {LocalRunRunLink} options.parentRun
 * @param {GitHubIssue} options.childIssue
 * @param {PrdAutomationMode} options.mode
 * @param {'dry-run' | 'publish'} options.publicationMode
 * @param {ChildIssueRunner} options.runChildIssue
 * @param {(request: PullRequestOperationRequest) => Promise<Record<string, unknown>>} [options.runChildPullRequestOperation]
 * @param {{ decision: ChildDependencyDecision, blockingDependencies: GitHubIssue[] }} [options.dependencyFacts]
 * @returns {Promise<{ child: ChildAutomationResult, stop: boolean, restorePrdBase: boolean }>}
 */
async function coordinateLocalChildIssue(
  context,
  {
    parentIssue,
    parentBranchName,
    parentRun,
    childIssue,
    mode,
    publicationMode,
    runChildIssue,
    runChildPullRequestOperation,
    dependencyFacts,
  },
) {
  if (childIssue.state !== 'OPEN') {
    return localChildAutomation({
      child: childResult({
        issue: childIssue,
        status: 'closed',
        summary: `Child issue #${childIssue.number} is closed.`,
      }),
    });
  }

  const parentIssueNumber = getNativeParentIssueNumber(childIssue);
  if (parentIssueNumber !== parentIssue.number) {
    return localChildAutomation({
      child: childResult({
        issue: childIssue,
        status: 'skipped',
        summary: `Issue #${childIssue.number} is not part of PRD issue #${parentIssue.number}.`,
      }),
    });
  }

  const resolvedDependencyFacts =
    dependencyFacts ??
    (await readChildDependencyDecision(context, {
      issue: childIssue,
      virtualCompletedIssueNumbers: new Set(),
    }));
  const { blockingDependencies } = resolvedDependencyFacts;
  if (blockingDependencies.length > 0) {
    const child = childResult({
      issue: childIssue,
      status: 'blocked',
      summary: `Child issue #${childIssue.number} is blocked by ${formatIssueNumbers(
        blockingDependencies,
      )}.`,
      extra: withDependencyDecision(
        {
          blockedBy: blockingDependencies.map(issue => issue.number),
        },
        resolvedDependencyFacts.decision,
      ),
    });
    await recordObservedLocalPrdChildRun(context, {
      parentRun,
      childIssue,
      child,
    });
    return localChildAutomation({
      child,
    });
  }

  const dependencyDecisionExtra = createDependencyDecisionExtra(resolvedDependencyFacts.decision);

  const childBranchName = createIssueBranchName({
    branchPrefix: context.config.branchPrefix,
    parentNumber: parentIssue.number,
    issueNumber: childIssue.number,
  });
  const pullRequest = await context.githubClient.findOpenPullRequestByHead(childBranchName);

  if (pullRequest !== undefined) {
    const child =
      mode === 'auto-complete'
        ? await coordinateLocalChildPullRequest(context, {
            childIssue,
            parentIssue,
            parentBranchName,
            parentRun,
            pullRequest,
            publicationMode,
            runChildPullRequestOperation,
          })
        : inspectLocalChildPullRequest({
            childIssue,
            parentBranchName,
            pullRequest,
          });
    const observedChild = {
      ...child,
      ...dependencyDecisionExtra,
    };
    await recordObservedLocalPrdChildRun(context, {
      parentRun,
      childIssue,
      child: observedChild,
    });

    return localChildAutomation({
      child: observedChild,
      stop: child.status === 'blocked',
      restorePrdBase: publicationMode === 'publish',
    });
  }

  if (hasAnyLabel(childIssue.labels, ACTIVE_CHILD_ISSUE_LABELS)) {
    const child = childResult({
      issue: childIssue,
      status: 'already-active',
      summary: `Child issue #${childIssue.number} already has active PullOps issue automation.`,
      extra: {
        labels: childIssue.labels,
        ...dependencyDecisionExtra,
      },
    });
    await recordObservedLocalPrdChildRun(context, {
      parentRun,
      childIssue,
      child,
    });
    return localChildAutomation({
      child,
    });
  }

  if (childIssue.labels.includes(PULL_OPS_STATUS_LABELS.humanRequired)) {
    const child = childResult({
      issue: childIssue,
      status: 'human-required',
      summary: `Child issue #${childIssue.number} needs human attention before PullOps automation can continue.`,
      extra: {
        labels: childIssue.labels,
        ...dependencyDecisionExtra,
      },
    });
    await recordObservedLocalPrdChildRun(context, {
      parentRun,
      childIssue,
      child,
    });
    return localChildAutomation({
      child,
    });
  }

  const childRunStartedAt = new Date();
  const childRunLocation = createLocalPrdRunRecordLocation({
    cwd: context.cwd,
    operationReference: 'issue:implement',
    targetNumber: childIssue.number,
  });
  const childRunLink = createLocalRunLink({
    runRecordDirectory: childRunLocation.directory,
    operationReference: 'issue:implement',
    target: {
      type: 'issue',
      number: childIssue.number,
    },
    statePath: join(childRunLocation.directory, 'state.json'),
  });
  if (parentRun !== undefined) {
    await recordLocalRunChildRun({
      statePath: parentRun.statePath,
      childRun: {
        ...childRunLink,
        status: 'running',
        startedAt: childRunStartedAt.toISOString(),
        updatedAt: childRunStartedAt.toISOString(),
        summary: `Started implementation for child issue #${childIssue.number}.`,
      },
    });
  }

  const progressReporter = createLocalPrdAutoCompleteChildProgressReporter(context, childIssue);
  /** @type {Record<string, unknown>} */
  let output;
  try {
    output = await runChildIssue(childIssue.number, {
      virtualCompletedIssueNumbers: resolvedDependencyFacts.decision.satisfiedByVirtualCompletions,
      ...(progressReporter === undefined ? {} : { progress: progressReporter.progress }),
      localRunRecordDirectory: childRunLocation.directory,
      parentRun,
    });
  } catch (error) {
    await progressReporter?.flush();
    if (parentRun !== undefined) {
      await recordLocalPrdChildRunState(parentRun, childRunLink, childRunStartedAt, {
        status: 'failed',
        summary: getErrorMessage(error),
      });
    }
    throw error;
  }
  await progressReporter?.flush();
  const status =
    output.status === 'blocked' ? 'blocked' : localImplementedChildStatus(publicationMode);
  const child = childResult({
    issue: childIssue,
    status,
    summary: String(output.summary),
    extra: {
      branch: readOutputBranch(output, childBranchName),
      pullRequest: readOutputPullRequest(output),
      localRunRecord: readOutputString(output, 'localRunRecord'),
      publicationMode,
      ...readOutputBlocker(output),
      ...dependencyDecisionExtra,
    },
  });

  if (mode === 'auto-complete' && publicationMode === 'dry-run' && output.status !== 'blocked') {
    const integrated = await integrateLocalDryRunChildBranch(context, {
      parentBranchName,
      childIssue,
      childBranchName: child.branch ?? childBranchName,
      output,
      localRunRecord: child.localRunRecord,
    });
    const finalChild = {
      ...integrated,
      ...dependencyDecisionExtra,
    };
    if (parentRun !== undefined) {
      await recordLocalPrdChildRunState(parentRun, childRunLink, childRunStartedAt, finalChild);
    }
    return localChildAutomation({
      child: finalChild,
      stop: integrated.status === 'blocked',
      restorePrdBase: true,
    });
  }

  if (mode === 'auto-complete' && publicationMode === 'publish' && output.status !== 'blocked') {
    const pullRequest = await context.githubClient.findOpenPullRequestByHead(childBranchName);
    if (pullRequest === undefined) {
      return localChildAutomation({
        child: await blockPublishedLocalChildRun({
          parentRun,
          childRunLink,
          childRunStartedAt,
          child,
          summary: [
            `Child issue #${childIssue.number} was published,`,
            'but PullOps could not find its open Child Issue PR for integration.',
          ].join(' '),
        }),
        stop: true,
        restorePrdBase: true,
      });
    }

    const integrated = await coordinateLocalChildPullRequest(context, {
      childIssue,
      parentIssue,
      parentBranchName,
      parentRun,
      pullRequest,
      publicationMode,
      runChildPullRequestOperation,
    });
    const finalChild = {
      ...integrated,
      ...(integrated.localRunRecord === undefined && child.localRunRecord !== undefined
        ? { localRunRecord: child.localRunRecord }
        : {}),
      publicationMode,
      ...dependencyDecisionExtra,
    };
    if (parentRun !== undefined) {
      await recordLocalPrdChildRunState(parentRun, childRunLink, childRunStartedAt, finalChild);
    }
    return localChildAutomation({
      child: finalChild,
      stop: integrated.status === 'blocked',
      restorePrdBase: true,
    });
  }

  if (parentRun !== undefined) {
    await recordLocalPrdChildRunState(parentRun, childRunLink, childRunStartedAt, child);
  }
  return localChildAutomation({
    child,
    stop: output.status === 'blocked',
    restorePrdBase: publicationMode === 'publish',
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {object} options
 * @param {string} options.parentBranchName
 * @param {GitHubIssue} options.childIssue
 * @param {string} options.childBranchName
 * @param {Record<string, unknown>} options.output
 * @param {string | undefined} options.localRunRecord
 * @returns {Promise<ChildAutomationResult>}
 */
async function integrateLocalDryRunChildBranch(
  context,
  { parentBranchName, childIssue, childBranchName, output, localRunRecord },
) {
  if (context.gitClient.cherryPickCommitOntoBranch === undefined) {
    return childResult({
      issue: childIssue,
      status: 'blocked',
      summary: 'Git client cannot locally integrate finalized child dry-run branches.',
      extra: {
        branch: childBranchName,
        publicationMode: 'dry-run',
        ...(localRunRecord === undefined ? {} : { localRunRecord }),
        blockedPhase: 'integration',
      },
    });
  }

  const finalizedHeadSha = await readLocalDryRunChildFinalizedHeadSha(context, {
    childBranchName,
    output,
  });
  if (finalizedHeadSha === undefined) {
    return childResult({
      issue: childIssue,
      status: 'blocked',
      summary: `Child issue #${childIssue.number} completed locally, but PullOps could not identify the finalized child branch head.`,
      extra: {
        branch: childBranchName,
        publicationMode: 'dry-run',
        ...(localRunRecord === undefined ? {} : { localRunRecord }),
        blockedPhase: 'integration',
      },
    });
  }

  const integration = await context.gitClient.cherryPickCommitOntoBranch({
    branchName: parentBranchName,
    baseBranch: context.config.baseBranch,
    commitSha: finalizedHeadSha,
    committer: GITHUB_ACTIONS_BOT_AUTHOR,
  });

  if (integration.status === 'conflicts') {
    return childResult({
      issue: childIssue,
      status: 'blocked',
      summary: `Child issue #${childIssue.number} could not be merged locally into ${parentBranchName} without conflicts.`,
      extra: {
        branch: childBranchName,
        publicationMode: 'dry-run',
        ...(localRunRecord === undefined ? {} : { localRunRecord }),
        mergeMethod: 'local-cherry-pick',
        conflictedFiles: integration.conflictedFiles,
        blockedPhase: 'integration',
      },
    });
  }

  return childResult({
    issue: childIssue,
    status: 'merged',
    summary: `Merged finalized local dry-run child issue #${childIssue.number} into ${parentBranchName}.`,
    extra: {
      branch: childBranchName,
      publicationMode: 'dry-run',
      ...(localRunRecord === undefined ? {} : { localRunRecord }),
      mergeMethod: 'local-cherry-pick',
      finalizedHeadSha,
      headSha: integration.headSha,
      treeHash: integration.treeHash,
    },
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {{ childBranchName: string, output: Record<string, unknown> }} options
 * @returns {Promise<string | undefined>}
 */
async function readLocalDryRunChildFinalizedHeadSha(context, { childBranchName, output }) {
  const prFinalize = readRecordProperty(output, 'prFinalize');
  const finalizedHead = prFinalize?.finalizedHead;
  if (typeof finalizedHead === 'string' && finalizedHead.trim() !== '') {
    return finalizedHead;
  }

  const currentBranch = await context.gitClient.getCurrentBranch?.();
  if (currentBranch !== undefined && currentBranch !== childBranchName) {
    return undefined;
  }

  return await context.gitClient.getCurrentHeadSha();
}

/**
 * @param {GitHubIssue} childIssue
 * @param {{ decision: ChildDependencyDecision, blockingDependencies: GitHubIssue[] }} dependencyFacts
 * @returns {ChildAutomationResult}
 */
function blockedByDependencyChildResult(childIssue, dependencyFacts) {
  const { blockingDependencies } = dependencyFacts;
  return childResult({
    issue: childIssue,
    status: 'blocked',
    summary: `Child issue #${childIssue.number} is blocked by ${formatIssueNumbers(
      blockingDependencies,
    )}.`,
    extra: withDependencyDecision(
      {
        blockedBy: blockingDependencies.map(issue => issue.number),
      },
      dependencyFacts.decision,
    ),
  });
}

/**
 * @param {GitHubIssue} childIssue
 * @param {ChildAutomationResult | undefined} localBlocker
 * @returns {ChildAutomationResult}
 */
function blockedByLocalAutoCompletePhaseResult(childIssue, localBlocker) {
  if (localBlocker === undefined) {
    return childResult({
      issue: childIssue,
      status: 'blocked',
      summary: `Child issue #${childIssue.number} was not reachable during local PRD auto-complete.`,
    });
  }

  return childResult({
    issue: childIssue,
    status: 'blocked',
    summary: `Child issue #${childIssue.number} was not started because local PRD auto-complete stopped at child issue #${localBlocker.issue.number}.`,
    extra: { blockedBy: [localBlocker.issue.number] },
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {object} options
 * @param {GitHubIssue} options.issue
 * @param {ReadonlySet<number>} options.virtualCompletedIssueNumbers
 * @returns {Promise<{ decision: ChildDependencyDecision, blockingDependencies: GitHubIssue[] }>}
 */
async function readChildDependencyDecision(context, { issue, virtualCompletedIssueNumbers }) {
  const dependencyNumbers = parseIssueDependencies(issue.body).blockedBy;
  /** @type {number[]} */
  const satisfiedByClosedIssues = [];
  /** @type {number[]} */
  const satisfiedByVirtualCompletions = [];
  /** @type {GitHubIssue[]} */
  const blockingDependencies = [];

  for (const dependencyNumber of dependencyNumbers) {
    const dependency = await context.githubClient.getIssue(dependencyNumber);
    if (isIssueDone(dependency)) {
      satisfiedByClosedIssues.push(dependencyNumber);
      continue;
    }

    if (virtualCompletedIssueNumbers.has(dependencyNumber)) {
      satisfiedByVirtualCompletions.push(dependencyNumber);
      continue;
    }

    blockingDependencies.push(dependency);
  }

  const remainingBlockedBy = blockingDependencies.map(dependency => dependency.number);
  return {
    decision: {
      blockedBy: dependencyNumbers,
      satisfiedByClosedIssues,
      satisfiedByVirtualCompletions,
      remainingBlockedBy,
    },
    blockingDependencies,
  };
}

/**
 * @param {Partial<ChildAutomationResult>} extra
 * @param {ChildDependencyDecision} decision
 * @returns {Partial<ChildAutomationResult>}
 */
function withDependencyDecision(extra, decision) {
  return {
    ...extra,
    ...createDependencyDecisionExtra(decision),
  };
}

/**
 * @param {ChildDependencyDecision} decision
 * @returns {Partial<ChildAutomationResult>}
 */
function createDependencyDecisionExtra(decision) {
  return decision.blockedBy.length === 0 ? {} : { dependencyDecision: decision };
}

/**
 * @param {ChildAutomationResult} child
 * @returns {boolean}
 */
function isLocalDryRunVirtualCompletion(child) {
  return child.status === 'dry-run-completed' || child.status === 'merged';
}

/**
 * @param {object} options
 * @param {GitHubIssue} options.childIssue
 * @param {string} options.parentBranchName
 * @param {GitHubPullRequest} options.pullRequest
 * @returns {ChildAutomationResult}
 */
function inspectLocalChildPullRequest({ childIssue, parentBranchName, pullRequest }) {
  if (pullRequest.baseRefName !== parentBranchName) {
    return childPullRequestResult({
      issue: childIssue,
      pullRequest,
      status: 'skipped',
      summary: `Child PR #${pullRequest.number} does not target ${parentBranchName}.`,
    });
  }

  const state = readManagedPrState(pullRequest.body);
  if (!state.managed || state.sourceIssueNumber !== childIssue.number) {
    return childPullRequestResult({
      issue: childIssue,
      pullRequest,
      status: 'skipped',
      summary: `Child PR #${pullRequest.number} is not the PullOps-managed PR for child issue #${childIssue.number}.`,
    });
  }

  return childPullRequestResult({
    issue: childIssue,
    pullRequest,
    status: isFinalizedForRebase(state) ? 'ready-for-human-merge' : 'waiting',
    summary: isFinalizedForRebase(state)
      ? `Child PR #${pullRequest.number} is finalized for human merge.`
      : `Child PR #${pullRequest.number} is waiting for human review or merge gates.`,
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {object} options
 * @param {GitHubIssue} options.childIssue
 * @param {GitHubIssue} options.parentIssue
 * @param {string} options.parentBranchName
 * @param {LocalRunRunLink | undefined} options.parentRun
 * @param {GitHubPullRequest} options.pullRequest
 * @param {'dry-run' | 'publish'} options.publicationMode
 * @param {(request: PullRequestOperationRequest) => Promise<Record<string, unknown>>} [options.runChildPullRequestOperation]
 * @returns {Promise<ChildAutomationResult>}
 */
async function coordinateLocalChildPullRequest(
  context,
  {
    childIssue,
    parentIssue,
    parentBranchName,
    parentRun,
    pullRequest,
    publicationMode,
    runChildPullRequestOperation,
  },
) {
  if (pullRequest.baseRefName !== parentBranchName) {
    return childPullRequestResult({
      issue: childIssue,
      pullRequest,
      status: 'skipped',
      summary: `Child PR #${pullRequest.number} does not target ${parentBranchName}.`,
    });
  }

  const state = readManagedPrState(pullRequest.body);
  if (!state.managed || state.sourceIssueNumber !== childIssue.number) {
    return childPullRequestResult({
      issue: childIssue,
      pullRequest,
      status: 'skipped',
      summary: `Child PR #${pullRequest.number} is not the PullOps-managed PR for child issue #${childIssue.number}.`,
    });
  }

  if (!isFinalizedForRebase(state)) {
    if (publicationMode === 'publish' && runChildPullRequestOperation !== undefined) {
      return await continuePublishedLocalChildPullRequest(context, {
        childIssue,
        parentIssue,
        parentBranchName,
        parentRun,
        pullRequest,
        runChildPullRequestOperation,
      });
    }

    return childPullRequestResult({
      issue: childIssue,
      pullRequest,
      status: 'waiting',
      summary: `Child PR #${pullRequest.number} is waiting for human review or merge gates.`,
    });
  }

  return await mergeFinalizedChildPullRequestLocally(context, {
    childIssue,
    parentIssue,
    parentBranchName,
    pullRequest,
    finalizedHeadSha: state.finalizedHeadSha,
    publicationMode,
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {object} options
 * @param {GitHubIssue} options.childIssue
 * @param {GitHubIssue} options.parentIssue
 * @param {string} options.parentBranchName
 * @param {LocalRunRunLink | undefined} options.parentRun
 * @param {GitHubPullRequest} options.pullRequest
 * @param {(request: PullRequestOperationRequest) => Promise<Record<string, unknown>>} options.runChildPullRequestOperation
 * @returns {Promise<ChildAutomationResult>}
 */
async function continuePublishedLocalChildPullRequest(
  context,
  {
    childIssue,
    parentIssue,
    parentBranchName,
    parentRun,
    pullRequest,
    runChildPullRequestOperation,
  },
) {
  /** @type {GitHubPullRequest} */
  let currentPullRequest = pullRequest;
  /** @type {string | undefined} */
  let latestLocalRunRecord;

  for (let iteration = 0; iteration < 8; iteration += 1) {
    const nextOperation = selectLocalChildPullRequestOperation(currentPullRequest);
    if (nextOperation === undefined) {
      break;
    }

    if (!isLocalChildPullRequestOperation(nextOperation)) {
      return childPullRequestResult({
        issue: childIssue,
        pullRequest: currentPullRequest,
        status: 'blocked',
        summary: `Child PR #${currentPullRequest.number} needs ${nextOperation} before local auto-complete can continue.`,
        extra: {
          nextOperation,
          blockedPhase: 'pull-request-automation',
          blockedOperation: nextOperation,
        },
      });
    }

    const output = await runChildPullRequestOperation({
      pullRequestNumber: currentPullRequest.number,
      operation: nextOperation,
      ...(parentRun === undefined ? {} : { parentRun }),
    });
    latestLocalRunRecord = readOutputString(output, 'localRunRecord') ?? latestLocalRunRecord;
    if (output.status === 'blocked' || output.status === 'refused') {
      const blockedPhase =
        readOutputString(output, 'blockedPhase') ?? phaseForPullRequestOperation(nextOperation);
      const blockedOperation =
        readOutputString(output, 'blockedOperation') ??
        operationReferenceForPullRequestOperation(nextOperation);
      return withChildLocalRunRecord(
        childPullRequestResult({
          issue: childIssue,
          pullRequest: currentPullRequest,
          status: 'blocked',
          summary: String(
            output.summary ?? `Child PR #${currentPullRequest.number} could not continue.`,
          ),
          extra: {
            nextOperation,
            blockedPhase,
            blockedOperation,
          },
        }),
        latestLocalRunRecord,
      );
    }

    const finalized = readRecordProperty(output, 'prFinalize');
    if (finalized?.waiting === true) {
      return withChildLocalRunRecord(
        childPullRequestResult({
          issue: childIssue,
          pullRequest: currentPullRequest,
          status: 'waiting',
          summary: String(
            output.summary ??
              `Child PR #${currentPullRequest.number} is waiting for finalized-head checks.`,
          ),
          extra: {
            nextOperation,
            blockedPhase: 'checks',
            blockedOperation: 'pr:finalize',
          },
        }),
        latestLocalRunRecord,
      );
    }

    currentPullRequest = await context.githubClient.getPullRequest(currentPullRequest.number);
    const state = readManagedPrState(currentPullRequest.body);
    if (isFinalizedForRebase(state)) {
      return withChildLocalRunRecord(
        await mergeFinalizedChildPullRequestLocally(context, {
          childIssue,
          parentIssue,
          parentBranchName,
          pullRequest: currentPullRequest,
          finalizedHeadSha: state.finalizedHeadSha,
          publicationMode: 'publish',
        }),
        latestLocalRunRecord,
      );
    }
  }

  const state = readManagedPrState(currentPullRequest.body);
  if (isFinalizedForRebase(state)) {
    return withChildLocalRunRecord(
      await mergeFinalizedChildPullRequestLocally(context, {
        childIssue,
        parentIssue,
        parentBranchName,
        pullRequest: currentPullRequest,
        finalizedHeadSha: state.finalizedHeadSha,
        publicationMode: 'publish',
      }),
      latestLocalRunRecord,
    );
  }

  return withChildLocalRunRecord(
    childPullRequestResult({
      issue: childIssue,
      pullRequest: currentPullRequest,
      status: 'waiting',
      summary: `Child PR #${currentPullRequest.number} is waiting for human review or merge gates.`,
      extra: {
        blockedPhase: 'review',
        blockedOperation: 'pr:review',
      },
    }),
    latestLocalRunRecord,
  );
}

/**
 * @param {object} options
 * @param {ChildAutomationResult} options.child
 * @param {boolean} [options.stop]
 * @param {boolean} [options.restorePrdBase]
 * @returns {{ child: ChildAutomationResult, stop: boolean, restorePrdBase: boolean }}
 */
function localChildAutomation({ child, stop = false, restorePrdBase = false }) {
  return { child, stop, restorePrdBase };
}

/**
 * @param {ChildAutomationResult} child
 * @returns {boolean}
 */
function shouldPreserveInspectableBranchState(child) {
  return child.status === 'blocked' && (child.conflictedFiles?.length ?? 0) > 0;
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
    return childPullRequestResult({
      issue: childIssue,
      pullRequest,
      status: 'skipped',
      summary: `Child PR #${pullRequest.number} does not target ${parentBranchName}.`,
    });
  }

  const state = readManagedPrState(pullRequest.body);
  if (!state.managed || state.sourceIssueNumber !== childIssue.number) {
    return childPullRequestResult({
      issue: childIssue,
      pullRequest,
      status: 'skipped',
      summary: `Child PR #${pullRequest.number} is not the PullOps-managed PR for child issue #${childIssue.number}.`,
    });
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
    return childPullRequestResult({
      issue: childIssue,
      pullRequest,
      status: 'resumed',
      summary: `Resumed child PR #${pullRequest.number} with ${workflow.nextOperation}.`,
      extra: { nextOperation: workflow.nextOperation },
    });
  }

  if (workflow.status === 'already-active') {
    return childPullRequestResult({
      issue: childIssue,
      pullRequest,
      status: 'already-active',
      summary: `Child PR #${pullRequest.number} already has active PullOps PR automation.`,
      extra: { labels: workflow.labels ?? [] },
    });
  }

  return childPullRequestResult({
    issue: childIssue,
    pullRequest,
    status: isFinalizedForRebase(state) ? 'ready-for-human-merge' : 'waiting',
    summary: isFinalizedForRebase(state)
      ? `Child PR #${pullRequest.number} is finalized for human merge.`
      : `Child PR #${pullRequest.number} is waiting for human attention.`,
  });
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
    return childPullRequestResult({
      issue: childIssue,
      pullRequest,
      status: 'blocked',
      summary: 'GitHub client cannot merge pull requests.',
    });
  }

  if (pullRequest.isDraft) {
    return childPullRequestResult({
      issue: childIssue,
      pullRequest,
      status: 'waiting',
      summary: `Child PR #${pullRequest.number} is still a draft.`,
    });
  }

  const checks = await context.githubClient.getPullRequestChecksForRef(finalizedHeadSha);
  const checkState = classifyCheckState(checks);
  if (checkState === 'pending') {
    return childPullRequestResult({
      issue: childIssue,
      pullRequest,
      status: 'waiting',
      summary: `Child PR #${pullRequest.number} is waiting for finalized-head checks.`,
      extra: { checks: checks.length },
    });
  }

  if (checkState === 'failed') {
    await context.githubClient.addLabelsToPullRequest({
      number: pullRequest.number,
      labels: [PULL_OPS_OPERATION_LABELS.prFixCi],
    });
    return childPullRequestResult({
      issue: childIssue,
      pullRequest,
      status: 'routed-to-ci-repair',
      summary: `Child PR #${pullRequest.number} finalized-head checks failed; routed to CI repair.`,
      extra: { checks: checks.length },
    });
  }

  await context.githubClient.mergePullRequest({
    number: pullRequest.number,
    method: 'rebase',
  });

  return childPullRequestResult({
    issue: childIssue,
    pullRequest,
    status: 'merged',
    summary: `Merged finalized child PR #${pullRequest.number} into PRD issue #${parentIssue.number}.`,
    extra: { mergeMethod: 'rebase' },
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {object} options
 * @param {GitHubIssue} options.childIssue
 * @param {GitHubIssue} options.parentIssue
 * @param {string} options.parentBranchName
 * @param {GitHubPullRequest} options.pullRequest
 * @param {string} options.finalizedHeadSha
 * @param {'dry-run' | 'publish'} options.publicationMode
 * @returns {Promise<ChildAutomationResult>}
 */
async function mergeFinalizedChildPullRequestLocally(
  context,
  { childIssue, parentIssue, parentBranchName, pullRequest, finalizedHeadSha, publicationMode },
) {
  if (context.gitClient.cherryPickCommitOntoBranch === undefined) {
    return childPullRequestResult({
      issue: childIssue,
      pullRequest,
      status: 'blocked',
      summary: 'Git client cannot locally integrate finalized child pull requests.',
      extra: {
        blockedPhase: 'integration',
      },
    });
  }

  if (pullRequest.isDraft) {
    return childPullRequestResult({
      issue: childIssue,
      pullRequest,
      status: 'waiting',
      summary: `Child PR #${pullRequest.number} is still a draft.`,
      extra: {
        blockedPhase: 'review',
        blockedOperation: 'pr:review',
      },
    });
  }

  const checks = await context.githubClient.getPullRequestChecksForRef(finalizedHeadSha);
  const checkState = classifyCheckState(checks);
  if (checkState === 'pending') {
    return childPullRequestResult({
      issue: childIssue,
      pullRequest,
      status: 'waiting',
      summary: `Child PR #${pullRequest.number} is waiting for finalized-head checks.`,
      extra: { checks: checks.length, blockedPhase: 'checks', blockedOperation: 'pr:finalize' },
    });
  }

  if (checkState === 'failed') {
    return childPullRequestResult({
      issue: childIssue,
      pullRequest,
      status: 'blocked',
      summary: `Child PR #${pullRequest.number} finalized-head checks failed; repair CI before local auto-complete can merge it.`,
      extra: { checks: checks.length, blockedPhase: 'checks', blockedOperation: 'pr:finalize' },
    });
  }

  const integration = await context.gitClient.cherryPickCommitOntoBranch({
    branchName: parentBranchName,
    baseBranch: context.config.baseBranch,
    commitSha: finalizedHeadSha,
    committer: GITHUB_ACTIONS_BOT_AUTHOR,
  });

  if (integration.status === 'conflicts') {
    return childPullRequestResult({
      issue: childIssue,
      pullRequest,
      status: 'blocked',
      summary: `Child PR #${pullRequest.number} could not be merged locally into ${parentBranchName} without conflicts.`,
      extra: {
        mergeMethod: 'local-cherry-pick',
        conflictedFiles: integration.conflictedFiles,
        blockedPhase: 'integration',
      },
    });
  }

  if (publicationMode === 'publish') {
    const pushResult = await context.gitClient.pushBranchWithLease({
      branchName: parentBranchName,
    });
    if (pushResult.status === 'stale-lease') {
      return childPullRequestResult({
        issue: childIssue,
        pullRequest,
        status: 'blocked',
        summary: `Remote branch ${parentBranchName} changed while local auto-complete was merging child PR #${pullRequest.number}.`,
        extra: { mergeMethod: 'local-cherry-pick', blockedPhase: 'integration' },
      });
    }

    await closeChildIssue(context, {
      issue: childIssue,
      pullRequest,
      expectedBaseBranch: parentBranchName,
    });
    await closeIntegratedChildPullRequest(context, { pullRequest });
    childIssue.state = 'CLOSED';
    markParentChildIssueReferenceClosed(parentIssue, childIssue.number);
  }

  return childPullRequestResult({
    issue: childIssue,
    pullRequest,
    status: 'merged',
    summary: `Merged finalized child PR #${pullRequest.number} locally into PRD issue #${parentIssue.number}.`,
    extra: {
      mergeMethod: 'local-cherry-pick',
      finalizedHeadSha,
      headSha: integration.headSha,
      treeHash: integration.treeHash,
    },
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {{ pullRequest: GitHubPullRequest }} options
 * @returns {Promise<void>}
 */
async function closeIntegratedChildPullRequest(context, { pullRequest }) {
  if (context.githubClient.closePullRequest === undefined) {
    return;
  }

  await context.githubClient.closePullRequest({ number: pullRequest.number });
}

/**
 * @param {GitHubIssue} parentIssue
 * @param {number} childIssueNumber
 * @returns {void}
 */
function markParentChildIssueReferenceClosed(parentIssue, childIssueNumber) {
  parentIssue.subIssues = parentIssue.subIssues.map(childIssue =>
    childIssue.number === childIssueNumber
      ? {
          ...childIssue,
          state: 'CLOSED',
        }
      : childIssue,
  );
}

/**
 * @param {OperationRunnerContext} context
 * @param {{
 *   parentIssue?: GitHubIssue,
 *   parentIssueNumber: number,
 *   parentBranchName?: string,
 *   childIssues?: GitHubIssue[],
 *   requestReview?: boolean,
 * }} options
 * @returns {Promise<ParentReviewResult>}
 */
async function requestUmbrellaReviewIfComplete(
  context,
  { parentIssue, parentIssueNumber, parentBranchName, childIssues, requestReview = true },
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

  if (isFinalizedForRebase(readManagedPrState(pullRequest.body))) {
    return inspectManagedPrForLocalReview(pullRequest);
  }

  let reviewPullRequest = pullRequest;
  const nextLocalOperation = selectLocalParentPullRequestOperation(pullRequest);
  if (resolvedParentIssue !== undefined && nextLocalOperation === 'pr-review') {
    const refreshedBody = await createPrdPreparePullRequestBodyForIssue(context, {
      issue: resolvedParentIssue,
      branchName,
    });
    if (requestReview || context.publicationMode === 'publish') {
      await context.githubClient.updatePullRequestBody({
        number: pullRequest.number,
        body: refreshedBody,
      });
    }
    reviewPullRequest = {
      ...pullRequest,
      body: refreshedBody,
    };
  }

  if (!requestReview) {
    return inspectManagedPrForLocalReview(reviewPullRequest);
  }

  return await requestManagedPrReview({
    githubClient: context.githubClient,
    pullRequest: reviewPullRequest,
  });
}

/**
 * @param {GitHubPullRequest} pullRequest
 * @returns {ParentReviewResult}
 */
function inspectManagedPrForLocalReview(pullRequest) {
  if (hasActiveManagedPrWorkflow(pullRequest.labels)) {
    return {
      status: 'already-active',
      pullRequest: formatPullRequest(pullRequest),
      labels: pullRequest.labels ?? [],
    };
  }

  const state = readManagedPrState(pullRequest.body);
  if (!state.managed) {
    return {
      status: 'not-managed',
      pullRequest: formatPullRequest(pullRequest),
    };
  }

  if (isFinalizedForRebase(state)) {
    return {
      status: 'finalized',
      pullRequest: formatPullRequest(pullRequest),
    };
  }

  const nextOperation = selectLocalParentPullRequestOperation(pullRequest);
  if (nextOperation === 'pr-finalize') {
    return {
      status: 'ready-for-finalize',
      pullRequest: formatPullRequest(pullRequest),
      nextOperation: PULL_OPS_OPERATION_LABELS.prFinalize,
    };
  }

  if (nextOperation === 'pr-address-review') {
    return {
      status: 'ready-for-address-review',
      pullRequest: formatPullRequest(pullRequest),
      nextOperation: PULL_OPS_OPERATION_LABELS.prAddressReview,
    };
  }

  return {
    status: 'ready-for-review',
    pullRequest: formatPullRequest(pullRequest),
    nextOperation: PULL_OPS_OPERATION_LABELS.prReview,
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {{
 *   parentIssue: GitHubIssue,
 *   parentIssueNumber: number,
 *   parentBranchName: string,
 *   childIssues: GitHubIssue[],
 *   parentRun: LocalRunRunLink,
 *   runParentPullRequestOperation?: (request: PullRequestOperationRequest) => Promise<Record<string, unknown>>,
 * }} options
 * @returns {Promise<ParentReviewResult>}
 */
async function completePublishedLocalUmbrellaPullRequest(
  context,
  {
    parentIssue,
    parentIssueNumber,
    parentBranchName,
    childIssues,
    parentRun,
    runParentPullRequestOperation,
  },
) {
  const inspected = await requestUmbrellaReviewIfComplete(context, {
    parentIssue,
    parentIssueNumber,
    parentBranchName,
    childIssues,
    requestReview: false,
  });

  if (!isPublishedUmbrellaOperationReady(inspected.status)) {
    return inspected;
  }

  if (runParentPullRequestOperation === undefined) {
    return {
      ...inspected,
      status: 'blocked',
      summary: 'Local PRD auto-complete cannot run Umbrella PR review/finalize operations.',
    };
  }

  const pullRequestNumber = inspected.pullRequest?.number;
  if (pullRequestNumber === undefined) {
    return {
      ...inspected,
      status: 'blocked',
      summary: `Umbrella PR for parent issue #${parentIssueNumber} is ready, but its pull request number is unavailable.`,
    };
  }

  /** @type {Record<string, unknown> | undefined} */
  let review;
  /** @type {Record<string, unknown>[]} */
  const addressReviews = [];
  /** @type {string[]} */
  const localRunRecords = [];
  const parentPullRequestNumber = pullRequestNumber;
  const parentPullRequestOperationRunner = runParentPullRequestOperation;
  let parentOperationSteps = 0;

  /**
   * @param {PullRequestOperationName} operation
   * @returns {Promise<Record<string, unknown>>}
   */
  async function runTrackedParentPullRequestOperation(operation) {
    if (parentOperationSteps >= MAX_PUBLISHED_UMBRELLA_PARENT_OPERATION_STEPS) {
      return {
        status: 'blocked',
        summary: `Umbrella PR parent operation loop budget was exhausted for PR #${parentPullRequestNumber}.`,
      };
    }

    parentOperationSteps += 1;
    const output = await parentPullRequestOperationRunner({
      pullRequestNumber: parentPullRequestNumber,
      operation,
      parentRun,
    });
    recordParentOperationRunRecord(localRunRecords, output);
    return output;
  }

  /** @type {PullRequestOperationName} */
  let nextOperation =
    inspected.status === 'ready-for-address-review'
      ? 'pr-address-review'
      : inspected.status === 'ready-for-finalize'
        ? 'pr-finalize'
        : 'pr-review';
  /** @type {Record<string, unknown> | undefined} */
  let finalize;

  while (true) {
    const output = await runTrackedParentPullRequestOperation(nextOperation);
    if (output.status === 'blocked' || output.status === 'refused') {
      return completeBlockedPublishedUmbrellaPullRequest(inspected, {
        review,
        addressReviews,
        ...(nextOperation === 'pr-finalize' ? { finalize: output } : {}),
        localRunRecords,
        summary: String(
          output.summary ?? `Umbrella PR ${nextOperation} blocked on PR #${pullRequestNumber}.`,
        ),
      });
    }

    if (nextOperation === 'pr-address-review') {
      addressReviews.push(output);
      nextOperation = 'pr-review';
      continue;
    }

    if (nextOperation === 'pr-review') {
      review = output;
      if (review.reviewResult === 'approved') {
        nextOperation = 'pr-finalize';
        continue;
      }

      if (review.reviewResult === 'changes_requested') {
        nextOperation = 'pr-address-review';
        continue;
      }

      return completeBlockedPublishedUmbrellaPullRequest(inspected, {
        review,
        addressReviews,
        localRunRecords,
        summary: `Umbrella PR review did not approve PR #${pullRequestNumber}.`,
      });
    }

    finalize = output;
    const prFinalize = readRecordProperty(finalize, 'prFinalize');
    if (prFinalize?.waiting === true) {
      return {
        ...inspected,
        status: 'waiting',
        review,
        addressReviews,
        finalize,
        localRunRecords,
        nextOperation: PULL_OPS_OPERATION_LABELS.prFinalize,
      };
    }

    const routedOperation = readRoutedParentPullRequestOperation(prFinalize?.routedTo);
    if (routedOperation !== undefined) {
      nextOperation = routedOperation;
      continue;
    }

    if (typeof prFinalize?.routedTo === 'string') {
      return {
        ...inspected,
        status: 'blocked',
        summary: String(
          finalize.summary ?? `Umbrella PR finalization routed to ${prFinalize.routedTo}.`,
        ),
        review,
        addressReviews,
        finalize,
        localRunRecords,
        nextOperation: prFinalize.routedTo,
      };
    }

    return {
      ...inspected,
      status: 'finalized',
      review,
      addressReviews,
      finalize,
      localRunRecords,
    };
  }
}

/**
 * @param {unknown} routedTo
 * @returns {PullRequestOperationName | undefined}
 */
function readRoutedParentPullRequestOperation(routedTo) {
  if (
    routedTo === PULL_OPS_OPERATION_LABELS.prReview ||
    routedTo === 'pr:review' ||
    routedTo === 'pr-review'
  ) {
    return 'pr-review';
  }

  if (
    routedTo === PULL_OPS_OPERATION_LABELS.prAddressReview ||
    routedTo === 'pr:address-review' ||
    routedTo === 'pr-address-review'
  ) {
    return 'pr-address-review';
  }

  if (
    routedTo === PULL_OPS_OPERATION_LABELS.prFinalize ||
    routedTo === 'pr:finalize' ||
    routedTo === 'pr-finalize'
  ) {
    return 'pr-finalize';
  }

  return undefined;
}

/**
 * @param {ParentReviewResult} inspected
 * @param {{
 *   summary: string,
 *   review?: Record<string, unknown>,
 *   addressReviews: Record<string, unknown>[],
 *   finalize?: Record<string, unknown>,
 *   localRunRecords: string[],
 * }} options
 * @returns {ParentReviewResult}
 */
function completeBlockedPublishedUmbrellaPullRequest(
  inspected,
  { summary, review, addressReviews, finalize, localRunRecords },
) {
  return {
    ...inspected,
    status: 'blocked',
    summary,
    ...(review === undefined ? {} : { review }),
    addressReviews,
    ...(finalize === undefined ? {} : { finalize }),
    localRunRecords,
  };
}

/**
 * @param {string[]} localRunRecords
 * @param {Record<string, unknown>} output
 * @returns {void}
 */
function recordParentOperationRunRecord(localRunRecords, output) {
  const runRecord = readOutputString(output, 'localRunRecord');
  if (runRecord !== undefined) {
    localRunRecords.push(runRecord);
  }
}

/**
 * @param {ChildAutomationResult} child
 * @param {string | undefined} localRunRecord
 * @returns {ChildAutomationResult}
 */
function withChildLocalRunRecord(child, localRunRecord) {
  return localRunRecord === undefined ? child : { ...child, localRunRecord };
}

/**
 * @param {Record<string, unknown>} output
 * @param {string} key
 * @returns {Record<string, unknown> | undefined}
 */
function readRecordProperty(output, key) {
  const value = output[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  return /** @type {Record<string, unknown>} */ (value);
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

/** @type {ReadonlySet<'pr-review' | 'pr-address-review' | 'pr-finalize'>} */
const LOCAL_CHILD_PULL_REQUEST_OPERATIONS = new Set([
  'pr-review',
  'pr-address-review',
  'pr-finalize',
]);

/**
 * @param {string} operation
 * @returns {operation is 'pr-review' | 'pr-address-review' | 'pr-finalize'}
 */
function isLocalChildPullRequestOperation(operation) {
  return LOCAL_CHILD_PULL_REQUEST_OPERATIONS.has(
    /** @type {'pr-review' | 'pr-address-review' | 'pr-finalize'} */ (operation),
  );
}

/**
 * @param {GitHubPullRequest} pullRequest
 * @returns {string | undefined}
 */
function selectLocalChildPullRequestOperation(pullRequest) {
  const labels = pullRequest.labels ?? [];
  for (const label of labels) {
    if (STALE_STATUS_LABELS.has(label) || label === PULL_OPS_STATUS_LABELS.humanRequired) {
      continue;
    }

    if (
      label.startsWith('pullops:pr:') &&
      label !== PULL_OPS_OPERATION_LABELS.prReview &&
      label !== PULL_OPS_OPERATION_LABELS.prAddressReview &&
      label !== PULL_OPS_OPERATION_LABELS.prFinalize
    ) {
      return label;
    }
  }

  const state = readManagedPrState(pullRequest.body);
  if (isFinalizedForRebase(state)) {
    return undefined;
  }

  if (state.reviewedTreeHash !== undefined || state.status === 'Review approved') {
    return 'pr-finalize';
  }

  if (state.status === 'Changes requested') {
    return 'pr-address-review';
  }

  if (
    state.status === 'Review feedback addressed' ||
    state.status === 'Draft automation' ||
    state.lastOperation === PULL_OPS_OPERATION_LABELS.issueImplement ||
    state.lastOperation === PULL_OPS_OPERATION_LABELS.prAddressReview
  ) {
    return 'pr-review';
  }

  return undefined;
}

/**
 * @param {GitHubPullRequest} pullRequest
 * @returns {'pr-review' | 'pr-address-review' | 'pr-finalize' | undefined}
 */
function selectLocalParentPullRequestOperation(pullRequest) {
  const state = readManagedPrState(pullRequest.body);
  if (isFinalizedForRebase(state)) {
    return undefined;
  }

  if (state.reviewedTreeHash !== undefined || state.status === 'Review approved') {
    return 'pr-finalize';
  }

  if (state.status === 'Changes requested') {
    return 'pr-address-review';
  }

  if (
    state.status === 'Review feedback addressed' ||
    state.status === 'Review required' ||
    state.status === 'Draft parent preparation' ||
    state.lastOperation === PULL_OPS_OPERATION_LABELS.prdPrepare ||
    state.lastOperation === PULL_OPS_OPERATION_LABELS.prAddressReview
  ) {
    return 'pr-review';
  }

  return 'pr-review';
}

/**
 * @param {string} status
 * @returns {boolean}
 */
function isPublishedUmbrellaOperationReady(status) {
  return (
    status === 'ready-for-review' ||
    status === 'ready-for-address-review' ||
    status === 'ready-for-finalize'
  );
}

/**
 * @param {PullRequestOperationName} operation
 * @returns {'review' | 'address-review' | 'finalization'}
 */
function phaseForPullRequestOperation(operation) {
  if (operation === 'pr-review') {
    return 'review';
  }

  if (operation === 'pr-address-review') {
    return 'address-review';
  }

  return 'finalization';
}

/**
 * @param {PullRequestOperationName} operation
 * @returns {'pr:review' | 'pr:address-review' | 'pr:finalize'}
 */
function operationReferenceForPullRequestOperation(operation) {
  if (operation === 'pr-review') {
    return 'pr:review';
  }

  if (operation === 'pr-address-review') {
    return 'pr:address-review';
  }

  return 'pr:finalize';
}

/**
 * @param {object} options
 * @param {GitHubIssue} options.issue
 * @param {string} options.status
 * @param {string} options.summary
 * @param {Partial<ChildAutomationResult>} [options.extra]
 * @returns {ChildAutomationResult}
 */
function childResult({ issue, status, summary, extra = {} }) {
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
 * @param {object} options
 * @param {GitHubIssue} options.issue
 * @param {GitHubPullRequest} options.pullRequest
 * @param {string} options.status
 * @param {string} options.summary
 * @param {Partial<ChildAutomationResult>} [options.extra]
 * @returns {ChildAutomationResult}
 */
function childPullRequestResult({ issue, pullRequest, status, summary, extra = {} }) {
  return childResult({
    issue,
    status,
    summary,
    extra: {
      pullRequest: formatPullRequest(pullRequest),
      ...extra,
    },
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
 * @param {object} options
 * @param {PrdAutomationMode} options.mode
 * @param {GitHubIssue} options.parentIssue
 * @param {ChildAutomationResult[]} options.children
 * @param {'dry-run' | 'publish'} options.publicationMode
 * @returns {string}
 */
function summarizeLocalPrdAutomation({ mode, parentIssue, children, publicationMode }) {
  const dryRunCompleted = countChildrenByStatus(children, 'dry-run-completed');
  const published = countChildrenByStatus(children, 'published');
  const merged = countChildrenByStatus(children, 'merged');
  const blocked = countChildrenByStatus(children, 'blocked');
  const waiting = countChildrenByStatus(children, 'waiting');
  const readyForHumanMerge = countChildrenByStatus(children, 'ready-for-human-merge');
  const parts = [`Ran local PRD ${mode} for issue #${parentIssue.number}.`];

  if (publicationMode === 'dry-run') {
    parts.push(`${dryRunCompleted + merged} child issue dry-run(s) completed.`);
  } else {
    parts.push(`${published} child issue PR(s) published.`);
  }

  if (mode === 'auto-complete') {
    parts.push(
      publicationMode === 'dry-run'
        ? `${merged} finalized child branch(es) merged locally.`
        : `${merged} finalized child PR(s) merged locally.`,
    );
  }

  if (blocked > 0) {
    parts.push(`${blocked} child issue(s) blocked.`);
  }

  if (waiting > 0 || readyForHumanMerge > 0) {
    parts.push(`${waiting + readyForHumanMerge} child PR(s) left for human review or merge.`);
  }

  return parts.join(' ');
}

/**
 * @param {{ directory: string }} runRecord
 * @param {GitHubIssue} issue
 * @param {{
 *   reason: string,
 *   mode: PrdAutomationMode,
 *   publicationMode: 'dry-run' | 'publish',
 * }} options
 * @returns {Promise<PrdAutomationResult>}
 */
async function refuseLocalPrdAutomation(runRecord, issue, { reason, mode, publicationMode }) {
  const targetNumber = issue.parent?.number ?? issue.number;
  const operationReference = readLocalPrdOperationReference(mode);
  const nextStep = `Run PRD ${mode} on Parent Issue #${targetNumber} instead.`;
  await writeLocalPrdRunArtifact(runRecord, 'failure-reason.txt', `${reason}\n`);
  return {
    status: 'refused',
    summary: reason,
    displayMessage: reason,
    refusalReason: 'wrong-target',
    issue: issue.number,
    mode,
    publicationMode,
    nextSteps: [nextStep],
    suggestedActions: [
      {
        kind: 'command',
        description: nextStep,
        argv: [
          'pullops',
          'run',
          operationReference,
          String(targetNumber),
          ...(publicationMode === 'publish' ? ['--publish', 'pr'] : []),
        ],
        approvalRequired: false,
      },
    ],
  };
}

/**
 * @param {PrdAutomationMode} mode
 * @returns {'prd:auto-advance' | 'prd:auto-complete'}
 */
function readLocalPrdOperationReference(mode) {
  return mode === 'auto-complete' ? 'prd:auto-complete' : 'prd:auto-advance';
}

/**
 * @param {OperationRunnerContext} context
 * @param {{
 *   operationReference: 'prd:auto-advance' | 'prd:auto-complete',
 *   targetNumber: number,
 *   publicationMode: 'dry-run' | 'publish',
 * }} options
 * @returns {Promise<LocalRunRecord>}
 */
async function createLocalPrdRunRecord(
  context,
  { operationReference, targetNumber, publicationMode },
) {
  const normalizedReference = normalizeOperationReferenceForPath(operationReference);
  const createdAt = new Date();
  const directory =
    context.localRunRecordDirectory ??
    createLocalPrdRunRecordLocation({
      cwd: context.cwd,
      operationReference,
      targetNumber,
    }).directory;

  await mkdir(directory, { recursive: true });
  await writeLocalPrdRunArtifact(
    { directory },
    'metadata.json',
    `${JSON.stringify(
      {
        operationReference,
        normalizedOperationReference: normalizedReference,
        target: {
          type: context.target.type,
          number: targetNumber,
        },
        publicationMode,
        runGoal: context.runGoal ?? 'operation',
        createdAt: createdAt.toISOString(),
        heartbeatCommand: LOCAL_RUN_HEARTBEAT_COMMAND,
        heartbeatIntervalMs: DEFAULT_LOCAL_RUN_HEARTBEAT_INTERVAL_MS,
        leaseDurationMs: DEFAULT_LOCAL_RUN_LEASE_DURATION_MS,
      },
      null,
      2,
    )}\n`,
  );
  await context.progressEventWriter?.bindLocalRunRecord(directory);

  const stateRecord = await initializeLocalRunState({
    runRecordDirectory: directory,
    operationReference,
    target: {
      type: context.target.type,
      number: targetNumber,
    },
    publicationMode,
    runGoal: context.runGoal ?? 'operation',
    createdAt,
  });

  return {
    directory,
    statePath: stateRecord.statePath,
    heartbeatEnvironment: stateRecord.heartbeatEnvironment,
    runLink: stateRecord.runLink,
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {{ directory: string }} runRecord
 * @param {{
 *   operationReference: 'prd:auto-advance' | 'prd:auto-complete',
 *   parentIssueNumber: number,
 *   mode: PrdAutomationMode,
 *   publicationMode: 'dry-run' | 'publish',
 * }} options
 * @returns {Promise<void>}
 */
async function requireCleanLocalPrdWorktree(
  context,
  runRecord,
  { operationReference, parentIssueNumber, mode, publicationMode },
) {
  if (!(await context.gitClient.hasChanges())) {
    return;
  }

  const nextStep = 'Commit, stash, or discard existing changes and run PullOps again.';
  const reason = [
    `Local ${operationReference} requires a clean worktree before PullOps reads or mutates branch state.`,
    nextStep,
  ].join(' ');
  await writeLocalPrdRunArtifact(runRecord, 'failure-reason.txt', `${reason}\n`);
  throw createKnownLocalPrdRunBoundaryError({
    message: reason,
    localRunRecord: runRecord.directory,
    output: {
      status: 'refused',
      summary: reason,
      displayMessage: reason,
      refusalReason: 'dirty-worktree',
      issue: parentIssueNumber,
      mode,
      publicationMode,
      nextSteps: [nextStep],
      suggestedActions: [
        {
          kind: 'command',
          description: `Rerun PRD ${mode} after the worktree is clean.`,
          argv: [
            'pullops',
            'run',
            operationReference,
            String(parentIssueNumber),
            ...(publicationMode === 'publish' ? ['--publish', 'pr'] : []),
          ],
          approvalRequired: true,
          approvalReason:
            'Existing local changes require maintainer approval before rerunning PullOps.',
        },
      ],
    },
  });
}

/**
 * @param {LocalRunRecord} runRecord
 * @param {PrdAutomationResult} result
 * @returns {Promise<PrdAutomationResult>}
 */
async function completeLocalPrdRunRecord(runRecord, result) {
  const withRunRecord = {
    ...result,
    localRunRecord: runRecord.directory,
  };
  const terminalStatus = mapLocalRunResultStatusToTerminalStatus(
    /** @type {import('../local-run-state/types.js').LocalRunResultStatus} */ (result.status),
  );
  const terminalSummary = result.summary;

  await writeLocalPrdRunArtifact(
    runRecord,
    'result.json',
    `${JSON.stringify(withRunRecord, null, 2)}\n`,
  );
  await recordLocalRunTerminalStatus({
    statePath: runRecord.statePath,
    status: terminalStatus,
    summary: terminalSummary,
    phase: 'run',
  });
  return withRunRecord;
}

/**
 * @param {OperationRunnerContext} context
 * @param {number} parentIssueNumber
 * @returns {Promise<void>}
 */
async function emitLocalPrdAutoCompleteRunStarted(context, parentIssueNumber) {
  if (context.progressEventWriter === undefined) {
    return;
  }

  await context.progressEventWriter.emit('run.started', {
    phase: 'run',
    message: `Starting local PRD auto-complete for issue #${parentIssueNumber}.`,
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {number} parentIssueNumber
 * @returns {Promise<void>}
 */
async function emitLocalPrdAutoCompletePhaseStarted(context, parentIssueNumber) {
  if (context.progressEventWriter === undefined) {
    return;
  }

  await context.progressEventWriter.emit('phase.started', {
    phase: 'child-coordination',
    message: `Coordinating child issues for issue #${parentIssueNumber}.`,
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubIssue} childIssue
 * @returns {Promise<void>}
 */
async function emitLocalPrdAutoCompleteChildStarted(context, childIssue) {
  if (context.progressEventWriter === undefined) {
    return;
  }

  await context.progressEventWriter.emit('child.started', {
    phase: 'child-coordination',
    childIssue: {
      number: childIssue.number,
      url: childIssue.url,
    },
    message: `Coordinating child issue #${childIssue.number}.`,
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {ChildAutomationResult} child
 * @returns {Promise<void>}
 */
async function emitLocalPrdAutoCompleteChildProgress(context, child) {
  if (context.progressEventWriter === undefined) {
    return;
  }

  const progressEvent = createLocalPrdAutoCompleteChildProgressEvent(child);
  await context.progressEventWriter.emit(progressEvent.event, progressEvent.details);
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubIssue} childIssue
 * @returns {{ progress(message: string): void, flush(): Promise<void> } | undefined}
 */
function createLocalPrdAutoCompleteChildProgressReporter(context, childIssue) {
  if (context.progressEventWriter === undefined) {
    return undefined;
  }

  /** @type {Promise<void>} */
  let pending = Promise.resolve();

  return {
    progress(message) {
      pending = pending.then(async () => {
        await emitLocalPrdAutoCompleteChildProgressMessage(context, childIssue, message);
      });
    },
    async flush() {
      await pending;
    },
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubIssue} childIssue
 * @param {string} progressMessage
 * @returns {Promise<void>}
 */
async function emitLocalPrdAutoCompleteChildProgressMessage(context, childIssue, progressMessage) {
  if (context.progressEventWriter === undefined) {
    return;
  }

  await context.progressEventWriter.emit('child.progress', {
    phase: 'child-coordination',
    childIssue: {
      number: childIssue.number,
      url: childIssue.url,
    },
    message: progressMessage,
    progressMessage,
    ...readLocalRunRecordProgress(progressMessage),
  });
}

/**
 * @param {string} progressMessage
 * @returns {{ localRunRecord: string } | {}}
 */
function readLocalRunRecordProgress(progressMessage) {
  const prefix = 'Local Run Record: ';
  if (!progressMessage.startsWith(prefix)) {
    return {};
  }

  return {
    localRunRecord: progressMessage.slice(prefix.length),
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {ChildAutomationResult[]} children
 * @param {number} parentIssueNumber
 * @returns {Promise<void>}
 */
async function emitLocalPrdAutoCompletePhaseCompleted(context, children, parentIssueNumber) {
  if (context.progressEventWriter === undefined) {
    return;
  }

  await context.progressEventWriter.emit(
    'phase.completed',
    createLocalPrdAutoCompletePhaseCompletedEvent({
      children,
      targetNumber: parentIssueNumber,
    }),
  );
}

/**
 * @param {OperationRunnerContext} context
 * @param {ParentReviewResult | undefined} parentPullRequest
 * @returns {Promise<void>}
 */
async function emitLocalPrdAutoCompleteParentWaiting(context, parentPullRequest) {
  if (context.progressEventWriter === undefined) {
    return;
  }

  const waitingEvent = createLocalPrdAutoCompleteParentWaitingEvent(parentPullRequest);
  if (waitingEvent === undefined) {
    return;
  }

  await context.progressEventWriter.emit('waiting', waitingEvent);
}

/**
 * @param {{ directory: string }} runRecord
 * @param {string} fileName
 * @param {string} contents
 * @returns {Promise<void>}
 */
async function writeLocalPrdRunArtifact(runRecord, fileName, contents) {
  await writeFile(join(runRecord.directory, fileName), contents);
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {unknown} error
 * @returns {import('../local-run-state/types.js').LocalRunTerminalStatus | undefined}
 */
function readKnownLocalPrdRunBoundaryTerminalStatus(error) {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const boundary = /** @type {{ localPrdRunBoundary?: unknown }} */ (error).localPrdRunBoundary;
  if (typeof boundary !== 'object' || boundary === null) {
    return undefined;
  }

  const status = /** @type {{ status?: unknown }} */ (boundary).status;
  switch (status) {
    case 'blocked':
    case 'refused':
    case 'failed':
      return mapLocalRunResultStatusToTerminalStatus(status);
    default:
      return undefined;
  }
}

/**
 * @param {{
 *   message: string,
 *   localRunRecord: string,
 *   output: PrdAutomationResult,
 * }} options
 * @returns {Error & { localRunRecord: string, localPrdRunBoundary: PrdAutomationResult }}
 */
function createKnownLocalPrdRunBoundaryError({ message, localRunRecord, output }) {
  return Object.assign(new Error(`${message} Local Run Record: ${localRunRecord}`), {
    localRunRecord,
    localPrdRunBoundary: output,
  });
}

/**
 * @param {unknown} error
 * @param {string} localRunRecord
 * @returns {unknown}
 */
function attachLocalRunRecordToError(error, localRunRecord) {
  if (typeof error === 'object' && error !== null) {
    return Object.assign(error, { localRunRecord });
  }

  return Object.assign(new Error(getErrorMessage(error)), { localRunRecord });
}

/**
 * @param {object} options
 * @param {PrdAutomationMode} options.mode
 * @param {ChildAutomationResult[]} options.children
 * @param {'dry-run' | 'publish'} options.publicationMode
 * @param {ParentReviewResult | undefined} options.parentPullRequest
 * @returns {string[]}
 */
function buildLocalNextSteps({ mode, children, publicationMode, parentPullRequest }) {
  if (publicationMode === 'dry-run') {
    if (mode === 'auto-complete') {
      return buildLocalAutoCompleteDryRunNextSteps({ children, parentPullRequest, mode });
    }

    const completed = children.filter(child => child.status === 'dry-run-completed');
    if (completed.length > 0) {
      const completedIssueNumbers = completed.map(child => `#${child.issue.number}`).join(', ');
      const completedIssueLabel = completed.length === 1 ? 'child issue' : 'child issues';
      return [
        `Inspect local run evidence for ${completedIssueLabel} ${completedIssueNumbers}.`,
        `Publish with \`pullops run prd:${mode} <parent-issue-number> --publish pr\` after reviewing the local branch.`,
      ];
    }

    const merged = children.filter(child => child.status === 'merged');
    if (merged.length > 0) {
      return [
        'Inspect the local umbrella branch with finalized child PR commits applied.',
        `Publish with \`pullops run prd:${mode} <parent-issue-number> --publish pr\` after reviewing the local branch.`,
      ];
    }

    return buildLocalFollowUpWithoutRunnableChild(parentPullRequest, publicationMode, mode);
  }

  const blocked = children.find(child => child.status === 'blocked');
  if (blocked !== undefined) {
    return [
      `Resolve the blocker for child issue #${blocked.issue.number}, then rerun PRD ${mode}.`,
    ];
  }

  const waiting = children.find(child => child.status === 'waiting');
  if (waiting !== undefined) {
    return [
      `Wait for child issue #${waiting.issue.number} to finish review or checks, then rerun PRD ${mode}.`,
    ];
  }

  if (parentPullRequest?.status === 'ready-for-review') {
    return [
      'Umbrella PR is ready for human review; request review manually after verifying the refreshed PRD context.',
    ];
  }

  if (parentPullRequest?.status === 'blocked') {
    return ['Resolve the Umbrella PR automation blocker, then rerun PRD auto-complete.'];
  }

  if (
    parentPullRequest?.status === 'waiting' &&
    (parentPullRequest.openChildIssues?.length ?? 0) > 0
  ) {
    return [
      `Wait for open Child Issues to close, then rerun PRD ${mode} before the final Umbrella PR merge.`,
    ];
  }

  if (parentPullRequest?.status === 'waiting') {
    return ['Wait for Umbrella PR checks to finish, then rerun PRD auto-complete.'];
  }

  if (mode === 'auto-complete') {
    return [
      'Review the Umbrella PR branch and merge the Umbrella PR manually when ready; PullOps did not merge it into the default branch.',
    ];
  }

  return ['Review and merge the published Child Issue PRs before completing the umbrella PRD PR.'];
}

/**
 * @param {object} options
 * @param {ChildAutomationResult[]} options.children
 * @param {ParentReviewResult | undefined} options.parentPullRequest
 * @param {PrdAutomationMode} options.mode
 * @returns {string[]}
 */
function buildLocalAutoCompleteDryRunNextSteps({ children, parentPullRequest, mode }) {
  /** @type {string[]} */
  const steps = [];
  const merged = children.filter(child => child.status === 'merged');
  const completed = children.filter(
    child => child.status === 'dry-run-completed' || child.status === 'merged',
  );

  if (completed.length > 0) {
    const completedIssueNumbers = completed.map(child => `#${child.issue.number}`).join(', ');
    const completedIssueLabel = completed.length === 1 ? 'child issue' : 'child issues';
    steps.push(`Inspect local run evidence for ${completedIssueLabel} ${completedIssueNumbers}.`);
  }

  if (merged.length > 0) {
    steps.push('Inspect the local umbrella branch with finalized child commits applied.');
  }

  const waiting = children.find(child => child.status === 'waiting');
  if (waiting !== undefined) {
    steps.push(
      `Wait for child issue #${waiting.issue.number} to finish review or checks, then rerun PRD ${mode}.`,
    );
    return steps;
  }

  const blocked = children.find(child => child.status === 'blocked');
  if (blocked !== undefined) {
    steps.push(
      `Resolve the blocker for child issue #${blocked.issue.number}, then rerun PRD ${mode}.`,
    );
    return steps;
  }

  if (completed.length > 0) {
    steps.push(
      `Publish with \`pullops run prd:${mode} <parent-issue-number> --publish pr\` after reviewing the local branch.`,
    );
    return steps;
  }

  return buildLocalFollowUpWithoutRunnableChild(parentPullRequest, 'dry-run', mode);
}

/**
 * @param {ParentReviewResult | undefined} parentPullRequest
 * @param {'dry-run' | 'publish'} publicationMode
 * @param {PrdAutomationMode} mode
 * @returns {string[]}
 */
function buildLocalFollowUpWithoutRunnableChild(parentPullRequest, publicationMode, mode) {
  if (parentPullRequest?.status === 'ready-for-review') {
    return [
      `Umbrella PR is ready for human review after local ${publicationMode}; request review manually instead of adding trigger labels.`,
    ];
  }

  if (parentPullRequest?.status === 'waiting-for-child-issues') {
    return [`Add or reopen a native Child Issue before rerunning local PRD ${mode}.`];
  }

  return ['No runnable child issue was available for local dry-run.'];
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
 * @param {'dry-run' | 'publish'} publicationMode
 * @returns {'dry-run-completed' | 'published'}
 */
function localImplementedChildStatus(publicationMode) {
  return publicationMode === 'publish' ? 'published' : 'dry-run-completed';
}

/**
 * @param {Record<string, unknown>} output
 * @param {string} fallback
 * @returns {string}
 */
function readOutputBranch(output, fallback) {
  const branch = readOutputString(output, 'branch');
  if (branch !== undefined) {
    return branch;
  }

  const pullRequest = readOutputPullRequest(output);
  return pullRequest?.headBranch ?? fallback;
}

/**
 * @param {Record<string, unknown>} output
 * @param {string} key
 * @returns {string | undefined}
 */
function readOutputString(output, key) {
  const value = output[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * @param {Record<string, unknown>} output
 * @returns {Partial<ChildAutomationResult>}
 */
function readOutputBlocker(output) {
  const blockedPhase = readOutputString(output, 'blockedPhase');
  const blockedOperation = readOutputString(output, 'blockedOperation');
  return {
    ...(blockedPhase === undefined ? {} : { blockedPhase }),
    ...(blockedOperation === undefined ? {} : { blockedOperation }),
  };
}

/**
 * @param {Record<string, unknown>} output
 * @returns {{ number: number, url: string, baseBranch?: string, headBranch: string } | undefined}
 */
function readOutputPullRequest(output) {
  const value = output.pullRequest;
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const pullRequest = /** @type {Record<string, unknown>} */ (value);
  if (
    typeof pullRequest.number !== 'number' ||
    typeof pullRequest.url !== 'string' ||
    typeof pullRequest.branch !== 'string'
  ) {
    return undefined;
  }

  return {
    number: pullRequest.number,
    url: pullRequest.url,
    headBranch: pullRequest.branch,
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {{ parentBranchName: string }} options
 * @returns {Promise<void>}
 */
async function checkoutLocalPrdBase(context, { parentBranchName }) {
  if (context.gitClient.fetchRemoteRefs === undefined) {
    throw new Error('Git client does not support local remote ref fetching.');
  }

  if (context.gitClient.checkoutPullOpsBranch === undefined) {
    throw new Error('Git client does not support local PullOps branch checkout.');
  }

  await context.gitClient.fetchRemoteRefs({
    requiredBranchNames: [context.config.baseBranch],
    optionalBranchNames: [parentBranchName],
  });
  await context.gitClient.checkoutPullOpsBranch({
    branchName: parentBranchName,
    baseBranch: context.config.baseBranch,
  });
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
