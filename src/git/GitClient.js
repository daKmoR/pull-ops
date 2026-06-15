import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(nodeExecFile);

/**
 * @typedef {import('./types.js').GitClient} GitClient
 * @typedef {import('./types.js').CreateBranchOptions} CreateBranchOptions
 * @typedef {import('./types.js').CommitAllOptions} CommitAllOptions
 * @typedef {import('./types.js').CommitEmptyOptions} CommitEmptyOptions
 * @typedef {import('./types.js').PushBranchOptions} PushBranchOptions
 * @typedef {import('./types.js').GetChangedFilesSinceBaseOptions} GetChangedFilesSinceBaseOptions
 * @typedef {import('./types.js').RewriteBranchWithCommitPlanOptions} RewriteBranchWithCommitPlanOptions
 * @typedef {import('./types.js').GitRewriteResult} GitRewriteResult
 * @typedef {import('../github/types.js').ExecFile} ExecFile
 */

/**
 * @param {{ execFile?: ExecFile, env?: NodeJS.ProcessEnv }} [options]
 * @returns {GitClient}
 */
export function createGitClient({ execFile = execFileAsync, env = process.env } = {}) {
  return {
    /**
     * @param {CreateBranchOptions} options
     * @returns {Promise<void>}
     */
    async createBranch({ branchName, baseBranch }) {
      await configureAuthenticatedOrigin(execFile, env);
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
     * @param {CommitEmptyOptions} options
     * @returns {Promise<void>}
     */
    async commitEmpty({ message, author }) {
      await runGit(
        execFile,
        [
          '-c',
          `user.name=${author.name}`,
          '-c',
          `user.email=${author.email}`,
          'commit',
          '--allow-empty',
          '-m',
          message,
        ],
        'create an empty PullOps commit',
      );
    },

    /**
     * @param {PushBranchOptions} options
     * @returns {Promise<void>}
     */
    async pushBranch({ branchName }) {
      await configureAuthenticatedOrigin(execFile, env);
      await runGit(
        execFile,
        ['push', '--set-upstream', 'origin', branchName],
        `push branch ${branchName}`,
      );
    },

    /**
     * @returns {Promise<string>}
     */
    async getCurrentHeadSha() {
      return await getCurrentHeadSha(execFile);
    },

    /**
     * @returns {Promise<string>}
     */
    async getCurrentTreeHash() {
      return await getCurrentTreeHash(execFile);
    },

    /**
     * @param {GetChangedFilesSinceBaseOptions} options
     * @returns {Promise<string[]>}
     */
    async getChangedFilesSinceBase({ baseBranch }) {
      await configureAuthenticatedOrigin(execFile, env);
      await runGit(execFile, ['fetch', 'origin', baseBranch], 'fetch the base branch');
      const result = await runGit(
        execFile,
        ['diff', '--name-only', '-z', `origin/${baseBranch}...HEAD`],
        `inspect changed files since ${baseBranch}`,
      );
      return parseNullSeparatedFiles(result.stdout);
    },

    /**
     * @param {RewriteBranchWithCommitPlanOptions} options
     * @returns {Promise<GitRewriteResult>}
     */
    async rewriteBranchWithCommitPlan({ baseBranch, branchName, commits, author }) {
      const originalHead = (
        await runGit(execFile, ['rev-parse', 'HEAD'], 'record the original branch head')
      ).stdout
        .toString()
        .trim();
      const baseRef = `origin/${baseBranch}`;

      await runGit(execFile, ['reset', '--hard', baseRef], `reset branch to ${baseRef}`);

      for (const [index, commit] of commits.entries()) {
        for (const file of commit.files) {
          await restorePathFromRevision(execFile, originalHead, file);
        }

        if (!(await hasStagedChanges(execFile))) {
          throw new Error(`Commit Plan commit ${index + 1} did not stage any changes.`);
        }

        await runGit(
          execFile,
          [
            '-c',
            `user.name=${author.name}`,
            '-c',
            `user.email=${author.email}`,
            'commit',
            '-m',
            commit.message,
          ],
          `create planned commit ${index + 1}`,
        );
      }

      await configureAuthenticatedOrigin(execFile, env);
      await runGit(
        execFile,
        ['push', '--force-with-lease', 'origin', `HEAD:${branchName}`],
        `force-with-lease push branch ${branchName}`,
      );

      return {
        headSha: await getCurrentHeadSha(execFile),
        treeHash: await getCurrentTreeHash(execFile),
      };
    },
  };
}

/**
 * @param {ExecFile} execFile
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<void>}
 */
async function configureAuthenticatedOrigin(execFile, env) {
  const remoteUrl = createAuthenticatedGitHubRemoteUrl(env);
  if (remoteUrl === undefined) {
    return;
  }

  await runGit(
    execFile,
    ['remote', 'set-url', 'origin', remoteUrl],
    'configure authenticated git origin',
  );
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | undefined}
 */
function createAuthenticatedGitHubRemoteUrl(env) {
  const token = readNonEmptyEnv(env.PULLOPS_GITHUB_TOKEN);
  const repository = readNonEmptyEnv(env.GITHUB_REPOSITORY);

  if (token === undefined && repository === undefined) {
    return undefined;
  }

  if (token === undefined) {
    throw new Error('PULLOPS_GITHUB_TOKEN must be set to authenticate PullOps git pushes.');
  }

  if (repository === undefined) {
    throw new Error('GITHUB_REPOSITORY must be set to authenticate PullOps git pushes.');
  }

  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error(`Invalid GITHUB_REPOSITORY "${repository}". Expected "OWNER/REPO".`);
  }

  return `https://x-access-token:${encodeURIComponent(token)}@github.com/${repository}.git`;
}

/**
 * @param {string | undefined} value
 * @returns {string | undefined}
 */
function readNonEmptyEnv(value) {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * @param {ExecFile} execFile
 * @returns {Promise<string>}
 */
async function getCurrentHeadSha(execFile) {
  return (await runGit(execFile, ['rev-parse', 'HEAD'], 'read the current branch head')).stdout
    .toString()
    .trim();
}

/**
 * @param {ExecFile} execFile
 * @returns {Promise<string>}
 */
async function getCurrentTreeHash(execFile) {
  return (await runGit(execFile, ['rev-parse', 'HEAD^{tree}'], 'read the current tree hash')).stdout
    .toString()
    .trim();
}

/**
 * @param {ExecFile} execFile
 * @param {string} revision
 * @param {string} path
 * @returns {Promise<void>}
 */
async function restorePathFromRevision(execFile, revision, path) {
  if (await pathExistsAtRevision(execFile, revision, path)) {
    await runGit(
      execFile,
      ['restore', '--source', revision, '--worktree', '--', path],
      `restore ${path} from the original branch head`,
    );
    await runGit(execFile, ['add', '--', path], `stage ${path}`);
    return;
  }

  await runGit(execFile, ['rm', '--ignore-unmatch', '--', path], `stage deletion of ${path}`);
}

/**
 * @param {ExecFile} execFile
 * @param {string} revision
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function pathExistsAtRevision(execFile, revision, path) {
  try {
    await execFile('git', ['cat-file', '-e', `${revision}:${path}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {ExecFile} execFile
 * @returns {Promise<boolean>}
 */
async function hasStagedChanges(execFile) {
  try {
    await execFile('git', ['diff', '--cached', '--quiet']);
    return false;
  } catch (error) {
    if (isPlainObject(error) && error.code === 1) {
      return true;
    }

    throw new Error(`Failed to inspect staged changes: ${getCommandErrorMessage(error)}`, {
      cause: error,
    });
  }
}

/**
 * @param {string | Buffer} stdout
 * @returns {string[]}
 */
function parseNullSeparatedFiles(stdout) {
  return stdout
    .toString()
    .split('\0')
    .filter(file => file !== '');
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
