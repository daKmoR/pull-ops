import { execFile as nodeExecFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(nodeExecFile);
const PULL_OPS_LOCAL_RUN_RECORD_PATH = '.pullops/runs';
const PULL_OPS_WORKTREE_PATHSPEC = [
  '.',
  `:!${PULL_OPS_LOCAL_RUN_RECORD_PATH}`,
  `:!${PULL_OPS_LOCAL_RUN_RECORD_PATH}/**`,
];

/**
 * @typedef {import('./types.js').GitClient} GitClient
 * @typedef {import('./types.js').GitCommitAuthor} GitCommitAuthor
 * @typedef {import('./types.js').CreateBranchOptions} CreateBranchOptions
 * @typedef {import('./types.js').FetchRemoteRefsOptions} FetchRemoteRefsOptions
 * @typedef {import('./types.js').CheckoutPullOpsBranchOptions} CheckoutPullOpsBranchOptions
 * @typedef {import('./types.js').CheckoutBranchOptions} CheckoutBranchOptions
 * @typedef {import('./types.js').CommitAllOptions} CommitAllOptions
 * @typedef {import('./types.js').CommitEmptyOptions} CommitEmptyOptions
 * @typedef {import('./types.js').PushBranchOptions} PushBranchOptions
 * @typedef {import('./types.js').RebaseBranchOntoBaseOptions} RebaseBranchOntoBaseOptions
 * @typedef {import('./types.js').GitRebaseResult} GitRebaseResult
 * @typedef {import('./types.js').StartRebaseBranchOntoBaseOptions} StartRebaseBranchOntoBaseOptions
 * @typedef {import('./types.js').ContinueRebaseOptions} ContinueRebaseOptions
 * @typedef {import('./types.js').ReadRebaseConflictContextOptions} ReadRebaseConflictContextOptions
 * @typedef {import('./types.js').GitRebaseStepResult} GitRebaseStepResult
 * @typedef {import('./types.js').GitConflictContext} GitConflictContext
 * @typedef {import('./types.js').GitConflictFile} GitConflictFile
 * @typedef {import('./types.js').CherryPickCommitOntoBranchOptions} CherryPickCommitOntoBranchOptions
 * @typedef {import('./types.js').GitCherryPickResult} GitCherryPickResult
 * @typedef {import('./types.js').PushBranchWithLeaseOptions} PushBranchWithLeaseOptions
 * @typedef {import('./types.js').GitPushWithLeaseResult} GitPushWithLeaseResult
 * @typedef {import('./types.js').GetChangedFilesSinceBaseOptions} GetChangedFilesSinceBaseOptions
 * @typedef {import('./types.js').GetCommitsSinceBaseOptions} GetCommitsSinceBaseOptions
 * @typedef {import('./types.js').GitCommit} GitCommit
 * @typedef {import('./types.js').RewriteBranchWithCommitPlanOptions} RewriteBranchWithCommitPlanOptions
 * @typedef {import('./types.js').RewriteBranchWithExistingCommitsOptions} RewriteBranchWithExistingCommitsOptions
 * @typedef {import('./types.js').GitRewriteResult} GitRewriteResult
 * @typedef {import('../github/types.js').ExecFile} ExecFile
 */

/**
 * @param {{ execFile?: ExecFile, env?: NodeJS.ProcessEnv, traceCommand?: (command: string) => void }} [options]
 * @returns {GitClient}
 */
export function createGitClient({
  execFile: rawExecFile = execFileAsync,
  env = process.env,
  traceCommand,
} = {}) {
  /** @type {ExecFile} */
  const execFile =
    traceCommand === undefined
      ? rawExecFile
      : async (file, args) => {
          if (file === 'git') {
            traceCommand(formatGitCommand(args));
          }

          return await rawExecFile(file, args);
        };

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
     * @param {FetchRemoteRefsOptions} options
     * @returns {Promise<void>}
     */
    async fetchRemoteRefs({ requiredBranchNames, optionalBranchNames = [] }) {
      for (const branchName of requiredBranchNames) {
        await fetchRemoteBranch(execFile, branchName, { optional: false });
      }
      for (const branchName of optionalBranchNames) {
        await fetchRemoteBranch(execFile, branchName, { optional: true });
      }
    },

    /**
     * @param {CheckoutPullOpsBranchOptions} options
     * @returns {Promise<void>}
     */
    async checkoutPullOpsBranch({ branchName, baseBranch }) {
      if (await gitRefExists(execFile, `refs/heads/${branchName}`)) {
        await runGit(execFile, ['checkout', branchName], `check out branch ${branchName}`);
        return;
      }

      if (await gitRefExists(execFile, `refs/remotes/origin/${branchName}`)) {
        await runGit(
          execFile,
          ['checkout', '-B', branchName, `origin/${branchName}`],
          `check out branch ${branchName}`,
        );
        return;
      }

      if (await gitRefExists(execFile, `refs/heads/${baseBranch}`)) {
        await runGit(
          execFile,
          ['checkout', '-B', branchName, baseBranch],
          `create branch ${branchName}`,
        );
        return;
      }

      if (await gitRefExists(execFile, `refs/remotes/origin/${baseBranch}`)) {
        await runGit(
          execFile,
          ['checkout', '-B', branchName, `origin/${baseBranch}`],
          `create branch ${branchName}`,
        );
        return;
      }

      await runGit(
        execFile,
        ['checkout', '-B', branchName, `origin/${baseBranch}`],
        `create branch ${branchName}`,
      );
    },

    /**
     * @returns {Promise<string>}
     */
    async getCurrentBranch() {
      const result = await runGit(
        execFile,
        ['branch', '--show-current'],
        'read the current branch name',
      );
      return result.stdout.toString().trim();
    },

    /**
     * @param {CheckoutBranchOptions} options
     * @returns {Promise<void>}
     */
    async checkoutBranch({ branchName }) {
      await runGit(execFile, ['checkout', branchName], `restore branch ${branchName}`);
    },

    /**
     * @returns {Promise<boolean>}
     */
    async hasChanges() {
      const result = await runGit(
        execFile,
        ['status', '--porcelain', '--', ...PULL_OPS_WORKTREE_PATHSPEC],
        'inspect the working tree',
      );
      return result.stdout.toString().trim() !== '';
    },

    /**
     * @param {CommitAllOptions} options
     * @returns {Promise<void>}
     */
    async commitAll({ message, author }) {
      await runGit(execFile, ['add', '--all', '--', '.'], 'stage PullOps changes');
      await runGit(
        execFile,
        ['reset', '--', PULL_OPS_LOCAL_RUN_RECORD_PATH],
        'unstage PullOps local run records',
      );
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
     * @returns {Promise<string>}
     */
    async readWorkingTreePatch() {
      const result = await runGit(
        execFile,
        ['diff', '--binary', 'HEAD', '--'],
        'capture the working tree patch',
      );
      const untrackedFiles = await readUntrackedFiles(execFile);
      if (untrackedFiles.length === 0) {
        return result.stdout.toString();
      }

      const patches = [result.stdout.toString().trimEnd()];
      for (const filePath of untrackedFiles) {
        const untrackedPatch = await readUntrackedFilePatch(execFile, filePath);
        if (untrackedPatch.trim() !== '') {
          patches.push(untrackedPatch.trimEnd());
        }
      }

      return patches.filter(patch => patch !== '').join('\n');
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
     * @param {RebaseBranchOntoBaseOptions} options
     * @returns {Promise<GitRebaseResult>}
     */
    async rebaseBranchOntoBase({ branchName, baseBranch, committer }) {
      await configureAuthenticatedOrigin(execFile, env);
      await runGit(execFile, ['fetch', 'origin', baseBranch], 'fetch the base branch');
      await runGit(
        execFile,
        ['fetch', 'origin', `+refs/heads/${branchName}:refs/remotes/origin/${branchName}`],
        `fetch branch ${branchName}`,
      );
      await runGit(
        execFile,
        ['checkout', '-B', branchName, `origin/${branchName}`],
        `check out branch ${branchName}`,
      );

      try {
        await runGit(
          execFile,
          withGitCommitter(['rebase', `origin/${baseBranch}`], committer),
          `rebase branch ${branchName} onto ${baseBranch}`,
        );
      } catch (error) {
        const conflictedFiles = await readConflictedFiles(execFile);
        if (conflictedFiles.length === 0) {
          throw error;
        }

        await runGit(
          execFile,
          ['rebase', '--abort'],
          `abort conflicted rebase of branch ${branchName}`,
        );
        return {
          status: 'conflicts',
          conflictedFiles,
        };
      }

      return {
        status: 'rebased',
        headSha: await getCurrentHeadSha(execFile),
        treeHash: await getCurrentTreeHash(execFile),
      };
    },

    /**
     * @param {StartRebaseBranchOntoBaseOptions} options
     * @returns {Promise<GitRebaseStepResult>}
     */
    async startRebaseBranchOntoBase({ branchName, baseBranch, committer }) {
      await configureAuthenticatedOrigin(execFile, env);
      await runGit(execFile, ['fetch', 'origin', baseBranch], 'fetch the base branch');
      await runGit(
        execFile,
        ['fetch', 'origin', `+refs/heads/${branchName}:refs/remotes/origin/${branchName}`],
        `fetch branch ${branchName}`,
      );
      await runGit(
        execFile,
        ['checkout', '-B', branchName, `origin/${branchName}`],
        `check out branch ${branchName}`,
      );

      try {
        await runGit(
          execFile,
          withGitCommitter(['rebase', `origin/${baseBranch}`], committer),
          `start conflictable rebase of branch ${branchName} onto ${baseBranch}`,
        );
      } catch (error) {
        const conflictContext = await readRebaseConflictContext(execFile, {
          branchName,
          baseBranch,
        });
        if (conflictContext === undefined) {
          throw error;
        }

        return {
          status: 'conflicts',
          conflictContext,
        };
      }

      return await readCompletedRebaseStep(execFile);
    },

    /**
     * @param {ContinueRebaseOptions} options
     * @returns {Promise<GitRebaseStepResult>}
     */
    async continueRebase({ branchName, baseBranch, committer }) {
      await runGit(execFile, ['add', '--all'], 'stage resolved rebase conflicts');

      try {
        await runGit(
          execFile,
          withGitCommitter(['-c', 'core.editor=true', 'rebase', '--continue'], committer),
          `continue rebase of branch ${branchName}`,
        );
      } catch (error) {
        const conflictContext = await readRebaseConflictContext(execFile, {
          branchName,
          baseBranch,
        });
        if (conflictContext === undefined) {
          throw error;
        }

        return {
          status: 'conflicts',
          conflictContext,
        };
      }

      return await readCompletedRebaseStep(execFile);
    },

    /**
     * @param {ReadRebaseConflictContextOptions} options
     * @returns {Promise<GitConflictContext | undefined>}
     */
    async readRebaseConflictContext({ branchName, baseBranch }) {
      return await readRebaseConflictContext(execFile, { branchName, baseBranch });
    },

    /**
     * @param {CherryPickCommitOntoBranchOptions} options
     * @returns {Promise<GitCherryPickResult>}
     */
    async cherryPickCommitOntoBranch({ branchName, baseBranch, commitSha, committer }) {
      await runGit(execFile, ['fetch', 'origin', baseBranch], 'fetch the base branch');
      await fetchRemoteBranch(execFile, branchName, { optional: true });

      if (await gitRefExists(execFile, `refs/heads/${branchName}`)) {
        await runGit(execFile, ['checkout', branchName], `check out branch ${branchName}`);
      } else if (await gitRefExists(execFile, `refs/remotes/origin/${branchName}`)) {
        await runGit(
          execFile,
          ['checkout', '-B', branchName, `origin/${branchName}`],
          `check out branch ${branchName}`,
        );
      } else {
        await runGit(
          execFile,
          ['checkout', '-B', branchName, `origin/${baseBranch}`],
          `create branch ${branchName}`,
        );
      }

      try {
        await runGit(
          execFile,
          withGitCommitter(['cherry-pick', commitSha], committer),
          `cherry-pick ${commitSha} onto ${branchName}`,
        );
      } catch (error) {
        const conflictedFiles = await readConflictedFiles(execFile);
        if (conflictedFiles.length === 0) {
          throw error;
        }

        return {
          status: 'conflicts',
          conflictedFiles,
        };
      }

      return {
        status: 'cherry-picked',
        headSha: await getCurrentHeadSha(execFile),
        treeHash: await getCurrentTreeHash(execFile),
      };
    },

    /**
     * @param {PushBranchWithLeaseOptions} options
     * @returns {Promise<GitPushWithLeaseResult>}
     */
    async pushBranchWithLease({ branchName }) {
      await configureAuthenticatedOrigin(execFile, env);

      try {
        await runGit(
          execFile,
          ['push', '--force-with-lease', 'origin', `HEAD:${branchName}`],
          `force-with-lease push branch ${branchName}`,
        );
      } catch (error) {
        if (isStaleLeaseError(error)) {
          return {
            status: 'stale-lease',
          };
        }

        throw error;
      }

      return {
        status: 'pushed',
        headSha: await getCurrentHeadSha(execFile),
        treeHash: await getCurrentTreeHash(execFile),
      };
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
     * @param {import('./types.js').ResetHardToRevisionOptions} options
     * @returns {Promise<void>}
     */
    async resetHardToRevision({ revision }) {
      await runGit(execFile, ['reset', '--hard', revision], `reset branch to ${revision}`);
    },

    /**
     * @param {GetChangedFilesSinceBaseOptions} options
     * @returns {Promise<string[]>}
     */
    async getChangedFilesSinceBase({ baseBranch }) {
      await runGit(execFile, ['fetch', 'origin', baseBranch], 'fetch the base branch');
      const result = await runGit(
        execFile,
        ['diff', '--name-only', '-z', `origin/${baseBranch}...HEAD`],
        `inspect changed files since ${baseBranch}`,
      );
      return parseNullSeparatedFiles(result.stdout);
    },

    /**
     * @param {GetCommitsSinceBaseOptions} options
     * @returns {Promise<GitCommit[]>}
     */
    async getCommitsSinceBase({ baseBranch }) {
      await runGit(execFile, ['fetch', 'origin', baseBranch], 'fetch the base branch');
      const baseRef = `origin/${baseBranch}`;
      const result = await runGit(
        execFile,
        ['rev-list', '--reverse', `${baseRef}..HEAD`],
        `list commits since ${baseBranch}`,
      );
      const shas = result.stdout
        .toString()
        .split('\n')
        .map(sha => sha.trim())
        .filter(Boolean);
      /** @type {GitCommit[]} */
      const commits = [];

      for (const sha of shas) {
        commits.push(await readCommit(execFile, sha));
      }

      return commits;
    },

    /**
     * @param {RewriteBranchWithCommitPlanOptions} options
     * @returns {Promise<GitRewriteResult>}
     */
    async rewriteBranchWithCommitPlan({ baseBranch, branchName, commits, author, push = true }) {
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

      if (push) {
        await configureAuthenticatedOrigin(execFile, env);
        await runGit(
          execFile,
          ['push', '--force-with-lease', 'origin', `HEAD:${branchName}`],
          `force-with-lease push branch ${branchName}`,
        );
      }

      return {
        headSha: await getCurrentHeadSha(execFile),
        treeHash: await getCurrentTreeHash(execFile),
      };
    },

    /**
     * @param {RewriteBranchWithExistingCommitsOptions} options
     * @returns {Promise<GitRewriteResult>}
     */
    async rewriteBranchWithExistingCommits({ baseBranch, branchName, commitShas, committer }) {
      const baseRef = `origin/${baseBranch}`;

      await runGit(execFile, ['reset', '--hard', baseRef], `reset branch to ${baseRef}`);

      for (const [index, sha] of commitShas.entries()) {
        await runGit(
          execFile,
          withGitCommitter(['cherry-pick', sha], committer),
          `cherry-pick existing commit ${index + 1}`,
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
 * @param {string[]} args
 * @param {GitCommitAuthor} committer
 * @returns {string[]}
 */
function withGitCommitter(args, committer) {
  return ['-c', `user.name=${committer.name}`, '-c', `user.email=${committer.email}`, ...args];
}

/**
 * @param {ExecFile} execFile
 * @param {string} branchName
 * @param {{ optional: boolean }} options
 * @returns {Promise<void>}
 */
async function fetchRemoteBranch(execFile, branchName, { optional }) {
  try {
    await runGit(
      execFile,
      ['fetch', 'origin', `+refs/heads/${branchName}:refs/remotes/origin/${branchName}`],
      `fetch branch ${branchName}`,
    );
  } catch (error) {
    if (optional && isMissingRemoteRefError(error)) {
      return;
    }

    throw error;
  }
}

/**
 * @param {ExecFile} execFile
 * @param {string} ref
 * @returns {Promise<boolean>}
 */
async function gitRefExists(execFile, ref) {
  try {
    await execFile('git', ['show-ref', '--verify', '--quiet', ref]);
    return true;
  } catch (error) {
    if (isPlainObject(error) && (error.code === 1 || error.code === 128)) {
      return false;
    }

    throw new Error(`Failed to inspect git ref ${ref}: ${getCommandErrorMessage(error)}`, {
      cause: error,
    });
  }
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isMissingRemoteRefError(error) {
  return /couldn't find remote ref|could not find remote ref/i.test(getCommandErrorMessage(error));
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
 * @param {string} sha
 * @returns {Promise<GitCommit>}
 */
async function readCommit(execFile, sha) {
  const body = (
    await runGit(execFile, ['show', '-s', '--format=%B', sha], `read commit ${sha} message`)
  ).stdout.toString();
  const files = parseNullSeparatedFiles(
    (
      await runGit(
        execFile,
        ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', sha],
        `read commit ${sha} files`,
      )
    ).stdout,
  );
  const subject = body.split('\n')[0]?.trim() ?? '';

  return {
    sha,
    subject,
    body: body.trimEnd(),
    files,
  };
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
 * @param {ExecFile} execFile
 * @returns {Promise<string[]>}
 */
async function readConflictedFiles(execFile) {
  const result = await runGit(
    execFile,
    ['diff', '--name-only', '--diff-filter=U', '-z'],
    'inspect rebase conflicts',
  );
  return parseNullSeparatedFiles(result.stdout);
}

/**
 * @param {ExecFile} execFile
 * @returns {Promise<GitRebaseStepResult & { status: 'complete' }>}
 */
async function readCompletedRebaseStep(execFile) {
  return {
    status: 'complete',
    headSha: await getCurrentHeadSha(execFile),
    treeHash: await getCurrentTreeHash(execFile),
  };
}

/**
 * @param {ExecFile} execFile
 * @param {ReadRebaseConflictContextOptions} options
 * @returns {Promise<GitConflictContext | undefined>}
 */
async function readRebaseConflictContext(execFile, { branchName, baseBranch }) {
  const conflictedFilePaths = await readConflictedFiles(execFile);
  if (conflictedFilePaths.length === 0) {
    return undefined;
  }

  const repositoryRoot = await getRepositoryRoot(execFile);
  /** @type {GitConflictFile[]} */
  const conflictedFiles = [];
  for (const path of conflictedFilePaths) {
    conflictedFiles.push(await readConflictFile(execFile, repositoryRoot, path));
  }
  const baseHeadSha = await readOptionalGitRevision(execFile, `origin/${baseBranch}`);
  const originalHeadSha = await readOptionalGitRevision(execFile, 'ORIG_HEAD');
  const rebaseHeadSha = await readOptionalGitRevision(execFile, 'REBASE_HEAD');

  return {
    branchName,
    baseBranch,
    conflictedFiles,
    ...(baseHeadSha === undefined ? {} : { baseHeadSha }),
    ...(originalHeadSha === undefined ? {} : { originalHeadSha }),
    currentHeadSha: await getCurrentHeadSha(execFile),
    ...(rebaseHeadSha === undefined ? {} : { rebaseHeadSha }),
  };
}

/**
 * @param {ExecFile} execFile
 * @param {string} repositoryRoot
 * @param {string} path
 * @returns {Promise<GitConflictFile>}
 */
async function readConflictFile(execFile, repositoryRoot, path) {
  const content = await readWorkingTreeFile(repositoryRoot, path);
  return {
    path,
    exists: content !== undefined,
    ...(content === undefined ? {} : { content }),
    ...optionalProperty('baseContent', await readConflictStage(execFile, 1, path)),
    ...optionalProperty('oursContent', await readConflictStage(execFile, 2, path)),
    ...optionalProperty('theirsContent', await readConflictStage(execFile, 3, path)),
  };
}

/**
 * @param {ExecFile} execFile
 * @param {number} stage
 * @param {string} path
 * @returns {Promise<string | undefined>}
 */
async function readConflictStage(execFile, stage, path) {
  try {
    const result = await execFile('git', ['show', `:${stage}:${path}`]);
    return result.stdout.toString();
  } catch {
    return undefined;
  }
}

/**
 * @param {string} repositoryRoot
 * @param {string} path
 * @returns {Promise<string | undefined>}
 */
async function readWorkingTreeFile(repositoryRoot, path) {
  try {
    return await readFile(join(repositoryRoot, path), 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * @param {ExecFile} execFile
 * @returns {Promise<string>}
 */
async function getRepositoryRoot(execFile) {
  return (await runGit(execFile, ['rev-parse', '--show-toplevel'], 'read repository root')).stdout
    .toString()
    .trim();
}

/**
 * @param {ExecFile} execFile
 * @param {string} revision
 * @returns {Promise<string | undefined>}
 */
async function readOptionalGitRevision(execFile, revision) {
  try {
    return (await execFile('git', ['rev-parse', '--verify', revision])).stdout.toString().trim();
  } catch {
    return undefined;
  }
}

/**
 * @param {string} name
 * @param {string | undefined} value
 * @returns {Record<string, string>}
 */
function optionalProperty(name, value) {
  return value === undefined ? {} : { [name]: value };
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
 * @returns {Promise<string[]>}
 */
async function readUntrackedFiles(execFile) {
  const result = await runGit(
    execFile,
    ['ls-files', '--others', '--exclude-standard', '-z', '--'],
    'read untracked files',
  );
  return parseNullSeparatedFiles(result.stdout);
}

/**
 * @param {ExecFile} execFile
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function readUntrackedFilePatch(execFile, filePath) {
  try {
    const result = await execFile('git', [
      'diff',
      '--binary',
      '--no-index',
      '--',
      '/dev/null',
      filePath,
    ]);
    return result.stdout.toString();
  } catch (error) {
    if (isPlainObject(error) && error.code === 1) {
      const stdout = error.stdout;
      if (typeof stdout === 'string') {
        return stdout;
      }
      if (Buffer.isBuffer(stdout)) {
        return stdout.toString();
      }
    }

    throw new Error(
      `Failed to capture untracked file patch for ${filePath}: ${getCommandErrorMessage(error)}`,
      { cause: error },
    );
  }
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
 * @param {unknown} error
 * @returns {boolean}
 */
function isStaleLeaseError(error) {
  const message = getCommandErrorMessage(error);
  return (
    /\bstale info\b/i.test(message) ||
    /\[rejected\].*\(stale info\)/i.test(message) ||
    /fetch first/i.test(message) ||
    (/failed to push some refs/i.test(message) && /stale|remote contains work/i.test(message))
  );
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {string[]} args
 * @returns {string}
 */
function formatGitCommand(args) {
  return ['git', ...args.map(redactGitCommandArgument)].map(quoteCommandPart).join(' ');
}

/**
 * @param {string} value
 * @returns {string}
 */
function redactGitCommandArgument(value) {
  return value.replace(/(https:\/\/x-access-token:)[^@]+(@github\.com\/)/g, '$1REDACTED$2');
}

/**
 * @param {string} value
 * @returns {string}
 */
function quoteCommandPart(value) {
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", "'\\''")}'`;
}
