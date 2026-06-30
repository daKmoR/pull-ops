/**
 * @typedef {import('../config/types.js').OperationConfig} OperationConfig
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
  if (operationName === PRD_PREPARE_OPERATION_NAME) {
    return PRD_PREPARE_SUPPORTED_RUNNER_LIFECYCLES;
  }

  if (operationName === ISSUE_IMPLEMENT_OPERATION_NAME) {
    return ISSUE_IMPLEMENT_SUPPORTED_RUNNER_LIFECYCLES;
  }

  return undefined;
}

/**
 * @param {string} operationName
 * @returns {WorkflowOperation | undefined}
 */
export function getOperationCatalogWorkflowOperation(operationName) {
  if (operationName === PRD_PREPARE_OPERATION_NAME) {
    return PRD_PREPARE_WORKFLOW_OPERATION;
  }

  if (operationName === ISSUE_IMPLEMENT_OPERATION_NAME) {
    return ISSUE_IMPLEMENT_WORKFLOW_OPERATION;
  }

  return undefined;
}

/**
 * @param {string} reference
 * @returns {OperationLabelReference | undefined}
 */
export function getOperationCatalogOperationLabelReference(reference) {
  if (reference === PRD_PREPARE_OPERATION_LABEL_REFERENCE) {
    return PRD_PREPARE_OPERATION_LABEL_REFERENCE_ENTRY;
  }

  if (reference === ISSUE_IMPLEMENT_OPERATION_LABEL_REFERENCE) {
    return ISSUE_IMPLEMENT_OPERATION_LABEL_REFERENCE_ENTRY;
  }

  return undefined;
}

/**
 * @param {string} operationName
 * @returns {OperationConfig | undefined}
 */
export function getOperationCatalogDefaultOperationSettings(operationName) {
  if (operationName === PRD_PREPARE_OPERATION_NAME) {
    return PRD_PREPARE_DEFAULT_OPERATION_SETTINGS;
  }

  if (operationName === ISSUE_IMPLEMENT_OPERATION_NAME) {
    return ISSUE_IMPLEMENT_DEFAULT_OPERATION_SETTINGS;
  }

  return undefined;
}

/**
 * @param {string} operationName
 * @returns {PullOpsLabel | undefined}
 */
export function getOperationCatalogLabelDefinition(operationName) {
  if (operationName === PRD_PREPARE_OPERATION_NAME) {
    return PRD_PREPARE_LABEL_DEFINITION;
  }

  if (operationName === ISSUE_IMPLEMENT_OPERATION_NAME) {
    return ISSUE_IMPLEMENT_LABEL_DEFINITION;
  }

  return undefined;
}

/**
 * @param {string} operationName
 * @returns {string | undefined}
 */
export function getOperationCatalogWorkflowFileName(operationName) {
  if (operationName === PRD_PREPARE_OPERATION_NAME) {
    return PRD_PREPARE_WORKFLOW_FILE_NAME;
  }

  if (operationName === ISSUE_IMPLEMENT_OPERATION_NAME) {
    return ISSUE_IMPLEMENT_WORKFLOW_FILE_NAME;
  }

  return undefined;
}

/**
 * @param {string} operationName
 * @returns {string | undefined}
 */
export function getOperationCatalogPackageScriptName(operationName) {
  if (operationName === PRD_PREPARE_OPERATION_NAME) {
    return PRD_PREPARE_PACKAGE_SCRIPT_NAME;
  }

  if (operationName === ISSUE_IMPLEMENT_OPERATION_NAME) {
    return ISSUE_IMPLEMENT_PACKAGE_SCRIPT_NAME;
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
  if (operationName === PRD_PREPARE_OPERATION_NAME) {
    return phase === 'run' ? runPrdPrepareThroughCatalog : undefined;
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
