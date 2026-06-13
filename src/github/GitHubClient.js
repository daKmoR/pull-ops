import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(nodeExecFile);

/**
 * @typedef {import('./types.js').PullOpsLabel} PullOpsLabel
 * @typedef {import('./types.js').GitHubLabel} GitHubLabel
 * @typedef {import('./types.js').EnsureLabelsResult} EnsureLabelsResult
 * @typedef {import('./types.js').ExecFile} ExecFile
 * @typedef {import('./types.js').ExecFileResult} ExecFileResult
 * @typedef {import('./types.js').GitHubClient} GitHubClient
 */

/** @type {PullOpsLabel[]} */
export const PULL_OPS_LABELS = [
  {
    name: 'pullops:implement',
    color: '5319E7',
    description: 'Run PullOps implementation for an issue or PRD.',
  },
  {
    name: 'pullops:review',
    color: '5319E7',
    description: 'Run PullOps automated PR review.',
  },
  {
    name: 'pullops:address-review',
    color: '5319E7',
    description: 'Address actionable PullOps PR review feedback.',
  },
  {
    name: 'pullops:fix-ci',
    color: '5319E7',
    description: 'Classify and fix actionable CI failures.',
  },
  {
    name: 'pullops:update-branch',
    color: '5319E7',
    description: 'Update a same-repository PR branch.',
  },
  {
    name: 'pullops:resolve-conflicts',
    color: '5319E7',
    description: 'Resolve branch update conflicts with the PullOps runner.',
  },
  {
    name: 'pullops:prepare-merge',
    color: '5319E7',
    description: 'Prepare a PullOps-managed PR for human review and merge.',
  },
  {
    name: 'pullops:in-progress',
    color: 'FBCA04',
    description: 'PullOps automation is currently working.',
  },
  {
    name: 'pullops:blocked',
    color: 'D93F0B',
    description: 'PullOps automation is blocked and needs human attention.',
  },
];

/**
 * @param {{ execFile?: ExecFile }} [options]
 * @returns {GitHubClient}
 */
export function createGitHubClient({ execFile = execFileAsync } = {}) {
  return {
    /**
     * @param {PullOpsLabel[]} labels
     * @returns {Promise<EnsureLabelsResult>}
     */
    async ensureLabels(labels) {
      const existingLabels = await listLabels(execFile);
      const existingLabelsByName = new Map(existingLabels.map(label => [label.name, label]));
      /** @type {EnsureLabelsResult} */
      const result = {
        created: [],
        updated: [],
        alreadyCorrect: [],
      };

      for (const label of labels) {
        const existingLabel = existingLabelsByName.get(label.name);

        if (existingLabel === undefined) {
          await createLabel(execFile, label);
          result.created.push(label.name);
          continue;
        }

        if (labelNeedsUpdate(existingLabel, label)) {
          await updateLabel(execFile, label);
          result.updated.push(label.name);
          continue;
        }

        result.alreadyCorrect.push(label.name);
      }

      return result;
    },
  };
}

/**
 * @param {ExecFile} execFile
 * @returns {Promise<GitHubLabel[]>}
 */
async function listLabels(execFile) {
  try {
    const result = await execFile('gh', [
      'label',
      'list',
      '--limit',
      '1000',
      '--json',
      'name,color,description',
    ]);
    return parseGitHubLabels(getStdout(result));
  } catch (error) {
    throw new Error(`Failed to list GitHub labels: ${getGitHubErrorMessage(error)}`, {
      cause: error,
    });
  }
}

/**
 * @param {ExecFile} execFile
 * @param {PullOpsLabel} label
 * @returns {Promise<void>}
 */
async function createLabel(execFile, label) {
  try {
    await execFile('gh', [
      'label',
      'create',
      label.name,
      '--color',
      label.color,
      '--description',
      label.description,
    ]);
  } catch (error) {
    throw new Error(
      `Failed to create GitHub label "${label.name}": ${getGitHubErrorMessage(error)}`,
      { cause: error },
    );
  }
}

/**
 * @param {ExecFile} execFile
 * @param {PullOpsLabel} label
 * @returns {Promise<void>}
 */
async function updateLabel(execFile, label) {
  try {
    await execFile('gh', [
      'label',
      'edit',
      label.name,
      '--color',
      label.color,
      '--description',
      label.description,
    ]);
  } catch (error) {
    throw new Error(
      `Failed to update GitHub label "${label.name}": ${getGitHubErrorMessage(error)}`,
      { cause: error },
    );
  }
}

/**
 * @param {GitHubLabel} existingLabel
 * @param {PullOpsLabel} expectedLabel
 * @returns {boolean}
 */
function labelNeedsUpdate(existingLabel, expectedLabel) {
  return (
    normalizeColor(existingLabel.color) !== normalizeColor(expectedLabel.color) ||
    existingLabel.description !== expectedLabel.description
  );
}

/**
 * @param {string} color
 * @returns {string}
 */
function normalizeColor(color) {
  return color.replace(/^#/, '').toLowerCase();
}

/**
 * @param {ExecFileResult} result
 * @returns {string}
 */
function getStdout(result) {
  return result.stdout.toString();
}

/**
 * @param {string} stdout
 * @returns {GitHubLabel[]}
 */
function parseGitHubLabels(stdout) {
  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed)) {
    throw new Error('Expected gh label list to return an array.');
  }

  return parsed.map(parseGitHubLabel);
}

/**
 * @param {unknown} label
 * @param {number} index
 * @returns {GitHubLabel}
 */
function parseGitHubLabel(label, index) {
  if (!isPlainObject(label)) {
    throw new Error(`Expected GitHub label at index ${index} to be an object.`);
  }

  if (typeof label.name !== 'string') {
    throw new Error(`Expected GitHub label at index ${index} to include a name.`);
  }

  if (typeof label.color !== 'string') {
    throw new Error(`Expected GitHub label "${label.name}" to include a color.`);
  }

  if (label.description !== null && typeof label.description !== 'string') {
    throw new Error(`Expected GitHub label "${label.name}" to include a description.`);
  }

  return {
    name: label.name,
    color: label.color,
    description: label.description,
  };
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function getGitHubErrorMessage(error) {
  if (isPlainObject(error)) {
    const stderr = error.stderr;
    const stderrText = typeof stderr === 'string' ? stderr : undefined;
    if (stderrText !== undefined && stderrText.trim() !== '') {
      return stderrText.trim();
    }
  }

  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
