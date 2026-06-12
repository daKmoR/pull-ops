import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(nodeExecFile);

/**
 * @typedef {import('./types.js').PullOpsLabel} PullOpsLabel
 * @typedef {import('./types.js').ExecFile} ExecFile
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
     * @returns {Promise<{ labelsEnsured: number }>}
     */
    async ensureLabels(labels) {
      for (const label of labels) {
        await execFile('gh', [
          'label',
          'create',
          label.name,
          '--color',
          label.color,
          '--description',
          label.description,
          '--force',
        ]);
      }

      return { labelsEnsured: labels.length };
    },
  };
}
