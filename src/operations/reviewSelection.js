/**
 * @typedef {import('../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../config/types.js').ModelTier} ModelTier
 * @typedef {import('../managed-pr/ManagedPrState.types.js').ManagedPrState} ManagedPrState
 */

/**
 * @typedef {'normal' | 'escalation' | 'human-feedback-response' | 'blocked'} ReviewMode
 */

/**
 * @param {ManagedPrState} state
 * @returns {ReviewMode | 'blocked'}
 */
export function determinePrReviewMode(state) {
  if (isPendingHumanFeedbackResponse(state)) {
    return 'human-feedback-response';
  }

  if (state.reviewCycles.current < state.reviewCycles.max) {
    return 'normal';
  }

  if (hasEscalationReviewCapacity(state)) {
    return 'escalation';
  }

  return 'blocked';
}

/**
 * @param {ManagedPrState} state
 * @param {{ reviewId?: string }} [options]
 * @returns {ReviewMode | 'blocked'}
 */
export function determinePrAddressReviewMode(state, { reviewId } = {}) {
  if (reviewId !== undefined) {
    return isHumanFeedbackReviewProcessed(state, reviewId) ? 'blocked' : 'human-feedback-response';
  }

  if (state.reviewCycles.current < state.reviewCycles.max) {
    return 'normal';
  }

  if (hasEscalationReviewCapacity(state)) {
    return 'escalation';
  }

  return 'blocked';
}

/**
 * @param {OperationRunnerContext} context
 * @param {string} operationName
 * @param {ReviewMode} reviewMode
 * @returns {{ modelTier: ModelTier, model: string }}
 */
export function resolveReviewModelSelection(context, operationName, reviewMode) {
  const operation = context.config.operations[readOperationConfigKey(operationName)];

  if (reviewMode === 'blocked') {
    throw new Error(
      `Cannot resolve a model selection for blocked review mode on ${operationName}.`,
    );
  }

  const modelTier =
    reviewMode === 'normal'
      ? operation.modelTier
      : reviewMode === 'escalation'
        ? operation.escalationModelTier
        : operation.humanFeedbackResponseModelTier;

  return {
    modelTier,
    model: context.config.runner.models[modelTier],
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
 * @param {string} reviewId
 * @returns {boolean}
 */
function isHumanFeedbackReviewProcessed(state, reviewId) {
  return state.processedHumanFeedbackReviewIds?.includes(reviewId) ?? false;
}

/**
 * @param {string} operationName
 * @returns {'prReview' | 'prAddressReview'}
 */
function readOperationConfigKey(operationName) {
  if (operationName === 'pr-review') {
    return 'prReview';
  }

  if (operationName === 'pr-address-review') {
    return 'prAddressReview';
  }

  throw new Error(`Unsupported review operation "${operationName}".`);
}
