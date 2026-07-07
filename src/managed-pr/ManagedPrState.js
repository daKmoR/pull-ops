import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PULL_OPS_STATUS_LABEL_NAMES, PULL_OPS_STATUS_LABELS } from '../labels/pullOpsLabels.js';
import {
  getOperationCatalogOperationLabelNamesForTarget,
  requireOperationCatalogOperationLabelName,
} from '../operations/operationCatalog.js';

/**
 * @typedef {import('./ManagedPrState.types.js').ApplyManagedPrTransitionOptions} ApplyManagedPrTransitionOptions
 * @typedef {import('./ManagedPrState.types.js').InternalTransition} InternalTransition
 * @typedef {import('./ManagedPrState.types.js').ManagedPrState} ManagedPrState
 * @typedef {import('./ManagedPrState.types.js').ManagedPrStateSectionOptions} ManagedPrStateSectionOptions
 * @typedef {import('./ManagedPrState.types.js').ManagedPrTransitionOutcome} ManagedPrTransitionOutcome
 * @typedef {import('./ManagedPrState.types.js').ManagedPrTransitionResult} ManagedPrTransitionResult
 * @typedef {import('./ManagedPrState.types.js').ManagedPrReviewMode} ManagedPrReviewMode
 * @typedef {import('./ManagedPrState.types.js').ManagedPrWorkflowOptions} ManagedPrWorkflowOptions
 * @typedef {import('./ManagedPrState.types.js').ManagedPrWorkflowResult} ManagedPrWorkflowResult
 * @typedef {import('./ManagedPrState.types.js').RefusePrOperationTargetOptions} RefusePrOperationTargetOptions
 * @typedef {import('./ManagedPrState.types.js').UpdateManagedPrStateOptions} UpdateManagedPrStateOptions
 */

// Cycle counters are telemetry and generous backstop guards; the primary
// continuation gate is the Run Budget plus verifiable progress.
export const DEFAULT_MAX_REVIEW_CYCLES = 10;
export const DEFAULT_MAX_CI_FIX_CYCLES = 6;
export const DEFAULT_MAX_ESCALATION_REVIEW_CYCLES = 1;

// Marker sentinel that clears the recorded rejected tree once a later
// operation has changed the tree, so no-progress detection never blocks a
// cycle that did real work.
const CLEARED_LAST_CYCLE_TREE_HASH = 'none';

/** @type {ReadonlySet<string>} */
const PR_OPERATION_LABELS = new Set([
  requireOperationCatalogOperationLabelName('pr-review'),
  requireOperationCatalogOperationLabelName('pr-address-review'),
  requireOperationCatalogOperationLabelName('pr-fix-ci'),
  requireOperationCatalogOperationLabelName('pr-update-branch'),
  requireOperationCatalogOperationLabelName('pr-resolve-conflicts'),
  requireOperationCatalogOperationLabelName('pr-finalize'),
]);

/** @type {ReadonlySet<string>} */
const ACTIVE_PULL_OPS_PR_LABELS = new Set([
  ...getOperationCatalogOperationLabelNamesForTarget('pr'),
  ...PULL_OPS_STATUS_LABEL_NAMES,
]);

/**
 * @returns {{ current: number, max: number }}
 */
function createExhaustedEscalationReviewCycles() {
  return {
    current: DEFAULT_MAX_ESCALATION_REVIEW_CYCLES,
    max: DEFAULT_MAX_ESCALATION_REVIEW_CYCLES,
  };
}

/**
 * @param {ManagedPrState} state
 * @returns {boolean}
 */
function hasEscalationReviewCapacity(state) {
  return (
    state.escalationReviewCycles !== undefined &&
    state.escalationReviewCycles.current < state.escalationReviewCycles.max
  );
}

/**
 * @param {ManagedPrState} state
 * @param {string} reviewId
 * @returns {boolean}
 */
function isHumanFeedbackReviewProcessed(state, reviewId) {
  return state.processedHumanFeedbackReviewIds?.includes(reviewId) ?? false;
}

/**
 * @param {ManagedPrState} state
 * @returns {boolean}
 */
function isPendingHumanFeedbackResponse(state) {
  const pendingReviewId = state.pendingHumanFeedbackReviewId;
  if (pendingReviewId === undefined) {
    return false;
  }

  return !isHumanFeedbackReviewProcessed(state, pendingReviewId);
}

/**
 * @param {ManagedPrState} state
 * @param {ManagedPrReviewMode | undefined} explicitReviewMode
 * @returns {ManagedPrReviewMode}
 */
function resolveCompletedPrReviewMode(state, explicitReviewMode) {
  if (explicitReviewMode !== undefined) {
    return explicitReviewMode;
  }

  if (isPendingHumanFeedbackResponse(state)) {
    return 'human-feedback-response';
  }

  if (state.reviewCycles.current >= state.reviewCycles.max && hasEscalationReviewCapacity(state)) {
    return 'escalation';
  }

  return 'normal';
}

/**
 * @param {ManagedPrState} state
 * @param {ManagedPrReviewMode | undefined} reviewMode
 * @param {'approved' | 'changes-requested' | undefined} reviewResult
 * @returns {Pick<
 *   UpdateManagedPrStateOptions,
 *   | 'escalationReviewCycles'
 *   | 'humanFeedbackResponseCycles'
 *   | 'processedHumanFeedbackReviewIds'
 *   | 'pendingHumanFeedbackReviewId'
 * >}
 */
function createPrReviewSpecialStateUpdate(state, reviewMode, reviewResult) {
  const resolvedReviewMode = resolveCompletedPrReviewMode(state, reviewMode);
  if (resolvedReviewMode === 'escalation') {
    // Count the special cycle when escalation review closes out the loop, not on the
    // first changes-requested pass that sends the PR back through address-review.
    const shouldCountEscalationReview =
      reviewResult === 'approved' ||
      state.lastOperation === requireOperationCatalogOperationLabelName('pr-address-review');

    if (!shouldCountEscalationReview) {
      return {};
    }

    const escalationReviewCycles =
      state.escalationReviewCycles ?? createExhaustedEscalationReviewCycles();

    return {
      escalationReviewCycles: {
        current: Math.min(escalationReviewCycles.current + 1, escalationReviewCycles.max),
        max: escalationReviewCycles.max,
      },
    };
  }

  if (resolvedReviewMode !== 'human-feedback-response') {
    return {};
  }

  const pendingReviewId = state.pendingHumanFeedbackReviewId;
  if (pendingReviewId === undefined || isHumanFeedbackReviewProcessed(state, pendingReviewId)) {
    return {};
  }

  const processedHumanFeedbackReviewIds = state.processedHumanFeedbackReviewIds ?? [];
  const nextProcessedHumanFeedbackReviewIds = processedHumanFeedbackReviewIds.includes(
    pendingReviewId,
  )
    ? processedHumanFeedbackReviewIds
    : [...processedHumanFeedbackReviewIds, pendingReviewId];

  return {
    humanFeedbackResponseCycles:
      (state.humanFeedbackResponseCycles ?? processedHumanFeedbackReviewIds.length) + 1,
    processedHumanFeedbackReviewIds: nextProcessedHumanFeedbackReviewIds,
    pendingHumanFeedbackReviewId: 'none',
  };
}

/**
 * @param {ManagedPrState} state
 * @param {string | undefined} reviewId
 * @returns {Pick<UpdateManagedPrStateOptions, 'pendingHumanFeedbackReviewId'>}
 */
function createPrAddressReviewSpecialStateUpdate(state, reviewId) {
  if (reviewId === undefined || isHumanFeedbackReviewProcessed(state, reviewId)) {
    return {};
  }

  const pendingReviewId = state.pendingHumanFeedbackReviewId;
  if (
    pendingReviewId !== undefined &&
    pendingReviewId !== reviewId &&
    !isHumanFeedbackReviewProcessed(state, pendingReviewId)
  ) {
    return {};
  }

  return {
    pendingHumanFeedbackReviewId: reviewId,
  };
}

/**
 * @param {string} body
 * @returns {ManagedPrState}
 */
export function readManagedPrState(body) {
  const pullOpsState = readPullOpsStateMarker(body);
  const workflowState = readWorkflowStateBlock(body) ?? '';
  const source = readSource({ body, workflowState });
  const humanFeedbackResponseStateMarkersPresent =
    hasHumanFeedbackResponseStateMarkers(workflowState);
  const processedHumanFeedbackReviewIds = readProcessedHumanFeedbackReviewIds(workflowState);
  const humanFeedbackResponseCycles =
    readHumanFeedbackResponseCycles(workflowState) ?? processedHumanFeedbackReviewIds?.length;

  return {
    managed: pullOpsState.managed,
    ...(pullOpsState.status === undefined ? {} : { status: pullOpsState.status }),
    ...(source === undefined
      ? {}
      : {
          sourceIssueNumber: source.number,
          sourceKind: source.kind,
        }),
    lastOperation: readMarker(workflowState, 'Last operation:'),
    reviewedTreeHash: readMarker(workflowState, 'Reviewed tree:'),
    finalizedTreeHash: readMarker(workflowState, 'Finalized tree:'),
    finalizedHeadSha: readMarker(workflowState, 'Finalized head:'),
    mergeMethod: readMarker(workflowState, 'Merge method:'),
    reviewCycles: readReviewCycles(workflowState),
    escalationReviewCycles: readEscalationReviewCycles(workflowState),
    humanFeedbackResponseStateMarkersPresent,
    ...(humanFeedbackResponseCycles === undefined ? {} : { humanFeedbackResponseCycles }),
    ...(processedHumanFeedbackReviewIds === undefined ? {} : { processedHumanFeedbackReviewIds }),
    pendingHumanFeedbackReviewId: readPendingHumanFeedbackReviewId(workflowState),
    reviewFollowUpIssueNumbers: readReviewFollowUpIssueNumbers(workflowState),
    ciFixCycles: readCiFixCycles(workflowState),
    runBudgetUsage: readRunBudgetUsage(workflowState),
    lastCycleTreeHash: readLastCycleTreeHash(workflowState),
  };
}

/**
 * @param {string} body
 * @returns {string | undefined}
 */
function readLastCycleTreeHash(body) {
  const value = readMarker(body, 'Last cycle tree:');
  return value === undefined || value === CLEARED_LAST_CYCLE_TREE_HASH ? undefined : value;
}

/**
 * Read the accumulated operation usage a target's Run Budget is charged
 * against from a PullOps Workflow State block. Absent markers mean nothing
 * has been recorded yet.
 *
 * @param {string} body
 * @returns {import('./ManagedPrState.types.js').ManagedPrRunBudgetUsage}
 */
function readRunBudgetUsage(body) {
  return {
    usedTokens: readNonNegativeIntegerMarker(body, 'Run budget used tokens:') ?? 0,
    durationMs: readNonNegativeIntegerMarker(body, 'Run budget used ms:') ?? 0,
  };
}

/**
 * @param {string} body
 * @param {string} prefix
 * @returns {number | undefined}
 */
function readNonNegativeIntegerMarker(body, prefix) {
  const value = readMarker(body, prefix);
  if (value === undefined || !/^\d+$/.test(value)) {
    return undefined;
  }

  return Number(value);
}

/**
 * Read the operation usage that should be charged to a target's Run Budget
 * from an operation runner context: runner-reported Context Usage tokens
 * and elapsed wall-clock time since the operation was dispatched. Unknown
 * components stay unknown rather than being estimated.
 *
 * @param {import('../cli/types.js').OperationRunnerContext} context
 * @param {Date} [now]
 * @returns {import('./ManagedPrState.types.js').ManagedPrOperationUsage}
 */
export function readOperationBudgetUsage(context, now = new Date()) {
  const usedTokens = context.contextUsage?.used;
  const durationMs =
    context.operationStartedAt === undefined
      ? undefined
      : Math.max(0, now.getTime() - context.operationStartedAt.getTime());

  return {
    ...(usedTokens === undefined ? {} : { usedTokens }),
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

/**
 * Decide whether a target's accumulated usage has exhausted the configured
 * Run Budget. This is the primary continuation gate for PullOps-Managed PR
 * automation; cycle counters remain only as generous backstops.
 *
 * @param {import('./ManagedPrState.types.js').ManagedPrState} state
 * @param {import('../config/types.js').RunBudgetConfig} runBudget
 * @returns {import('./ManagedPrState.types.js').ManagedPrRunBudgetExhaustion}
 */
export function readRunBudgetExhaustion(state, runBudget) {
  const { usedTokens, durationMs } = state.runBudgetUsage;
  if (usedTokens >= runBudget.maxUsedTokens) {
    return {
      exhausted: true,
      reason: `Run Budget exhausted: ${usedTokens} / ${runBudget.maxUsedTokens} tokens used.`,
    };
  }

  if (durationMs >= runBudget.maxDurationMs) {
    return {
      exhausted: true,
      reason: `Run Budget exhausted: ${durationMs} / ${runBudget.maxDurationMs} ms of operation time used.`,
    };
  }

  return { exhausted: false };
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
    labels: [requireOperationCatalogOperationLabelName('pr-review')],
  });

  return {
    status: 'review-requested',
    pullRequest: formatPullRequest(pullRequest),
    nextOperation: requireOperationCatalogOperationLabelName('pr-review'),
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
  lastOperation,
  reviewCycles,
  escalationReviewCycles,
  humanFeedbackResponseCycles,
  processedHumanFeedbackReviewIds,
  pendingHumanFeedbackReviewId,
  reviewFollowUpIssueNumbers,
  ciFixCycles,
}) {
  const resolvedProcessedIds = processedHumanFeedbackReviewIds ?? [];
  const resolvedHumanFeedbackResponseCycles =
    humanFeedbackResponseCycles ?? resolvedProcessedIds.length;
  const resolvedPendingHumanFeedbackReviewId =
    pendingHumanFeedbackReviewId === undefined ? 'none' : pendingHumanFeedbackReviewId;
  const resolvedEscalationReviewCycles = escalationReviewCycles ?? {
    current: 0,
    max: DEFAULT_MAX_ESCALATION_REVIEW_CYCLES,
  };
  const workflowState = [
    formatSourceLine(source),
    ...(reviewCycles === undefined
      ? []
      : [`Review cycles: ${reviewCycles.current} / ${reviewCycles.max}`]),
    `Escalation review cycles: ${resolvedEscalationReviewCycles.current} / ${resolvedEscalationReviewCycles.max}`,
    `Human feedback response cycles: ${resolvedHumanFeedbackResponseCycles}`,
    `Processed human feedback review ids: ${formatHumanFeedbackReviewIds(resolvedProcessedIds)}`,
    `Pending human feedback review id: ${resolvedPendingHumanFeedbackReviewId}`,
    ...(reviewFollowUpIssueNumbers === undefined
      ? []
      : [
          `Review follow-up issue numbers: ${formatReviewFollowUpIssueNumbers(
            reviewFollowUpIssueNumbers,
          )}`,
        ]),
    ...(ciFixCycles === undefined
      ? []
      : [`CI fix cycles: ${ciFixCycles.current} / ${ciFixCycles.max}`]),
    `Last operation: ${lastOperation}`,
  ].join('\n');

  return [
    '## PullOps',
    '',
    'Managed: yes',
    `Status: ${status}`,
    '',
    formatWorkflowStateBlock(workflowState),
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
  escalationReviewCycles,
  humanFeedbackResponseCycles,
  processedHumanFeedbackReviewIds,
  pendingHumanFeedbackReviewId,
  reviewFollowUpIssueNumbers,
  ciFixCycles,
  reviewedTreeHash,
  finalizedTreeHash,
  finalizedHeadSha,
  mergeMethod,
  runBudgetUsage,
  lastCycleTreeHash,
  removeMergePreparationMarkers: shouldRemoveMergePreparationMarkers = false,
}) {
  let updated = body.trimEnd();
  let workflowState = readWorkflowStateBlock(updated) ?? '';
  const currentState = readManagedPrState(body);
  const resolvedEscalationReviewCycles =
    escalationReviewCycles ??
    currentState.escalationReviewCycles ??
    createExhaustedEscalationReviewCycles();
  const resolvedProcessedHumanFeedbackReviewIds =
    processedHumanFeedbackReviewIds ?? currentState.processedHumanFeedbackReviewIds ?? [];
  const resolvedHumanFeedbackResponseCycles =
    humanFeedbackResponseCycles ??
    currentState.humanFeedbackResponseCycles ??
    resolvedProcessedHumanFeedbackReviewIds.length;
  const resolvedPendingHumanFeedbackReviewId =
    pendingHumanFeedbackReviewId !== undefined
      ? pendingHumanFeedbackReviewId
      : currentState.pendingHumanFeedbackReviewId;
  const resolvedReviewFollowUpIssueNumbers =
    reviewFollowUpIssueNumbers ?? currentState.reviewFollowUpIssueNumbers;

  if (status !== undefined) {
    updated = upsertLine(updated, 'Status:', status);
  }

  if (reviewCycles !== undefined) {
    workflowState = upsertLine(
      workflowState,
      'Review cycles:',
      `${reviewCycles.current} / ${reviewCycles.max}`,
    );
  }

  if (ciFixCycles !== undefined) {
    workflowState = upsertLine(
      workflowState,
      'CI fix cycles:',
      `${ciFixCycles.current} / ${ciFixCycles.max}`,
    );
  }

  if (shouldRemoveMergePreparationMarkers) {
    updated = removeMergePreparationMarkersOutsideWorkflowStateBlock(updated);
    workflowState = removeMergePreparationMarkers(workflowState);
  }

  workflowState = upsertLine(
    workflowState,
    'Escalation review cycles:',
    `${resolvedEscalationReviewCycles.current} / ${resolvedEscalationReviewCycles.max}`,
  );
  workflowState = upsertLine(
    workflowState,
    'Human feedback response cycles:',
    String(resolvedHumanFeedbackResponseCycles),
  );
  workflowState = upsertLine(
    workflowState,
    'Processed human feedback review ids:',
    formatHumanFeedbackReviewIds(resolvedProcessedHumanFeedbackReviewIds),
  );
  workflowState = upsertLine(
    workflowState,
    'Pending human feedback review id:',
    resolvedPendingHumanFeedbackReviewId ?? 'none',
  );
  if (resolvedReviewFollowUpIssueNumbers !== undefined) {
    workflowState = upsertLine(
      workflowState,
      'Review follow-up issue numbers:',
      formatReviewFollowUpIssueNumbers(resolvedReviewFollowUpIssueNumbers),
    );
  }

  if (reviewedTreeHash !== undefined) {
    workflowState = upsertLine(workflowState, 'Reviewed tree:', reviewedTreeHash);
  }

  if (finalizedTreeHash !== undefined) {
    workflowState = upsertLine(workflowState, 'Finalized tree:', finalizedTreeHash);
  }

  if (finalizedHeadSha !== undefined) {
    workflowState = upsertLine(workflowState, 'Finalized head:', finalizedHeadSha);
  }

  if (mergeMethod !== undefined) {
    workflowState = upsertLine(workflowState, 'Merge method:', mergeMethod);
  }

  if (runBudgetUsage !== undefined) {
    workflowState = upsertLine(
      workflowState,
      'Run budget used tokens:',
      String(runBudgetUsage.usedTokens),
    );
    workflowState = upsertLine(
      workflowState,
      'Run budget used ms:',
      String(runBudgetUsage.durationMs),
    );
  }

  if (lastCycleTreeHash !== undefined) {
    workflowState = upsertLine(workflowState, 'Last cycle tree:', lastCycleTreeHash);
  }

  if (lastOperation !== undefined) {
    workflowState = upsertLine(workflowState, 'Last operation:', lastOperation);
  }

  updated = replaceWorkflowStateBlock(updated, workflowState);

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
  usage,
  suppressFollowUpOperationLabels = false,
}) {
  assertPrOperation(operation);

  const state = readManagedPrState(pullRequest.body);
  if (!state.managed) {
    throw new Error(
      `Cannot apply ${operation} transition to PR #${pullRequest.number} without a PullOps-managed PR State Marker.`,
    );
  }

  const transition = suppressFollowUpOperationLabels
    ? withoutFollowUpOperationLabels(
        createTransition({ body: pullRequest.body, operation, outcome, state }),
      )
    : createTransition({ body: pullRequest.body, operation, outcome, state });
  chargeRunBudgetUsage({ transition, state, usage, body: pullRequest.body });
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
 * @param {InternalTransition} transition
 * @returns {InternalTransition}
 */
function withoutFollowUpOperationLabels(transition) {
  return {
    ...transition,
    addLabelsAfterRemove: transition.addLabelsAfterRemove.filter(
      label => !PR_OPERATION_LABELS.has(label),
    ),
    nextOperationLabel: undefined,
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

  if (operation === requireOperationCatalogOperationLabelName('pr-review')) {
    return createPrReviewTransition({ body, outcome, state });
  }

  if (operation === requireOperationCatalogOperationLabelName('pr-address-review')) {
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
        ...createPrAddressReviewSpecialStateUpdate(state, outcome.reviewId),
        removeMergePreparationMarkers: true,
        // Feedback was addressed, so the rejected tree recorded by the last
        // changes-requested review is stale for no-progress detection.
        lastCycleTreeHash: CLEARED_LAST_CYCLE_TREE_HASH,
        lastOperation: operation,
      }),
      removeLabels: labelsForSuccessfulOperation(
        operation,
        requireOperationCatalogOperationLabelName('pr-review'),
      ),
      addLabelsAfterRemove: [requireOperationCatalogOperationLabelName('pr-review')],
      addLabelsBeforeRemove: [],
      nextOperationLabel: requireOperationCatalogOperationLabelName('pr-review'),
    };
  }

  if (operation === requireOperationCatalogOperationLabelName('pr-fix-ci')) {
    return createPrFixCiTransition({ body, outcome });
  }

  if (operation === requireOperationCatalogOperationLabelName('pr-update-branch')) {
    return createPrUpdateBranchTransition({ body, outcome });
  }

  if (operation === requireOperationCatalogOperationLabelName('pr-resolve-conflicts')) {
    return {
      body: updateManagedPrState({
        body,
        status: 'Rebase conflicts resolved',
        removeMergePreparationMarkers: true,
        lastOperation: operation,
      }),
      removeLabels: labelsForSuccessfulOperation(
        operation,
        requireOperationCatalogOperationLabelName('pr-review'),
      ),
      addLabelsAfterRemove: [requireOperationCatalogOperationLabelName('pr-review')],
      addLabelsBeforeRemove: [],
      nextOperationLabel: requireOperationCatalogOperationLabelName('pr-review'),
    };
  }

  return createPrFinalizeTransition({ body, outcome });
}

/**
 * @param {{ body: string, outcome: ManagedPrTransitionOutcome, state: ManagedPrState }} options
 * @returns {InternalTransition}
 */
function createPrReviewTransition({ body, outcome, state }) {
  const specialStateUpdate = createPrReviewSpecialStateUpdate(
    state,
    outcome.kind === 'approved' || outcome.kind === 'changes-requested'
      ? outcome.reviewMode
      : undefined,
    outcome.kind === 'approved' || outcome.kind === 'changes-requested' ? outcome.kind : undefined,
  );

  if (outcome.kind === 'approved') {
    const finalizedReview =
      state.lastOperation === requireOperationCatalogOperationLabelName('pr-finalize');
    return {
      body: updateManagedPrState({
        body,
        status: finalizedReview ? 'Ready for human merge' : 'Review approved',
        reviewCycles: {
          current: outcome.reviewCycle,
          max: outcome.maxReviewCycles,
        },
        ...specialStateUpdate,
        reviewedTreeHash: outcome.reviewedTreeHash,
        reviewFollowUpIssueNumbers: outcome.reviewFollowUpIssueNumbers,
        lastOperation: requireOperationCatalogOperationLabelName('pr-review'),
      }),
      removeLabels: labelsForSuccessfulOperation(
        requireOperationCatalogOperationLabelName('pr-review'),
        finalizedReview ? undefined : requireOperationCatalogOperationLabelName('pr-finalize'),
      ),
      addLabelsAfterRemove: finalizedReview
        ? []
        : [requireOperationCatalogOperationLabelName('pr-finalize')],
      addLabelsBeforeRemove: [],
      ...(finalizedReview
        ? {}
        : { nextOperationLabel: requireOperationCatalogOperationLabelName('pr-finalize') }),
    };
  }

  if (outcome.kind !== 'changes-requested') {
    throw new Error(
      `${outcome.kind} is not a valid ${requireOperationCatalogOperationLabelName('pr-review')} PullOps-Managed PR outcome.`,
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
      ...specialStateUpdate,
      removeMergePreparationMarkers: true,
      lastOperation: requireOperationCatalogOperationLabelName('pr-review'),
    }),
    removeLabels: labelsForSuccessfulOperation(
      requireOperationCatalogOperationLabelName('pr-review'),
      requireOperationCatalogOperationLabelName('pr-address-review'),
    ),
    addLabelsAfterRemove: [requireOperationCatalogOperationLabelName('pr-address-review')],
    addLabelsBeforeRemove: [],
    nextOperationLabel: requireOperationCatalogOperationLabelName('pr-address-review'),
  };
}

/**
 * @param {{ body: string, outcome: ManagedPrTransitionOutcome }} options
 * @returns {InternalTransition}
 */
function createPrFixCiTransition({ body, outcome }) {
  if (outcome.kind === 'no-failed-checks') {
    return {
      removeLabels: labelsForSuccessfulOperation(
        requireOperationCatalogOperationLabelName('pr-fix-ci'),
        requireOperationCatalogOperationLabelName('pr-review'),
      ),
      addLabelsAfterRemove: [requireOperationCatalogOperationLabelName('pr-review')],
      addLabelsBeforeRemove: [],
      nextOperationLabel: requireOperationCatalogOperationLabelName('pr-review'),
    };
  }

  if (outcome.kind !== 'fixed') {
    throw new Error(
      `${outcome.kind} is not a valid ${requireOperationCatalogOperationLabelName('pr-fix-ci')} PullOps-Managed PR outcome.`,
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
      removeMergePreparationMarkers: true,
      // The CI repair changed the tree, so the rejected tree recorded by
      // the last changes-requested review is stale for no-progress checks.
      lastCycleTreeHash: CLEARED_LAST_CYCLE_TREE_HASH,
      lastOperation: requireOperationCatalogOperationLabelName('pr-fix-ci'),
    }),
    removeLabels: labelsForSuccessfulOperation(
      requireOperationCatalogOperationLabelName('pr-fix-ci'),
      requireOperationCatalogOperationLabelName('pr-review'),
    ),
    addLabelsAfterRemove: [requireOperationCatalogOperationLabelName('pr-review')],
    addLabelsBeforeRemove: [],
    nextOperationLabel: requireOperationCatalogOperationLabelName('pr-review'),
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
        lastOperation: requireOperationCatalogOperationLabelName('pr-update-branch'),
      }),
      removeLabels: labelsForSuccessfulOperation(
        requireOperationCatalogOperationLabelName('pr-update-branch'),
        requireOperationCatalogOperationLabelName('pr-resolve-conflicts'),
      ),
      addLabelsAfterRemove: [requireOperationCatalogOperationLabelName('pr-resolve-conflicts')],
      addLabelsBeforeRemove: [],
      commentBody: [
        'PullOps could not complete `pullops run pr-update-branch` without conflicts.',
        '',
        `Base branch: ${outcome.baseBranch}`,
        `Conflicted files: ${formatList(outcome.conflictedFiles)}`,
        `Next operation: ${requireOperationCatalogOperationLabelName('pr-resolve-conflicts')}`,
      ].join('\n'),
      nextOperationLabel: requireOperationCatalogOperationLabelName('pr-resolve-conflicts'),
    };
  }

  if (outcome.kind !== 'updated') {
    throw new Error(
      `${outcome.kind} is not a valid ${requireOperationCatalogOperationLabelName('pr-update-branch')} PullOps-Managed PR outcome.`,
    );
  }

  return {
    body: updateManagedPrState({
      body,
      status: 'Branch updated',
      removeMergePreparationMarkers: true,
      lastOperation: requireOperationCatalogOperationLabelName('pr-update-branch'),
    }),
    removeLabels: labelsForSuccessfulOperation(
      requireOperationCatalogOperationLabelName('pr-update-branch'),
    ),
    addLabelsAfterRemove: [],
    addLabelsBeforeRemove: [],
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
        status: 'Ready for human merge',
        finalizedTreeHash: outcome.finalizedTreeHash,
        finalizedHeadSha: outcome.finalizedHeadSha,
        mergeMethod: 'rebase',
        lastOperation: requireOperationCatalogOperationLabelName('pr-finalize'),
      }),
      removeLabels: labelsForSuccessfulOperation(
        requireOperationCatalogOperationLabelName('pr-finalize'),
      ),
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
        lastOperation: requireOperationCatalogOperationLabelName('pr-finalize'),
      }),
      failureReason: outcome.reason,
      removeLabels: labelsForSuccessfulOperation(
        requireOperationCatalogOperationLabelName('pr-finalize'),
        requireOperationCatalogOperationLabelName('pr-review'),
      ),
      addLabelsAfterRemove: [requireOperationCatalogOperationLabelName('pr-review')],
      addLabelsBeforeRemove: [],
      commentBody: [
        'PullOps routed `pullops run pr-finalize` back to review.',
        '',
        `Reason: ${outcome.reason}`,
      ].join('\n'),
      nextOperationLabel: requireOperationCatalogOperationLabelName('pr-review'),
    };
  }

  if (outcome.kind !== 'route-to-ci-fix') {
    throw new Error(
      `${outcome.kind} is not a valid ${requireOperationCatalogOperationLabelName('pr-finalize')} PullOps-Managed PR outcome.`,
    );
  }

  return {
    failureReason: outcome.reason,
    removeLabels: labelsForSuccessfulOperation(
      requireOperationCatalogOperationLabelName('pr-finalize'),
      requireOperationCatalogOperationLabelName('pr-fix-ci'),
    ),
    addLabelsAfterRemove: [requireOperationCatalogOperationLabelName('pr-fix-ci')],
    addLabelsBeforeRemove: [],
    commentBody: [
      'PullOps routed `pullops run pr-finalize` to CI repair.',
      '',
      `Reason: ${outcome.reason}`,
    ].join('\n'),
    nextOperationLabel: requireOperationCatalogOperationLabelName('pr-fix-ci'),
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
    addLabelsBeforeRemove: [PULL_OPS_STATUS_LABELS.humanRequired],
    addLabelsAfterRemove: [],
    commentBody: [
      `PullOps could not complete \`pullops run ${formatOperationCommand(operation)}\`.`,
      '',
      `Reason: ${reason}`,
    ].join('\n'),
    statusLabel: PULL_OPS_STATUS_LABELS.humanRequired,
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
  if (operation === requireOperationCatalogOperationLabelName('pr-review')) {
    return updateManagedPrState({
      body,
      status: 'Human required',
      reviewCycles: {
        current: reviewCycle ?? state.reviewCycles.current,
        max: maxReviewCycles ?? state.reviewCycles.max,
      },
      removeMergePreparationMarkers: true,
      lastOperation: operation,
    });
  }

  if (operation === requireOperationCatalogOperationLabelName('pr-address-review')) {
    return updateManagedPrState({
      body,
      status: 'Human required',
      reviewCycles: {
        current: reviewCycle ?? state.reviewCycles.current,
        max: maxReviewCycles ?? state.reviewCycles.max,
      },
      lastOperation: operation,
    });
  }

  if (operation === requireOperationCatalogOperationLabelName('pr-fix-ci')) {
    return updateManagedPrState({
      body,
      status: 'Human required',
      ciFixCycles: {
        current: ciFixCycle ?? state.ciFixCycles.current,
        max: maxCiFixCycles ?? state.ciFixCycles.max,
      },
      lastOperation: operation,
    });
  }

  return updateManagedPrState({
    body,
    status: 'Human required',
    removeMergePreparationMarkers:
      operation === requireOperationCatalogOperationLabelName('pr-update-branch') ||
      operation === requireOperationCatalogOperationLabelName('pr-resolve-conflicts'),
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
  if (operation === requireOperationCatalogOperationLabelName('pr-review')) {
    return ['approved', 'changes-requested', 'blocked'];
  }

  if (operation === requireOperationCatalogOperationLabelName('pr-address-review')) {
    return ['addressed', 'blocked'];
  }

  if (operation === requireOperationCatalogOperationLabelName('pr-fix-ci')) {
    return ['fixed', 'no-failed-checks', 'blocked'];
  }

  if (operation === requireOperationCatalogOperationLabelName('pr-update-branch')) {
    return ['updated', 'conflicts-found', 'blocked'];
  }

  if (operation === requireOperationCatalogOperationLabelName('pr-resolve-conflicts')) {
    return ['resolved', 'blocked'];
  }

  return ['ready', 'route-to-review', 'route-to-ci-fix', 'blocked'];
}

/**
 * @param {{ body: string, state: ManagedPrState }} options
 * @returns {string | undefined}
 */
function chooseNextManagedPrOperation({ body, state }) {
  const status = state.status ?? readPullOpsStateMarker(body).status;

  if (isFinalizedForRebase(state)) {
    return undefined;
  }

  if (state.reviewedTreeHash !== undefined || status === 'Review approved') {
    return requireOperationCatalogOperationLabelName('pr-finalize');
  }

  if (status === 'Changes requested') {
    return requireOperationCatalogOperationLabelName('pr-address-review');
  }

  if (
    status === 'Review feedback addressed' ||
    status === 'Draft automation' ||
    state.lastOperation === requireOperationCatalogOperationLabelName('issue-implement') ||
    state.lastOperation === requireOperationCatalogOperationLabelName('pr-address-review')
  ) {
    return requireOperationCatalogOperationLabelName('pr-review');
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
 * @param {string | undefined} nextOperation
 * @returns {string[]}
 */
function labelsForSuccessfulOperation(operation, nextOperation = undefined) {
  return [
    ...new Set([
      operation,
      ...(nextOperation === undefined ? [] : [nextOperation]),
      PULL_OPS_STATUS_LABELS.humanRequired,
    ]),
  ];
}

/**
 * @param {string} operation
 * @returns {string[]}
 */
function labelsForBlockedOperation(operation) {
  return [operation, ...extraBlockedLabels(operation)];
}

/**
 * @param {string} operation
 * @returns {string[]}
 */
function extraBlockedLabels(operation) {
  if (
    operation === requireOperationCatalogOperationLabelName('pr-address-review') ||
    operation === requireOperationCatalogOperationLabelName('pr-fix-ci')
  ) {
    return [requireOperationCatalogOperationLabelName('pr-review')];
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
/**
 * @param {{ body: string, workflowState: string }} options
 * @returns {{ number: number, kind: 'issue' | 'parentIssue' } | undefined}
 */
function readSource({ body, workflowState }) {
  const sourceMatch = workflowState.match(/^Source:\s*(Parent\s+)?Issue\s+#(\d+)\s*$/im);
  if (sourceMatch?.[2] !== undefined) {
    return {
      number: Number(sourceMatch[2]),
      kind: sourceMatch[1] === undefined ? 'issue' : 'parentIssue',
    };
  }

  const sourceIssueMatch = body.match(/^Source Issue:\s*#(\d+)\s*$/im);
  if (sourceIssueMatch?.[1] !== undefined) {
    return {
      number: Number(sourceIssueMatch[1]),
      kind: 'issue',
    };
  }

  const prdIssueMatch = body.match(/^PRD Issue:\s*#(\d+)\s*$/im);
  if (prdIssueMatch?.[1] !== undefined) {
    return {
      number: Number(prdIssueMatch[1]),
      kind: 'parentIssue',
    };
  }

  return undefined;
}

/**
 * @param {string} body
 * @returns {{ managed: boolean, status: string | undefined }}
 */
function readPullOpsStateMarker(body) {
  const section = readMarkdownSection(body, 'PullOps') ?? '';
  const status = readMarker(section, 'Status:');
  return {
    managed: /^Managed:\s*yes\s*$/im.test(section) && status !== undefined,
    status,
  };
}

/**
 * @param {string} body
 * @param {string} title
 * @returns {string | undefined}
 */
function readMarkdownSection(body, title) {
  const headerPattern = new RegExp(`^##\\s+${escapeRegExp(title)}\\s*$`, 'im');
  const header = headerPattern.exec(body);
  if (header === null) {
    return undefined;
  }

  const start = header.index + header[0].length;
  const rest = body.slice(start);
  const nextSectionIndex = rest.search(/^##\s+/m);
  return (nextSectionIndex === -1 ? rest : rest.slice(0, nextSectionIndex)).trim();
}

/**
 * @param {string} body
 * @returns {string | undefined}
 */
function readWorkflowStateBlock(body) {
  const match = body.match(
    /<details>\s*<summary>\s*PullOps workflow state\s*<\/summary>\s*([\s\S]*?)\s*<\/details>/i,
  );
  return match?.[1]?.trim();
}

/**
 * @param {string} content
 * @returns {string}
 */
function formatWorkflowStateBlock(content) {
  return [
    '<details>',
    '<summary>PullOps workflow state</summary>',
    '',
    content.trim(),
    '',
    '</details>',
  ].join('\n');
}

/**
 * @param {string} body
 * @param {string} content
 * @returns {string}
 */
function replaceWorkflowStateBlock(body, content) {
  const replacement = formatWorkflowStateBlock(content);
  const pattern = workflowStateBlockPattern();

  if (pattern.test(body)) {
    return body.replace(pattern, replacement);
  }

  return `${body.trimEnd()}\n\n${replacement}`;
}

/**
 * @param {string} body
 * @returns {string}
 */
function removeMergePreparationMarkersOutsideWorkflowStateBlock(body) {
  const pattern = workflowStateBlockPattern();
  const match = pattern.exec(body);
  if (match === null) {
    return removeMergePreparationMarkers(body);
  }

  const placeholder = '<!-- pullops-workflow-state-placeholder -->';
  const withoutWorkflowState = [
    body.slice(0, match.index),
    placeholder,
    body.slice(match.index + match[0].length),
  ].join('');

  return removeMergePreparationMarkers(withoutWorkflowState).replace(placeholder, match[0]);
}

/**
 * @returns {RegExp}
 */
function workflowStateBlockPattern() {
  return /<details>\s*<summary>\s*PullOps workflow state\s*<\/summary>\s*[\s\S]*?\s*<\/details>/i;
}

/**
 * Charge one operation's usage against the target's Run Budget by
 * accumulating it into the transition's PullOps Workflow State markers.
 * When the transition would not otherwise update the body, the budget
 * charge still forces one so the durable record stays accurate.
 *
 * @param {{
 *   transition: import('./ManagedPrState.types.js').InternalTransition,
 *   state: import('./ManagedPrState.types.js').ManagedPrState,
 *   usage: import('./ManagedPrState.types.js').ManagedPrOperationUsage | undefined,
 *   body: string,
 * }} options
 */
function chargeRunBudgetUsage({ transition, state, usage, body }) {
  if (usage === undefined) {
    return;
  }

  const hasUsage =
    usage.usedTokens !== undefined ||
    usage.durationMs !== undefined ||
    usage.treeHash !== undefined;
  if (!hasUsage) {
    return;
  }

  transition.body = updateManagedPrState({
    body: transition.body ?? body,
    ...(usage.usedTokens === undefined && usage.durationMs === undefined
      ? {}
      : {
          runBudgetUsage: {
            usedTokens: state.runBudgetUsage.usedTokens + (usage.usedTokens ?? 0),
            durationMs: state.runBudgetUsage.durationMs + (usage.durationMs ?? 0),
          },
        }),
    ...(usage.treeHash === undefined ? {} : { lastCycleTreeHash: usage.treeHash }),
  });
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
 * @returns {{ current: number, max: number } | undefined}
 */
function readEscalationReviewCycles(body) {
  const match = body.match(/^Escalation review cycles:\s*(\d+)\s*\/\s*(\d+)\s*$/im);
  if (match?.[1] === undefined || match[2] === undefined) {
    return undefined;
  }

  return {
    current: Number(match[1]),
    max: Number(match[2]),
  };
}

/**
 * @param {string} body
 * @returns {boolean}
 */
function hasHumanFeedbackResponseStateMarkers(body) {
  return (
    /^Human feedback response cycles:\s*\d+\s*$/im.test(body) &&
    /^Processed human feedback review ids:\s*.+$/im.test(body) &&
    /^Pending human feedback review id:\s*.+$/im.test(body)
  );
}

/**
 * @param {string} body
 * @returns {number | undefined}
 */
function readHumanFeedbackResponseCycles(body) {
  const match = body.match(/^Human feedback response cycles:\s*(\d+)\s*$/im);
  if (match?.[1] === undefined) {
    return undefined;
  }

  return Number(match[1]);
}

/**
 * @param {string} body
 * @returns {string[] | undefined}
 */
function readProcessedHumanFeedbackReviewIds(body) {
  const match = body.match(/^Processed human feedback review ids:\s*(.+?)\s*$/im);
  if (match?.[1] === undefined) {
    return undefined;
  }

  const value = match[1].trim();
  if (value === '' || value.toLowerCase() === 'none') {
    return [];
  }

  return value
    .split(/\s*,\s*/)
    .map(reviewId => reviewId.trim())
    .filter(reviewId => reviewId !== '');
}

/**
 * @param {string} body
 * @returns {string | undefined}
 */
function readPendingHumanFeedbackReviewId(body) {
  const match = body.match(/^Pending human feedback review id:\s*(.+?)\s*$/im);
  if (match?.[1] === undefined) {
    return undefined;
  }

  const value = match[1].trim();
  if (value === '' || value.toLowerCase() === 'none') {
    return undefined;
  }

  return value;
}

/**
 * @param {string} body
 * @returns {number[] | undefined}
 */
function readReviewFollowUpIssueNumbers(body) {
  const match = body.match(/^Review follow-up issue numbers:\s*(.+?)\s*$/im);
  if (match?.[1] === undefined) {
    return undefined;
  }

  const value = match[1].trim();
  if (value === '' || value.toLowerCase() === 'none') {
    return [];
  }

  const issueNumbers = value.split(/\s*,\s*/).map(item => item.trim());
  const parsed = [];

  for (const issueNumber of issueNumbers) {
    const issueMatch = issueNumber.match(/^#?(\d+)$/);
    if (issueMatch?.[1] === undefined) {
      return undefined;
    }

    parsed.push(Number(issueMatch[1]));
  }

  return parsed;
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

/**
 * @param {string[] | undefined} reviewIds
 * @returns {string}
 */
function formatHumanFeedbackReviewIds(reviewIds) {
  if (reviewIds === undefined || reviewIds.length === 0) {
    return 'none';
  }

  return reviewIds.join(', ');
}

/**
 * @param {number[] | undefined} issueNumbers
 * @returns {string}
 */
function formatReviewFollowUpIssueNumbers(issueNumbers) {
  if (issueNumbers === undefined || issueNumbers.length === 0) {
    return 'none';
  }

  return issueNumbers.map(issueNumber => `#${issueNumber}`).join(', ');
}
