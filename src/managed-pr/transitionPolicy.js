import { requireOperationCatalogOperationLabelName } from '../operations/operationCatalog.js';

/**
 * @typedef {import('./transitionPolicy.types.js').ChooseNextManagedPrOperationFromStateOptions} ChooseNextManagedPrOperationFromStateOptions
 * @typedef {import('./transitionPolicy.types.js').GetNextManagedPrOperationOptions} GetNextManagedPrOperationOptions
 * @typedef {import('./transitionPolicy.types.js').ManagedPrOperationName} ManagedPrOperationName
 * @typedef {import('./transitionPolicy.types.js').ManagedPrRoutingState} ManagedPrRoutingState
 * @typedef {import('./transitionPolicy.types.js').ManagedPrTransitionGraphRow} ManagedPrTransitionGraphRow
 * @typedef {import('./transitionPolicy.types.js').ResolveNextManagedPrOperationOptions} ResolveNextManagedPrOperationOptions
 * @typedef {import('./transitionPolicy.types.js').ResolvedNextManagedPrOperation} ResolvedNextManagedPrOperation
 */

/**
 * The declarative PullOps-Managed PR Transition graph: for each PR operation
 * and outcome kind, the next operation in the pre-human review workflow, or
 * `undefined` when the outcome is terminal for automation.
 *
 * This graph is the routing trust boundary from ADR-0066: which operation may
 * follow which outcome is verified harness structure, never runner judgment.
 * Predicates are reserved for edges that depend on recorded workflow state;
 * the only one today ends the workflow when an approving review validated a
 * finalized tree instead of re-finalizing forever.
 *
 * @type {Readonly<Record<ManagedPrOperationName, ManagedPrTransitionGraphRow>>}
 */
const MANAGED_PR_TRANSITION_GRAPH = Object.freeze({
  'pr-review': Object.freeze({
    approved: (/** @type {ManagedPrRoutingState | undefined} */ state) =>
      state?.lastOperation === requireOperationCatalogOperationLabelName('pr-finalize')
        ? undefined
        : 'pr-finalize',
    'changes-requested': 'pr-address-review',
    blocked: undefined,
  }),
  'pr-address-review': Object.freeze({
    addressed: 'pr-review',
    blocked: undefined,
  }),
  'pr-fix-ci': Object.freeze({
    fixed: 'pr-review',
    'no-failed-checks': 'pr-review',
    blocked: undefined,
  }),
  'pr-update-branch': Object.freeze({
    updated: undefined,
    'conflicts-found': 'pr-resolve-conflicts',
    blocked: undefined,
  }),
  'pr-resolve-conflicts': Object.freeze({
    resolved: 'pr-review',
    blocked: undefined,
  }),
  'pr-finalize': Object.freeze({
    ready: undefined,
    'route-to-review': 'pr-review',
    'route-to-ci-fix': 'pr-fix-ci',
    blocked: undefined,
  }),
});

/**
 * Blocked outcomes that should hand the PR back to an operation once the
 * blocker is resolved re-add that operation's label alongside the failure.
 *
 * @type {Readonly<Partial<Record<ManagedPrOperationName, readonly ManagedPrOperationName[]>>>}
 */
const BLOCKED_FOLLOW_UP_OPERATIONS = Object.freeze({
  'pr-address-review': Object.freeze(/** @type {ManagedPrOperationName[]} */ (['pr-review'])),
  'pr-fix-ci': Object.freeze(/** @type {ManagedPrOperationName[]} */ (['pr-review'])),
});

/** @type {readonly ManagedPrOperationName[]} */
export const MANAGED_PR_OPERATION_NAMES = Object.freeze(
  /** @type {ManagedPrOperationName[]} */ (Object.keys(MANAGED_PR_TRANSITION_GRAPH)),
);

/**
 * @param {ManagedPrOperationName} operation
 * @returns {readonly string[]}
 */
export function getAllowedManagedPrOutcomeKinds(operation) {
  return Object.freeze(Object.keys(requireTransitionGraphRow(operation)));
}

/**
 * Reject an outcome kind the transition graph has no edge for, so a typo can
 * never route a PullOps-Managed PR.
 *
 * @param {ManagedPrOperationName} operation
 * @param {string} outcomeKind
 * @returns {void}
 */
export function validateManagedPrOutcome(operation, outcomeKind) {
  if (!(outcomeKind in requireTransitionGraphRow(operation))) {
    throw new Error(
      `${outcomeKind} is not a valid ${requireOperationCatalogOperationLabelName(operation)} PullOps-Managed PR outcome.`,
    );
  }
}

/**
 * Answer the one routing question of the pre-human review workflow: after
 * this operation reported this outcome, which operation runs next?
 *
 * @param {GetNextManagedPrOperationOptions} options
 * @returns {ManagedPrOperationName | undefined} next operation, or undefined when terminal
 */
export function getNextManagedPrOperation({ operation, outcomeKind, state }) {
  validateManagedPrOutcome(operation, outcomeKind);
  const edge = requireTransitionGraphRow(operation)[outcomeKind];
  return typeof edge === 'function' ? edge(state) : edge;
}

/**
 * @param {ManagedPrOperationName} operation
 * @returns {readonly ManagedPrOperationName[]}
 */
export function getBlockedManagedPrFollowUpOperations(operation) {
  return BLOCKED_FOLLOW_UP_OPERATIONS[operation] ?? Object.freeze([]);
}

/**
 * Detour edges a runner may propose instead of the default continuation.
 * Every detour still funnels back through pr-review, so proposals can widen
 * the route but never skip verification or the human merge boundary.
 *
 * @type {Readonly<Partial<Record<ManagedPrOperationName, Readonly<Record<string, readonly ManagedPrOperationName[]>>>>>}
 */
const PROPOSABLE_MANAGED_PR_DETOURS = Object.freeze({
  'pr-review': Object.freeze({
    // A review that finds the tree failing its checks can route the repair
    // to pr-fix-ci first instead of bouncing pr-address-review off red CI.
    'changes-requested': Object.freeze(/** @type {ManagedPrOperationName[]} */ (['pr-fix-ci'])),
  }),
});

/**
 * The operations a proposal may name after this outcome: the graph's default
 * continuation plus its declared detours.
 *
 * @param {GetNextManagedPrOperationOptions} options
 * @returns {readonly ManagedPrOperationName[]}
 */
export function getAllowedNextManagedPrOperations({ operation, outcomeKind, state }) {
  const defaultOperation = getNextManagedPrOperation({ operation, outcomeKind, state });
  const detours = PROPOSABLE_MANAGED_PR_DETOURS[operation]?.[outcomeKind] ?? [];
  return Object.freeze([...(defaultOperation === undefined ? [] : [defaultOperation]), ...detours]);
}

/**
 * The graph as validator: may this proposed operation follow this outcome?
 *
 * @param {ResolveNextManagedPrOperationOptions & { proposedOperation: string }} options
 * @returns {boolean}
 */
export function isManagedPrTransitionAllowed({ operation, outcomeKind, proposedOperation, state }) {
  return getAllowedNextManagedPrOperations({ operation, outcomeKind, state }).includes(
    /** @type {ManagedPrOperationName} */ (proposedOperation),
  );
}

/**
 * Route one outcome with an optional runner proposal: an allowed proposal is
 * applied, anything else falls back to the graph's default continuation. The
 * runner plans the route; the graph stays the routing trust boundary.
 *
 * @param {ResolveNextManagedPrOperationOptions} options
 * @returns {ResolvedNextManagedPrOperation}
 */
export function resolveNextManagedPrOperation({
  operation,
  outcomeKind,
  state,
  proposedOperation,
}) {
  if (
    proposedOperation !== undefined &&
    isManagedPrTransitionAllowed({ operation, outcomeKind, proposedOperation, state })
  ) {
    return {
      nextOperation: /** @type {ManagedPrOperationName} */ (proposedOperation),
      proposalApplied: true,
    };
  }

  return {
    nextOperation: getNextManagedPrOperation({ operation, outcomeKind, state }),
    proposalApplied: false,
  };
}

/**
 * Choose the next operation for a managed PR from its recorded workflow
 * state alone, when there is no fresh outcome to route from. Callers decide
 * first whether the PR is already finalized for rebase merge.
 *
 * @param {ChooseNextManagedPrOperationFromStateOptions} options
 * @returns {ManagedPrOperationName | undefined}
 */
export function chooseNextManagedPrOperationFromState({ state, status, profile = 'resume' }) {
  const effectiveStatus = status ?? state.status;

  if (state.reviewedTreeHash !== undefined || effectiveStatus === 'Review approved') {
    return 'pr-finalize';
  }

  if (effectiveStatus === 'Changes requested') {
    return 'pr-address-review';
  }

  const reviewStatuses = ['Review feedback addressed', 'Draft automation'];
  const reviewLastOperations = ['issue-implement', 'pr-address-review'];
  if (profile === 'local-drive') {
    reviewStatuses.push('Review required');
    reviewLastOperations.push('pr-finalize');
  }

  if (
    (effectiveStatus !== undefined && reviewStatuses.includes(effectiveStatus)) ||
    reviewLastOperations.some(
      name => state.lastOperation === requireOperationCatalogOperationLabelName(name),
    )
  ) {
    return 'pr-review';
  }

  return undefined;
}

/**
 * @param {ManagedPrOperationName} operation
 * @returns {ManagedPrTransitionGraphRow}
 */
function requireTransitionGraphRow(operation) {
  const row = MANAGED_PR_TRANSITION_GRAPH[operation];
  if (row === undefined) {
    throw new Error(`${operation} is not a PullOps-Managed PR workflow operation.`);
  }

  return row;
}
