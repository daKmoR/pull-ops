import { execFileSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  getOperationCatalogDefaultOperationSettings,
  getOperationCatalogWorkflowOperations,
} from '../operations/operationCatalog.js';
import {
  DEFAULT_RUNNER_ADAPTER,
  isRunnerAdapter,
  RUNNER_ADAPTERS,
} from '../runner/runnerAdapters.js';
import { readRunnerCommandCli } from '../runner/runnerCommand.js';

/**
 * @typedef {import('./types.js').ModelTier} ModelTier
 * @typedef {import('./types.js').PullOpsConfig} PullOpsConfig
 * @typedef {import('./types.js').UserPullOpsConfig} UserPullOpsConfig
 * @typedef {import('../operations/types.js').WorkflowOperationConfigKey} WorkflowOperationConfigKey
 */

/** @type {ModelTier[]} */
export const MODEL_TIERS = ['high', 'mid', 'low'];

/** @type {Record<ModelTier, string>} */
export const CLAUDE_RUNNER_MODEL_DEFAULTS = {
  high: 'claude-opus-4-8',
  mid: 'claude-sonnet-5',
  low: 'claude-haiku-4-5',
};

/**
 * Default per-target Run Budget: generous resource caps that replace cycle
 * counts as the primary continuation gate for PullOps-Managed PR automation.
 *
 * @type {import('./types.js').RunBudgetConfig}
 */
export const DEFAULT_RUN_BUDGET_CONFIG = {
  maxUsedTokens: 2_000_000,
  maxDurationMs: 4 * 60 * 60 * 1000,
};

/** @type {PullOpsConfig} */
export const DEFAULT_PULL_OPS_CONFIG = {
  baseBranch: 'main',
  branchPrefix: 'pullops',
  issueStore: {},
  runner: {
    adapter: DEFAULT_RUNNER_ADAPTER,
    command: 'codex exec',
    models: {
      high: 'gpt-5.5',
      mid: 'gpt-5.4',
      low: 'gpt-5.4-mini',
    },
  },
  runBudget: { ...DEFAULT_RUN_BUDGET_CONFIG },
  operations: buildDefaultOperationConfigs(),
};

/**
 * @returns {PullOpsConfig['operations']}
 */
function buildDefaultOperationConfigs() {
  const operations = /** @type {Record<string, unknown>} */ ({});

  for (const operation of getOperationCatalogWorkflowOperations()) {
    const defaultOperationSettings = getOperationCatalogDefaultOperationSettings(operation.name);
    if (defaultOperationSettings === undefined) {
      throw new Error(`${operation.name} defaults are missing from the operation catalog.`);
    }

    operations[operation.configKey] = defaultOperationSettings;
  }

  return /** @type {PullOpsConfig['operations']} */ (operations);
}

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
 * @param {{
 *   cwd?: string,
 *   configFile?: string,
 *   env?: NodeJS.ProcessEnv,
 *   readRemoteOriginUrl?: () => string | undefined,
 * }} [options]
 * @returns {Promise<PullOpsConfig>}
 */
export async function loadPullOpsConfig({
  cwd = process.cwd(),
  configFile = 'pullops.config.js',
  env = process.env,
  readRemoteOriginUrl = () => readGitRemoteOriginUrl(cwd),
} = {}) {
  const configPath = resolve(cwd, configFile);
  /** @type {UserPullOpsConfig} */
  let userConfig = {};

  if (await fileExists(configPath)) {
    const importedConfig = await importConfig(configPath);
    userConfig = validateConfigObject(importedConfig, configPath);
    validateModelOverrides(userConfig);
    validateIssueStoreOverrides(userConfig);
    validateOperationOverrides(userConfig);
  }

  const config = mergeConfig(userConfig);
  applyIssueStoreProviderDefault({
    config,
    env,
    readRemoteOriginUrl,
  });

  return config;
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
function validateIssueStoreOverrides(userConfig) {
  const issueStore = userConfig.issueStore;
  if (issueStore === undefined) {
    return;
  }

  if (!isPlainObject(issueStore)) {
    throw new PullOpsConfigError('PullOps Config issueStore must be an object.');
  }

  if (
    issueStore.provider !== undefined &&
    (typeof issueStore.provider !== 'string' || issueStore.provider !== 'github')
  ) {
    throw new PullOpsConfigError(
      `PullOps Config issueStore.provider must be one of: github. Received ${JSON.stringify(
        issueStore.provider,
      )}.`,
    );
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

  const workflowOperations = getOperationCatalogWorkflowOperations();
  const knownOperationConfigKeys = workflowOperations.map(operation => operation.configKey);
  const unknownOperations = Object.keys(operations).filter(
    operation =>
      !knownOperationConfigKeys.includes(/** @type {WorkflowOperationConfigKey} */ (operation)),
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

    if (
      (operation === 'prReview' || operation === 'prAddressReview') &&
      settings.escalationModelTier !== undefined &&
      (typeof settings.escalationModelTier !== 'string' ||
        !MODEL_TIERS.includes(/** @type {ModelTier} */ (settings.escalationModelTier)))
    ) {
      throw new PullOpsConfigError(
        `PullOps Config operations.${operation}.escalationModelTier must be one of: ${MODEL_TIERS.join(
          ', ',
        )}. Received ${JSON.stringify(settings.escalationModelTier)}.`,
      );
    }

    if (
      (operation === 'prReview' || operation === 'prAddressReview') &&
      settings.humanFeedbackResponseModelTier !== undefined &&
      (typeof settings.humanFeedbackResponseModelTier !== 'string' ||
        !MODEL_TIERS.includes(/** @type {ModelTier} */ (settings.humanFeedbackResponseModelTier)))
    ) {
      throw new PullOpsConfigError(
        `PullOps Config operations.${operation}.humanFeedbackResponseModelTier must be one of: ${MODEL_TIERS.join(
          ', ',
        )}. Received ${JSON.stringify(settings.humanFeedbackResponseModelTier)}.`,
      );
    }

    if (
      operation === 'prFinalize' &&
      settings.aiHistoryCleanup !== undefined &&
      typeof settings.aiHistoryCleanup !== 'boolean'
    ) {
      throw new PullOpsConfigError(
        `PullOps Config operations.prFinalize.aiHistoryCleanup must be a boolean. Received ${JSON.stringify(
          settings.aiHistoryCleanup,
        )}.`,
      );
    }

    if (
      operation === 'prResolveConflicts' &&
      settings.maxConflictResolutionPasses !== undefined &&
      !isPositiveInteger(settings.maxConflictResolutionPasses)
    ) {
      throw new PullOpsConfigError(
        `PullOps Config operations.prResolveConflicts.maxConflictResolutionPasses must be a positive integer. Received ${JSON.stringify(
          settings.maxConflictResolutionPasses,
        )}.`,
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

  const issueStore = userConfig.issueStore;
  if (issueStore !== undefined) {
    if (!isPlainObject(issueStore)) {
      throw new PullOpsConfigError('PullOps Config issueStore must be an object.');
    }
    if (issueStore.provider !== undefined) {
      config.issueStore.provider = requireIssueStoreProvider(
        issueStore.provider,
        'issueStore.provider',
      );
    }
  }

  const runner = userConfig.runner;
  if (runner !== undefined) {
    if (!isPlainObject(runner)) {
      throw new PullOpsConfigError('PullOps Config runner must be an object.');
    }
    if (runner.adapter !== undefined) {
      config.runner.adapter = requireRunnerAdapter(runner.adapter, 'runner.adapter');
    }
    if (runner.command !== undefined) {
      config.runner.command = requireString(runner.command, 'runner.command');
    }
    if (runner.models !== undefined) {
      config.runner.models = /** @type {Record<ModelTier, string>} */ ({ ...runner.models });
    } else if (readRunnerCommandCli(config.runner.command) === 'claude') {
      config.runner.models = { ...CLAUDE_RUNNER_MODEL_DEFAULTS };
    }
    if (runner.argsTemplate !== undefined) {
      config.runner.argsTemplate = requireStringArray(runner.argsTemplate, 'runner.argsTemplate');
    }
  }

  const runBudget = userConfig.runBudget;
  if (runBudget !== undefined) {
    if (!isPlainObject(runBudget)) {
      throw new PullOpsConfigError('PullOps Config runBudget must be an object.');
    }
    if (runBudget.maxUsedTokens !== undefined) {
      config.runBudget.maxUsedTokens = requirePositiveInteger(
        runBudget.maxUsedTokens,
        'runBudget.maxUsedTokens',
      );
    }
    if (runBudget.maxDurationMs !== undefined) {
      config.runBudget.maxDurationMs = requirePositiveInteger(
        runBudget.maxDurationMs,
        'runBudget.maxDurationMs',
      );
    }
  }

  if (isPlainObject(userConfig.operations)) {
    for (const operation of getOperationCatalogWorkflowOperations()) {
      const settings = userConfig.operations[operation.configKey];
      if (settings !== undefined) {
        Object.assign(config.operations[operation.configKey], settings);
      }
    }
  }

  return config;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {string[]}
 */
function requireStringArray(value, path) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(item => typeof item !== 'string' || item.trim() === '')
  ) {
    throw new PullOpsConfigError(
      `PullOps Config ${path} must be a non-empty array of non-empty strings.`,
    );
  }
  return /** @type {string[]} */ ([...value]);
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {number}
 */
function requirePositiveInteger(value, path) {
  if (!isPositiveInteger(value)) {
    throw new PullOpsConfigError(`PullOps Config ${path} must be a positive integer.`);
  }
  return /** @type {number} */ (value);
}

/**
 * @param {{
 *   config: PullOpsConfig,
 *   env: NodeJS.ProcessEnv,
 *   readRemoteOriginUrl: () => string | undefined,
 * }} options
 */
function applyIssueStoreProviderDefault({ config, env, readRemoteOriginUrl }) {
  if (config.issueStore.provider !== undefined) {
    return;
  }

  if (hasGitHubRepositoryContext({ env, readRemoteOriginUrl })) {
    config.issueStore.provider = 'github';
  }
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
 * @param {unknown} value
 * @param {string} path
 * @returns {import('../runner/types.js').RunnerAdapter}
 */
function requireRunnerAdapter(value, path) {
  if (!isRunnerAdapter(value)) {
    throw new PullOpsConfigError(
      `PullOps Config ${path} must be one of: ${RUNNER_ADAPTERS.join(', ')}.`,
    );
  }

  return value;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {import('./types.js').IssueStoreProvider}
 */
function requireIssueStoreProvider(value, path) {
  if (value !== 'github') {
    throw new PullOpsConfigError(`PullOps Config ${path} must be one of: github.`);
  }

  return value;
}

/**
 * @param {{
 *   env: NodeJS.ProcessEnv,
 *   readRemoteOriginUrl: () => string | undefined,
 * }} options
 * @returns {boolean}
 */
function hasGitHubRepositoryContext({ env, readRemoteOriginUrl }) {
  const envRepository = readNonEmptyEnv(env.GITHUB_REPOSITORY);
  if (envRepository !== undefined && parseRepositoryPath(envRepository) !== undefined) {
    return true;
  }

  return parseGitHubRemoteUrl(readRemoteOriginUrl()) !== undefined;
}

/**
 * @param {string | undefined} value
 * @returns {string | undefined}
 */
function readNonEmptyEnv(value) {
  const trimmedValue = value?.trim();
  return trimmedValue === undefined || trimmedValue === '' ? undefined : trimmedValue;
}

/**
 * @param {string | undefined} value
 * @returns {{ owner: string, repo: string } | undefined}
 */
function parseGitHubRemoteUrl(value) {
  const remoteUrl = value?.trim();
  if (remoteUrl === undefined || remoteUrl === '') {
    return undefined;
  }

  const scpLikeMatch = remoteUrl.match(/^(?:[^@\s]+@)?github\.com:([^/]+)\/(.+)$/i);
  if (scpLikeMatch !== null) {
    return parseRepositoryPath(stripGitSuffix(`${scpLikeMatch[1]}/${scpLikeMatch[2]}`));
  }

  try {
    const url = new URL(remoteUrl);
    if (url.hostname.toLowerCase() !== 'github.com') {
      return undefined;
    }

    const path = stripGitSuffix(url.pathname.replace(/^\/+/, ''));
    return parseRepositoryPath(path);
  } catch {
    return undefined;
  }
}

/**
 * @param {string} value
 * @returns {string}
 */
function stripGitSuffix(value) {
  return value.endsWith('.git') ? value.slice(0, -4) : value;
}

/**
 * @param {string} value
 * @returns {{ owner: string, repo: string } | undefined}
 */
function parseRepositoryPath(value) {
  const [owner, repo, ...extra] = value.split('/');
  if (
    owner === undefined ||
    owner.trim() === '' ||
    repo === undefined ||
    repo.trim() === '' ||
    extra.length > 0
  ) {
    return undefined;
  }

  return { owner: owner.trim(), repo: repo.trim() };
}

/**
 * @param {string} cwd
 * @returns {string | undefined}
 */
function readGitRemoteOriginUrl(cwd) {
  try {
    return execFileSync('git', ['-C', cwd, 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
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
 * @param {unknown} value
 * @returns {value is number}
 */
function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
