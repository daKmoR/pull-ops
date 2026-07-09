/** Canonical catalog operation names participating in the managed PR workflow. */
export type ManagedPrOperationName =
  | 'pr-review'
  | 'pr-address-review'
  | 'pr-fix-ci'
  | 'pr-update-branch'
  | 'pr-resolve-conflicts'
  | 'pr-finalize';

/** The recorded state facts PullOps-Managed PR Transition routing may consult. */
export interface ManagedPrRoutingState {
  status?: string;
  lastOperation?: string;
  reviewedTreeHash?: string;
}

export interface GetNextManagedPrOperationOptions {
  operation: ManagedPrOperationName;
  outcomeKind: string;
  state?: ManagedPrRoutingState;
}

/**
 * One edge of the PullOps-Managed PR Transition graph: the next operation, a
 * terminal (undefined), or a predicate on recorded workflow state.
 */
export type ManagedPrTransitionEdge =
  | ManagedPrOperationName
  | undefined
  | ((state: ManagedPrRoutingState | undefined) => ManagedPrOperationName | undefined);

/** The outcome-kind edges of one operation in the transition graph. */
export type ManagedPrTransitionGraphRow = Readonly<Record<string, ManagedPrTransitionEdge>>;

/**
 * Which continuation question the state-based chooser answers: 'resume'
 * restarts an idle managed PR from GitHub state, while 'local-drive' keeps a
 * local automation loop moving toward a finalized PR, including the
 * validating review after pr-finalize.
 */
export type ManagedPrRoutingProfile = 'resume' | 'local-drive';

export interface ChooseNextManagedPrOperationFromStateOptions {
  state: ManagedPrRoutingState;
  /** Explicit status override when the caller reads status from a PR body marker. */
  status?: string;
  profile?: ManagedPrRoutingProfile;
}

export interface ResolveNextManagedPrOperationOptions {
  operation: ManagedPrOperationName;
  outcomeKind: string;
  state?: ManagedPrRoutingState;
  /** A runner-proposed next operation; applied only when the graph allows it. */
  proposedOperation?: string;
}

export type ResolvedNextManagedPrOperation =
  | { nextOperation: ManagedPrOperationName | undefined; proposalApplied: false }
  | { nextOperation: ManagedPrOperationName; proposalApplied: true };
