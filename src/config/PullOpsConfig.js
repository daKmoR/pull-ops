import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { WORKFLOW_OPERATIONS, WORKFLOW_OPERATION_CONFIG_KEYS } from '../operations/operations.js';

/**
 * @typedef {import('./types.js').ModelTier} ModelTier
 * @typedef {import('./types.js').PullOpsConfig} PullOpsConfig
 * @typedef {import('./types.js').UserPullOpsConfig} UserPullOpsConfig
 * @typedef {import('../operations/types.js').WorkflowOperationConfigKey} WorkflowOperationConfigKey
 */

/** @type {ModelTier[]} */
export const MODEL_TIERS = ['high', 'mid', 'low'];

/** @type {PullOpsConfig} */
export const DEFAULT_PULL_OPS_CONFIG = {
  baseBranch: 'main',
  branchPrefix: 'pullops',
  runner: {
    provider: 'codex',
    command: 'codex exec',
    models: {
      high: 'codex-high',
      mid: 'codex-mid',
      low: 'codex-low',
    },
  },
  operations: {
    preparePrd: { modelTier: 'low' },
    implementIssue: { modelTier: 'high' },
    coordinatePrd: { modelTier: 'low' },
    reviewPr: { modelTier: 'high' },
    addressReview: { modelTier: 'mid' },
    fixCi: { modelTier: 'mid' },
    updateBranch: { modelTier: 'low' },
    resolveConflicts: { modelTier: 'high' },
    prepareMerge: { modelTier: 'high' },
  },
};

export class PullOpsConfigError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'PullOpsConfigError';
  }
}

/**
 * @param {{ cwd?: string, configFile?: string }} [options]
 * @returns {Promise<PullOpsConfig>}
 */
export async function loadPullOpsConfig({
  cwd = process.cwd(),
  configFile = 'pullops.config.js',
} = {}) {
  const configPath = resolve(cwd, configFile);

  if (!(await fileExists(configPath))) {
    return cloneConfig(DEFAULT_PULL_OPS_CONFIG);
  }

  const importedConfig = await importConfig(configPath);
  const userConfig = validateConfigObject(importedConfig, configPath);
  validateModelOverrides(userConfig);
  validateOperationOverrides(userConfig);

  return mergeConfig(userConfig);
}

/**
 * @param {string} configPath
 * @returns {Promise<unknown>}
 */
async function importConfig(configPath) {
  try {
    const url = pathToFileURL(configPath);
    url.searchParams.set('pullopsConfigLoad', String(Date.now()));
    const module = await import(url.href);
    return module.default;
  } catch (error) {
    throw new PullOpsConfigError(
      `Unable to load PullOps Config from ${configPath}: ${getErrorMessage(error)}`,
    );
  }
}

/**
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {unknown} userConfig
 * @param {string} configPath
 * @returns {UserPullOpsConfig}
 */
function validateConfigObject(userConfig, configPath) {
  if (!isPlainObject(userConfig)) {
    throw new PullOpsConfigError(`PullOps Config at ${configPath} must default-export an object.`);
  }

  return userConfig;
}

/**
 * @param {UserPullOpsConfig} userConfig
 */
function validateModelOverrides(userConfig) {
  const runner = userConfig.runner;
  const models = isPlainObject(runner) ? runner.models : undefined;
  if (models === undefined) {
    return;
  }

  if (!isPlainObject(models)) {
    throw new PullOpsConfigError('PullOps Config runner.models must be an object.');
  }

  const modelKeys = Object.keys(models);
  const missing = MODEL_TIERS.filter(tier => !modelKeys.includes(tier));
  const unknown = modelKeys.filter(tier => !MODEL_TIERS.includes(/** @type {ModelTier} */ (tier)));

  if (missing.length > 0 || unknown.length > 0) {
    const problems = [];
    if (missing.length > 0) {
      problems.push(`missing ${missing.join(', ')}`);
    }
    if (unknown.length > 0) {
      problems.push(`unknown ${unknown.join(', ')}`);
    }
    throw new PullOpsConfigError(
      `PullOps Config runner.models must override all model tiers (${MODEL_TIERS.join(
        ', ',
      )}); ${problems.join('; ')}.`,
    );
  }

  for (const tier of MODEL_TIERS) {
    if (typeof models[tier] !== 'string' || models[tier].trim() === '') {
      throw new PullOpsConfigError(
        `PullOps Config runner.models.${tier} must be a non-empty string.`,
      );
    }
  }
}

/**
 * @param {UserPullOpsConfig} userConfig
 */
function validateOperationOverrides(userConfig) {
  const operations = userConfig.operations;
  if (operations === undefined) {
    return;
  }

  if (!isPlainObject(operations)) {
    throw new PullOpsConfigError('PullOps Config operations must be an object.');
  }

  const unknownOperations = Object.keys(operations).filter(
    operation =>
      !WORKFLOW_OPERATION_CONFIG_KEYS.includes(
        /** @type {WorkflowOperationConfigKey} */ (operation),
      ),
  );

  if (unknownOperations.length > 0) {
    throw new PullOpsConfigError(
      `PullOps Config operations contains unknown operation keys: ${unknownOperations.join(', ')}.`,
    );
  }

  for (const [operation, settings] of Object.entries(operations)) {
    if (!isPlainObject(settings)) {
      throw new PullOpsConfigError(`PullOps Config operations.${operation} must be an object.`);
    }

    const modelTier = settings.modelTier;
    if (
      modelTier !== undefined &&
      (typeof modelTier !== 'string' || !MODEL_TIERS.includes(/** @type {ModelTier} */ (modelTier)))
    ) {
      throw new PullOpsConfigError(
        `PullOps Config operations.${operation}.modelTier must be one of: ${MODEL_TIERS.join(
          ', ',
        )}. Received ${JSON.stringify(modelTier)}.`,
      );
    }
  }
}

/**
 * @param {UserPullOpsConfig} userConfig
 * @returns {PullOpsConfig}
 */
function mergeConfig(userConfig) {
  const config = cloneConfig(DEFAULT_PULL_OPS_CONFIG);

  if (userConfig.baseBranch !== undefined) {
    config.baseBranch = requireString(userConfig.baseBranch, 'baseBranch');
  }
  if (userConfig.branchPrefix !== undefined) {
    config.branchPrefix = requireString(userConfig.branchPrefix, 'branchPrefix');
  }

  const runner = userConfig.runner;
  if (runner !== undefined) {
    if (!isPlainObject(runner)) {
      throw new PullOpsConfigError('PullOps Config runner must be an object.');
    }
    if (runner.provider !== undefined) {
      config.runner.provider = requireString(runner.provider, 'runner.provider');
    }
    if (runner.command !== undefined) {
      config.runner.command = requireString(runner.command, 'runner.command');
    }
    if (runner.models !== undefined) {
      config.runner.models = /** @type {Record<ModelTier, string>} */ ({ ...runner.models });
    }
  }

  if (isPlainObject(userConfig.operations)) {
    for (const operation of WORKFLOW_OPERATIONS) {
      const settings = userConfig.operations[operation.configKey];
      if (settings !== undefined) {
        config.operations[operation.configKey] = {
          ...config.operations[operation.configKey],
          ...settings,
        };
      }
    }
  }

  return config;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {string}
 */
function requireString(value, path) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PullOpsConfigError(`PullOps Config ${path} must be a non-empty string.`);
  }
  return value;
}

/**
 * @param {PullOpsConfig} config
 * @returns {PullOpsConfig}
 */
function cloneConfig(config) {
  return structuredClone(config);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
