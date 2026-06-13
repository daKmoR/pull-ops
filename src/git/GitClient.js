import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(nodeExecFile);

/**
 * @typedef {import('./types.js').GitClient} GitClient
 * @typedef {import('./types.js').CreateBranchOptions} CreateBranchOptions
 * @typedef {import('./types.js').CommitAllOptions} CommitAllOptions
 * @typedef {import('./types.js').PushBranchOptions} PushBranchOptions
 * @typedef {import('../github/types.js').ExecFile} ExecFile
 */

/**
 * @param {{ execFile?: ExecFile }} [options]
 * @returns {GitClient}
 */
export function createGitClient({ execFile = execFileAsync } = {}) {
  return {
    /**
     * @param {CreateBranchOptions} options
     * @returns {Promise<void>}
     */
    async createBranch({ branchName, baseBranch }) {
      await runGit(execFile, ['fetch', 'origin', baseBranch], 'fetch the base branch');
      await runGit(
        execFile,
        ['checkout', '-B', branchName, `origin/${baseBranch}`],
        `create branch ${branchName}`,
      );
    },

    /**
     * @returns {Promise<boolean>}
     */
    async hasChanges() {
      const result = await runGit(execFile, ['status', '--porcelain'], 'inspect the working tree');
      return result.stdout.toString().trim() !== '';
    },

    /**
     * @param {CommitAllOptions} options
     * @returns {Promise<void>}
     */
    async commitAll({ message, author }) {
      await runGit(execFile, ['add', '--all'], 'stage PullOps changes');
      await runGit(
        execFile,
        [
          '-c',
          `user.name=${author.name}`,
          '-c',
          `user.email=${author.email}`,
          'commit',
          '-m',
          message,
        ],
        'commit PullOps changes',
      );
    },

    /**
     * @param {PushBranchOptions} options
     * @returns {Promise<void>}
     */
    async pushBranch({ branchName }) {
      await runGit(
        execFile,
        ['push', '--set-upstream', 'origin', branchName],
        `push branch ${branchName}`,
      );
    },
  };
}

/**
 * @param {ExecFile} execFile
 * @param {string[]} args
 * @param {string} action
 * @returns {Promise<import('../github/types.js').ExecFileResult>}
 */
async function runGit(execFile, args, action) {
  try {
    return await execFile('git', args);
  } catch (error) {
    throw new Error(`Failed to ${action}: ${getCommandErrorMessage(error)}`, { cause: error });
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function getCommandErrorMessage(error) {
  if (isPlainObject(error)) {
    const stderr = error.stderr;
    if (typeof stderr === 'string' && stderr.trim() !== '') {
      return stderr.trim();
    }
    if (Buffer.isBuffer(stderr) && stderr.toString().trim() !== '') {
      return stderr.toString().trim();
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
