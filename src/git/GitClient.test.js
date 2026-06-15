import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createGitClient } from './GitClient.js';

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
});

/**
 * @param {string[]} args
 * @returns {string}
 */
function stdoutFor(args) {
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
