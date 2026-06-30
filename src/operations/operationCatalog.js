/**
 * @typedef {import('../config/types.js').OperationConfig} OperationConfig
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

/** @type {readonly RunnerAdapter[]} */
const PRD_PREPARE_SUPPORTED_RUNNER_ADAPTERS = Object.freeze(['codex-cli']);

/** @type {readonly import('../cli/types.js').OperationPhase[]} */
const PRD_PREPARE_SUPPORTED_RUNNER_PHASES = Object.freeze(['run']);

/**
 * @param {import('../cli/types.js').OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
async function runPrdPrepareThroughCatalog(context) {
  const { runPrdPrepare } = await import('./prd-prepare/run.js');
  return await runPrdPrepare(context);
}

/**
 * @param {string} operationName
 * @returns {WorkflowOperation | undefined}
 */
export function getOperationCatalogWorkflowOperation(operationName) {
  return operationName === PRD_PREPARE_OPERATION_NAME ? PRD_PREPARE_WORKFLOW_OPERATION : undefined;
}

/**
 * @param {string} reference
 * @returns {OperationLabelReference | undefined}
 */
export function getOperationCatalogOperationLabelReference(reference) {
  return reference === PRD_PREPARE_OPERATION_LABEL_REFERENCE
    ? PRD_PREPARE_OPERATION_LABEL_REFERENCE_ENTRY
    : undefined;
}

/**
 * @param {string} operationName
 * @returns {OperationConfig | undefined}
 */
export function getOperationCatalogDefaultOperationSettings(operationName) {
  return operationName === PRD_PREPARE_OPERATION_NAME
    ? PRD_PREPARE_DEFAULT_OPERATION_SETTINGS
    : undefined;
}

/**
 * @param {string} operationName
 * @returns {PullOpsLabel | undefined}
 */
export function getOperationCatalogLabelDefinition(operationName) {
  return operationName === PRD_PREPARE_OPERATION_NAME ? PRD_PREPARE_LABEL_DEFINITION : undefined;
}

/**
 * @param {string} operationName
 * @returns {string | undefined}
 */
export function getOperationCatalogWorkflowFileName(operationName) {
  return operationName === PRD_PREPARE_OPERATION_NAME ? PRD_PREPARE_WORKFLOW_FILE_NAME : undefined;
}

/**
 * @param {string} operationName
 * @returns {string | undefined}
 */
export function getOperationCatalogPackageScriptName(operationName) {
  return operationName === PRD_PREPARE_OPERATION_NAME ? PRD_PREPARE_PACKAGE_SCRIPT_NAME : undefined;
}

/**
 * @param {string} operationName
 * @returns {readonly RunnerAdapter[] | undefined}
 */
export function getOperationCatalogSupportedRunnerAdapters(operationName) {
  return operationName === PRD_PREPARE_OPERATION_NAME
    ? PRD_PREPARE_SUPPORTED_RUNNER_ADAPTERS
    : undefined;
}

/**
 * @param {string} operationName
 * @returns {readonly import('../cli/types.js').OperationPhase[] | undefined}
 */
export function getOperationCatalogSupportedRunnerPhases(operationName) {
  return operationName === PRD_PREPARE_OPERATION_NAME
    ? PRD_PREPARE_SUPPORTED_RUNNER_PHASES
    : undefined;
}

/**
 * @param {string} operationName
 * @returns {((context: import('../cli/types.js').OperationRunnerContext) => Promise<Record<string, unknown>> | Record<string, unknown>) | undefined}
 */
export function getOperationCatalogHandler(operationName) {
  return operationName === PRD_PREPARE_OPERATION_NAME ? runPrdPrepareThroughCatalog : undefined;
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
  const supportedRunnerAdapters = getOperationCatalogSupportedRunnerAdapters(operationName);
  const supportedRunnerPhases = getOperationCatalogSupportedRunnerPhases(operationName);
  if (supportedRunnerAdapters === undefined || supportedRunnerPhases === undefined) {
    return false;
  }

  return supportedRunnerAdapters.includes(runnerAdapter) && supportedRunnerPhases.includes(phase);
}
