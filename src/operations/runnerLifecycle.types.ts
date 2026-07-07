import type { OperationRunnerContext } from '../cli/types.js';
import type { LocalPullRequestOperationFlow } from './runLocalPullRequestOperation.types.js';

/** One phase of an Operation Module executed against a runner context. */
export type OperationPhaseHandler = (
  context: OperationRunnerContext,
) => Promise<Record<string, unknown>>;

/**
 * The one interface an Operation Module hands the Runner Lifecycle: catalog
 * identity, runner-step factories, and flow data. The lifecycle owns the
 * shared flow — the local dry-run guard, phase dispatch, and finalize
 * ordering — so Operation Modules do not re-implement entry scaffolding.
 */
export interface OperationDescriptor {
  /** Operation Label Reference this descriptor executes, such as 'pr:review'. */
  operationReference: string;
  /**
   * Factory for the standard run, prepare, and complete phases. Required
   * unless every used phase is overridden.
   */
  createOperation?: RunnerLifecycleOperationFactory;
  /**
   * Complete-phase factory for operations whose finalize must read prepared
   * state instead of preparing again.
   */
  createFinalizeOperation?: RunnerLifecycleOperationFactory;
  /** Finalize ordering and error recording; defaults to 'prepare-first'. */
  finalize?: FinalizeOperationRunnerStepOptions;
  /**
   * The Operation Module's local dry-run flow. Operations without one are
   * blocked as not implemented for local execution after the shared
   * guardrails run.
   */
  localRun?: LocalPullRequestOperationFlow;
  /**
   * Run-phase flow override for operations with a bespoke runner flow, such
   * as multi-pass loops. Pull request targets still pass the shared local
   * dry-run guard first; issue targets own their full entry dispatch.
   */
  run?: OperationPhaseHandler;
  /** Full prepare-phase override. */
  prepare?: OperationPhaseHandler;
  /** Full complete-phase override. */
  complete?: OperationPhaseHandler;
}

/**
 * The single interface an Operation Module presents to the Runner Lifecycle:
 * one factory that inspects the context and either settles the operation
 * without a runner step, or describes the one runner step to execute.
 */
export type RunnerLifecycleOperationFactory = (
  context: OperationRunnerContext,
) => Promise<RunnerLifecycleOperation>;

export type RunnerLifecycleOperation =
  | SettledRunnerLifecycleOperation
  | RunnerStepLifecycleOperation;

/**
 * The operation finished without a runner step: a guardrail refusal or a
 * deterministic completion. The output is returned as-is.
 */
export interface SettledRunnerLifecycleOperation {
  status: 'settled';
  output: Record<string, unknown>;
}

/** One runner step: prompt in, validated Operation Output out. */
export interface RunnerStepLifecycleOperation {
  status: 'runner';
  prompt: string;
  model: string;
  /** Branch the external runner checkout must be on before editing files. */
  branch: string;
  /** Extra runner options used only by the inline codex-cli run. */
  runOptions?: RunnerLifecycleRunOptions;
  /** Waiting output facts for the external prepare phase. */
  waiting: RunnerLifecycleWaiting;
  /** Consume the raw runner output and produce the Operation Output. */
  finalize: (rawOutput: unknown) => Promise<Record<string, unknown>>;
  /** Record a runner failure before the lifecycle rethrows it. */
  onRunnerFailure?: (error: unknown) => Promise<void>;
}

export interface RunnerLifecycleRunOptions {
  streamOutput?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface RunnerLifecycleWaiting {
  summary: string;
  details?: Record<string, unknown>;
}

export interface FinalizeOperationRunnerStepOptions {
  /**
   * Whether the finalize phase builds the operation before reading the
   * external runner output ('prepare-first'), or reads the output first and
   * only then builds the operation ('output-first'). Operations whose
   * preparation transitions GitHub state must use 'output-first' so a missing
   * or failed runner result is not masked by a preparation transition.
   */
  order: 'prepare-first' | 'output-first';
  rejectSkippedPreparedRunner?: boolean;
  /**
   * Failure recording for 'output-first' operations, which have no prepared
   * operation yet when reading the runner output fails.
   */
  onOutputError?: (context: OperationRunnerContext, error: unknown) => Promise<void>;
}
