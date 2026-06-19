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
 * @typedef {import('./childCoordination.types.js').ChildDependencyDecision} ChildDependencyDecision
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
 * @param {object} options
 * @param {number} options.parentIssueNumber
 * @param {(childIssueNumber: number, options?: { virtualCompletedIssueNumbers?: number[] }) => Promise<Record<string, unknown>>} options.runChildIssue
 * @returns {Promise<PrdAutomationResult>}
 */
export async function coordinateLocalPrdAutoAdvance(context, { parentIssueNumber, runChildIssue }) {
  return await coordinateLocalPrdAutomation(context, {
    parentIssueNumber,
    mode: 'auto-advance',
    runChildIssue,
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {object} options
 * @param {number} options.parentIssueNumber
 * @param {(childIssueNumber: number, options?: { virtualCompletedIssueNumbers?: number[] }) => Promise<Record<string, unknown>>} options.runChildIssue
 * @returns {Promise<PrdAutomationResult>}
 */
export async function coordinateLocalPrdAutoComplete(
  context,
  { parentIssueNumber, runChildIssue },
) {
  return await coordinateLocalPrdAutomation(context, {
    parentIssueNumber,
    mode: 'auto-complete',
    runChildIssue,
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {object} options
 * @param {number} options.parentIssueNumber
 * @param {PrdAutomationMode} options.mode
 * @param {(childIssueNumber: number, options?: { virtualCompletedIssueNumbers?: number[] }) => Promise<Record<string, unknown>>} options.runChildIssue
 * @returns {Promise<PrdAutomationResult>}
 */
async function coordinateLocalPrdAutomation(context, { parentIssueNumber, mode, runChildIssue }) {
  const publicationMode = context.publicationMode ?? 'dry-run';
  const operationReference = readLocalPrdOperationReference(mode);
  const runRecord = await createLocalPrdRunRecord(context, {
    operationReference,
    targetNumber: parentIssueNumber,
    publicationMode,
  });

  try {
    await requireCleanLocalPrdWorktree(context, runRecord, operationReference);
    const parentIssue = await context.githubClient.getIssue(parentIssueNumber);
    if (parentIssue.state !== 'OPEN') {
      return await completeLocalPrdRunRecord(runRecord, {
        status: 'skipped',
        summary: `PRD issue #${parentIssue.number} is ${parentIssue.state.toLowerCase()}.`,
        issue: parentIssue.number,
        mode,
      });
    }

    const nativeParentIssueNumber = getNativeParentIssueNumber(parentIssue);
    if (nativeParentIssueNumber !== undefined) {
      const result = await blockLocalPrdAutomation(runRecord, parentIssue, {
        reason: [
          `Issue #${parentIssue.number} is already part of parent issue #${nativeParentIssueNumber}.`,
          'PRD automation can only run on a Parent Issue.',
        ].join(' '),
        mode,
        publicationMode,
      });
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

    if (publicationMode === 'publish') {
      await checkoutLocalPrdBase(context, { parentBranchName });
    }

    if (mode === 'auto-complete' && publicationMode === 'dry-run') {
      const dryRun = await coordinateLocalAutoCompleteDryRunChildren(context, {
        parentIssue,
        parentBranchName,
        childIssues,
        runChildIssue,
      });
      children.push(...dryRun.children);
      virtualCompletedChildren = dryRun.virtualCompletedChildren;
      preserveInspectableBranchState = dryRun.preserveInspectableBranchState;
    } else {
      for (const childIssue of childIssues) {
        const localResult = await coordinateLocalChildIssue(context, {
          parentIssue,
          parentBranchName,
          childIssue,
          mode,
          publicationMode,
          runChildIssue,
        });
        children.push(localResult.child);
        preserveInspectableBranchState =
          preserveInspectableBranchState || shouldPreserveInspectableBranchState(localResult.child);

        if (
          publicationMode === 'publish' &&
          localResult.restorePrdBase &&
          !preserveInspectableBranchState
        ) {
          await checkoutLocalPrdBase(context, { parentBranchName });
        }

        if (mode === 'auto-complete' && localResult.stop) {
          break;
        }
      }
    }

    const refreshedPreparation =
      publicationMode === 'publish' ? await ensurePrdPrepared(context, parentIssue) : preparation;

    if (publicationMode === 'publish' && !preserveInspectableBranchState) {
      await checkoutLocalPrdBase(context, { parentBranchName });
    }

    const parentPullRequest = await requestUmbrellaReviewIfComplete(context, {
      parentIssue,
      parentIssueNumber: parentIssue.number,
      parentBranchName,
      childIssues,
      requestReview: false,
    });

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
    throw error;
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
 * @param {GitHubIssue} options.parentIssue
 * @param {string} options.parentBranchName
 * @param {GitHubIssue[]} options.childIssues
 * @param {(childIssueNumber: number, options?: { virtualCompletedIssueNumbers?: number[] }) => Promise<Record<string, unknown>>} options.runChildIssue
 * @returns {Promise<{
 *   children: ChildAutomationResult[],
 *   virtualCompletedChildren: number[],
 *   preserveInspectableBranchState: boolean,
 * }>}
 */
async function coordinateLocalAutoCompleteDryRunChildren(
  context,
  { parentIssue, parentBranchName, childIssues, runChildIssue },
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

      const dependencyFacts = await readChildDependencyDecision(
        context,
        childIssue,
        virtualCompletedIssueNumbers,
      );
      if (shouldDeferLocalDryRunChild(parentIssue, childIssue, dependencyFacts)) {
        continue;
      }

      const localResult = await coordinateLocalChildIssue(context, {
        parentIssue,
        parentBranchName,
        childIssue,
        mode: 'auto-complete',
        publicationMode: 'dry-run',
        runChildIssue,
        dependencyFacts,
      });

      recordLocalDryRunChildResult({
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

    const dependencyFacts = await readChildDependencyDecision(
      context,
      childIssue,
      virtualCompletedIssueNumbers,
    );
    const child =
      dependencyFacts.blockingDependencies.length > 0
        ? blockedByDependencyChildResult(childIssue, dependencyFacts)
        : blockedByLocalAutoCompletePhaseResult(childIssue, localBlocker);
    recordLocalDryRunChildResult({
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
 * @param {GitHubIssue} parentIssue
 * @param {GitHubIssue} childIssue
 * @param {{ blockingDependencies: GitHubIssue[] }} dependencyFacts
 * @returns {boolean}
 */
function shouldDeferLocalDryRunChild(parentIssue, childIssue, dependencyFacts) {
  return (
    childIssue.state === 'OPEN' &&
    getNativeParentIssueNumber(childIssue) === parentIssue.number &&
    dependencyFacts.blockingDependencies.length > 0
  );
}

/**
 * @param {object} options
 * @param {ChildAutomationResult[]} options.children
 * @param {Set<number>} options.pendingIssueNumbers
 * @param {Set<number>} options.virtualCompletedIssueNumbers
 * @param {ChildAutomationResult} options.child
 * @returns {void}
 */
function recordLocalDryRunChildResult({
  children,
  pendingIssueNumbers,
  virtualCompletedIssueNumbers,
  child,
}) {
  children.push(child);
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
 * @param {PrdAutomationMode} options.mode
 * @param {'dry-run' | 'publish'} options.publicationMode
 * @param {(childIssueNumber: number, options?: { virtualCompletedIssueNumbers?: number[] }) => Promise<Record<string, unknown>>} options.runChildIssue
 * @param {{ decision: ChildDependencyDecision, blockingDependencies: GitHubIssue[] }} [options.dependencyFacts]
 * @returns {Promise<{ child: ChildAutomationResult, stop: boolean, restorePrdBase: boolean }>}
 */
async function coordinateLocalChildIssue(
  context,
  {
    parentIssue,
    parentBranchName,
    childIssue,
    mode,
    publicationMode,
    runChildIssue,
    dependencyFacts,
  },
) {
  if (childIssue.state !== 'OPEN') {
    return localChildAutomation({
      child: childResult(childIssue, 'closed', `Child issue #${childIssue.number} is closed.`),
    });
  }

  const parentIssueNumber = getNativeParentIssueNumber(childIssue);
  if (parentIssueNumber !== parentIssue.number) {
    return localChildAutomation({
      child: childResult(
        childIssue,
        'skipped',
        `Issue #${childIssue.number} is not part of PRD issue #${parentIssue.number}.`,
      ),
    });
  }

  const resolvedDependencyFacts =
    dependencyFacts ?? (await readChildDependencyDecision(context, childIssue, new Set()));
  const { blockingDependencies } = resolvedDependencyFacts;
  if (blockingDependencies.length > 0) {
    return localChildAutomation({
      child: childResult(
        childIssue,
        'blocked',
        `Child issue #${childIssue.number} is blocked by ${formatIssueNumbers(
          blockingDependencies,
        )}.`,
        withDependencyDecision(
          {
            blockedBy: blockingDependencies.map(issue => issue.number),
          },
          resolvedDependencyFacts.decision,
        ),
      ),
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
            pullRequest,
            publicationMode,
          })
        : inspectLocalChildPullRequest({
            childIssue,
            parentBranchName,
            pullRequest,
          });

    return localChildAutomation({
      child: {
        ...child,
        ...dependencyDecisionExtra,
      },
      stop: child.status === 'blocked',
      restorePrdBase: publicationMode === 'publish',
    });
  }

  if (hasAnyLabel(childIssue.labels, ACTIVE_CHILD_ISSUE_LABELS)) {
    return localChildAutomation({
      child: childResult(
        childIssue,
        'already-active',
        `Child issue #${childIssue.number} already has active PullOps issue automation.`,
        {
          labels: childIssue.labels,
          ...dependencyDecisionExtra,
        },
      ),
    });
  }

  if (childIssue.labels.includes(PULL_OPS_STATUS_LABELS.humanRequired)) {
    return localChildAutomation({
      child: childResult(
        childIssue,
        'human-required',
        `Child issue #${childIssue.number} needs human attention before PullOps automation can continue.`,
        {
          labels: childIssue.labels,
          ...dependencyDecisionExtra,
        },
      ),
    });
  }

  const output = await runChildIssue(childIssue.number, {
    virtualCompletedIssueNumbers: resolvedDependencyFacts.decision.satisfiedByVirtualCompletions,
  });
  const status =
    output.status === 'blocked' ? 'blocked' : localImplementedChildStatus(publicationMode);

  return localChildAutomation({
    child: childResult(childIssue, status, String(output.summary), {
      branch: readOutputBranch(output, childBranchName),
      pullRequest: readOutputPullRequest(output),
      localRunRecord: readOutputString(output, 'localRunRecord'),
      publicationMode,
      ...dependencyDecisionExtra,
    }),
    stop: output.status === 'blocked',
    restorePrdBase: publicationMode === 'publish',
  });
}

/**
 * @param {GitHubIssue} childIssue
 * @param {{ decision: ChildDependencyDecision, blockingDependencies: GitHubIssue[] }} dependencyFacts
 * @returns {ChildAutomationResult}
 */
function blockedByDependencyChildResult(childIssue, dependencyFacts) {
  const { blockingDependencies } = dependencyFacts;
  return childResult(
    childIssue,
    'blocked',
    `Child issue #${childIssue.number} is blocked by ${formatIssueNumbers(blockingDependencies)}.`,
    withDependencyDecision(
      {
        blockedBy: blockingDependencies.map(issue => issue.number),
      },
      dependencyFacts.decision,
    ),
  );
}

/**
 * @param {GitHubIssue} childIssue
 * @param {ChildAutomationResult | undefined} localBlocker
 * @returns {ChildAutomationResult}
 */
function blockedByLocalAutoCompletePhaseResult(childIssue, localBlocker) {
  if (localBlocker === undefined) {
    return childResult(
      childIssue,
      'blocked',
      `Child issue #${childIssue.number} was not reachable during local PRD auto-complete.`,
    );
  }

  return childResult(
    childIssue,
    'blocked',
    `Child issue #${childIssue.number} was not started because local PRD auto-complete stopped at child issue #${localBlocker.issue.number}.`,
    { blockedBy: [localBlocker.issue.number] },
  );
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubIssue} issue
 * @param {ReadonlySet<number>} virtualCompletedIssueNumbers
 * @returns {Promise<{ decision: ChildDependencyDecision, blockingDependencies: GitHubIssue[] }>}
 */
async function readChildDependencyDecision(context, issue, virtualCompletedIssueNumbers) {
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

  return childPullRequestResult(
    childIssue,
    pullRequest,
    isFinalizedForRebase(state) ? 'ready-for-human-merge' : 'waiting',
    isFinalizedForRebase(state)
      ? `Child PR #${pullRequest.number} is finalized for human merge.`
      : `Child PR #${pullRequest.number} is waiting for human review or merge gates.`,
  );
}

/**
 * @param {OperationRunnerContext} context
 * @param {object} options
 * @param {GitHubIssue} options.childIssue
 * @param {GitHubIssue} options.parentIssue
 * @param {string} options.parentBranchName
 * @param {GitHubPullRequest} options.pullRequest
 * @param {'dry-run' | 'publish'} options.publicationMode
 * @returns {Promise<ChildAutomationResult>}
 */
async function coordinateLocalChildPullRequest(
  context,
  { childIssue, parentIssue, parentBranchName, pullRequest, publicationMode },
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

  if (!isFinalizedForRebase(state)) {
    return childPullRequestResult(
      childIssue,
      pullRequest,
      'waiting',
      `Child PR #${pullRequest.number} is waiting for human review or merge gates.`,
    );
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
    return childPullRequestResult(
      childIssue,
      pullRequest,
      'blocked',
      'Git client cannot locally integrate finalized child pull requests.',
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
    return childPullRequestResult(
      childIssue,
      pullRequest,
      'blocked',
      `Child PR #${pullRequest.number} finalized-head checks failed; repair CI before local auto-complete can merge it.`,
      { checks: checks.length },
    );
  }

  const integration = await context.gitClient.cherryPickCommitOntoBranch({
    branchName: parentBranchName,
    baseBranch: context.config.baseBranch,
    commitSha: finalizedHeadSha,
    committer: GITHUB_ACTIONS_BOT_AUTHOR,
  });

  if (integration.status === 'conflicts') {
    return childPullRequestResult(
      childIssue,
      pullRequest,
      'blocked',
      `Child PR #${pullRequest.number} could not be merged locally into ${parentBranchName} without conflicts.`,
      {
        mergeMethod: 'local-cherry-pick',
        conflictedFiles: integration.conflictedFiles,
      },
    );
  }

  if (publicationMode === 'publish') {
    const pushResult = await context.gitClient.pushBranchWithLease({
      branchName: parentBranchName,
    });
    if (pushResult.status === 'stale-lease') {
      return childPullRequestResult(
        childIssue,
        pullRequest,
        'blocked',
        `Remote branch ${parentBranchName} changed while local auto-complete was merging child PR #${pullRequest.number}.`,
        { mergeMethod: 'local-cherry-pick' },
      );
    }

    await closeChildIssue(context, {
      issue: childIssue,
      pullRequest,
      expectedBaseBranch: parentBranchName,
    });
    childIssue.state = 'CLOSED';
  }

  return childPullRequestResult(
    childIssue,
    pullRequest,
    'merged',
    `Merged finalized child PR #${pullRequest.number} locally into PRD issue #${parentIssue.number}.`,
    {
      mergeMethod: 'local-cherry-pick',
      finalizedHeadSha,
      headSha: integration.headSha,
      treeHash: integration.treeHash,
    },
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

  let reviewPullRequest = pullRequest;
  if (resolvedParentIssue !== undefined) {
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

  return {
    status: 'ready-for-review',
    pullRequest: formatPullRequest(pullRequest),
    nextOperation: PULL_OPS_OPERATION_LABELS.prReview,
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
    parts.push(`${dryRunCompleted} child issue dry-run(s) completed.`);
  } else {
    parts.push(`${published} child issue PR(s) published.`);
  }

  if (mode === 'auto-complete') {
    parts.push(`${merged} finalized child PR(s) merged locally.`);
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
async function blockLocalPrdAutomation(runRecord, issue, { reason, mode, publicationMode }) {
  await writeLocalPrdRunArtifact(runRecord, 'failure-reason.txt', `${reason}\n`);
  return {
    status: 'blocked',
    summary: reason,
    issue: issue.number,
    mode,
    publicationMode,
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
 * @returns {Promise<{ directory: string }>}
 */
async function createLocalPrdRunRecord(
  context,
  { operationReference, targetNumber, publicationMode },
) {
  const normalizedReference = normalizeOperationReferenceForPath(operationReference);
  const timestamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', '');
  const directory = join(
    context.cwd,
    '.pullops',
    'runs',
    `${timestamp}-${normalizedReference}-${targetNumber}`,
  );

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
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );

  return { directory };
}

/**
 * @param {OperationRunnerContext} context
 * @param {{ directory: string }} runRecord
 * @param {string} operationReference
 * @returns {Promise<void>}
 */
async function requireCleanLocalPrdWorktree(context, runRecord, operationReference) {
  if (!(await context.gitClient.hasChanges())) {
    return;
  }

  const reason = [
    `Local ${operationReference} requires a clean worktree before PullOps reads or mutates branch state.`,
    'Commit, stash, or discard existing changes and run PullOps again.',
  ].join(' ');
  await writeLocalPrdRunArtifact(runRecord, 'failure-reason.txt', `${reason}\n`);
  throw new Error(`${reason} Local Run Record: ${runRecord.directory}`);
}

/**
 * @param {{ directory: string }} runRecord
 * @param {PrdAutomationResult} result
 * @returns {Promise<PrdAutomationResult>}
 */
async function completeLocalPrdRunRecord(runRecord, result) {
  const withRunRecord = {
    ...result,
    localRunRecord: runRecord.directory,
  };

  await writeLocalPrdRunArtifact(
    runRecord,
    'result.json',
    `${JSON.stringify(withRunRecord, null, 2)}\n`,
  );
  return withRunRecord;
}

/**
 * @param {string} reference
 * @returns {string}
 */
function normalizeOperationReferenceForPath(reference) {
  return reference
    .trim()
    .toLowerCase()
    .replaceAll(':', '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
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

  if (parentPullRequest?.status === 'waiting') {
    return [
      `Wait for open Child Issues to close, then rerun PRD ${mode} before the final Umbrella PR merge.`,
    ];
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
  const completed = children.filter(child => child.status === 'dry-run-completed');
  const merged = children.filter(child => child.status === 'merged');

  if (completed.length > 0) {
    const completedIssueNumbers = completed.map(child => `#${child.issue.number}`).join(', ');
    const completedIssueLabel = completed.length === 1 ? 'child issue' : 'child issues';
    steps.push(`Inspect local run evidence for ${completedIssueLabel} ${completedIssueNumbers}.`);
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

  if (merged.length > 0) {
    return [
      'Inspect the local umbrella branch with finalized child PR commits applied.',
      `Publish with \`pullops run prd:${mode} <parent-issue-number> --publish pr\` after reviewing the local branch.`,
    ];
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
