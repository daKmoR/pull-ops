import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  PULL_OPS_OPERATION_LABELS,
  PULL_OPS_PR_OPERATION_LABELS,
  PULL_OPS_STATUS_LABEL_NAMES,
  PULL_OPS_STATUS_LABELS,
} from '../labels/pullOpsLabels.js';

/**
 * @typedef {import('./ManagedPrState.types.js').ApplyManagedPrTransitionOptions} ApplyManagedPrTransitionOptions
 * @typedef {import('./ManagedPrState.types.js').InternalTransition} InternalTransition
 * @typedef {import('./ManagedPrState.types.js').ManagedPrState} ManagedPrState
 * @typedef {import('./ManagedPrState.types.js').ManagedPrStateSectionOptions} ManagedPrStateSectionOptions
 * @typedef {import('./ManagedPrState.types.js').ManagedPrTransitionOutcome} ManagedPrTransitionOutcome
 * @typedef {import('./ManagedPrState.types.js').ManagedPrTransitionResult} ManagedPrTransitionResult
 * @typedef {import('./ManagedPrState.types.js').ManagedPrWorkflowOptions} ManagedPrWorkflowOptions
 * @typedef {import('./ManagedPrState.types.js').ManagedPrWorkflowResult} ManagedPrWorkflowResult
 * @typedef {import('./ManagedPrState.types.js').RefusePrOperationTargetOptions} RefusePrOperationTargetOptions
 * @typedef {import('./ManagedPrState.types.js').UpdateManagedPrStateOptions} UpdateManagedPrStateOptions
 */

export const DEFAULT_MAX_REVIEW_CYCLES = 3;
export const DEFAULT_MAX_CI_FIX_CYCLES = 2;

/** @type {ReadonlySet<string>} */
const PR_OPERATION_LABELS = new Set([
  PULL_OPS_OPERATION_LABELS.prReview,
  PULL_OPS_OPERATION_LABELS.prAddressReview,
  PULL_OPS_OPERATION_LABELS.prFixCi,
  PULL_OPS_OPERATION_LABELS.prUpdateBranch,
  PULL_OPS_OPERATION_LABELS.prResolveConflicts,
  PULL_OPS_OPERATION_LABELS.prFinalize,
]);

/** @type {ReadonlySet<string>} */
const ACTIVE_PULL_OPS_PR_LABELS = new Set([
  ...PULL_OPS_PR_OPERATION_LABELS,
  ...PULL_OPS_STATUS_LABEL_NAMES,
]);

const FAILURE_STATUS_LABELS_TO_REMOVE = [
  PULL_OPS_STATUS_LABELS.inProgress,
  PULL_OPS_STATUS_LABELS.failed,
  PULL_OPS_STATUS_LABELS.prepared,
  PULL_OPS_STATUS_LABELS.done,
];

/**
 * @param {string} body
 * @returns {ManagedPrState}
 */
export function readManagedPrState(body) {
  const source = readSource(body);

  return {
    managed: /^Managed PR:\s*yes\s*$/im.test(body),
    ...(source === undefined
      ? {}
      : {
          sourceIssueNumber: source.number,
          sourceKind: source.kind,
        }),
    lastOperation: readMarker(body, 'Last operation:'),
    reviewedTreeHash: readMarker(body, 'Reviewed tree:'),
    finalizedTreeHash: readMarker(body, 'Finalized tree:'),
    finalizedHeadSha: readMarker(body, 'Finalized head:'),
    mergeMethod: readMarker(body, 'Merge method:'),
    reviewCycles: readReviewCycles(body),
    ciFixCycles: readCiFixCycles(body),
  };
}

/**
 * @param {ManagedPrState} state
 * @returns {state is ManagedPrState & { finalizedHeadSha: string, finalizedTreeHash: string }}
 */
export function isFinalizedForRebase(state) {
  return (
    state.finalizedHeadSha !== undefined &&
    state.finalizedTreeHash !== undefined &&
    state.mergeMethod === 'rebase'
  );
}

/**
 * @param {string[] | undefined} labels
 * @returns {boolean}
 */
export function hasActiveManagedPrWorkflow(labels) {
  return labels?.some(label => ACTIVE_PULL_OPS_PR_LABELS.has(label)) ?? false;
}

/**
 * @param {ManagedPrWorkflowOptions} options
 * @returns {Promise<ManagedPrWorkflowResult>}
 */
export async function requestManagedPrReview({ githubClient, pullRequest }) {
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

  await githubClient.addLabelsToPullRequest({
    number: pullRequest.number,
    labels: [PULL_OPS_OPERATION_LABELS.prReview],
  });

  return {
    status: 'review-requested',
    pullRequest: formatPullRequest(pullRequest),
    nextOperation: PULL_OPS_OPERATION_LABELS.prReview,
  };
}

/**
 * @param {ManagedPrWorkflowOptions} options
 * @returns {Promise<ManagedPrWorkflowResult>}
 */
export async function resumeManagedPrWorkflow({ githubClient, pullRequest }) {
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

  const nextOperation = chooseNextManagedPrOperation({
    body: pullRequest.body,
    state,
  });
  if (nextOperation === undefined) {
    return {
      status: 'waiting',
      pullRequest: formatPullRequest(pullRequest),
    };
  }

  await githubClient.addLabelsToPullRequest({
    number: pullRequest.number,
    labels: [nextOperation],
  });

  return {
    status: 'resumed',
    pullRequest: formatPullRequest(pullRequest),
    nextOperation,
  };
}

/**
 * @param {ManagedPrStateSectionOptions} options
 * @returns {string}
 */
export function createManagedPrStateSection({
  status,
  source,
  branchName,
  triggerActor,
  runnerTask,
  modelTier,
  model,
  lastOperation,
  reviewCycles,
  ciFixCycles,
}) {
  return [
    '## PullOps',
    '',
    'Managed PR: yes',
    `Status: ${status}`,
    ...(reviewCycles === undefined
      ? []
      : [`Review cycles: ${reviewCycles.current} / ${reviewCycles.max}`]),
    ...(ciFixCycles === undefined
      ? []
      : [`CI fix cycles: ${ciFixCycles.current} / ${ciFixCycles.max}`]),
    formatSourceLine(source),
    `Branch: ${branchName}`,
    `Triggered by: ${formatActor(triggerActor)}`,
    `Runner task: ${runnerTask}`,
    `Model tier: ${modelTier}`,
    `Model: ${model}`,
    `Last operation: ${lastOperation}`,
  ].join('\n');
}

/**
 * @param {UpdateManagedPrStateOptions} options
 * @returns {string}
 */
export function updateManagedPrState({
  body,
  status,
  lastOperation,
  reviewCycles,
  ciFixCycles,
  reviewedTreeHash,
  finalizedTreeHash,
  finalizedHeadSha,
  mergeMethod,
  removeMergePreparationMarkers: shouldRemoveMergePreparationMarkers = false,
}) {
  let updated = body.trimEnd();

  if (status !== undefined) {
    updated = upsertLine(updated, 'Status:', status);
  }

  if (reviewCycles !== undefined) {
    updated = upsertLine(
      updated,
      'Review cycles:',
      `${reviewCycles.current} / ${reviewCycles.max}`,
    );
  }

  if (ciFixCycles !== undefined) {
    updated = upsertLine(updated, 'CI fix cycles:', `${ciFixCycles.current} / ${ciFixCycles.max}`);
  }

  if (shouldRemoveMergePreparationMarkers) {
    updated = removeMergePreparationMarkers(updated);
  }

  if (reviewedTreeHash !== undefined) {
    updated = upsertLine(updated, 'Reviewed tree:', reviewedTreeHash);
  }

  if (finalizedTreeHash !== undefined) {
    updated = upsertLine(updated, 'Finalized tree:', finalizedTreeHash);
  }

  if (finalizedHeadSha !== undefined) {
    updated = upsertLine(updated, 'Finalized head:', finalizedHeadSha);
  }

  if (mergeMethod !== undefined) {
    updated = upsertLine(updated, 'Merge method:', mergeMethod);
  }

  if (lastOperation !== undefined) {
    updated = upsertLine(updated, 'Last operation:', lastOperation);
  }

  return `${updated}\n`;
}

/**
 * @param {ApplyManagedPrTransitionOptions} options
 * @returns {Promise<ManagedPrTransitionResult>}
 */
export async function applyManagedPrTransition({
  githubClient,
  outputDirectory,
  pullRequest,
  operation,
  outcome,
}) {
  assertPrOperation(operation);

  const state = readManagedPrState(pullRequest.body);
  if (!state.managed) {
    throw new Error(
      `Cannot apply ${operation} transition to PR #${pullRequest.number} without a PullOps-managed PR State Marker.`,
    );
  }

  const transition = createTransition({ body: pullRequest.body, operation, outcome, state });
  await executeTransition({
    githubClient,
    outputDirectory,
    pullRequestNumber: pullRequest.number,
    transition,
  });

  return {
    updatedBody: transition.body !== undefined,
    addedLabels: [...transition.addLabelsBeforeRemove, ...transition.addLabelsAfterRemove],
    removedLabels: transition.removeLabels,
    ...(transition.commentBody === undefined ? {} : { comment: transition.commentBody }),
    ...(transition.nextOperationLabel === undefined
      ? {}
      : { nextOperationLabel: transition.nextOperationLabel }),
    ...(transition.statusLabel === undefined ? {} : { statusLabel: transition.statusLabel }),
  };
}

/**
 * @param {RefusePrOperationTargetOptions} options
 * @returns {Promise<ManagedPrTransitionResult>}
 */
export async function refusePrOperationTarget({
  githubClient,
  outputDirectory,
  pullRequest,
  operation,
  reason,
}) {
  assertPrOperation(operation);

  const state = readManagedPrState(pullRequest.body);
  const transition = createBlockedTransition({
    body: pullRequest.body,
    operation,
    reason,
    state,
    updateBody: state.managed,
  });
  await executeTransition({
    githubClient,
    outputDirectory,
    pullRequestNumber: pullRequest.number,
    transition,
  });

  return {
    updatedBody: transition.body !== undefined,
    addedLabels: [...transition.addLabelsBeforeRemove, ...transition.addLabelsAfterRemove],
    removedLabels: transition.removeLabels,
    ...(transition.commentBody === undefined ? {} : { comment: transition.commentBody }),
    ...(transition.statusLabel === undefined ? {} : { statusLabel: transition.statusLabel }),
  };
}

/**
 * @param {{ body: string, operation: string, outcome: ManagedPrTransitionOutcome, state: ManagedPrState }} options
 * @returns {InternalTransition}
 */
function createTransition({ body, operation, outcome, state }) {
  validateOperationOutcome(operation, outcome);

  if (outcome.kind === 'blocked') {
    return createBlockedTransition({
      body,
      operation,
      reason: outcome.reason,
      state,
      updateBody: true,
      reviewCycle: outcome.reviewCycle,
      maxReviewCycles: outcome.maxReviewCycles,
      ciFixCycle: outcome.ciFixCycle,
      maxCiFixCycles: outcome.maxCiFixCycles,
    });
  }

  if (operation === PULL_OPS_OPERATION_LABELS.prReview) {
    return createPrReviewTransition({ body, outcome, state });
  }

  if (operation === PULL_OPS_OPERATION_LABELS.prAddressReview) {
    if (outcome.kind !== 'addressed') {
      throw new Error(`${outcome.kind} is not a valid ${operation} PullOps-Managed PR outcome.`);
    }

    return {
      body: updateManagedPrState({
        body,
        status: 'Review feedback addressed',
        reviewCycles: {
          current: outcome.reviewCycle,
          max: outcome.maxReviewCycles,
        },
        lastOperation: operation,
      }),
      removeLabels: labelsForSuccessfulOperation(operation),
      addLabelsAfterRemove: [PULL_OPS_OPERATION_LABELS.prReview],
      addLabelsBeforeRemove: [],
      nextOperationLabel: PULL_OPS_OPERATION_LABELS.prReview,
    };
  }

  if (operation === PULL_OPS_OPERATION_LABELS.prFixCi) {
    return createPrFixCiTransition({ body, outcome });
  }

  if (operation === PULL_OPS_OPERATION_LABELS.prUpdateBranch) {
    return createPrUpdateBranchTransition({ body, outcome });
  }

  if (operation === PULL_OPS_OPERATION_LABELS.prResolveConflicts) {
    return {
      body: updateManagedPrState({
        body,
        status: 'Rebase conflicts resolved',
        removeMergePreparationMarkers: true,
        lastOperation: operation,
      }),
      removeLabels: labelsForSuccessfulOperation(operation),
      addLabelsAfterRemove: [PULL_OPS_OPERATION_LABELS.prReview],
      addLabelsBeforeRemove: [],
      nextOperationLabel: PULL_OPS_OPERATION_LABELS.prReview,
    };
  }

  return createPrFinalizeTransition({ body, outcome });
}

/**
 * @param {{ body: string, outcome: ManagedPrTransitionOutcome, state: ManagedPrState }} options
 * @returns {InternalTransition}
 */
function createPrReviewTransition({ body, outcome, state }) {
  if (outcome.kind === 'approved') {
    const nextLabel =
      state.lastOperation === PULL_OPS_OPERATION_LABELS.prFinalize
        ? PULL_OPS_STATUS_LABELS.done
        : PULL_OPS_OPERATION_LABELS.prFinalize;
    return {
      body: updateManagedPrState({
        body,
        status: 'Review approved',
        reviewCycles: {
          current: outcome.reviewCycle,
          max: outcome.maxReviewCycles,
        },
        reviewedTreeHash: outcome.reviewedTreeHash,
        lastOperation: PULL_OPS_OPERATION_LABELS.prReview,
      }),
      removeLabels: labelsForSuccessfulOperation(PULL_OPS_OPERATION_LABELS.prReview),
      addLabelsAfterRemove: [nextLabel],
      addLabelsBeforeRemove: [],
      ...(nextLabel === PULL_OPS_STATUS_LABELS.done
        ? { statusLabel: nextLabel }
        : { nextOperationLabel: nextLabel }),
    };
  }

  if (outcome.kind !== 'changes-requested') {
    throw new Error(
      `${outcome.kind} is not a valid ${PULL_OPS_OPERATION_LABELS.prReview} PullOps-Managed PR outcome.`,
    );
  }

  return {
    body: updateManagedPrState({
      body,
      status: 'Changes requested',
      reviewCycles: {
        current: outcome.reviewCycle,
        max: outcome.maxReviewCycles,
      },
      removeMergePreparationMarkers: true,
      lastOperation: PULL_OPS_OPERATION_LABELS.prReview,
    }),
    removeLabels: labelsForSuccessfulOperation(PULL_OPS_OPERATION_LABELS.prReview),
    addLabelsAfterRemove: [PULL_OPS_OPERATION_LABELS.prAddressReview],
    addLabelsBeforeRemove: [],
    nextOperationLabel: PULL_OPS_OPERATION_LABELS.prAddressReview,
  };
}

/**
 * @param {{ body: string, outcome: ManagedPrTransitionOutcome }} options
 * @returns {InternalTransition}
 */
function createPrFixCiTransition({ body, outcome }) {
  if (outcome.kind === 'no-failed-checks') {
    return {
      removeLabels: labelsForSuccessfulOperation(PULL_OPS_OPERATION_LABELS.prFixCi),
      addLabelsAfterRemove: [PULL_OPS_OPERATION_LABELS.prReview],
      addLabelsBeforeRemove: [],
      nextOperationLabel: PULL_OPS_OPERATION_LABELS.prReview,
    };
  }

  if (outcome.kind !== 'fixed') {
    throw new Error(
      `${outcome.kind} is not a valid ${PULL_OPS_OPERATION_LABELS.prFixCi} PullOps-Managed PR outcome.`,
    );
  }

  return {
    body: updateManagedPrState({
      body,
      status: 'CI fixed',
      ciFixCycles: {
        current: outcome.ciFixCycle,
        max: outcome.maxCiFixCycles,
      },
      lastOperation: PULL_OPS_OPERATION_LABELS.prFixCi,
    }),
    removeLabels: labelsForSuccessfulOperation(PULL_OPS_OPERATION_LABELS.prFixCi),
    addLabelsAfterRemove: [PULL_OPS_OPERATION_LABELS.prReview],
    addLabelsBeforeRemove: [],
    nextOperationLabel: PULL_OPS_OPERATION_LABELS.prReview,
  };
}

/**
 * @param {{ body: string, outcome: ManagedPrTransitionOutcome }} options
 * @returns {InternalTransition}
 */
function createPrUpdateBranchTransition({ body, outcome }) {
  if (outcome.kind === 'conflicts-found') {
    return {
      body: updateManagedPrState({
        body,
        status: 'Rebase conflicts',
        removeMergePreparationMarkers: true,
        lastOperation: PULL_OPS_OPERATION_LABELS.prUpdateBranch,
      }),
      removeLabels: labelsForSuccessfulOperation(PULL_OPS_OPERATION_LABELS.prUpdateBranch),
      addLabelsAfterRemove: [PULL_OPS_OPERATION_LABELS.prResolveConflicts],
      addLabelsBeforeRemove: [],
      commentBody: [
        'PullOps could not complete `pullops run pr-update-branch` without conflicts.',
        '',
        `Base branch: ${outcome.baseBranch}`,
        `Conflicted files: ${formatList(outcome.conflictedFiles)}`,
        `Next operation: ${PULL_OPS_OPERATION_LABELS.prResolveConflicts}`,
      ].join('\n'),
      nextOperationLabel: PULL_OPS_OPERATION_LABELS.prResolveConflicts,
    };
  }

  if (outcome.kind !== 'updated') {
    throw new Error(
      `${outcome.kind} is not a valid ${PULL_OPS_OPERATION_LABELS.prUpdateBranch} PullOps-Managed PR outcome.`,
    );
  }

  return {
    body: updateManagedPrState({
      body,
      status: 'Branch updated',
      removeMergePreparationMarkers: true,
      lastOperation: PULL_OPS_OPERATION_LABELS.prUpdateBranch,
    }),
    removeLabels: labelsForSuccessfulOperation(PULL_OPS_OPERATION_LABELS.prUpdateBranch),
    addLabelsAfterRemove: [PULL_OPS_OPERATION_LABELS.prReview],
    addLabelsBeforeRemove: [],
    nextOperationLabel: PULL_OPS_OPERATION_LABELS.prReview,
  };
}

/**
 * @param {{ body: string, outcome: ManagedPrTransitionOutcome }} options
 * @returns {InternalTransition}
 */
function createPrFinalizeTransition({ body, outcome }) {
  if (outcome.kind === 'ready') {
    return {
      body: updateManagedPrState({
        body,
        status: 'Ready for human rebase merge',
        finalizedTreeHash: outcome.finalizedTreeHash,
        finalizedHeadSha: outcome.finalizedHeadSha,
        mergeMethod: 'rebase',
        lastOperation: PULL_OPS_OPERATION_LABELS.prFinalize,
      }),
      removeLabels: labelsForSuccessfulOperation(PULL_OPS_OPERATION_LABELS.prFinalize),
      addLabelsAfterRemove: [],
      addLabelsBeforeRemove: [],
    };
  }

  if (outcome.kind === 'route-to-review') {
    return {
      body: updateManagedPrState({
        body,
        status: 'Review required',
        removeMergePreparationMarkers: true,
        lastOperation: PULL_OPS_OPERATION_LABELS.prFinalize,
      }),
      failureReason: outcome.reason,
      removeLabels: labelsForSuccessfulOperation(PULL_OPS_OPERATION_LABELS.prFinalize),
      addLabelsAfterRemove: [PULL_OPS_OPERATION_LABELS.prReview],
      addLabelsBeforeRemove: [],
      commentBody: [
        'PullOps routed `pullops run pr-finalize` back to review.',
        '',
        `Reason: ${outcome.reason}`,
      ].join('\n'),
      nextOperationLabel: PULL_OPS_OPERATION_LABELS.prReview,
    };
  }

  if (outcome.kind !== 'route-to-ci-fix') {
    throw new Error(
      `${outcome.kind} is not a valid ${PULL_OPS_OPERATION_LABELS.prFinalize} PullOps-Managed PR outcome.`,
    );
  }

  return {
    failureReason: outcome.reason,
    removeLabels: labelsForSuccessfulOperation(PULL_OPS_OPERATION_LABELS.prFinalize),
    addLabelsAfterRemove: [PULL_OPS_OPERATION_LABELS.prFixCi],
    addLabelsBeforeRemove: [],
    commentBody: [
      'PullOps routed `pullops run pr-finalize` to CI repair.',
      '',
      `Reason: ${outcome.reason}`,
    ].join('\n'),
    nextOperationLabel: PULL_OPS_OPERATION_LABELS.prFixCi,
  };
}

/**
 * @param {{
 *   body: string,
 *   operation: string,
 *   reason: string,
 *   state: ManagedPrState,
 *   updateBody: boolean,
 *   reviewCycle?: number,
 *   maxReviewCycles?: number,
 *   ciFixCycle?: number,
 *   maxCiFixCycles?: number,
 * }} options
 * @returns {InternalTransition}
 */
function createBlockedTransition({
  body,
  operation,
  reason,
  state,
  updateBody,
  reviewCycle,
  maxReviewCycles,
  ciFixCycle,
  maxCiFixCycles,
}) {
  return {
    body: updateBody
      ? createBlockedBody({
          body,
          operation,
          state,
          reviewCycle,
          maxReviewCycles,
          ciFixCycle,
          maxCiFixCycles,
        })
      : undefined,
    failureReason: reason,
    removeLabels: labelsForBlockedOperation(operation),
    addLabelsBeforeRemove: [PULL_OPS_STATUS_LABELS.blocked],
    addLabelsAfterRemove: [],
    commentBody: [
      `PullOps could not complete \`pullops run ${formatOperationCommand(operation)}\`.`,
      '',
      `Reason: ${reason}`,
    ].join('\n'),
    statusLabel: PULL_OPS_STATUS_LABELS.blocked,
  };
}

/**
 * @param {{
 *   body: string,
 *   operation: string,
 *   state: ManagedPrState,
 *   reviewCycle?: number,
 *   maxReviewCycles?: number,
 *   ciFixCycle?: number,
 *   maxCiFixCycles?: number,
 * }} options
 * @returns {string}
 */
function createBlockedBody({
  body,
  operation,
  state,
  reviewCycle,
  maxReviewCycles,
  ciFixCycle,
  maxCiFixCycles,
}) {
  if (operation === PULL_OPS_OPERATION_LABELS.prReview) {
    return updateManagedPrState({
      body,
      status: 'Blocked',
      reviewCycles: {
        current: reviewCycle ?? state.reviewCycles.current,
        max: maxReviewCycles ?? state.reviewCycles.max,
      },
      removeMergePreparationMarkers: true,
      lastOperation: operation,
    });
  }

  if (operation === PULL_OPS_OPERATION_LABELS.prAddressReview) {
    return updateManagedPrState({
      body,
      status: 'Blocked',
      reviewCycles: {
        current: reviewCycle ?? state.reviewCycles.current,
        max: maxReviewCycles ?? state.reviewCycles.max,
      },
      lastOperation: operation,
    });
  }

  if (operation === PULL_OPS_OPERATION_LABELS.prFixCi) {
    return updateManagedPrState({
      body,
      status: 'Blocked',
      ciFixCycles: {
        current: ciFixCycle ?? state.ciFixCycles.current,
        max: maxCiFixCycles ?? state.ciFixCycles.max,
      },
      lastOperation: operation,
    });
  }

  return updateManagedPrState({
    body,
    status: 'Blocked',
    removeMergePreparationMarkers:
      operation === PULL_OPS_OPERATION_LABELS.prUpdateBranch ||
      operation === PULL_OPS_OPERATION_LABELS.prResolveConflicts,
    lastOperation: operation,
  });
}

/**
 * @param {{
 *   githubClient: import('../github/types.js').GitHubClient,
 *   outputDirectory?: string,
 *   pullRequestNumber: number,
 *   transition: InternalTransition,
 * }} options
 * @returns {Promise<void>}
 */
async function executeTransition({ githubClient, outputDirectory, pullRequestNumber, transition }) {
  if (transition.failureReason !== undefined) {
    await writeFailureReason({ outputDirectory, reason: transition.failureReason });
  }

  if (transition.body !== undefined) {
    await githubClient.updatePullRequestBody({
      number: pullRequestNumber,
      body: transition.body,
    });
  }

  if (transition.addLabelsBeforeRemove.length > 0) {
    await githubClient.addLabelsToPullRequest({
      number: pullRequestNumber,
      labels: transition.addLabelsBeforeRemove,
    });
  }

  if (transition.removeLabels.length > 0) {
    await githubClient.removeLabelsFromPullRequest({
      number: pullRequestNumber,
      labels: transition.removeLabels,
    });
  }

  if (transition.addLabelsAfterRemove.length > 0) {
    await githubClient.addLabelsToPullRequest({
      number: pullRequestNumber,
      labels: transition.addLabelsAfterRemove,
    });
  }

  if (transition.commentBody !== undefined) {
    await githubClient.commentOnPullRequest({
      number: pullRequestNumber,
      body: transition.commentBody,
    });
  }
}

/**
 * @param {{ outputDirectory?: string, reason: string }} options
 * @returns {Promise<void>}
 */
async function writeFailureReason({ outputDirectory, reason }) {
  if (outputDirectory === undefined || outputDirectory.trim() === '') {
    return;
  }

  await mkdir(outputDirectory, { recursive: true });
  await writeFile(join(outputDirectory, 'failure_reason.txt'), `${reason}\n`);
}

/**
 * @param {string} operation
 * @returns {void}
 */
function assertPrOperation(operation) {
  if (!PR_OPERATION_LABELS.has(operation)) {
    throw new Error(`${operation} is not a PullOps PR Operation Label.`);
  }
}

/**
 * @param {string} operation
 * @param {ManagedPrTransitionOutcome} outcome
 * @returns {void}
 */
function validateOperationOutcome(operation, outcome) {
  const allowed = getAllowedOutcomes(operation);
  if (!allowed.includes(outcome.kind)) {
    throw new Error(`${outcome.kind} is not a valid ${operation} PullOps-Managed PR outcome.`);
  }
}

/**
 * @param {string} operation
 * @returns {string[]}
 */
function getAllowedOutcomes(operation) {
  if (operation === PULL_OPS_OPERATION_LABELS.prReview) {
    return ['approved', 'changes-requested', 'blocked'];
  }

  if (operation === PULL_OPS_OPERATION_LABELS.prAddressReview) {
    return ['addressed', 'blocked'];
  }

  if (operation === PULL_OPS_OPERATION_LABELS.prFixCi) {
    return ['fixed', 'no-failed-checks', 'blocked'];
  }

  if (operation === PULL_OPS_OPERATION_LABELS.prUpdateBranch) {
    return ['updated', 'conflicts-found', 'blocked'];
  }

  if (operation === PULL_OPS_OPERATION_LABELS.prResolveConflicts) {
    return ['resolved', 'blocked'];
  }

  return ['ready', 'route-to-review', 'route-to-ci-fix', 'blocked'];
}

/**
 * @param {{ body: string, state: ManagedPrState }} options
 * @returns {string | undefined}
 */
function chooseNextManagedPrOperation({ body, state }) {
  const status = readMarker(body, 'Status:');

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
 * @param {import('../github/types.js').GitHubPullRequest} pullRequest
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
 * @param {string} operation
 * @returns {string[]}
 */
function labelsForSuccessfulOperation(operation) {
  return [operation, ...PULL_OPS_STATUS_LABEL_NAMES];
}

/**
 * @param {string} operation
 * @returns {string[]}
 */
function labelsForBlockedOperation(operation) {
  return [operation, ...extraBlockedLabels(operation), ...FAILURE_STATUS_LABELS_TO_REMOVE];
}

/**
 * @param {string} operation
 * @returns {string[]}
 */
function extraBlockedLabels(operation) {
  if (
    operation === PULL_OPS_OPERATION_LABELS.prAddressReview ||
    operation === PULL_OPS_OPERATION_LABELS.prFixCi
  ) {
    return [PULL_OPS_OPERATION_LABELS.prReview];
  }

  return [];
}

/**
 * @param {string} operation
 * @returns {string}
 */
function formatOperationCommand(operation) {
  return operation.replace(/^pullops:/, '').replaceAll(':', '-');
}

/**
 * @param {string[]} values
 * @returns {string}
 */
function formatList(values) {
  return values.length === 0 ? 'none reported' : values.join(', ');
}

/**
 * @param {{ kind: 'issue' | 'parentIssue', number: number }} source
 * @returns {string}
 */
function formatSourceLine(source) {
  return source.kind === 'parentIssue'
    ? `Source: Parent Issue #${source.number}`
    : `Source: Issue #${source.number}`;
}

/**
 * @param {string | undefined} actor
 * @returns {string}
 */
function formatActor(actor) {
  if (actor === undefined || actor.trim() === '') {
    return 'unknown';
  }

  return actor.startsWith('@') ? actor : `@${actor}`;
}

/**
 * @param {string} body
 * @returns {{ number: number, kind: 'issue' | 'parentIssue' } | undefined}
 */
function readSource(body) {
  const sourceMatch = body.match(/^Source:\s*(Parent\s+)?Issue\s+#(\d+)\s*$/im);
  if (sourceMatch?.[2] !== undefined) {
    return {
      number: Number(sourceMatch[2]),
      kind: sourceMatch[1] === undefined ? 'issue' : 'parentIssue',
    };
  }

  const closesMatch = body.match(/^Closes\s+#(\d+)\s*$/im);
  if (closesMatch?.[1] !== undefined) {
    return {
      number: Number(closesMatch[1]),
      kind: 'issue',
    };
  }

  return undefined;
}

/**
 * @param {string} body
 * @param {string} prefix
 * @returns {string | undefined}
 */
function readMarker(body, prefix) {
  const pattern = new RegExp(`^${escapeRegExp(prefix)}\\s*(.+?)\\s*$`, 'im');
  const match = body.match(pattern);
  return match?.[1]?.trim();
}

/**
 * @param {string} body
 * @returns {{ current: number, max: number }}
 */
function readReviewCycles(body) {
  const match = body.match(/^Review cycles:\s*(\d+)\s*\/\s*(\d+)\s*$/im);
  if (match?.[1] === undefined || match[2] === undefined) {
    return {
      current: 0,
      max: DEFAULT_MAX_REVIEW_CYCLES,
    };
  }

  return {
    current: Number(match[1]),
    max: Number(match[2]),
  };
}

/**
 * @param {string} body
 * @returns {{ current: number, max: number }}
 */
function readCiFixCycles(body) {
  const match = body.match(/^CI fix cycles:\s*(\d+)\s*\/\s*(\d+)\s*$/im);
  if (match?.[1] === undefined || match[2] === undefined) {
    return {
      current: 0,
      max: DEFAULT_MAX_CI_FIX_CYCLES,
    };
  }

  return {
    current: Number(match[1]),
    max: Number(match[2]),
  };
}

/**
 * @param {string} body
 * @param {string} prefix
 * @param {string} value
 * @returns {string}
 */
function upsertLine(body, prefix, value) {
  const replacement = `${prefix} ${value}`;
  const pattern = new RegExp(`^${escapeRegExp(prefix)}\\s*.*$`, 'im');
  if (pattern.test(body)) {
    return body.replace(pattern, replacement);
  }

  return `${body}\n${replacement}`;
}

/**
 * @param {string} body
 * @returns {string}
 */
function removeMergePreparationMarkers(body) {
  let updated = body;
  for (const prefix of ['Reviewed tree:', 'Finalized tree:', 'Finalized head:', 'Merge method:']) {
    updated = removeLine(updated, prefix);
  }
  return updated.trimEnd();
}

/**
 * @param {string} body
 * @param {string} prefix
 * @returns {string}
 */
function removeLine(body, prefix) {
  const pattern = new RegExp(`^${escapeRegExp(prefix)}\\s*.*\\n?`, 'im');
  return body.replace(pattern, '');
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
