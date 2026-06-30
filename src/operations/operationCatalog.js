/**
 * @typedef {import('../config/types.js').OperationConfig} OperationConfig
 * @typedef {import('../config/types.js').ReviewOperationConfig} ReviewOperationConfig
 * @typedef {import('../config/types.js').PrResolveConflictsOperationConfig} PrResolveConflictsOperationConfig
 * @typedef {import('../cli/types.js').OperationPhase} OperationPhase
 * @typedef {import('../github/types.js').PullOpsLabel} PullOpsLabel
 * @typedef {import('../operations/types.js').OperationLabelReference} OperationLabelReference
 * @typedef {import('../operations/types.js').WorkflowOperation} WorkflowOperation
 * @typedef {import('../runner/types.js').RunnerAdapter} RunnerAdapter
 */

const PRD_PREPARE_OPERATION_NAME = 'prd-prepare';
const PRD_PREPARE_OPERATION_LABEL_REFERENCE = 'prd:prepare';
const PRD_PREPARE_OPERATION_LABEL_NAME = 'pullops:prd:prepare';
const PRD_PREPARE_OPERATION_LABEL_DESCRIPTION =
  'Prepare an umbrella branch and draft PR for a PRD issue.';
const PRD_PREPARE_OPERATION_LABEL_COLOR = '5319E7';
const PRD_PREPARE_WORKFLOW_FILE_NAME = 'pullops-prd-prepare.yml';
const PRD_PREPARE_PACKAGE_SCRIPT_NAME = 'pullops:prd-prepare';
/** @type {readonly [RunnerAdapter, OperationPhase][]} */
const PRD_PREPARE_SUPPORTED_RUNNER_LIFECYCLES = Object.freeze([['codex-cli', 'run']]);

const PRD_AUTO_ADVANCE_OPERATION_NAME = 'prd-auto-advance';
const PRD_AUTO_ADVANCE_OPERATION_LABEL_REFERENCE = 'prd:auto-advance';
const PRD_AUTO_ADVANCE_OPERATION_LABEL_NAME = 'pullops:prd:auto-advance';
const PRD_AUTO_ADVANCE_OPERATION_LABEL_DESCRIPTION =
  'Prepare a PRD and drain the current unblocked child frontier.';
const PRD_AUTO_ADVANCE_OPERATION_LABEL_COLOR = '5319E7';
const PRD_AUTO_ADVANCE_WORKFLOW_FILE_NAME = 'pullops-prd-auto-advance.yml';
const PRD_AUTO_ADVANCE_PACKAGE_SCRIPT_NAME = 'pullops:prd-auto-advance';
/** @type {readonly [RunnerAdapter, OperationPhase][]} */
const PRD_AUTO_ADVANCE_SUPPORTED_RUNNER_LIFECYCLES = Object.freeze([['codex-cli', 'run']]);
/** @type {WorkflowOperation} */
const PRD_AUTO_ADVANCE_WORKFLOW_OPERATION = Object.freeze({
  name: PRD_AUTO_ADVANCE_OPERATION_NAME,
  target: 'issue',
  option: 'issue',
  configKey: 'prdAutoAdvance',
});
/** @type {OperationLabelReference} */
const PRD_AUTO_ADVANCE_OPERATION_LABEL_REFERENCE_ENTRY = Object.freeze({
  reference: PRD_AUTO_ADVANCE_OPERATION_LABEL_REFERENCE,
  workflowOperationName: PRD_AUTO_ADVANCE_OPERATION_NAME,
  target: 'issue',
  label: PRD_AUTO_ADVANCE_OPERATION_LABEL_NAME,
});
/** @type {PullOpsLabel} */
const PRD_AUTO_ADVANCE_LABEL_DEFINITION = Object.freeze({
  name: PRD_AUTO_ADVANCE_OPERATION_LABEL_NAME,
  color: PRD_AUTO_ADVANCE_OPERATION_LABEL_COLOR,
  description: PRD_AUTO_ADVANCE_OPERATION_LABEL_DESCRIPTION,
});
/** @type {OperationConfig} */
const PRD_AUTO_ADVANCE_DEFAULT_OPERATION_SETTINGS = Object.freeze({
  modelTier: 'low',
});

const PRD_AUTO_COMPLETE_OPERATION_NAME = 'prd-auto-complete';
const PRD_AUTO_COMPLETE_OPERATION_LABEL_REFERENCE = 'prd:auto-complete';
const PRD_AUTO_COMPLETE_OPERATION_LABEL_NAME = 'pullops:prd:auto-complete';
const PRD_AUTO_COMPLETE_OPERATION_LABEL_DESCRIPTION =
  'Complete a PRD through child PRs, umbrella integration, and finalization; humans merge umbrella PR.';
const PRD_AUTO_COMPLETE_OPERATION_LABEL_COLOR = '5319E7';
const PRD_AUTO_COMPLETE_WORKFLOW_FILE_NAME = 'pullops-prd-auto-complete.yml';
const PRD_AUTO_COMPLETE_PACKAGE_SCRIPT_NAME = 'pullops:prd-auto-complete';
/** @type {readonly [RunnerAdapter, OperationPhase][]} */
const PRD_AUTO_COMPLETE_SUPPORTED_RUNNER_LIFECYCLES = Object.freeze([['codex-cli', 'run']]);
/** @type {WorkflowOperation} */
const PRD_AUTO_COMPLETE_WORKFLOW_OPERATION = Object.freeze({
  name: PRD_AUTO_COMPLETE_OPERATION_NAME,
  target: 'issue',
  option: 'issue',
  configKey: 'prdAutoComplete',
});
/** @type {OperationLabelReference} */
const PRD_AUTO_COMPLETE_OPERATION_LABEL_REFERENCE_ENTRY = Object.freeze({
  reference: PRD_AUTO_COMPLETE_OPERATION_LABEL_REFERENCE,
  workflowOperationName: PRD_AUTO_COMPLETE_OPERATION_NAME,
  target: 'issue',
  label: PRD_AUTO_COMPLETE_OPERATION_LABEL_NAME,
});
/** @type {PullOpsLabel} */
const PRD_AUTO_COMPLETE_LABEL_DEFINITION = Object.freeze({
  name: PRD_AUTO_COMPLETE_OPERATION_LABEL_NAME,
  color: PRD_AUTO_COMPLETE_OPERATION_LABEL_COLOR,
  description: PRD_AUTO_COMPLETE_OPERATION_LABEL_DESCRIPTION,
});
/** @type {OperationConfig} */
const PRD_AUTO_COMPLETE_DEFAULT_OPERATION_SETTINGS = Object.freeze({
  modelTier: 'low',
});

const ISSUE_IMPLEMENT_OPERATION_NAME = 'issue-implement';
const ISSUE_IMPLEMENT_OPERATION_LABEL_REFERENCE = 'issue:implement';
const ISSUE_IMPLEMENT_OPERATION_LABEL_NAME = 'pullops:issue:implement';
const ISSUE_IMPLEMENT_OPERATION_LABEL_DESCRIPTION =
  'Implement one concrete issue through review and finalization. Does not coordinate child issues.';
const ISSUE_IMPLEMENT_OPERATION_LABEL_COLOR = '5319E7';
const ISSUE_IMPLEMENT_WORKFLOW_FILE_NAME = 'pullops-issue-implement.yml';
const ISSUE_IMPLEMENT_PACKAGE_SCRIPT_NAME = 'pullops:issue-implement';
/** @type {readonly [RunnerAdapter, OperationPhase][]} */
const ISSUE_IMPLEMENT_SUPPORTED_RUNNER_LIFECYCLES = Object.freeze([
  ['codex-cli', 'run'],
  ['codex-action', 'prepare'],
  ['codex-action', 'finalize'],
]);

const PR_REVIEW_OPERATION_NAME = 'pr-review';
const PR_REVIEW_OPERATION_LABEL_REFERENCE = 'pr:review';
const PR_REVIEW_OPERATION_LABEL_NAME = 'pullops:pr:review';
const PR_REVIEW_OPERATION_LABEL_DESCRIPTION = 'Run PullOps automated PR review.';
const PR_REVIEW_OPERATION_LABEL_COLOR = '5319E7';
const PR_REVIEW_WORKFLOW_FILE_NAME = 'pullops-pr-review.yml';
const PR_REVIEW_PACKAGE_SCRIPT_NAME = 'pullops:pr-review';

const PR_ADDRESS_REVIEW_OPERATION_NAME = 'pr-address-review';
const PR_ADDRESS_REVIEW_OPERATION_LABEL_REFERENCE = 'pr:address-review';
const PR_ADDRESS_REVIEW_OPERATION_LABEL_NAME = 'pullops:pr:address-review';
const PR_ADDRESS_REVIEW_OPERATION_LABEL_DESCRIPTION =
  'Address actionable PullOps PR review feedback.';
const PR_ADDRESS_REVIEW_OPERATION_LABEL_COLOR = '5319E7';
const PR_ADDRESS_REVIEW_WORKFLOW_FILE_NAME = 'pullops-pr-address-review.yml';
const PR_ADDRESS_REVIEW_PACKAGE_SCRIPT_NAME = 'pullops:pr-address-review';

/** @type {readonly [RunnerAdapter, OperationPhase][]} */
const REVIEW_LOOP_SUPPORTED_RUNNER_LIFECYCLES = Object.freeze([
  ['codex-cli', 'run'],
  ['codex-action', 'prepare'],
  ['codex-action', 'finalize'],
]);

/** @type {WorkflowOperation} */
const PR_REVIEW_WORKFLOW_OPERATION = Object.freeze({
  name: PR_REVIEW_OPERATION_NAME,
  target: 'pr',
  option: 'pr',
  configKey: 'prReview',
});

/** @type {WorkflowOperation} */
const PR_ADDRESS_REVIEW_WORKFLOW_OPERATION = Object.freeze({
  name: PR_ADDRESS_REVIEW_OPERATION_NAME,
  target: 'pr',
  option: 'pr',
  configKey: 'prAddressReview',
});

/** @type {OperationLabelReference} */
const PR_REVIEW_OPERATION_LABEL_REFERENCE_ENTRY = Object.freeze({
  reference: PR_REVIEW_OPERATION_LABEL_REFERENCE,
  workflowOperationName: PR_REVIEW_OPERATION_NAME,
  target: 'pr',
  label: PR_REVIEW_OPERATION_LABEL_NAME,
});

/** @type {OperationLabelReference} */
const PR_ADDRESS_REVIEW_OPERATION_LABEL_REFERENCE_ENTRY = Object.freeze({
  reference: PR_ADDRESS_REVIEW_OPERATION_LABEL_REFERENCE,
  workflowOperationName: PR_ADDRESS_REVIEW_OPERATION_NAME,
  target: 'pr',
  label: PR_ADDRESS_REVIEW_OPERATION_LABEL_NAME,
});

/** @type {PullOpsLabel} */
const PR_REVIEW_LABEL_DEFINITION = Object.freeze({
  name: PR_REVIEW_OPERATION_LABEL_NAME,
  color: PR_REVIEW_OPERATION_LABEL_COLOR,
  description: PR_REVIEW_OPERATION_LABEL_DESCRIPTION,
});

/** @type {PullOpsLabel} */
const PR_ADDRESS_REVIEW_LABEL_DEFINITION = Object.freeze({
  name: PR_ADDRESS_REVIEW_OPERATION_LABEL_NAME,
  color: PR_ADDRESS_REVIEW_OPERATION_LABEL_COLOR,
  description: PR_ADDRESS_REVIEW_OPERATION_LABEL_DESCRIPTION,
});

/** @type {ReviewOperationConfig} */
const PR_REVIEW_DEFAULT_OPERATION_SETTINGS = Object.freeze({
  modelTier: 'high',
  escalationModelTier: 'high',
  humanFeedbackResponseModelTier: 'high',
});

/** @type {ReviewOperationConfig} */
const PR_ADDRESS_REVIEW_DEFAULT_OPERATION_SETTINGS = Object.freeze({
  modelTier: 'mid',
  escalationModelTier: 'high',
  humanFeedbackResponseModelTier: 'high',
});

const PR_FIX_CI_OPERATION_NAME = 'pr-fix-ci';
const PR_FIX_CI_OPERATION_LABEL_REFERENCE = 'pr:fix-ci';
const PR_FIX_CI_OPERATION_LABEL_NAME = 'pullops:pr:fix-ci';
const PR_FIX_CI_OPERATION_LABEL_DESCRIPTION = 'Classify and fix actionable CI failures.';
const PR_FIX_CI_OPERATION_LABEL_COLOR = '5319E7';
const PR_FIX_CI_WORKFLOW_FILE_NAME = 'pullops-pr-fix-ci.yml';
const PR_FIX_CI_PACKAGE_SCRIPT_NAME = 'pullops:pr-fix-ci';
/** @type {readonly [RunnerAdapter, OperationPhase][]} */
const PR_FIX_CI_SUPPORTED_RUNNER_LIFECYCLES = Object.freeze([
  ['codex-cli', 'run'],
  ['codex-action', 'prepare'],
  ['codex-action', 'finalize'],
]);
/** @type {WorkflowOperation} */
const PR_FIX_CI_WORKFLOW_OPERATION = Object.freeze({
  name: PR_FIX_CI_OPERATION_NAME,
  target: 'pr',
  option: 'pr',
  configKey: 'prFixCi',
});
/** @type {OperationLabelReference} */
const PR_FIX_CI_OPERATION_LABEL_REFERENCE_ENTRY = Object.freeze({
  reference: PR_FIX_CI_OPERATION_LABEL_REFERENCE,
  workflowOperationName: PR_FIX_CI_OPERATION_NAME,
  target: 'pr',
  label: PR_FIX_CI_OPERATION_LABEL_NAME,
});
/** @type {PullOpsLabel} */
const PR_FIX_CI_LABEL_DEFINITION = Object.freeze({
  name: PR_FIX_CI_OPERATION_LABEL_NAME,
  color: PR_FIX_CI_OPERATION_LABEL_COLOR,
  description: PR_FIX_CI_OPERATION_LABEL_DESCRIPTION,
});
/** @type {OperationConfig} */
const PR_FIX_CI_DEFAULT_OPERATION_SETTINGS = Object.freeze({
  modelTier: 'mid',
});

const PR_UPDATE_BRANCH_OPERATION_NAME = 'pr-update-branch';
const PR_UPDATE_BRANCH_OPERATION_LABEL_REFERENCE = 'pr:update-branch';
const PR_UPDATE_BRANCH_OPERATION_LABEL_NAME = 'pullops:pr:update-branch';
const PR_UPDATE_BRANCH_OPERATION_LABEL_DESCRIPTION = 'Update a same-repository PR branch.';
const PR_UPDATE_BRANCH_OPERATION_LABEL_COLOR = '5319E7';
const PR_UPDATE_BRANCH_WORKFLOW_FILE_NAME = 'pullops-pr-update-branch.yml';
const PR_UPDATE_BRANCH_PACKAGE_SCRIPT_NAME = 'pullops:pr-update-branch';
/** @type {readonly [RunnerAdapter, OperationPhase][]} */
const PR_UPDATE_BRANCH_SUPPORTED_RUNNER_LIFECYCLES = Object.freeze([['codex-cli', 'run']]);
/** @type {WorkflowOperation} */
const PR_UPDATE_BRANCH_WORKFLOW_OPERATION = Object.freeze({
  name: PR_UPDATE_BRANCH_OPERATION_NAME,
  target: 'pr',
  option: 'pr',
  configKey: 'prUpdateBranch',
});
/** @type {OperationLabelReference} */
const PR_UPDATE_BRANCH_OPERATION_LABEL_REFERENCE_ENTRY = Object.freeze({
  reference: PR_UPDATE_BRANCH_OPERATION_LABEL_REFERENCE,
  workflowOperationName: PR_UPDATE_BRANCH_OPERATION_NAME,
  target: 'pr',
  label: PR_UPDATE_BRANCH_OPERATION_LABEL_NAME,
});
/** @type {PullOpsLabel} */
const PR_UPDATE_BRANCH_LABEL_DEFINITION = Object.freeze({
  name: PR_UPDATE_BRANCH_OPERATION_LABEL_NAME,
  color: PR_UPDATE_BRANCH_OPERATION_LABEL_COLOR,
  description: PR_UPDATE_BRANCH_OPERATION_LABEL_DESCRIPTION,
});
/** @type {OperationConfig} */
const PR_UPDATE_BRANCH_DEFAULT_OPERATION_SETTINGS = Object.freeze({
  modelTier: 'low',
});

const PR_RESOLVE_CONFLICTS_OPERATION_NAME = 'pr-resolve-conflicts';
const PR_RESOLVE_CONFLICTS_OPERATION_LABEL_REFERENCE = 'pr:resolve-conflicts';
const PR_RESOLVE_CONFLICTS_OPERATION_LABEL_NAME = 'pullops:pr:resolve-conflicts';
const PR_RESOLVE_CONFLICTS_OPERATION_LABEL_DESCRIPTION =
  'Resolve branch update conflicts with the PullOps runner.';
const PR_RESOLVE_CONFLICTS_OPERATION_LABEL_COLOR = '5319E7';
const PR_RESOLVE_CONFLICTS_WORKFLOW_FILE_NAME = 'pullops-pr-resolve-conflicts.yml';
const PR_RESOLVE_CONFLICTS_PACKAGE_SCRIPT_NAME = 'pullops:pr-resolve-conflicts';
/** @type {readonly [RunnerAdapter, OperationPhase][]} */
const PR_RESOLVE_CONFLICTS_SUPPORTED_RUNNER_LIFECYCLES = Object.freeze([
  ['codex-cli', 'run'],
  ['codex-action', 'prepare'],
  ['codex-action', 'finalize'],
]);
/** @type {WorkflowOperation} */
const PR_RESOLVE_CONFLICTS_WORKFLOW_OPERATION = Object.freeze({
  name: PR_RESOLVE_CONFLICTS_OPERATION_NAME,
  target: 'pr',
  option: 'pr',
  configKey: 'prResolveConflicts',
});
/** @type {OperationLabelReference} */
const PR_RESOLVE_CONFLICTS_OPERATION_LABEL_REFERENCE_ENTRY = Object.freeze({
  reference: PR_RESOLVE_CONFLICTS_OPERATION_LABEL_REFERENCE,
  workflowOperationName: PR_RESOLVE_CONFLICTS_OPERATION_NAME,
  target: 'pr',
  label: PR_RESOLVE_CONFLICTS_OPERATION_LABEL_NAME,
});
/** @type {PullOpsLabel} */
const PR_RESOLVE_CONFLICTS_LABEL_DEFINITION = Object.freeze({
  name: PR_RESOLVE_CONFLICTS_OPERATION_LABEL_NAME,
  color: PR_RESOLVE_CONFLICTS_OPERATION_LABEL_COLOR,
  description: PR_RESOLVE_CONFLICTS_OPERATION_LABEL_DESCRIPTION,
});
/** @type {PrResolveConflictsOperationConfig} */
const PR_RESOLVE_CONFLICTS_DEFAULT_OPERATION_SETTINGS = Object.freeze({
  modelTier: 'high',
  maxConflictResolutionPasses: 3,
});

/** @type {WorkflowOperation} */
const PRD_PREPARE_WORKFLOW_OPERATION = Object.freeze({
  name: PRD_PREPARE_OPERATION_NAME,
  target: 'issue',
  option: 'issue',
  configKey: 'prdPrepare',
});

/** @type {OperationLabelReference} */
const PRD_PREPARE_OPERATION_LABEL_REFERENCE_ENTRY = Object.freeze({
  reference: PRD_PREPARE_OPERATION_LABEL_REFERENCE,
  workflowOperationName: PRD_PREPARE_OPERATION_NAME,
  target: 'issue',
  label: PRD_PREPARE_OPERATION_LABEL_NAME,
});

/** @type {PullOpsLabel} */
const PRD_PREPARE_LABEL_DEFINITION = Object.freeze({
  name: PRD_PREPARE_OPERATION_LABEL_NAME,
  color: PRD_PREPARE_OPERATION_LABEL_COLOR,
  description: PRD_PREPARE_OPERATION_LABEL_DESCRIPTION,
});

/** @type {OperationConfig} */
const PRD_PREPARE_DEFAULT_OPERATION_SETTINGS = Object.freeze({
  modelTier: 'low',
});

/** @type {WorkflowOperation} */
const ISSUE_IMPLEMENT_WORKFLOW_OPERATION = Object.freeze({
  name: ISSUE_IMPLEMENT_OPERATION_NAME,
  target: 'issue',
  option: 'issue',
  configKey: 'issueImplement',
});

/** @type {OperationLabelReference} */
const ISSUE_IMPLEMENT_OPERATION_LABEL_REFERENCE_ENTRY = Object.freeze({
  reference: ISSUE_IMPLEMENT_OPERATION_LABEL_REFERENCE,
  workflowOperationName: ISSUE_IMPLEMENT_OPERATION_NAME,
  target: 'issue',
  label: ISSUE_IMPLEMENT_OPERATION_LABEL_NAME,
});

/** @type {PullOpsLabel} */
const ISSUE_IMPLEMENT_LABEL_DEFINITION = Object.freeze({
  name: ISSUE_IMPLEMENT_OPERATION_LABEL_NAME,
  color: ISSUE_IMPLEMENT_OPERATION_LABEL_COLOR,
  description: ISSUE_IMPLEMENT_OPERATION_LABEL_DESCRIPTION,
});

/** @type {OperationConfig} */
const ISSUE_IMPLEMENT_DEFAULT_OPERATION_SETTINGS = Object.freeze({
  modelTier: 'high',
});

/**
 * @param {import('../cli/types.js').OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
async function runPrdPrepareThroughCatalog(context) {
  const { runPrdPrepare } = await import('./prd-prepare/run.js');
  return await runPrdPrepare(context);
}

/**
 * @param {import('../cli/types.js').OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
async function runPrdAutoAdvanceThroughCatalog(context) {
  const { runPrdAutoAdvance } = await import('./prd-automation/run.js');
  return await runPrdAutoAdvance(context);
}

/**
 * @param {import('../cli/types.js').OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
async function runPrdAutoCompleteThroughCatalog(context) {
  const { runPrdAutoComplete } = await import('./prd-automation/run.js');
  return await runPrdAutoComplete(context);
}

/**
 * @param {import('../cli/types.js').OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
async function runIssueImplementThroughCatalog(context) {
  const { runIssueImplement } = await import('./issue-implement/run.js');
  return await runIssueImplement(context);
}

/**
 * @param {import('../cli/types.js').OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
async function runIssueImplementCodexActionPrepareThroughCatalog(context) {
  const { runIssueImplementCodexActionPrepare } = await import('./issue-implement/run.js');
  return await runIssueImplementCodexActionPrepare(context);
}

/**
 * @param {import('../cli/types.js').OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
async function runIssueImplementCodexActionFinalizeThroughCatalog(context) {
  const { runIssueImplementCodexActionFinalize } = await import('./issue-implement/run.js');
  return await runIssueImplementCodexActionFinalize(context);
}

/**
 * @param {import('../cli/types.js').OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
async function runPrReviewThroughCatalog(context) {
  const { runPrReview } = await import('./pr-review/run.js');
  return await runPrReview(context);
}

/**
 * @param {import('../cli/types.js').OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
async function runPrReviewCodexActionPrepareThroughCatalog(context) {
  const { runPrReviewCodexActionPrepare } = await import('./pr-review/run.js');
  return await runPrReviewCodexActionPrepare(context);
}

/**
 * @param {import('../cli/types.js').OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
async function runPrReviewCodexActionFinalizeThroughCatalog(context) {
  const { runPrReviewCodexActionFinalize } = await import('./pr-review/run.js');
  return await runPrReviewCodexActionFinalize(context);
}

/**
 * @param {import('../cli/types.js').OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
async function runPrAddressReviewThroughCatalog(context) {
  const { runPrAddressReview } = await import('./pr-address-review/run.js');
  return await runPrAddressReview(context);
}

/**
 * @param {import('../cli/types.js').OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
async function runPrAddressReviewCodexActionPrepareThroughCatalog(context) {
  const { runPrAddressReviewCodexActionPrepare } = await import('./pr-address-review/run.js');
  return await runPrAddressReviewCodexActionPrepare(context);
}

/**
 * @param {import('../cli/types.js').OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
async function runPrAddressReviewCodexActionFinalizeThroughCatalog(context) {
  const { runPrAddressReviewCodexActionFinalize } = await import('./pr-address-review/run.js');
  return await runPrAddressReviewCodexActionFinalize(context);
}

/**
 * @param {import('../cli/types.js').OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
async function runPrFixCiThroughCatalog(context) {
  const { runPrFixCi } = await import('./pr-fix-ci/run.js');
  return await runPrFixCi(context);
}

/**
 * @param {import('../cli/types.js').OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
async function runPrFixCiCodexActionPrepareThroughCatalog(context) {
  const { runPrFixCiCodexActionPrepare } = await import('./pr-fix-ci/run.js');
  return await runPrFixCiCodexActionPrepare(context);
}

/**
 * @param {import('../cli/types.js').OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
async function runPrFixCiCodexActionFinalizeThroughCatalog(context) {
  const { runPrFixCiCodexActionFinalize } = await import('./pr-fix-ci/run.js');
  return await runPrFixCiCodexActionFinalize(context);
}

/**
 * @param {import('../cli/types.js').OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
async function runPrUpdateBranchThroughCatalog(context) {
  const { runPrUpdateBranch } = await import('./pr-update-branch/run.js');
  return await runPrUpdateBranch(context);
}

/**
 * @param {import('../cli/types.js').OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
async function runPrResolveConflictsThroughCatalog(context) {
  const { runPrResolveConflicts } = await import('./pr-resolve-conflicts/run.js');
  return await runPrResolveConflicts(context);
}

/**
 * @param {import('../cli/types.js').OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
async function runPrResolveConflictsCodexActionPrepareThroughCatalog(context) {
  const { runPrResolveConflictsCodexActionPrepare } = await import('./pr-resolve-conflicts/run.js');
  return await runPrResolveConflictsCodexActionPrepare(context);
}

/**
 * @param {import('../cli/types.js').OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
async function runPrResolveConflictsCodexActionFinalizeThroughCatalog(context) {
  const { runPrResolveConflictsCodexActionFinalize } =
    await import('./pr-resolve-conflicts/run.js');
  return await runPrResolveConflictsCodexActionFinalize(context);
}

/**
 * @param {readonly [RunnerAdapter, OperationPhase][]} lifecycles
 * @returns {readonly RunnerAdapter[]}
 */
function readUniqueSupportedRunnerAdapters(lifecycles) {
  return Object.freeze([...new Set(lifecycles.map(([runnerAdapter]) => runnerAdapter))]);
}

/**
 * @param {readonly [RunnerAdapter, OperationPhase][]} lifecycles
 * @returns {readonly OperationPhase[]}
 */
function readUniqueSupportedRunnerPhases(lifecycles) {
  return Object.freeze([...new Set(lifecycles.map(([, phase]) => phase))]);
}

/**
 * @param {string} operationName
 * @returns {readonly [RunnerAdapter, OperationPhase][] | undefined}
 */
export function getOperationCatalogSupportedRunnerLifecycles(operationName) {
  if (operationName === PR_FIX_CI_OPERATION_NAME) {
    return PR_FIX_CI_SUPPORTED_RUNNER_LIFECYCLES;
  }

  if (operationName === PR_UPDATE_BRANCH_OPERATION_NAME) {
    return PR_UPDATE_BRANCH_SUPPORTED_RUNNER_LIFECYCLES;
  }

  if (operationName === PR_RESOLVE_CONFLICTS_OPERATION_NAME) {
    return PR_RESOLVE_CONFLICTS_SUPPORTED_RUNNER_LIFECYCLES;
  }

  if (operationName === PRD_PREPARE_OPERATION_NAME) {
    return PRD_PREPARE_SUPPORTED_RUNNER_LIFECYCLES;
  }

  if (operationName === PRD_AUTO_ADVANCE_OPERATION_NAME) {
    return PRD_AUTO_ADVANCE_SUPPORTED_RUNNER_LIFECYCLES;
  }

  if (operationName === PRD_AUTO_COMPLETE_OPERATION_NAME) {
    return PRD_AUTO_COMPLETE_SUPPORTED_RUNNER_LIFECYCLES;
  }

  if (operationName === ISSUE_IMPLEMENT_OPERATION_NAME) {
    return ISSUE_IMPLEMENT_SUPPORTED_RUNNER_LIFECYCLES;
  }

  if (
    operationName === PR_REVIEW_OPERATION_NAME ||
    operationName === PR_ADDRESS_REVIEW_OPERATION_NAME
  ) {
    return REVIEW_LOOP_SUPPORTED_RUNNER_LIFECYCLES;
  }

  return undefined;
}

/**
 * @param {string} operationName
 * @returns {WorkflowOperation | undefined}
 */
export function getOperationCatalogWorkflowOperation(operationName) {
  if (operationName === PR_FIX_CI_OPERATION_NAME) {
    return PR_FIX_CI_WORKFLOW_OPERATION;
  }

  if (operationName === PR_UPDATE_BRANCH_OPERATION_NAME) {
    return PR_UPDATE_BRANCH_WORKFLOW_OPERATION;
  }

  if (operationName === PR_RESOLVE_CONFLICTS_OPERATION_NAME) {
    return PR_RESOLVE_CONFLICTS_WORKFLOW_OPERATION;
  }

  if (operationName === PRD_PREPARE_OPERATION_NAME) {
    return PRD_PREPARE_WORKFLOW_OPERATION;
  }

  if (operationName === PRD_AUTO_ADVANCE_OPERATION_NAME) {
    return PRD_AUTO_ADVANCE_WORKFLOW_OPERATION;
  }

  if (operationName === PRD_AUTO_COMPLETE_OPERATION_NAME) {
    return PRD_AUTO_COMPLETE_WORKFLOW_OPERATION;
  }

  if (operationName === ISSUE_IMPLEMENT_OPERATION_NAME) {
    return ISSUE_IMPLEMENT_WORKFLOW_OPERATION;
  }

  if (operationName === PR_REVIEW_OPERATION_NAME) {
    return PR_REVIEW_WORKFLOW_OPERATION;
  }

  if (operationName === PR_ADDRESS_REVIEW_OPERATION_NAME) {
    return PR_ADDRESS_REVIEW_WORKFLOW_OPERATION;
  }

  return undefined;
}

/**
 * @param {string} reference
 * @returns {OperationLabelReference | undefined}
 */
export function getOperationCatalogOperationLabelReference(reference) {
  if (reference === PR_FIX_CI_OPERATION_LABEL_REFERENCE) {
    return PR_FIX_CI_OPERATION_LABEL_REFERENCE_ENTRY;
  }

  if (reference === PR_UPDATE_BRANCH_OPERATION_LABEL_REFERENCE) {
    return PR_UPDATE_BRANCH_OPERATION_LABEL_REFERENCE_ENTRY;
  }

  if (reference === PR_RESOLVE_CONFLICTS_OPERATION_LABEL_REFERENCE) {
    return PR_RESOLVE_CONFLICTS_OPERATION_LABEL_REFERENCE_ENTRY;
  }

  if (reference === PRD_PREPARE_OPERATION_LABEL_REFERENCE) {
    return PRD_PREPARE_OPERATION_LABEL_REFERENCE_ENTRY;
  }

  if (reference === PRD_AUTO_ADVANCE_OPERATION_LABEL_REFERENCE) {
    return PRD_AUTO_ADVANCE_OPERATION_LABEL_REFERENCE_ENTRY;
  }

  if (reference === PRD_AUTO_COMPLETE_OPERATION_LABEL_REFERENCE) {
    return PRD_AUTO_COMPLETE_OPERATION_LABEL_REFERENCE_ENTRY;
  }

  if (reference === ISSUE_IMPLEMENT_OPERATION_LABEL_REFERENCE) {
    return ISSUE_IMPLEMENT_OPERATION_LABEL_REFERENCE_ENTRY;
  }

  if (reference === PR_REVIEW_OPERATION_LABEL_REFERENCE) {
    return PR_REVIEW_OPERATION_LABEL_REFERENCE_ENTRY;
  }

  if (reference === PR_ADDRESS_REVIEW_OPERATION_LABEL_REFERENCE) {
    return PR_ADDRESS_REVIEW_OPERATION_LABEL_REFERENCE_ENTRY;
  }

  return undefined;
}

/**
 * @param {string} operationName
 * @returns {OperationConfig | ReviewOperationConfig | PrResolveConflictsOperationConfig | undefined}
 */
export function getOperationCatalogDefaultOperationSettings(operationName) {
  if (operationName === PR_FIX_CI_OPERATION_NAME) {
    return PR_FIX_CI_DEFAULT_OPERATION_SETTINGS;
  }

  if (operationName === PR_UPDATE_BRANCH_OPERATION_NAME) {
    return PR_UPDATE_BRANCH_DEFAULT_OPERATION_SETTINGS;
  }

  if (operationName === PR_RESOLVE_CONFLICTS_OPERATION_NAME) {
    return PR_RESOLVE_CONFLICTS_DEFAULT_OPERATION_SETTINGS;
  }

  if (operationName === PRD_PREPARE_OPERATION_NAME) {
    return PRD_PREPARE_DEFAULT_OPERATION_SETTINGS;
  }

  if (operationName === PRD_AUTO_ADVANCE_OPERATION_NAME) {
    return PRD_AUTO_ADVANCE_DEFAULT_OPERATION_SETTINGS;
  }

  if (operationName === PRD_AUTO_COMPLETE_OPERATION_NAME) {
    return PRD_AUTO_COMPLETE_DEFAULT_OPERATION_SETTINGS;
  }

  if (operationName === ISSUE_IMPLEMENT_OPERATION_NAME) {
    return ISSUE_IMPLEMENT_DEFAULT_OPERATION_SETTINGS;
  }

  if (operationName === PR_REVIEW_OPERATION_NAME) {
    return PR_REVIEW_DEFAULT_OPERATION_SETTINGS;
  }

  if (operationName === PR_ADDRESS_REVIEW_OPERATION_NAME) {
    return PR_ADDRESS_REVIEW_DEFAULT_OPERATION_SETTINGS;
  }

  return undefined;
}

/**
 * @param {string} operationName
 * @returns {PullOpsLabel | undefined}
 */
export function getOperationCatalogLabelDefinition(operationName) {
  if (operationName === PR_FIX_CI_OPERATION_NAME) {
    return PR_FIX_CI_LABEL_DEFINITION;
  }

  if (operationName === PR_UPDATE_BRANCH_OPERATION_NAME) {
    return PR_UPDATE_BRANCH_LABEL_DEFINITION;
  }

  if (operationName === PR_RESOLVE_CONFLICTS_OPERATION_NAME) {
    return PR_RESOLVE_CONFLICTS_LABEL_DEFINITION;
  }

  if (operationName === PRD_PREPARE_OPERATION_NAME) {
    return PRD_PREPARE_LABEL_DEFINITION;
  }

  if (operationName === PRD_AUTO_ADVANCE_OPERATION_NAME) {
    return PRD_AUTO_ADVANCE_LABEL_DEFINITION;
  }

  if (operationName === PRD_AUTO_COMPLETE_OPERATION_NAME) {
    return PRD_AUTO_COMPLETE_LABEL_DEFINITION;
  }

  if (operationName === ISSUE_IMPLEMENT_OPERATION_NAME) {
    return ISSUE_IMPLEMENT_LABEL_DEFINITION;
  }

  if (operationName === PR_REVIEW_OPERATION_NAME) {
    return PR_REVIEW_LABEL_DEFINITION;
  }

  if (operationName === PR_ADDRESS_REVIEW_OPERATION_NAME) {
    return PR_ADDRESS_REVIEW_LABEL_DEFINITION;
  }

  return undefined;
}

/**
 * @param {string} operationName
 * @returns {string | undefined}
 */
export function getOperationCatalogWorkflowFileName(operationName) {
  if (operationName === PR_FIX_CI_OPERATION_NAME) {
    return PR_FIX_CI_WORKFLOW_FILE_NAME;
  }

  if (operationName === PR_UPDATE_BRANCH_OPERATION_NAME) {
    return PR_UPDATE_BRANCH_WORKFLOW_FILE_NAME;
  }

  if (operationName === PR_RESOLVE_CONFLICTS_OPERATION_NAME) {
    return PR_RESOLVE_CONFLICTS_WORKFLOW_FILE_NAME;
  }

  if (operationName === PRD_PREPARE_OPERATION_NAME) {
    return PRD_PREPARE_WORKFLOW_FILE_NAME;
  }

  if (operationName === PRD_AUTO_ADVANCE_OPERATION_NAME) {
    return PRD_AUTO_ADVANCE_WORKFLOW_FILE_NAME;
  }

  if (operationName === PRD_AUTO_COMPLETE_OPERATION_NAME) {
    return PRD_AUTO_COMPLETE_WORKFLOW_FILE_NAME;
  }

  if (operationName === ISSUE_IMPLEMENT_OPERATION_NAME) {
    return ISSUE_IMPLEMENT_WORKFLOW_FILE_NAME;
  }

  if (operationName === PR_REVIEW_OPERATION_NAME) {
    return PR_REVIEW_WORKFLOW_FILE_NAME;
  }

  if (operationName === PR_ADDRESS_REVIEW_OPERATION_NAME) {
    return PR_ADDRESS_REVIEW_WORKFLOW_FILE_NAME;
  }

  return undefined;
}

/**
 * @param {string} operationName
 * @returns {string | undefined}
 */
export function getOperationCatalogPackageScriptName(operationName) {
  if (operationName === PR_FIX_CI_OPERATION_NAME) {
    return PR_FIX_CI_PACKAGE_SCRIPT_NAME;
  }

  if (operationName === PR_UPDATE_BRANCH_OPERATION_NAME) {
    return PR_UPDATE_BRANCH_PACKAGE_SCRIPT_NAME;
  }

  if (operationName === PR_RESOLVE_CONFLICTS_OPERATION_NAME) {
    return PR_RESOLVE_CONFLICTS_PACKAGE_SCRIPT_NAME;
  }

  if (operationName === PRD_PREPARE_OPERATION_NAME) {
    return PRD_PREPARE_PACKAGE_SCRIPT_NAME;
  }

  if (operationName === PRD_AUTO_ADVANCE_OPERATION_NAME) {
    return PRD_AUTO_ADVANCE_PACKAGE_SCRIPT_NAME;
  }

  if (operationName === PRD_AUTO_COMPLETE_OPERATION_NAME) {
    return PRD_AUTO_COMPLETE_PACKAGE_SCRIPT_NAME;
  }

  if (operationName === ISSUE_IMPLEMENT_OPERATION_NAME) {
    return ISSUE_IMPLEMENT_PACKAGE_SCRIPT_NAME;
  }

  if (operationName === PR_REVIEW_OPERATION_NAME) {
    return PR_REVIEW_PACKAGE_SCRIPT_NAME;
  }

  if (operationName === PR_ADDRESS_REVIEW_OPERATION_NAME) {
    return PR_ADDRESS_REVIEW_PACKAGE_SCRIPT_NAME;
  }

  return undefined;
}

/**
 * @param {string} operationName
 * @returns {readonly RunnerAdapter[] | undefined}
 */
export function getOperationCatalogSupportedRunnerAdapters(operationName) {
  const supportedRunnerLifecycles = getOperationCatalogSupportedRunnerLifecycles(operationName);
  if (supportedRunnerLifecycles === undefined) {
    return undefined;
  }

  return readUniqueSupportedRunnerAdapters(supportedRunnerLifecycles);
}

/**
 * @param {string} operationName
 * @returns {readonly import('../cli/types.js').OperationPhase[] | undefined}
 */
export function getOperationCatalogSupportedRunnerPhases(operationName) {
  const supportedRunnerLifecycles = getOperationCatalogSupportedRunnerLifecycles(operationName);
  if (supportedRunnerLifecycles === undefined) {
    return undefined;
  }

  return readUniqueSupportedRunnerPhases(supportedRunnerLifecycles);
}

/**
 * @param {string} operationName
 * @returns {((context: import('../cli/types.js').OperationRunnerContext) => Promise<Record<string, unknown>> | Record<string, unknown>) | undefined}
 */
export function getOperationCatalogHandler(operationName, phase = 'run') {
  if (operationName === PR_FIX_CI_OPERATION_NAME) {
    if (phase === 'run') {
      return runPrFixCiThroughCatalog;
    }

    if (phase === 'prepare') {
      return runPrFixCiCodexActionPrepareThroughCatalog;
    }

    if (phase === 'finalize') {
      return runPrFixCiCodexActionFinalizeThroughCatalog;
    }
  }

  if (operationName === PR_UPDATE_BRANCH_OPERATION_NAME) {
    return phase === 'run' ? runPrUpdateBranchThroughCatalog : undefined;
  }

  if (operationName === PR_RESOLVE_CONFLICTS_OPERATION_NAME) {
    if (phase === 'run') {
      return runPrResolveConflictsThroughCatalog;
    }

    if (phase === 'prepare') {
      return runPrResolveConflictsCodexActionPrepareThroughCatalog;
    }

    if (phase === 'finalize') {
      return runPrResolveConflictsCodexActionFinalizeThroughCatalog;
    }
  }

  if (operationName === PRD_PREPARE_OPERATION_NAME) {
    return phase === 'run' ? runPrdPrepareThroughCatalog : undefined;
  }

  if (operationName === PRD_AUTO_ADVANCE_OPERATION_NAME) {
    return phase === 'run' ? runPrdAutoAdvanceThroughCatalog : undefined;
  }

  if (operationName === PRD_AUTO_COMPLETE_OPERATION_NAME) {
    return phase === 'run' ? runPrdAutoCompleteThroughCatalog : undefined;
  }

  if (operationName === ISSUE_IMPLEMENT_OPERATION_NAME) {
    if (phase === 'run') {
      return runIssueImplementThroughCatalog;
    }

    if (phase === 'prepare') {
      return runIssueImplementCodexActionPrepareThroughCatalog;
    }

    if (phase === 'finalize') {
      return runIssueImplementCodexActionFinalizeThroughCatalog;
    }
  }

  if (operationName === PR_REVIEW_OPERATION_NAME) {
    if (phase === 'run') {
      return runPrReviewThroughCatalog;
    }

    if (phase === 'prepare') {
      return runPrReviewCodexActionPrepareThroughCatalog;
    }

    if (phase === 'finalize') {
      return runPrReviewCodexActionFinalizeThroughCatalog;
    }
  }

  if (operationName === PR_ADDRESS_REVIEW_OPERATION_NAME) {
    if (phase === 'run') {
      return runPrAddressReviewThroughCatalog;
    }

    if (phase === 'prepare') {
      return runPrAddressReviewCodexActionPrepareThroughCatalog;
    }

    if (phase === 'finalize') {
      return runPrAddressReviewCodexActionFinalizeThroughCatalog;
    }
  }

  return undefined;
}

/**
 * @param {string} operationName
 * @param {{
 *   phase: import('../cli/types.js').OperationPhase,
 *   runnerAdapter: RunnerAdapter,
 * }} options
 * @returns {boolean}
 */
export function supportsOperationCatalogRunnerLifecycle(operationName, { phase, runnerAdapter }) {
  const supportedRunnerLifecycles = getOperationCatalogSupportedRunnerLifecycles(operationName);
  if (supportedRunnerLifecycles === undefined) {
    return false;
  }

  return supportedRunnerLifecycles.some(
    ([supportedRunnerAdapter, supportedPhase]) =>
      supportedRunnerAdapter === runnerAdapter && supportedPhase === phase,
  );
}
