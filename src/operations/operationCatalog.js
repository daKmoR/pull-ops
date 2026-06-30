/**
 * @typedef {import('../config/types.js').OperationConfig} OperationConfig
 * @typedef {import('../config/types.js').ReviewOperationConfig} ReviewOperationConfig
 * @typedef {import('../config/types.js').PrFinalizeOperationConfig} PrFinalizeOperationConfig
 * @typedef {import('../config/types.js').PrResolveConflictsOperationConfig} PrResolveConflictsOperationConfig
 * @typedef {import('../cli/types.js').OperationPhase} OperationPhase
 * @typedef {import('../github/types.js').PullOpsLabel} PullOpsLabel
 * @typedef {import('../operations/types.js').OperationLabelReference} OperationLabelReference
 * @typedef {import('../operations/types.js').WorkflowOperation} WorkflowOperation
 * @typedef {import('../operations/types.js').WorkflowOperationConfigKey} WorkflowOperationConfigKey
 * @typedef {import('../runner/types.js').RunnerAdapter} RunnerAdapter
 */

const OPERATION_LABEL_COLOR = '5319E7';

const CODEX_CLI_RUN_LIFECYCLES = freezeRunnerLifecycles([['codex-cli', 'run']]);
const CODEX_BACKED_RUNNER_LIFECYCLES = freezeRunnerLifecycles([
  ['codex-cli', 'run'],
  ['codex-action', 'prepare'],
  ['codex-action', 'finalize'],
]);

const OPERATION_CATALOG_ENTRIES = Object.freeze([
  createOperationCatalogEntry({
    name: 'prd-prepare',
    target: 'issue',
    configKey: 'prdPrepare',
    defaultOperationSettings: Object.freeze({
      modelTier: 'low',
    }),
    supportedRunnerLifecycles: CODEX_CLI_RUN_LIFECYCLES,
    workflowFileName: 'pullops-prd-prepare.yml',
    packageScriptName: 'pullops:prd-prepare',
    label: createOperationCatalogLabel({
      reference: 'prd:prepare',
      name: 'pullops:prd:prepare',
      description: 'Prepare an umbrella branch and draft PR for a PRD issue.',
    }),
    handlers: {
      run: createImportedOperationHandler('./prd-prepare/run.js', 'runPrdPrepare'),
    },
  }),
  createOperationCatalogEntry({
    name: 'prd-auto-advance',
    target: 'issue',
    configKey: 'prdAutoAdvance',
    defaultOperationSettings: Object.freeze({
      modelTier: 'low',
    }),
    supportedRunnerLifecycles: CODEX_CLI_RUN_LIFECYCLES,
    workflowFileName: 'pullops-prd-auto-advance.yml',
    packageScriptName: 'pullops:prd-auto-advance',
    label: createOperationCatalogLabel({
      reference: 'prd:auto-advance',
      name: 'pullops:prd:auto-advance',
      description: 'Prepare a PRD and drain the current unblocked child frontier.',
    }),
    handlers: {
      run: createImportedOperationHandler('./prd-automation/run.js', 'runPrdAutoAdvance'),
    },
  }),
  createOperationCatalogEntry({
    name: 'prd-auto-complete',
    target: 'issue',
    configKey: 'prdAutoComplete',
    defaultOperationSettings: Object.freeze({
      modelTier: 'low',
    }),
    supportedRunnerLifecycles: CODEX_CLI_RUN_LIFECYCLES,
    workflowFileName: 'pullops-prd-auto-complete.yml',
    packageScriptName: 'pullops:prd-auto-complete',
    label: createOperationCatalogLabel({
      reference: 'prd:auto-complete',
      name: 'pullops:prd:auto-complete',
      description:
        'Complete a PRD through child PRs, umbrella integration, and finalization; humans merge umbrella PR.',
    }),
    handlers: {
      run: createImportedOperationHandler('./prd-automation/run.js', 'runPrdAutoComplete'),
    },
  }),
  createOperationCatalogEntry({
    name: 'issue-implement',
    target: 'issue',
    configKey: 'issueImplement',
    defaultOperationSettings: Object.freeze({
      modelTier: 'high',
    }),
    supportedRunnerLifecycles: CODEX_BACKED_RUNNER_LIFECYCLES,
    workflowFileName: 'pullops-issue-implement.yml',
    packageScriptName: 'pullops:issue-implement',
    label: createOperationCatalogLabel({
      reference: 'issue:implement',
      name: 'pullops:issue:implement',
      description:
        'Implement one concrete issue through review and finalization. Does not coordinate child issues.',
    }),
    handlers: {
      run: createImportedOperationHandler('./issue-implement/run.js', 'runIssueImplement'),
      prepare: createImportedOperationHandler(
        './issue-implement/run.js',
        'runIssueImplementCodexActionPrepare',
      ),
      finalize: createImportedOperationHandler(
        './issue-implement/run.js',
        'runIssueImplementCodexActionFinalize',
      ),
    },
  }),
  createOperationCatalogEntry({
    name: 'pr-review',
    target: 'pr',
    configKey: 'prReview',
    defaultOperationSettings: Object.freeze({
      modelTier: 'high',
      escalationModelTier: 'high',
      humanFeedbackResponseModelTier: 'high',
    }),
    supportedRunnerLifecycles: CODEX_BACKED_RUNNER_LIFECYCLES,
    workflowFileName: 'pullops-pr-review.yml',
    packageScriptName: 'pullops:pr-review',
    label: createOperationCatalogLabel({
      reference: 'pr:review',
      name: 'pullops:pr:review',
      description: 'Run PullOps automated PR review.',
    }),
    handlers: {
      run: createImportedOperationHandler('./pr-review/run.js', 'runPrReview'),
      prepare: createImportedOperationHandler(
        './pr-review/run.js',
        'runPrReviewCodexActionPrepare',
      ),
      finalize: createImportedOperationHandler(
        './pr-review/run.js',
        'runPrReviewCodexActionFinalize',
      ),
    },
  }),
  createOperationCatalogEntry({
    name: 'pr-address-review',
    target: 'pr',
    configKey: 'prAddressReview',
    defaultOperationSettings: Object.freeze({
      modelTier: 'mid',
      escalationModelTier: 'high',
      humanFeedbackResponseModelTier: 'high',
    }),
    supportedRunnerLifecycles: CODEX_BACKED_RUNNER_LIFECYCLES,
    workflowFileName: 'pullops-pr-address-review.yml',
    packageScriptName: 'pullops:pr-address-review',
    label: createOperationCatalogLabel({
      reference: 'pr:address-review',
      name: 'pullops:pr:address-review',
      description: 'Address actionable PullOps PR review feedback.',
    }),
    handlers: {
      run: createImportedOperationHandler('./pr-address-review/run.js', 'runPrAddressReview'),
      prepare: createImportedOperationHandler(
        './pr-address-review/run.js',
        'runPrAddressReviewCodexActionPrepare',
      ),
      finalize: createImportedOperationHandler(
        './pr-address-review/run.js',
        'runPrAddressReviewCodexActionFinalize',
      ),
    },
  }),
  createOperationCatalogEntry({
    name: 'pr-fix-ci',
    target: 'pr',
    configKey: 'prFixCi',
    defaultOperationSettings: Object.freeze({
      modelTier: 'mid',
    }),
    supportedRunnerLifecycles: CODEX_BACKED_RUNNER_LIFECYCLES,
    workflowFileName: 'pullops-pr-fix-ci.yml',
    packageScriptName: 'pullops:pr-fix-ci',
    label: createOperationCatalogLabel({
      reference: 'pr:fix-ci',
      name: 'pullops:pr:fix-ci',
      description: 'Classify and fix actionable CI failures.',
    }),
    handlers: {
      run: createImportedOperationHandler('./pr-fix-ci/run.js', 'runPrFixCi'),
      prepare: createImportedOperationHandler('./pr-fix-ci/run.js', 'runPrFixCiCodexActionPrepare'),
      finalize: createImportedOperationHandler(
        './pr-fix-ci/run.js',
        'runPrFixCiCodexActionFinalize',
      ),
    },
  }),
  createOperationCatalogEntry({
    name: 'pr-update-branch',
    target: 'pr',
    configKey: 'prUpdateBranch',
    defaultOperationSettings: Object.freeze({
      modelTier: 'low',
    }),
    supportedRunnerLifecycles: CODEX_CLI_RUN_LIFECYCLES,
    workflowFileName: 'pullops-pr-update-branch.yml',
    packageScriptName: 'pullops:pr-update-branch',
    label: createOperationCatalogLabel({
      reference: 'pr:update-branch',
      name: 'pullops:pr:update-branch',
      description: 'Update a same-repository PR branch.',
    }),
    handlers: {
      run: createImportedOperationHandler('./pr-update-branch/run.js', 'runPrUpdateBranch'),
    },
  }),
  createOperationCatalogEntry({
    name: 'pr-resolve-conflicts',
    target: 'pr',
    configKey: 'prResolveConflicts',
    defaultOperationSettings: Object.freeze({
      modelTier: 'high',
      maxConflictResolutionPasses: 3,
    }),
    supportedRunnerLifecycles: CODEX_BACKED_RUNNER_LIFECYCLES,
    workflowFileName: 'pullops-pr-resolve-conflicts.yml',
    packageScriptName: 'pullops:pr-resolve-conflicts',
    label: createOperationCatalogLabel({
      reference: 'pr:resolve-conflicts',
      name: 'pullops:pr:resolve-conflicts',
      description: 'Resolve branch update conflicts with the PullOps runner.',
    }),
    handlers: {
      run: createImportedOperationHandler('./pr-resolve-conflicts/run.js', 'runPrResolveConflicts'),
      prepare: createImportedOperationHandler(
        './pr-resolve-conflicts/run.js',
        'runPrResolveConflictsCodexActionPrepare',
      ),
      finalize: createImportedOperationHandler(
        './pr-resolve-conflicts/run.js',
        'runPrResolveConflictsCodexActionFinalize',
      ),
    },
  }),
  createOperationCatalogEntry({
    name: 'pr-finalize',
    target: 'pr',
    configKey: 'prFinalize',
    defaultOperationSettings: Object.freeze({
      modelTier: 'high',
      aiHistoryCleanup: true,
    }),
    supportedRunnerLifecycles: CODEX_BACKED_RUNNER_LIFECYCLES,
    workflowFileName: 'pullops-pr-finalize.yml',
    packageScriptName: 'pullops:pr-finalize',
    label: createOperationCatalogLabel({
      reference: 'pr:finalize',
      name: 'pullops:pr:finalize',
      description: 'Finalize a PullOps-managed PR for human review and merge.',
    }),
    handlers: {
      run: createImportedOperationHandler('./pr-finalize/run.js', 'runPrFinalize'),
      prepare: createImportedOperationHandler(
        './pr-finalize/run.js',
        'runPrFinalizeCodexActionPrepare',
      ),
      finalize: createImportedOperationHandler(
        './pr-finalize/run.js',
        'runPrFinalizeCodexActionFinalize',
      ),
    },
  }),
  createOperationCatalogEntry({
    name: 'pr-close-child-issue',
    target: 'pr',
    configKey: 'prCloseChildIssue',
    defaultOperationSettings: Object.freeze({
      modelTier: 'low',
    }),
    supportedRunnerLifecycles: CODEX_CLI_RUN_LIFECYCLES,
    workflowFileName: 'pullops-pr-close-child-issue.yml',
    packageScriptName: 'pullops:pr-close-child-issue',
    handlers: {
      run: createImportedOperationHandler('./pr-close-child-issue/run.js', 'runPrCloseChildIssue'),
    },
  }),
]);

const OPERATION_CATALOG_ENTRY_BY_NAME = new Map(
  OPERATION_CATALOG_ENTRIES.map(entry => [entry.name, entry]),
);

/** @type {readonly WorkflowOperation[]} */
const OPERATION_CATALOG_WORKFLOW_OPERATIONS = Object.freeze(
  OPERATION_CATALOG_ENTRIES.map(entry => entry.workflowOperation),
);

/** @type {readonly OperationLabelReference[]} */
const OPERATION_CATALOG_OPERATION_LABEL_REFERENCES = Object.freeze(
  OPERATION_CATALOG_ENTRIES.flatMap(entry =>
    entry.operationLabelReference === undefined ? [] : [entry.operationLabelReference],
  ),
);

/** @type {readonly PullOpsLabel[]} */
const OPERATION_CATALOG_LABEL_DEFINITIONS = Object.freeze(
  OPERATION_CATALOG_ENTRIES.flatMap(entry =>
    entry.labelDefinition === undefined ? [] : [entry.labelDefinition],
  ),
);

/** @type {readonly string[]} */
const OPERATION_CATALOG_OPERATION_LABEL_NAMES = Object.freeze(
  OPERATION_CATALOG_OPERATION_LABEL_REFERENCES.map(operation => operation.label),
);

/** @type {readonly string[]} */
const EMPTY_OPERATION_LABEL_NAMES = Object.freeze([]);

const OPERATION_CATALOG_OPERATION_LABEL_NAMES_BY_TARGET = new Map(
  ['issue', 'pr'].map(target => [
    target,
    Object.freeze(
      OPERATION_CATALOG_OPERATION_LABEL_REFERENCES.flatMap(operation =>
        operation.target === target ? [operation.label] : [],
      ),
    ),
  ]),
);

const OPERATION_CATALOG_OPERATION_LABEL_REFERENCE_BY_REFERENCE = new Map(
  OPERATION_CATALOG_OPERATION_LABEL_REFERENCES.map(operation => [operation.reference, operation]),
);

const OPERATION_CATALOG_OPERATION_LABEL_REFERENCE_BY_WORKFLOW_OPERATION_NAME = new Map(
  OPERATION_CATALOG_OPERATION_LABEL_REFERENCES.map(operation => [
    operation.workflowOperationName,
    operation,
  ]),
);

/**
 * @returns {readonly WorkflowOperation[]}
 */
export function getOperationCatalogWorkflowOperations() {
  return OPERATION_CATALOG_WORKFLOW_OPERATIONS;
}

/**
 * @returns {readonly OperationLabelReference[]}
 */
export function getOperationCatalogOperationLabelReferences() {
  return OPERATION_CATALOG_OPERATION_LABEL_REFERENCES;
}

/**
 * @returns {readonly PullOpsLabel[]}
 */
export function getOperationCatalogLabelDefinitions() {
  return OPERATION_CATALOG_LABEL_DEFINITIONS;
}

/**
 * @returns {readonly string[]}
 */
export function getOperationCatalogOperationLabelNames() {
  return OPERATION_CATALOG_OPERATION_LABEL_NAMES;
}

/**
 * @param {WorkflowOperation['target']} target
 * @returns {readonly string[]}
 */
export function getOperationCatalogOperationLabelNamesForTarget(target) {
  return (
    OPERATION_CATALOG_OPERATION_LABEL_NAMES_BY_TARGET.get(target) ?? EMPTY_OPERATION_LABEL_NAMES
  );
}

/**
 * @param {string} operationName
 * @returns {readonly [RunnerAdapter, OperationPhase][] | undefined}
 */
export function getOperationCatalogSupportedRunnerLifecycles(operationName) {
  return getOperationCatalogEntry(operationName)?.supportedRunnerLifecycles;
}

/**
 * @param {string} operationName
 * @returns {WorkflowOperation | undefined}
 */
export function getOperationCatalogWorkflowOperation(operationName) {
  return getOperationCatalogEntry(operationName)?.workflowOperation;
}

/**
 * @param {string} reference
 * @returns {OperationLabelReference | undefined}
 */
export function getOperationCatalogOperationLabelReference(reference) {
  return OPERATION_CATALOG_OPERATION_LABEL_REFERENCE_BY_REFERENCE.get(reference);
}

/**
 * @param {string} operationName
 * @returns {OperationLabelReference | undefined}
 */
export function getOperationCatalogOperationLabelReferenceForWorkflowOperation(operationName) {
  return OPERATION_CATALOG_OPERATION_LABEL_REFERENCE_BY_WORKFLOW_OPERATION_NAME.get(operationName);
}

/**
 * @param {string} operationName
 * @returns {OperationConfig | ReviewOperationConfig | PrResolveConflictsOperationConfig | PrFinalizeOperationConfig | undefined}
 */
export function getOperationCatalogDefaultOperationSettings(operationName) {
  return getOperationCatalogEntry(operationName)?.defaultOperationSettings;
}

/**
 * @param {string} operationName
 * @returns {PullOpsLabel | undefined}
 */
export function getOperationCatalogLabelDefinition(operationName) {
  return getOperationCatalogEntry(operationName)?.labelDefinition;
}

/**
 * @param {string} operationName
 * @returns {string | undefined}
 */
export function getOperationCatalogOperationLabelName(operationName) {
  return getOperationCatalogLabelDefinition(operationName)?.name;
}

/**
 * @param {string} operationName
 * @returns {string}
 */
export function requireOperationCatalogOperationLabelName(operationName) {
  const labelName = getOperationCatalogOperationLabelName(operationName);
  if (labelName === undefined) {
    throw new Error(`${operationName} label definition is missing from the operation catalog.`);
  }

  return labelName;
}

/**
 * @param {string} operationName
 * @returns {string | undefined}
 */
export function getOperationCatalogWorkflowFileName(operationName) {
  return getOperationCatalogEntry(operationName)?.workflowFileName;
}

/**
 * @param {string} operationName
 * @returns {string | undefined}
 */
export function getOperationCatalogPackageScriptName(operationName) {
  return getOperationCatalogEntry(operationName)?.packageScriptName;
}

/**
 * @param {string} operationName
 * @returns {readonly RunnerAdapter[] | undefined}
 */
export function getOperationCatalogSupportedRunnerAdapters(operationName) {
  return getOperationCatalogEntry(operationName)?.supportedRunnerAdapters;
}

/**
 * @param {string} operationName
 * @returns {readonly OperationPhase[] | undefined}
 */
export function getOperationCatalogSupportedRunnerPhases(operationName) {
  return getOperationCatalogEntry(operationName)?.supportedRunnerPhases;
}

/**
 * @param {string} operationName
 * @param {OperationPhase} [phase]
 * @returns {((context: import('../cli/types.js').OperationRunnerContext) => Promise<Record<string, unknown>>) | undefined}
 */
export function getOperationCatalogHandler(operationName, phase = 'run') {
  const entry = getOperationCatalogEntry(operationName);
  if (entry === undefined) {
    return undefined;
  }

  return entry.handlers[phase];
}

/**
 * @param {string} operationName
 * @param {{
 *   phase: OperationPhase,
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

/**
 * @param {object} options
 * @param {string} options.name
 * @param {WorkflowOperation['target']} options.target
 * @param {WorkflowOperationConfigKey} options.configKey
 * @param {OperationConfig | ReviewOperationConfig | PrResolveConflictsOperationConfig | PrFinalizeOperationConfig} options.defaultOperationSettings
 * @param {readonly [RunnerAdapter, OperationPhase][]} options.supportedRunnerLifecycles
 * @param {string} options.workflowFileName
 * @param {string} options.packageScriptName
 * @param {{ reference: string, name: string, description: string, color: string }} [options.label]
 * @param {{
 *   run: (context: import('../cli/types.js').OperationRunnerContext) => Promise<Record<string, unknown>>,
 *   prepare?: (context: import('../cli/types.js').OperationRunnerContext) => Promise<Record<string, unknown>>,
 *   finalize?: (context: import('../cli/types.js').OperationRunnerContext) => Promise<Record<string, unknown>>,
 * }} options.handlers
 */
function createOperationCatalogEntry({
  name,
  target,
  configKey,
  defaultOperationSettings,
  supportedRunnerLifecycles,
  workflowFileName,
  packageScriptName,
  label,
  handlers,
}) {
  const workflowOperation = Object.freeze({
    name,
    target,
    option: target,
    configKey,
  });
  const operationLabelReference =
    label === undefined
      ? undefined
      : Object.freeze({
          reference: label.reference,
          workflowOperationName: name,
          target,
          label: label.name,
        });
  const labelDefinition =
    label === undefined
      ? undefined
      : Object.freeze({
          name: label.name,
          color: label.color,
          description: label.description,
        });

  return Object.freeze({
    name,
    workflowOperation,
    operationLabelReference,
    defaultOperationSettings,
    labelDefinition,
    workflowFileName,
    packageScriptName,
    supportedRunnerLifecycles,
    supportedRunnerAdapters: readUniqueSupportedRunnerAdapters(supportedRunnerLifecycles),
    supportedRunnerPhases: readUniqueSupportedRunnerPhases(supportedRunnerLifecycles),
    handlers: Object.freeze({ ...handlers }),
  });
}

/**
 * @param {object} options
 * @param {string} options.reference
 * @param {string} options.name
 * @param {string} options.description
 * @param {string} [options.color]
 * @returns {{ reference: string, name: string, description: string, color: string }}
 */
function createOperationCatalogLabel({
  reference,
  name,
  description,
  color = OPERATION_LABEL_COLOR,
}) {
  return Object.freeze({
    reference,
    name,
    description,
    color,
  });
}

/**
 * @param {string} operationName
 * @returns {any}
 */
function getOperationCatalogEntry(operationName) {
  return OPERATION_CATALOG_ENTRY_BY_NAME.get(operationName);
}

/**
 * @param {string} importPath
 * @param {string} exportName
 * @returns {(context: import('../cli/types.js').OperationRunnerContext) => Promise<Record<string, unknown>>}
 */
function createImportedOperationHandler(importPath, exportName) {
  return async context => {
    const operationModule = await import(importPath);
    const handler = operationModule[exportName];
    if (typeof handler !== 'function') {
      throw new Error(`${exportName} is missing from ${importPath}.`);
    }

    return await handler(context);
  };
}

/**
 * @param {Array<[RunnerAdapter, OperationPhase]>} lifecycles
 * @returns {readonly [RunnerAdapter, OperationPhase][]}
 */
function freezeRunnerLifecycles(lifecycles) {
  return /** @type {readonly [RunnerAdapter, OperationPhase][]} */ (
    Object.freeze(lifecycles.map(([runnerAdapter, phase]) => [runnerAdapter, phase]))
  );
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
