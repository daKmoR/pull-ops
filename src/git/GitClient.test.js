import assert from 'node:assert/strict';
import { execFile as nodeExecFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';

import { createGitClient } from './GitClient.js';

const execFile = promisify(nodeExecFile);

describe('createGitClient', () => {
  it('01: authenticates origin before force-with-lease rewrite pushes in GitHub Actions', async () => {
    /** @type {Array<{ file: string, args: string[] }>} */
    const calls = [];
    const gitClient = createGitClient({
      env: {
        PULLOPS_GITHUB_TOKEN: 'pullops-token',
        GITHUB_REPOSITORY: 'acme/widgets',
      },
      execFile: async (file, args) => {
        calls.push({ file, args });
        return { stdout: stdoutFor(args), stderr: '' };
      },
    });

    await gitClient.rewriteBranchWithCommitPlan({
      baseBranch: 'main',
      branchName: 'pullops/issue-15',
      commits: [],
      author: {
        name: 'github-actions[bot]',
        email: '41898282+github-actions[bot]@users.noreply.github.com',
      },
    });

    const setOriginIndex = calls.findIndex(call =>
      isGitCall(call, [
        'remote',
        'set-url',
        'origin',
        'https://x-access-token:pullops-token@github.com/acme/widgets.git',
      ]),
    );
    const pushIndex = calls.findIndex(call =>
      isGitCall(call, ['push', '--force-with-lease', 'origin', 'HEAD:pullops/issue-15']),
    );

    assert.notEqual(setOriginIndex, -1);
    assert.notEqual(pushIndex, -1);
    assert.equal(setOriginIndex < pushIndex, true);
  });

  it('02: authenticates origin before normal branch pushes in GitHub Actions', async () => {
    /** @type {Array<{ file: string, args: string[] }>} */
    const calls = [];
    const gitClient = createGitClient({
      env: {
        PULLOPS_GITHUB_TOKEN: 'pullops-token',
        GITHUB_REPOSITORY: 'acme/widgets',
      },
      execFile: async (file, args) => {
        calls.push({ file, args });
        return { stdout: '', stderr: '' };
      },
    });

    await gitClient.pushBranch({ branchName: 'pullops/issue-15' });

    assert.deepEqual(calls, [
      {
        file: 'git',
        args: [
          'remote',
          'set-url',
          'origin',
          'https://x-access-token:pullops-token@github.com/acme/widgets.git',
        ],
      },
      {
        file: 'git',
        args: ['push', '--set-upstream', 'origin', 'pullops/issue-15'],
      },
    ]);
  });

  it('03: leaves local pushes alone when GitHub Actions auth env is absent', async () => {
    /** @type {Array<{ file: string, args: string[] }>} */
    const calls = [];
    const gitClient = createGitClient({
      env: {},
      execFile: async (file, args) => {
        calls.push({ file, args });
        return { stdout: '', stderr: '' };
      },
    });

    await gitClient.pushBranch({ branchName: 'pullops/issue-15' });

    assert.deepEqual(calls, [
      {
        file: 'git',
        args: ['push', '--set-upstream', 'origin', 'pullops/issue-15'],
      },
    ]);
  });

  it('04: fails before pushing when Actions has no PullOps token', async () => {
    /** @type {Array<{ file: string, args: string[] }>} */
    const calls = [];
    const gitClient = createGitClient({
      env: {
        GITHUB_REPOSITORY: 'acme/widgets',
      },
      execFile: async (file, args) => {
        calls.push({ file, args });
        return { stdout: '', stderr: '' };
      },
    });

    await assert.rejects(
      async () => await gitClient.pushBranch({ branchName: 'pullops/issue-15' }),
      /PULLOPS_GITHUB_TOKEN must be set/,
    );
    assert.deepEqual(calls, []);
  });

  it('05: rebases with the configured committer identity', async () => {
    /** @type {Array<{ file: string, args: string[] }>} */
    const calls = [];
    const gitClient = createGitClient({
      env: {},
      execFile: async (file, args) => {
        calls.push({ file, args });
        return { stdout: stdoutFor(args), stderr: '' };
      },
    });
    const committer = {
      name: 'github-actions[bot]',
      email: '41898282+github-actions[bot]@users.noreply.github.com',
    };

    await gitClient.rebaseBranchOntoBase({
      branchName: 'pullops/issue-15',
      baseBranch: 'main',
      committer,
    });
    await gitClient.startRebaseBranchOntoBase?.({
      branchName: 'pullops/issue-15',
      baseBranch: 'main',
      committer,
    });
    await gitClient.continueRebase?.({
      branchName: 'pullops/issue-15',
      baseBranch: 'main',
      committer,
    });

    assert.equal(
      countGitCalls(calls, [
        '-c',
        'user.name=github-actions[bot]',
        '-c',
        'user.email=41898282+github-actions[bot]@users.noreply.github.com',
        'rebase',
        'origin/main',
      ]),
      2,
    );
    assert.equal(
      calls.some(call =>
        isGitCall(call, [
          '-c',
          'user.name=github-actions[bot]',
          '-c',
          'user.email=41898282+github-actions[bot]@users.noreply.github.com',
          '-c',
          'core.editor=true',
          'rebase',
          '--continue',
        ]),
      ),
      true,
    );
  });

  it('06: rewrites a branch with existing commits before authenticated force-with-lease push', async () => {
    /** @type {Array<{ file: string, args: string[] }>} */
    const calls = [];
    const gitClient = createGitClient({
      env: {
        PULLOPS_GITHUB_TOKEN: 'pullops-token',
        GITHUB_REPOSITORY: 'acme/widgets',
      },
      execFile: async (file, args) => {
        calls.push({ file, args });
        return { stdout: stdoutFor(args), stderr: '' };
      },
    });

    if (gitClient.rewriteBranchWithExistingCommits === undefined) {
      throw new Error('Expected rewriteBranchWithExistingCommits to be available.');
    }

    await gitClient.rewriteBranchWithExistingCommits({
      baseBranch: 'main',
      branchName: 'pullops/prd-7',
      commitShas: ['child-21', 'child-22'],
      committer: {
        name: 'github-actions[bot]',
        email: '41898282+github-actions[bot]@users.noreply.github.com',
      },
    });

    assert.equal(
      calls.some(call => isGitCall(call, ['reset', '--hard', 'origin/main'])),
      true,
    );
    assert.equal(
      calls.some(call =>
        isGitCall(call, [
          '-c',
          'user.name=github-actions[bot]',
          '-c',
          'user.email=41898282+github-actions[bot]@users.noreply.github.com',
          'cherry-pick',
          'child-21',
        ]),
      ),
      true,
    );
    assert.equal(
      calls.some(call =>
        isGitCall(call, [
          '-c',
          'user.name=github-actions[bot]',
          '-c',
          'user.email=41898282+github-actions[bot]@users.noreply.github.com',
          'cherry-pick',
          'child-22',
        ]),
      ),
      true,
    );

    const setOriginIndex = calls.findIndex(call =>
      isGitCall(call, [
        'remote',
        'set-url',
        'origin',
        'https://x-access-token:pullops-token@github.com/acme/widgets.git',
      ]),
    );
    const pushIndex = calls.findIndex(call =>
      isGitCall(call, ['push', '--force-with-lease', 'origin', 'HEAD:pullops/prd-7']),
    );

    assert.notEqual(setOriginIndex, -1);
    assert.notEqual(pushIndex, -1);
    assert.equal(setOriginIndex < pushIndex, true);
  });

  it('07: fetches local dry-run refs and checks out existing or new PullOps branches', async () => {
    /** @type {Array<{ file: string, args: string[] }>} */
    const calls = [];
    const refs = new Set(['refs/remotes/origin/pullops/issue-15']);
    const gitClient = createGitClient({
      env: {},
      execFile: async (file, args) => {
        calls.push({ file, args });
        if (args[0] === 'show-ref') {
          const ref = args.at(-1);
          if (typeof ref === 'string' && refs.has(ref)) {
            return { stdout: '', stderr: '' };
          }

          const error = new Error('missing ref');
          Object.assign(error, { code: 1 });
          throw error;
        }

        return { stdout: stdoutFor(args), stderr: '' };
      },
    });

    await gitClient.fetchRemoteRefs?.({
      requiredBranchNames: ['main'],
      optionalBranchNames: ['pullops/issue-15'],
    });
    await gitClient.checkoutPullOpsBranch?.({
      branchName: 'pullops/issue-15',
      baseBranch: 'main',
    });
    refs.delete('refs/remotes/origin/pullops/issue-15');
    await gitClient.checkoutPullOpsBranch?.({
      branchName: 'pullops/issue-16',
      baseBranch: 'main',
    });

    assert.equal(
      calls.some(call =>
        isGitCall(call, ['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main']),
      ),
      true,
    );
    assert.equal(
      calls.some(call =>
        isGitCall(call, [
          'fetch',
          'origin',
          '+refs/heads/pullops/issue-15:refs/remotes/origin/pullops/issue-15',
        ]),
      ),
      true,
    );
    assert.equal(
      calls.some(call =>
        isGitCall(call, ['checkout', '-B', 'pullops/issue-15', 'origin/pullops/issue-15']),
      ),
      true,
    );
    assert.equal(
      calls.some(call => isGitCall(call, ['checkout', '-B', 'pullops/issue-16', 'origin/main'])),
      true,
    );
  });

  it('08: creates a child PullOps branch from an existing local base branch', async () => {
    /** @type {Array<{ file: string, args: string[] }>} */
    const calls = [];
    const refs = new Set(['refs/heads/pullops/prd-12']);
    const gitClient = createGitClient({
      env: {},
      execFile: async (file, args) => {
        calls.push({ file, args });
        if (args[0] === 'show-ref') {
          const ref = args.at(-1);
          if (typeof ref === 'string' && refs.has(ref)) {
            return { stdout: '', stderr: '' };
          }

          const error = new Error('missing ref');
          Object.assign(error, { code: 1 });
          throw error;
        }

        return { stdout: stdoutFor(args), stderr: '' };
      },
    });

    await gitClient.checkoutPullOpsBranch?.({
      branchName: 'pullops/prd-12-issue-35',
      baseBranch: 'pullops/prd-12',
    });

    assert.equal(
      calls.some(call =>
        isGitCall(call, ['checkout', '-B', 'pullops/prd-12-issue-35', 'pullops/prd-12']),
      ),
      true,
    );
  });

  it('09: excludes local run records when committing all changes', async () => {
    /** @type {Array<{ file: string, args: string[] }>} */
    const calls = [];
    const gitClient = createGitClient({
      env: {},
      execFile: async (file, args) => {
        calls.push({ file, args });
        return { stdout: '', stderr: '' };
      },
    });

    await gitClient.commitAll({
      message: 'Test commit',
      author: {
        name: 'PullOps',
        email: 'pullops@example.com',
      },
    });

    assert.equal(
      calls.some(call => isGitCall(call, ['add', '--all', '--', '.', ':!.pullops/runs/**'])),
      true,
    );
  });

  it('10: ignores local run records when checking for worktree changes', async () => {
    /** @type {Array<{ file: string, args: string[] }>} */
    const calls = [];
    const gitClient = createGitClient({
      env: {},
      execFile: async (file, args) => {
        calls.push({ file, args });
        return { stdout: '', stderr: '' };
      },
    });

    const hasChanges = await gitClient.hasChanges();

    assert.equal(hasChanges, false);
    assert.equal(
      calls.some(call =>
        isGitCall(call, ['status', '--porcelain', '--', '.', ':!.pullops/runs/**']),
      ),
      true,
    );
  });

  it('11: includes untracked files in the working tree patch', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-git-patch-'));
    await execFile('git', ['init'], { cwd });
    await execFile('git', ['config', 'user.name', 'PullOps'], { cwd });
    await execFile('git', ['config', 'user.email', 'pullops@example.com'], { cwd });
    await writeFile(join(cwd, 'tracked.txt'), 'tracked\n');
    await execFile('git', ['add', 'tracked.txt'], { cwd });
    await execFile('git', ['commit', '-m', 'Initial commit'], { cwd });
    await writeFile(join(cwd, 'new-file.txt'), 'hello from a new file\n');

    const gitClient = createGitClient({
      env: {},
      execFile: async (file, args) => {
        const result = await execFile(file, args, { cwd });
        return {
          stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? ''),
          stderr: Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? ''),
        };
      },
    });

    const patch = await gitClient.readWorkingTreePatch?.();

    assert.match(patch ?? '', /diff --git a\/new-file\.txt b\/new-file\.txt/);
    assert.match(patch ?? '', /\+hello from a new file/);
  });

  it('12: fetches local dry-run refs without requiring GitHub Actions push auth', async () => {
    /** @type {Array<{ file: string, args: string[] }>} */
    const calls = [];
    const gitClient = createGitClient({
      env: {
        GITHUB_REPOSITORY: 'acme/widgets',
      },
      execFile: async (file, args) => {
        calls.push({ file, args });
        return { stdout: '', stderr: '' };
      },
    });

    await gitClient.fetchRemoteRefs?.({
      requiredBranchNames: ['main'],
      optionalBranchNames: ['pullops/issue-15'],
    });

    assert.deepEqual(calls, [
      {
        file: 'git',
        args: ['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
      },
      {
        file: 'git',
        args: [
          'fetch',
          'origin',
          '+refs/heads/pullops/issue-15:refs/remotes/origin/pullops/issue-15',
        ],
      },
    ]);
  });

  it('13: reads the current branch name', async () => {
    const gitClient = createGitClient({
      env: {},
      execFile: async (_file, args) => {
        assert.deepEqual(args, ['branch', '--show-current']);
        return { stdout: 'pullops/issue-15\n', stderr: '' };
      },
    });

    assert.equal(await gitClient.getCurrentBranch?.(), 'pullops/issue-15');
  });

  it('14: cherry-picks finalized child commits onto a local PullOps branch', async () => {
    /** @type {Array<{ file: string, args: string[] }>} */
    const calls = [];
    const refs = new Set(['refs/heads/pullops/prd-7']);
    const gitClient = createGitClient({
      env: {},
      execFile: async (file, args) => {
        calls.push({ file, args });
        if (args[0] === 'show-ref') {
          const ref = args.at(-1);
          if (typeof ref === 'string' && refs.has(ref)) {
            return { stdout: '', stderr: '' };
          }

          const error = new Error('missing ref');
          Object.assign(error, { code: 1 });
          throw error;
        }

        return { stdout: stdoutFor(args), stderr: '' };
      },
    });

    const result = await gitClient.cherryPickCommitOntoBranch?.({
      branchName: 'pullops/prd-7',
      baseBranch: 'main',
      commitSha: 'finalized-head',
      committer: {
        name: 'github-actions[bot]',
        email: '41898282+github-actions[bot]@users.noreply.github.com',
      },
    });

    assert.equal(result?.status, 'cherry-picked');
    assert.equal(
      calls.some(call => isGitCall(call, ['checkout', 'pullops/prd-7'])),
      true,
    );
    assert.equal(
      calls.some(call =>
        isGitCall(call, [
          '-c',
          'user.name=github-actions[bot]',
          '-c',
          'user.email=41898282+github-actions[bot]@users.noreply.github.com',
          'cherry-pick',
          'finalized-head',
        ]),
      ),
      true,
    );
  });

  it('15: leaves conflicted cherry-picks inspectable on the target branch', async () => {
    /** @type {Array<{ file: string, args: string[] }>} */
    const calls = [];
    const gitClient = createGitClient({
      env: {},
      execFile: async (file, args) => {
        calls.push({ file, args });
        if (args[0] === 'show-ref') {
          const error = new Error('missing ref');
          Object.assign(error, { code: 1 });
          throw error;
        }

        if (args[0] === 'cherry-pick' || args.includes('cherry-pick')) {
          const error = new Error('conflict');
          Object.assign(error, { code: 1 });
          throw error;
        }

        if (isGitCall({ file, args }, ['diff', '--name-only', '--diff-filter=U', '-z'])) {
          return { stdout: 'src/conflicted.js\u0000', stderr: '' };
        }

        return { stdout: stdoutFor(args), stderr: '' };
      },
    });

    const result = await gitClient.cherryPickCommitOntoBranch?.({
      branchName: 'pullops/prd-7',
      baseBranch: 'main',
      commitSha: 'finalized-head',
      committer: {
        name: 'github-actions[bot]',
        email: '41898282+github-actions[bot]@users.noreply.github.com',
      },
    });

    assert.deepEqual(result, {
      status: 'conflicts',
      conflictedFiles: ['src/conflicted.js'],
    });
    assert.equal(
      calls.some(call => isGitCall(call, ['checkout', '-B', 'pullops/prd-7', 'origin/main'])),
      true,
    );
    assert.equal(
      calls.some(call => isGitCall(call, ['cherry-pick', '--abort'])),
      false,
    );
  });

  it('16: reads changed files since base without requiring Push auth configuration', async () => {
    /** @type {Array<{ file: string, args: string[] }>} */
    const calls = [];
    const gitClient = createGitClient({
      env: {
        GITHUB_REPOSITORY: 'acme/widgets',
      },
      execFile: async (file, args) => {
        calls.push({ file, args });
        if (isGitCall({ file, args }, ['diff', '--name-only', '-z', 'origin/main...HEAD'])) {
          return { stdout: 'src/file.js\u0000src/other.js\u0000', stderr: '' };
        }

        return { stdout: '', stderr: '' };
      },
    });

    const changedFiles = await gitClient.getChangedFilesSinceBase({ baseBranch: 'main' });

    assert.deepEqual(changedFiles, ['src/file.js', 'src/other.js']);
    assert.deepEqual(calls, [
      {
        file: 'git',
        args: ['fetch', 'origin', 'main'],
      },
      {
        file: 'git',
        args: ['diff', '--name-only', '-z', 'origin/main...HEAD'],
      },
    ]);
  });

  it('17: reads commits since base without requiring Push auth configuration', async () => {
    /** @type {Array<{ file: string, args: string[] }>} */
    const calls = [];
    const gitClient = createGitClient({
      env: {
        GITHUB_REPOSITORY: 'acme/widgets',
      },
      execFile: async (file, args) => {
        calls.push({ file, args });
        return { stdout: stdoutFor(args), stderr: '' };
      },
    });

    const commits = await gitClient.getCommitsSinceBase?.({ baseBranch: 'main' });

    assert.equal(commits?.length, 1);
    assert.equal(commits?.[0].sha, 'commit-one');
    assert.equal(
      calls.some(call =>
        isGitCall(call, [
          'remote',
          'set-url',
          'origin',
          'https://x-access-token:undefined@github.com/acme/widgets.git',
        ]),
      ),
      false,
    );
    assert.equal(
      calls.some(call => isGitCall(call, ['fetch', 'origin', 'main'])),
      true,
    );
  });
});

/**
 * @param {string[]} args
 * @returns {string}
 */
function stdoutFor(args) {
  if (args[0] === 'rev-list') {
    return 'commit-one\n';
  }

  if (
    args[0] === 'show' &&
    args[1] === '-s' &&
    args[2] === '--format=%B' &&
    args[3] === 'commit-one'
  ) {
    return 'Test commit subject\n\nTest commit body\n';
  }

  if (
    args[0] === 'diff-tree' &&
    args[1] === '--no-commit-id' &&
    args[2] === '--name-only' &&
    args[3] === '-r' &&
    args[4] === '-z' &&
    args[5] === 'commit-one'
  ) {
    return 'src/file.js\u0000src/other.js\u0000';
  }

  if (args[0] === 'rev-parse' && args[1] === 'HEAD^{tree}') {
    return 'rewritten-tree\n';
  }

  if (args[0] === 'rev-parse') {
    return 'rewritten-head\n';
  }

  return '';
}

/**
 * @param {{ file: string, args: string[] }} call
 * @param {string[]} args
 * @returns {boolean}
 */
function isGitCall(call, args) {
  return (
    call.file === 'git' &&
    call.args.length === args.length &&
    call.args.every((arg, index) => arg === args[index])
  );
}

/**
 * @param {Array<{ file: string, args: string[] }>} calls
 * @param {string[]} args
 * @returns {number}
 */
function countGitCalls(calls, args) {
  return calls.filter(call => isGitCall(call, args)).length;
}
