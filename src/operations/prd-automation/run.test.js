import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { DEFAULT_PULL_OPS_CONFIG } from '../../config/PullOpsConfig.js';
import { resumePrdAutomationForParentIssue, runPrdAutoAdvance, runPrdAutoComplete } from './run.js';

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../../github/types.js').GitHubCheckRun} GitHubCheckRun
 * @typedef {import('../../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('../../github/types.js').GitHubIssueReference} GitHubIssueReference
 * @typedef {import('../../github/types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('../../github/types.js').CreateDraftPullRequestOptions} CreateDraftPullRequestOptions
 * @typedef {import('../../github/types.js').EditLabelsOptions} EditLabelsOptions
 * @typedef {import('../../github/types.js').MergePullRequestOptions} MergePullRequestOptions
 * @typedef {import('../../config/types.js').PullOpsConfig} PullOpsConfig
 */

/** @typedef {import('../../prd-automation/childCoordination.types.js').ChildAutomationResult} ChildAutomationResult */
/** @typedef {import('../../prd-automation/childCoordination.types.js').ParentReviewResult} ParentReviewResult */

describe('runPrdAutoAdvance', () => {
  it('01: prepares the PRD and starts currently unblocked open child issues only', async () => {
    const parent = createIssue({
      number: 12,
      labels: ['pullops:prd:auto-advance'],
      subIssues: [issueReference(34), issueReference(35), issueReference(36), issueReference(37)],
    });
    const github = createFakeGitHub({
      issues: [
        parent,
        createIssue({ number: 34, parent: issueReference(12) }),
        createIssue({
          number: 35,
          body: 'Part of: #12\n\n## Blocked by\n\n#34',
          parent: issueReference(12),
        }),
        createIssue({ number: 36, state: 'CLOSED', parent: issueReference(12) }),
        createIssue({
          number: 37,
          labels: ['pullops:issue:implement'],
          parent: issueReference(12),
        }),
      ],
    });
    const git = createFakeGit();

    const result = await runPrdAutoAdvance(
      createContext({
        githubClient: github.client,
        gitClient: git.client,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.deepEqual(git.createdBranches, [
      {
        branchName: 'pullops/prd-12',
        baseBranch: 'main',
      },
    ]);
    assert.deepEqual(
      github.createdPullRequests.map(pullRequest => ({
        baseBranch: pullRequest.baseBranch,
        headBranch: pullRequest.headBranch,
      })),
      [
        {
          baseBranch: 'main',
          headBranch: 'pullops/prd-12',
        },
      ],
    );
    assert.deepEqual(github.issueLabelsAdded, [
      {
        number: 34,
        labels: ['pullops:issue:implement'],
      },
    ]);
    assert.equal(
      github.issueLabelsAdded.some(
        edit => edit.number === 12 && edit.labels.includes('pullops:issue:implement'),
      ),
      false,
    );
    assert.deepEqual(
      readChildResults(result).map(child => [child.issue.number, child.status]),
      [
        [34, 'started'],
        [35, 'blocked'],
        [36, 'closed'],
        [37, 'already-active'],
      ],
    );
  });

  it('02: ignores Part of body references that are not native Child Issues', async () => {
    const parent = createIssue({
      number: 12,
      labels: ['pullops:prd:auto-advance'],
      subIssues: [],
    });
    const github = createFakeGitHub({
      issues: [
        parent,
        createIssue({ number: 34, body: 'Part of: #12' }),
        createIssue({ number: 35, body: 'Part of: #99' }),
      ],
      bodyReferences: [issueReference(34), issueReference(35)],
      pullRequests: [
        createPullRequest({
          number: 200,
          headRefName: 'pullops/prd-12',
          baseRefName: 'main',
          body: parentPullRequestBody(12),
        }),
      ],
    });

    const result = await runPrdAutoAdvance(
      createContext({
        githubClient: github.client,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(readParentPullRequest(result)?.status, 'waiting-for-child-issues');
    assert.deepEqual(github.issueLabelsAdded, []);
    assert.deepEqual(github.pullRequestLabelsAdded, []);
    assert.deepEqual(
      readChildResults(result).map(child => child.issue.number),
      [],
    );
  });

  it('03: local dry-run drains the current unblocked child frontier without GitHub mutations', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-prd-local-dry-run-'));
    const parent = createIssue({
      number: 12,
      labels: ['pullops:prd:auto-advance'],
      subIssues: [
        issueReference(34),
        issueReference(35),
        issueReference(36),
        issueReference(37),
      ],
    });
    const github = createFakeGitHub({
      issues: [
        parent,
        createIssue({
          number: 34,
          body: 'Part of: #12\n\nBlocked by: #99',
          parent: issueReference(12),
        }),
        createIssue({ number: 35, parent: issueReference(12) }),
        createIssue({ number: 36, body: 'Blocked by: #35', parent: issueReference(12) }),
        createIssue({ number: 37, parent: issueReference(12) }),
        createIssue({ number: 99, state: 'OPEN' }),
      ],
    });
    const git = createFakeGit({ dirtyAfterRunner: true });
    const codex = createFakeCodexRunner(git);

    const result = await runPrdAutoAdvance(
      createContext({
        cwd,
        executionBackend: 'local',
        publicationMode: 'dry-run',
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(result.publicationMode, 'dry-run');
    assert.match(String(result.summary), /2 child issue dry-run\(s\) completed/);
    assert.match(String(result.localRunRecord), /\.pullops\/runs\/.+prd-auto-advance-12$/);
    assert.equal(codex.calls.length, 6);
    assert.match(codex.calls[0].prompt, /Child issue 35/);
    assert.match(codex.calls[1].prompt, /Use the pullops-pr-review skill/);
    assert.match(codex.calls[2].prompt, /Use the pullops-pr-finalize skill/);
    assert.match(codex.calls[3].prompt, /Child issue 37/);
    assert.match(codex.calls[4].prompt, /Use the pullops-pr-review skill/);
    assert.match(codex.calls[5].prompt, /Use the pullops-pr-finalize skill/);
    assert.deepEqual(github.issueLabelsAdded, []);
    assert.deepEqual(github.createdPullRequests, []);
    assert.deepEqual(github.updatedPullRequestBodies, []);
    assert.deepEqual(github.pullRequestComments, []);
    assert.deepEqual(
      readChildResults(result).map(child => [child.issue.number, child.status]),
      [
        [34, 'blocked'],
        [35, 'dry-run-completed'],
        [36, 'blocked'],
        [37, 'dry-run-completed'],
      ],
    );
    assert.deepEqual(
      git.checkouts.map(checkout => checkout.branchName),
      ['pullops/prd-12', 'pullops/prd-12-issue-35', 'pullops/prd-12-issue-37'],
    );
    assert.deepEqual(result.localNextSteps, [
      'Inspect local run evidence for child issues #35, #37.',
      'Publish with `pullops run prd:auto-advance <parent-issue-number> --publish pr` after reviewing the local branch.',
    ]);
  });

  it('04: local PR publication finalizes unblocked child issue PRs and restores the umbrella branch', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-prd-local-publish-'));
    const parent = createIssue({
      number: 12,
      labels: ['pullops:prd:auto-advance'],
      subIssues: [issueReference(34), issueReference(35)],
    });
    const github = createFakeGitHub({
      issues: [
        parent,
        createIssue({ number: 34, parent: issueReference(12) }),
        createIssue({ number: 35, parent: issueReference(12) }),
      ],
    });
    const git = createFakeGit({ dirtyAfterRunner: true });
    const codex = createFakeCodexRunner(git);

    const result = await runPrdAutoAdvance(
      createContext({
        cwd,
        executionBackend: 'local',
        publicationMode: 'publish',
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(result.publicationMode, 'publish');
    assert.equal(codex.calls.length, 6);
    assert.match(codex.calls[0].prompt, /Use the pullops-issue-implement skill/);
    assert.match(codex.calls[1].prompt, /Use the pullops-pr-review skill/);
    assert.match(codex.calls[2].prompt, /Use the pullops-pr-finalize skill/);
    assert.match(codex.calls[3].prompt, /Use the pullops-issue-implement skill/);
    assert.match(codex.calls[4].prompt, /Use the pullops-pr-review skill/);
    assert.match(codex.calls[5].prompt, /Use the pullops-pr-finalize skill/);
    assert.deepEqual(github.issueLabelsAdded, []);
    assert.deepEqual(github.pullRequestLabelsAdded, []);
    assert.deepEqual(
      readChildResults(result).map(child => [child.issue.number, child.status]),
      [
        [34, 'published'],
        [35, 'published'],
      ],
    );
    assert.deepEqual(
      github.createdPullRequests.map(pullRequest => ({
        baseBranch: pullRequest.baseBranch,
        headBranch: pullRequest.headBranch,
      })),
      [
        {
          baseBranch: 'main',
          headBranch: 'pullops/prd-12',
        },
        {
          baseBranch: 'pullops/prd-12',
          headBranch: 'pullops/prd-12-issue-34',
        },
        {
          baseBranch: 'pullops/prd-12',
          headBranch: 'pullops/prd-12-issue-35',
        },
      ],
    );
    assert.deepEqual(github.readyPullRequests, [302, 303]);
    assert.match(github.createdPullRequests[1].body, /Status: Ready for human merge/);
    assert.match(github.createdPullRequests[1].body, /Last operation: pullops:pr:finalize/);
    assert.match(github.createdPullRequests[1].body, /^Finalized tree: tree-current$/m);
    assert.match(github.createdPullRequests[1].body, /^Finalized head: head-current$/m);
    assert.deepEqual(
      github.pullRequestComments.map(comment => [
        comment.number,
        comment.body.match(/^Operation: (pullops:[^\n]+)$/m)?.[1],
      ]),
      [
        [302, 'pullops:issue:implement'],
        [302, 'pullops:pr:review'],
        [302, 'pullops:pr:finalize'],
        [303, 'pullops:issue:implement'],
        [303, 'pullops:pr:review'],
        [303, 'pullops:pr:finalize'],
      ],
    );
    assert.deepEqual(
      git.pushes.map(push => push.branchName),
      ['pullops/prd-12', 'pullops/prd-12-issue-34', 'pullops/prd-12-issue-35'],
    );
    assert.equal(git.currentBranch, 'pullops/prd-12');
    assert.deepEqual(
      git.checkouts.map(checkout => checkout.branchName),
      [
        'pullops/prd-12',
        'pullops/prd-12-issue-34',
        'pullops/prd-12',
        'pullops/prd-12-issue-35',
        'pullops/prd-12',
        'pullops/prd-12',
      ],
    );
  });

  it('05: local PRD auto-advance preserves human review gates for existing child PRs', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-prd-local-human-gate-'));
    const parent = createIssue({
      number: 12,
      labels: ['pullops:prd:auto-advance'],
      subIssues: [issueReference(34)],
    });
    const github = createFakeGitHub({
      issues: [parent, createIssue({ number: 34, parent: issueReference(12) })],
      pullRequests: [
        createPullRequest({
          number: 200,
          headRefName: 'pullops/prd-12',
          baseRefName: 'main',
          body: parentPullRequestBody(12),
        }),
        createPullRequest({
          number: 101,
          headRefName: 'pullops/prd-12-issue-34',
          baseRefName: 'pullops/prd-12',
          body: finalizedChildPullRequestBody(34),
          labels: [],
          isDraft: false,
        }),
      ],
    });
    const git = createFakeGit();
    const codex = createFakeCodexRunner(git);

    const result = await runPrdAutoAdvance(
      createContext({
        cwd,
        executionBackend: 'local',
        publicationMode: 'publish',
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(codex.calls.length, 0);
    assert.deepEqual(github.pullRequestLabelsAdded, []);
    assert.deepEqual(github.mergedPullRequests, []);
    assert.deepEqual(
      readChildResults(result).map(child => [child.issue.number, child.status]),
      [[34, 'ready-for-human-merge']],
    );
    assert.equal(git.currentBranch, 'pullops/prd-12');
  });

  it('06: local dry-run reports umbrella review readiness without adding trigger labels', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-prd-local-umbrella-review-'));
    const parent = createIssue({
      number: 12,
      labels: ['pullops:prd:auto-advance'],
      subIssues: [issueReference(34)],
    });
    const github = createFakeGitHub({
      issues: [
        parent,
        createIssue({
          number: 34,
          state: 'CLOSED',
          parent: issueReference(12),
        }),
      ],
      pullRequests: [
        createPullRequest({
          number: 200,
          headRefName: 'pullops/prd-12',
          baseRefName: 'main',
          body: parentPullRequestBody(12),
          isDraft: false,
        }),
      ],
    });
    const git = createFakeGit();
    const codex = createFakeCodexRunner(git);

    const result = await runPrdAutoAdvance(
      createContext({
        cwd,
        executionBackend: 'local',
        publicationMode: 'dry-run',
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(codex.calls.length, 0);
    assert.deepEqual(github.pullRequestLabelsAdded, []);
    assert.equal(readParentPullRequest(result)?.status, 'ready-for-review');
    assert.deepEqual(github.updatedPullRequestBodies, []);
    assert.deepEqual(result.localNextSteps, [
      'Umbrella PR is ready for human review after local dry-run; request review manually instead of adding trigger labels.',
    ]);
  });

  it('07: local dry-run records a follow-up when no native child issues are available', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-prd-local-no-children-'));
    const parent = createIssue({
      number: 12,
      labels: ['pullops:prd:auto-advance'],
      subIssues: [],
    });
    const github = createFakeGitHub({
      issues: [parent],
    });
    const git = createFakeGit();
    const codex = createFakeCodexRunner(git);

    const result = await runPrdAutoAdvance(
      createContext({
        cwd,
        executionBackend: 'local',
        publicationMode: 'dry-run',
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(codex.calls.length, 0);
    assert.deepEqual(github.pullRequestLabelsAdded, []);
    assert.equal(readParentPullRequest(result)?.status, 'waiting-for-child-issues');
    assert.match(String(result.localRunRecord), /\.pullops\/runs\/.+prd-auto-advance-12$/);
    assert.deepEqual(result.localNextSteps, [
      'Add or reopen a native Child Issue before rerunning local PRD auto-advance.',
    ]);
  });

  it('08: local PRD dry-run refuses a dirty worktree and still records a local run', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-prd-local-dirty-'));
    const github = createFakeGitHub({
      issues: [createIssue({ number: 12, labels: ['pullops:prd:auto-advance'] })],
    });
    const git = createFakeGit({ initialDirtyWorktree: true });

    await assert.rejects(
      runPrdAutoAdvance(
        createContext({
          cwd,
          executionBackend: 'local',
          publicationMode: 'dry-run',
          githubClient: github.client,
          gitClient: git.client,
        }),
      ),
      /requires a clean worktree/,
    );

    assert.deepEqual(github.createdPullRequests, []);
    assert.deepEqual(github.updatedPullRequestBodies, []);
    assert.deepEqual(git.checkouts, []);
    const [recordName] = await readdir(join(cwd, '.pullops', 'runs'));
    assert.match(recordName, /prd-auto-advance-12$/);
    assert.match(
      await readFile(join(cwd, '.pullops', 'runs', recordName, 'failure-reason.txt'), 'utf8'),
      /clean worktree/,
    );
  });

  it('09: local PRD publish refuses a dirty worktree before preparing the umbrella branch', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-prd-local-publish-dirty-'));
    const github = createFakeGitHub({
      issues: [createIssue({ number: 12, labels: ['pullops:prd:auto-advance'] })],
    });
    const git = createFakeGit({ initialDirtyWorktree: true });

    await assert.rejects(
      runPrdAutoAdvance(
        createContext({
          cwd,
          executionBackend: 'local',
          publicationMode: 'publish',
          githubClient: github.client,
          gitClient: git.client,
        }),
      ),
      /requires a clean worktree/,
    );

    assert.deepEqual(github.createdPullRequests, []);
    assert.deepEqual(github.updatedPullRequestBodies, []);
    assert.deepEqual(git.checkouts, []);
    assert.deepEqual(git.pushes, []);
  });

  it('10: local dry-run blocks child-issue misuse without mutating GitHub state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-prd-local-child-misuse-'));
    const github = createFakeGitHub({
      issues: [
        createIssue({
          number: 34,
          labels: ['pullops:prd:auto-advance'],
          parent: issueReference(12),
        }),
      ],
    });
    const git = createFakeGit();
    const codex = createFakeCodexRunner(git);

    const result = await runPrdAutoAdvance(
      createContext({
        cwd,
        executionBackend: 'local',
        publicationMode: 'dry-run',
        target: {
          type: 'issue',
          number: 34,
        },
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'blocked');
    assert.equal(result.mode, 'auto-advance');
    assert.equal(result.publicationMode, 'dry-run');
    assert.deepEqual(github.issueLabelsAdded, []);
    assert.deepEqual(github.createdPullRequests, []);
    assert.deepEqual(github.updatedPullRequestBodies, []);
    assert.deepEqual(github.pullRequestComments, []);
    assert.match(String(result.summary), /PRD automation can only run on a Parent Issue/);
    assert.match(
      await readFile(join(String(result.localRunRecord), 'failure-reason.txt'), 'utf8'),
      /PRD automation can only run on a Parent Issue/,
    );
  });

  it('11: local PR publication continues after a no-op child implementation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-prd-local-publish-noop-child-'));
    const parent = createIssue({
      number: 12,
      labels: ['pullops:prd:auto-advance'],
      subIssues: [issueReference(34), issueReference(35)],
    });
    const github = createFakeGitHub({
      issues: [
        parent,
        createIssue({ number: 34, parent: issueReference(12) }),
        createIssue({ number: 35, parent: issueReference(12) }),
      ],
    });
    const git = createFakeGit({ dirtyAfterRunner: [false, true] });
    const codex = createFakeCodexRunner(git);

    const result = await runPrdAutoAdvance(
      createContext({
        cwd,
        executionBackend: 'local',
        publicationMode: 'publish',
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(codex.calls.length, 6);
    assert.deepEqual(
      codex.calls.map(call => call.prompt.match(/Use the ([^ ]+) skill/)?.[1]),
      [
        'pullops-issue-implement',
        'pullops-pr-review',
        'pullops-pr-finalize',
        'pullops-issue-implement',
        'pullops-pr-review',
        'pullops-pr-finalize',
      ],
    );
    assert.deepEqual(
      readChildResults(result).map(child => [child.issue.number, child.status]),
      [
        [34, 'published'],
        [35, 'published'],
      ],
    );
    assert.deepEqual(
      git.emptyCommits.map(commit => commit.message.split('\n')[0]),
      ['chore(prd): prepare #12', 'feat(issue): implement #34'],
    );
    assert.deepEqual(
      github.createdPullRequests.map(pullRequest => pullRequest.headBranch),
      ['pullops/prd-12', 'pullops/prd-12-issue-34', 'pullops/prd-12-issue-35'],
    );
    assert.equal(git.currentBranch, 'pullops/prd-12');
  });
});

describe('resumePrdAutomationForParentIssue', () => {
  it('01: starts newly unblocked child issues after a blocking issue closes', async () => {
    const parent = createIssue({
      number: 12,
      labels: ['pullops:prd:auto-advance'],
      subIssues: [issueReference(35)],
    });
    const github = createFakeGitHub({
      issues: [
        parent,
        createIssue({ number: 34, state: 'CLOSED', parent: issueReference(12) }),
        createIssue({
          number: 35,
          body: 'Part of: #12\nBlocked by: #34',
          parent: issueReference(12),
        }),
      ],
      pullRequests: [
        createPullRequest({
          number: 200,
          headRefName: 'pullops/prd-12',
          baseRefName: 'main',
          body: parentPullRequestBody(12),
        }),
      ],
    });

    const result = await resumePrdAutomationForParentIssue(
      createContext({
        target: { type: 'pr', number: 101 },
        githubClient: github.client,
      }),
      12,
    );

    assert.equal(result.status, 'accepted');
    assert.deepEqual(github.issueLabelsAdded, [
      {
        number: 35,
        labels: ['pullops:issue:implement'],
      },
    ]);
  });
});

describe('runPrdAutoComplete', () => {
  it('01: rebase-merges finalized child PRs and leaves child issue closure to pr-close-child-issue', async () => {
    const parent = createIssue({
      number: 12,
      labels: ['pullops:prd:auto-complete'],
      subIssues: [issueReference(34)],
    });
    const github = createFakeGitHub({
      issues: [parent, createIssue({ number: 34, parent: issueReference(12) })],
      pullRequests: [
        createPullRequest({
          number: 200,
          headRefName: 'pullops/prd-12',
          baseRefName: 'main',
          body: parentPullRequestBody(12),
        }),
        createPullRequest({
          number: 101,
          headRefName: 'pullops/prd-12-issue-34',
          baseRefName: 'pullops/prd-12',
          body: finalizedChildPullRequestBody(34),
          labels: [],
          isDraft: false,
        }),
      ],
      checksByRef: new Map([
        [
          'head-finalized',
          [
            {
              name: 'CI',
              state: 'success',
              conclusion: 'success',
              bucket: 'pass',
            },
          ],
        ],
      ]),
    });

    const result = await runPrdAutoComplete(
      createContext({
        operation: 'prd-auto-complete',
        githubClient: github.client,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.deepEqual(github.mergedPullRequests, [
      {
        number: 101,
        method: 'rebase',
      },
    ]);
    assert.deepEqual(github.closedIssues, []);
    assert.deepEqual(
      readChildResults(result).map(child => [child.issue.number, child.status]),
      [[34, 'merged']],
    );
  });

  it('02: does not start duplicate work for active child PRs', async () => {
    const parent = createIssue({
      number: 12,
      labels: ['pullops:prd:auto-complete'],
      subIssues: [issueReference(34)],
    });
    const github = createFakeGitHub({
      issues: [parent, createIssue({ number: 34, parent: issueReference(12) })],
      pullRequests: [
        createPullRequest({
          number: 200,
          headRefName: 'pullops/prd-12',
          baseRefName: 'main',
          body: parentPullRequestBody(12),
        }),
        createPullRequest({
          number: 101,
          headRefName: 'pullops/prd-12-issue-34',
          baseRefName: 'pullops/prd-12',
          body: childPullRequestBody(34),
          labels: ['pullops:pr:review'],
        }),
      ],
    });

    const result = await runPrdAutoComplete(
      createContext({
        operation: 'prd-auto-complete',
        githubClient: github.client,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.deepEqual(github.issueLabelsAdded, []);
    assert.deepEqual(github.pullRequestLabelsAdded, []);
    assert.deepEqual(github.mergedPullRequests, []);
    assert.deepEqual(
      readChildResults(result).map(child => child.status),
      ['already-active'],
    );
  });

  it('03: local publish closes finalized child issues after merging them into the umbrella branch', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-prd-local-auto-complete-publish-'));
    const parent = createIssue({
      number: 12,
      labels: ['pullops:prd:auto-complete'],
      subIssues: [issueReference(34)],
    });
    const github = createFakeGitHub({
      issues: [parent, createIssue({ number: 34, parent: issueReference(12) })],
      pullRequests: [
        createPullRequest({
          number: 200,
          headRefName: 'pullops/prd-12',
          baseRefName: 'main',
          body: parentPullRequestBody(12),
        }),
        createPullRequest({
          number: 101,
          headRefName: 'pullops/prd-12-issue-34',
          baseRefName: 'pullops/prd-12',
          body: finalizedChildPullRequestBody(34),
          labels: [],
          isDraft: false,
        }),
      ],
      checksByRef: new Map([
        [
          'head-finalized',
          [
            {
              name: 'CI',
              state: 'success',
              conclusion: 'success',
              bucket: 'pass',
            },
          ],
        ],
      ]),
    });
    const git = createFakeGit();
    const codex = createFakeCodexRunner(git);

    const result = await runPrdAutoComplete(
      createContext({
        cwd,
        operation: 'prd-auto-complete',
        executionBackend: 'local',
        publicationMode: 'publish',
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(result.mode, 'auto-complete');
    assert.equal(result.publicationMode, 'publish');
    assert.equal(codex.calls.length, 0);
    assert.deepEqual(github.mergedPullRequests, []);
    assert.deepEqual(github.closedIssues, [34]);
    assert.deepEqual(github.pullRequestLabelsAdded, []);
    assert.deepEqual(git.cherryPicks, [
      {
        branchName: 'pullops/prd-12',
        baseBranch: 'main',
        commitSha: 'head-finalized',
      },
    ]);
    assert.deepEqual(
      git.pushes.map(push => push.branchName),
      ['pullops/prd-12'],
    );
    assert.equal(git.currentBranch, 'pullops/prd-12');
    assert.deepEqual(
      readChildResults(result).map(child => [child.issue.number, child.status, child.mergeMethod]),
      [[34, 'merged', 'local-cherry-pick']],
    );
    assert.equal(readParentPullRequest(result)?.status, 'ready-for-review');
    assert.deepEqual(result.localNextSteps, [
      'Umbrella PR is ready for human review; request review manually after verifying the refreshed PRD context.',
    ]);
  });

  it('04: local publish does not cherry-pick the same finalized child twice after closing it', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-prd-local-auto-complete-rerun-'));
    const parent = createIssue({
      number: 12,
      labels: ['pullops:prd:auto-complete'],
      subIssues: [issueReference(34)],
    });
    const github = createFakeGitHub({
      issues: [parent, createIssue({ number: 34, parent: issueReference(12) })],
      pullRequests: [
        createPullRequest({
          number: 200,
          headRefName: 'pullops/prd-12',
          baseRefName: 'main',
          body: parentPullRequestBody(12),
        }),
        createPullRequest({
          number: 101,
          headRefName: 'pullops/prd-12-issue-34',
          baseRefName: 'pullops/prd-12',
          body: finalizedChildPullRequestBody(34),
          labels: [],
          isDraft: false,
        }),
      ],
      checksByRef: new Map([
        [
          'head-finalized',
          [
            {
              name: 'CI',
              state: 'success',
              conclusion: 'success',
              bucket: 'pass',
            },
          ],
        ],
      ]),
    });
    const git = createFakeGit();
    const codex = createFakeCodexRunner(git);
    const context = createContext({
      cwd,
      operation: 'prd-auto-complete',
      executionBackend: 'local',
      publicationMode: 'publish',
      githubClient: github.client,
      gitClient: git.client,
      codexRunner: codex.runner,
    });

    await runPrdAutoComplete(context);
    const rerun = await runPrdAutoComplete(context);

    assert.deepEqual(git.cherryPicks, [
      {
        branchName: 'pullops/prd-12',
        baseBranch: 'main',
        commitSha: 'head-finalized',
      },
    ]);
    assert.deepEqual(
      readChildResults(rerun).map(child => [child.issue.number, child.status]),
      [[34, 'closed']],
    );
    assert.deepEqual(rerun.localNextSteps, [
      'Umbrella PR is ready for human review; request review manually after verifying the refreshed PRD context.',
    ]);
  });

  it('05: local auto-complete includes local auto-advance for runnable children', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-prd-local-auto-complete-advance-'));
    const parent = createIssue({
      number: 12,
      labels: ['pullops:prd:auto-complete'],
      subIssues: [issueReference(34)],
    });
    const github = createFakeGitHub({
      issues: [parent, createIssue({ number: 34, parent: issueReference(12) })],
    });
    const git = createFakeGit({ dirtyAfterRunner: true });
    const codex = createFakeCodexRunner(git);

    const result = await runPrdAutoComplete(
      createContext({
        cwd,
        operation: 'prd-auto-complete',
        executionBackend: 'local',
        publicationMode: 'dry-run',
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(result.mode, 'auto-complete');
    assert.equal(result.publicationMode, 'dry-run');
    assert.equal(codex.calls.length, 3);
    assert.match(codex.calls[0].prompt, /Child issue 34/);
    assert.match(codex.calls[1].prompt, /Use the pullops-pr-review skill/);
    assert.match(codex.calls[2].prompt, /Use the pullops-pr-finalize skill/);
    assert.deepEqual(github.issueLabelsAdded, []);
    assert.deepEqual(
      readChildResults(result).map(child => [child.issue.number, child.status]),
      [[34, 'dry-run-completed']],
    );
    assert.equal(git.currentBranch, 'pullops/prd-12-issue-34');
    assert.deepEqual(result.localNextSteps, [
      'Inspect local run evidence for child issue #34.',
      'Publish with `pullops run prd:auto-complete <parent-issue-number> --publish pr` after reviewing the local branch.',
    ]);
  });

  it('06: local auto-complete leaves waiting child PRs unmerged on the umbrella branch', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-prd-local-auto-complete-waiting-'));
    const parent = createIssue({
      number: 12,
      labels: ['pullops:prd:auto-complete'],
      subIssues: [issueReference(34)],
    });
    const github = createFakeGitHub({
      issues: [parent, createIssue({ number: 34, parent: issueReference(12) })],
      pullRequests: [
        createPullRequest({
          number: 200,
          headRefName: 'pullops/prd-12',
          baseRefName: 'main',
          body: parentPullRequestBody(12),
        }),
        createPullRequest({
          number: 101,
          headRefName: 'pullops/prd-12-issue-34',
          baseRefName: 'pullops/prd-12',
          body: finalizedChildPullRequestBody(34),
          labels: [],
          isDraft: true,
        }),
      ],
    });
    const git = createFakeGit();
    const codex = createFakeCodexRunner(git);

    const result = await runPrdAutoComplete(
      createContext({
        cwd,
        operation: 'prd-auto-complete',
        executionBackend: 'local',
        publicationMode: 'publish',
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.deepEqual(git.cherryPicks, []);
    assert.deepEqual(github.mergedPullRequests, []);
    assert.equal(git.currentBranch, 'pullops/prd-12');
    assert.deepEqual(
      readChildResults(result).map(child => [child.issue.number, child.status]),
      [[34, 'waiting']],
    );
    assert.deepEqual(result.localNextSteps, [
      'Wait for child issue #34 to finish review or checks, then rerun PRD auto-complete.',
    ]);
  });

  it('07: local auto-complete reports conflicted finalized child merges and leaves the umbrella branch checked out', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-prd-local-auto-complete-conflict-'));
    const parent = createIssue({
      number: 12,
      labels: ['pullops:prd:auto-complete'],
      subIssues: [issueReference(34)],
    });
    const github = createFakeGitHub({
      issues: [parent, createIssue({ number: 34, parent: issueReference(12) })],
      pullRequests: [
        createPullRequest({
          number: 200,
          headRefName: 'pullops/prd-12',
          baseRefName: 'main',
          body: parentPullRequestBody(12),
        }),
        createPullRequest({
          number: 101,
          headRefName: 'pullops/prd-12-issue-34',
          baseRefName: 'pullops/prd-12',
          body: finalizedChildPullRequestBody(34),
          labels: [],
          isDraft: false,
        }),
      ],
    });
    const git = createFakeGit({ cherryPickConflicts: ['src/conflicted.js'] });
    const codex = createFakeCodexRunner(git);

    const result = await runPrdAutoComplete(
      createContext({
        cwd,
        operation: 'prd-auto-complete',
        executionBackend: 'local',
        publicationMode: 'publish',
        githubClient: github.client,
        gitClient: git.client,
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.deepEqual(github.mergedPullRequests, []);
    assert.deepEqual(
      readChildResults(result).map(child => [
        child.issue.number,
        child.status,
        child.conflictedFiles,
      ]),
      [[34, 'blocked', ['src/conflicted.js']]],
    );
    assert.deepEqual(
      git.cherryPicks.map(cherryPick => cherryPick.branchName),
      ['pullops/prd-12'],
    );
    assert.deepEqual(git.checkouts, [
      {
        branchName: 'pullops/prd-12',
        baseBranch: 'main',
      },
    ]);
    assert.deepEqual(git.pushes, []);
    assert.equal(git.currentBranch, 'pullops/prd-12');
    assert.deepEqual(result.localNextSteps, [
      'Resolve the blocker for child issue #34, then rerun PRD auto-complete.',
    ]);
  });
});

/**
 * @param {Partial<OperationRunnerContext>} overrides
 * @returns {OperationRunnerContext}
 */
function createContext(overrides = {}) {
  return {
    operation: 'prd-auto-advance',
    phase: 'run',
    runnerAdapter: 'codex-cli',
    target: {
      type: 'issue',
      number: 12,
    },
    cwd: '/workspace',
    config: DEFAULT_PULL_OPS_CONFIG,
    modelTier: 'low',
    model: 'gpt-5.4-mini',
    githubClient: createFakeGitHub({ issues: [createIssue({ number: 12 })] }).client,
    gitClient: createFakeGit().client,
    codexRunner: {
      async run() {
        throw new Error('codexRunner.run was not expected in this test.');
      },
    },
    ...overrides,
  };
}

/**
 * @param {object} [options]
 * @param {number} [options.number]
 * @param {string} [options.title]
 * @param {string} [options.body]
 * @param {string} [options.state]
 * @param {string[]} [options.labels]
 * @param {GitHubIssueReference | null} [options.parent]
 * @param {GitHubIssueReference[]} [options.subIssues]
 * @returns {GitHubIssue}
 */
function createIssue({
  number = 12,
  title = number === 12 ? 'PRD: Parent workflow' : `Child issue ${number}`,
  body = '',
  state = 'OPEN',
  labels = [],
  parent = null,
  subIssues = [],
} = {}) {
  return {
    number,
    title,
    body,
    state,
    url: `https://github.com/acme/widgets/issues/${number}`,
    authorLogin: 'maintainer',
    labels,
    parent,
    subIssues,
  };
}

/**
 * @param {number} number
 * @returns {GitHubIssueReference}
 */
function issueReference(number) {
  return {
    number,
    title: number === 12 ? 'PRD: Parent workflow' : `Child issue ${number}`,
    state: 'OPEN',
    url: `https://github.com/acme/widgets/issues/${number}`,
    relationshipSource: 'native',
  };
}

/**
 * @param {object} [options]
 * @param {number} [options.number]
 * @param {string} [options.headRefName]
 * @param {string} [options.baseRefName]
 * @param {string} [options.body]
 * @param {string[]} [options.labels]
 * @param {boolean} [options.isDraft]
 * @returns {GitHubPullRequest}
 */
function createPullRequest({
  number = 101,
  headRefName = 'pullops/prd-12-issue-34',
  baseRefName = 'pullops/prd-12',
  body = childPullRequestBody(34),
  labels = [],
  isDraft = true,
} = {}) {
  return {
    number,
    title: `Pull request ${number}`,
    url: `https://github.com/acme/widgets/pull/${number}`,
    headRefName,
    headSha: `sha-${number}`,
    baseRefName,
    state: 'OPEN',
    body,
    isDraft,
    isCrossRepository: false,
    labels,
  };
}

/**
 * @param {number} issueNumber
 * @returns {string}
 */
function childPullRequestBody(issueNumber) {
  return [
    '## PullOps',
    '',
    'Managed: yes',
    'Status: Draft automation',
    '',
    '<details>',
    '<summary>PullOps workflow state</summary>',
    '',
    `Source: Issue #${issueNumber}`,
    'Last operation: pullops:issue:implement',
    '',
    '</details>',
  ].join('\n');
}

/**
 * @param {number} issueNumber
 * @returns {string}
 */
function finalizedChildPullRequestBody(issueNumber) {
  return [
    '## PullOps',
    '',
    'Managed: yes',
    'Status: Ready for human merge',
    '',
    '<details>',
    '<summary>PullOps workflow state</summary>',
    '',
    `Source: Issue #${issueNumber}`,
    'Reviewed tree: tree-reviewed',
    'Finalized tree: tree-finalized',
    'Finalized head: head-finalized',
    'Merge method: rebase',
    'Last operation: pullops:pr:finalize',
    '',
    '</details>',
  ].join('\n');
}

/**
 * @param {number} issueNumber
 * @returns {string}
 */
function parentPullRequestBody(issueNumber) {
  return [
    '## PullOps',
    '',
    'Managed: yes',
    'Status: Draft parent preparation',
    '',
    '<details>',
    '<summary>PullOps workflow state</summary>',
    '',
    `Source: Parent Issue #${issueNumber}`,
    'Last operation: pullops:prd:prepare',
    '',
    '</details>',
  ].join('\n');
}

/**
 * @param {Record<string, unknown>} result
 * @returns {ChildAutomationResult[]}
 */
function readChildResults(result) {
  return /** @type {ChildAutomationResult[]} */ (result.children);
}

/**
 * @param {Record<string, unknown>} result
 * @returns {ParentReviewResult | undefined}
 */
function readParentPullRequest(result) {
  return /** @type {ParentReviewResult | undefined} */ (result.parentPullRequest);
}

/**
 * @param {object} options
 * @param {GitHubIssue[]} options.issues
 * @param {GitHubIssueReference[]} [options.bodyReferences]
 * @param {GitHubPullRequest[]} [options.pullRequests]
 * @param {Map<string, GitHubCheckRun[]>} [options.checksByRef]
 * @returns {{
 *   client: import('../../github/types.js').GitHubClient;
 *   issueLabelsAdded: EditLabelsOptions[];
 *   pullRequestLabelsAdded: EditLabelsOptions[];
 *   createdPullRequests: CreateDraftPullRequestOptions[];
 *   updatedPullRequestBodies: { number: number, body: string }[];
 *   pullRequestComments: { number: number, body: string }[];
 *   mergedPullRequests: MergePullRequestOptions[];
 *   closedIssues: number[];
 *   readyPullRequests: number[];
 * }}
 */
function createFakeGitHub({
  issues,
  bodyReferences = [],
  pullRequests = [],
  checksByRef = new Map(),
}) {
  const issuesByNumber = new Map(issues.map(issue => [issue.number, issue]));
  const pullRequestsByHead = new Map(
    pullRequests.map(pullRequest => [pullRequest.headRefName, pullRequest]),
  );
  /** @type {EditLabelsOptions[]} */
  const issueLabelsAdded = [];
  /** @type {EditLabelsOptions[]} */
  const issueLabelsRemoved = [];
  /** @type {EditLabelsOptions[]} */
  const pullRequestLabelsAdded = [];
  /** @type {CreateDraftPullRequestOptions[]} */
  const createdPullRequests = [];
  /** @type {{ number: number, body: string }[]} */
  const updatedPullRequestBodies = [];
  /** @type {{ number: number, body: string }[]} */
  const pullRequestComments = [];
  /** @type {MergePullRequestOptions[]} */
  const mergedPullRequests = [];
  /** @type {number[]} */
  const closedIssues = [];
  /** @type {number[]} */
  const readyPullRequests = [];

  return {
    issueLabelsAdded,
    pullRequestLabelsAdded,
    createdPullRequests,
    updatedPullRequestBodies,
    pullRequestComments,
    mergedPullRequests,
    closedIssues,
    readyPullRequests,
    client: {
      async ensureLabels() {
        return {
          created: [],
          updated: [],
          alreadyCorrect: [],
        };
      },
      async getIssue(number) {
        const issue = issuesByNumber.get(number);
        if (issue === undefined) {
          throw new Error(`Unexpected issue lookup #${number}.`);
        }
        return issue;
      },
      async getPullRequest() {
        throw new Error('getPullRequest was not expected in this test.');
      },
      async getPullRequestChecks() {
        throw new Error('getPullRequestChecks was not expected in this test.');
      },
      async getPullRequestChecksForRef(ref) {
        return checksByRef.get(ref) ?? [];
      },
      async getPullRequestReviewContext() {
        throw new Error('getPullRequestReviewContext was not expected in this test.');
      },
      async getPullRequestDiff() {
        throw new Error('getPullRequestDiff was not expected in this test.');
      },
      async findOpenPullRequestByHead(headBranch) {
        return pullRequestsByHead.get(headBranch);
      },
      async findIssuesByBodyReference() {
        return bodyReferences;
      },
      async createDraftPullRequest(options) {
        createdPullRequests.push(options);
        const pullRequest = createPullRequest({
          number: 300 + createdPullRequests.length,
          headRefName: options.headBranch,
          baseRefName: options.baseBranch,
          body: options.body,
        });
        pullRequestsByHead.set(options.headBranch, pullRequest);
        return pullRequest;
      },
      async mergePullRequest(options) {
        mergedPullRequests.push(options);
      },
      async addLabelsToIssue(options) {
        issueLabelsAdded.push(options);
        const issue = issuesByNumber.get(options.number);
        if (issue !== undefined) {
          issue.labels = [...new Set([...issue.labels, ...options.labels])];
        }
      },
      async removeLabelsFromIssue(options) {
        issueLabelsRemoved.push(options);
        const issue = issuesByNumber.get(options.number);
        if (issue !== undefined) {
          issue.labels = issue.labels.filter(label => !options.labels.includes(label));
        }
      },
      async addLabelsToPullRequest(options) {
        pullRequestLabelsAdded.push(options);
      },
      async removeLabelsFromPullRequest() {
        throw new Error('removeLabelsFromPullRequest was not expected in this test.');
      },
      async commentOnIssue() {
        throw new Error('commentOnIssue was not expected in this test.');
      },
      async closeIssue(options) {
        closedIssues.push(options.number);
        const issue = issuesByNumber.get(options.number);
        if (issue !== undefined) {
          issue.state = 'CLOSED';
        }
      },
      async commentOnPullRequest(options) {
        pullRequestComments.push(options);
      },
      async updatePullRequestBody(options) {
        updatedPullRequestBodies.push(options);
        for (const pullRequest of pullRequestsByHead.values()) {
          if (pullRequest.number === options.number) {
            pullRequest.body = options.body;
          }
        }
      },
      async markPullRequestReadyForReview(number) {
        readyPullRequests.push(number);
        for (const pullRequest of pullRequestsByHead.values()) {
          if (pullRequest.number === number) {
            pullRequest.isDraft = false;
          }
        }
      },
      async publishPullRequestReview() {
        throw new Error('publishPullRequestReview was not expected in this test.');
      },
      async replyToPullRequestReviewComment() {
        throw new Error('replyToPullRequestReviewComment was not expected in this test.');
      },
      async resolvePullRequestReviewThread() {
        throw new Error('resolvePullRequestReviewThread was not expected in this test.');
      },
    },
  };
}

/**
 * @param {object} [options]
 * @param {boolean | boolean[]} [options.dirtyAfterRunner]
 * @param {string[]} [options.cherryPickConflicts]
 * @param {boolean} [options.initialDirtyWorktree]
 * @returns {{
 *   client: import('../../git/types.js').GitClient;
 *   createdBranches: { branchName: string, baseBranch: string }[];
 *   checkouts: { branchName: string, baseBranch: string }[];
 *   cherryPicks: { branchName: string, baseBranch: string, commitSha: string }[];
 *   emptyCommits: import('../../git/types.js').CommitEmptyOptions[];
 *   pushes: { branchName: string }[];
 *   currentBranch: string;
 *   markRunnerChangedWorktree(): void;
 * }}
 */
function createFakeGit({
  dirtyAfterRunner = false,
  cherryPickConflicts = [],
  initialDirtyWorktree = false,
} = {}) {
  /** @type {{ branchName: string, baseBranch: string }[]} */
  const createdBranches = [];
  /** @type {{ branchName: string, baseBranch: string }[]} */
  const checkouts = [];
  /** @type {{ branchName: string, baseBranch: string, commitSha: string }[]} */
  const cherryPicks = [];
  /** @type {import('../../git/types.js').CommitEmptyOptions[]} */
  const emptyCommits = [];
  /** @type {{ branchName: string }[]} */
  const pushes = [];
  let currentBranch = 'main';
  let dirty = initialDirtyWorktree;
  let runnerChangeIndex = 0;
  let hasUnmergedFiles = false;

  return {
    createdBranches,
    checkouts,
    cherryPicks,
    emptyCommits,
    pushes,
    get currentBranch() {
      return currentBranch;
    },
    markRunnerChangedWorktree() {
      if (Array.isArray(dirtyAfterRunner)) {
        const index = Math.min(runnerChangeIndex, dirtyAfterRunner.length - 1);
        dirty = dirtyAfterRunner[index] ?? false;
        runnerChangeIndex += 1;
        return;
      }

      dirty = dirtyAfterRunner;
    },
    client: {
      async createBranch(options) {
        createdBranches.push(options);
        currentBranch = options.branchName;
      },
      async fetchRemoteRefs() {},
      async checkoutPullOpsBranch(options) {
        if (hasUnmergedFiles) {
          throw new Error('cannot checkout with unmerged files');
        }
        checkouts.push(options);
        currentBranch = options.branchName;
      },
      async getCurrentBranch() {
        return currentBranch;
      },
      async hasChanges() {
        return dirty;
      },
      async commitAll() {
        dirty = false;
      },
      async commitEmpty(options) {
        emptyCommits.push(options);
        dirty = false;
      },
      async readWorkingTreePatch() {
        return dirty ? 'diff --git a/src/file.js b/src/file.js\n' : '';
      },
      async pushBranch(options) {
        pushes.push(options);
      },
      async cherryPickCommitOntoBranch(options) {
        cherryPicks.push({
          branchName: options.branchName,
          baseBranch: options.baseBranch,
          commitSha: options.commitSha,
        });
        currentBranch = options.branchName;
        if (cherryPickConflicts.length > 0) {
          hasUnmergedFiles = true;
          return {
            status: 'conflicts',
            conflictedFiles: cherryPickConflicts,
          };
        }
        hasUnmergedFiles = false;
        return {
          status: 'cherry-picked',
          headSha: `integrated-${options.commitSha}`,
          treeHash: `tree-${options.commitSha}`,
        };
      },
      async rebaseBranchOntoBase() {
        throw new Error('rebaseBranchOntoBase was not expected in this test.');
      },
      async pushBranchWithLease(options) {
        pushes.push(options);
        return {
          status: 'pushed',
          headSha: `pushed-${options.branchName}`,
          treeHash: `tree-${options.branchName}`,
        };
      },
      async getCurrentHeadSha() {
        return 'head-current';
      },
      async getCurrentTreeHash() {
        return 'tree-current';
      },
      async getChangedFilesSinceBase() {
        return ['src/file.js'];
      },
      async rewriteBranchWithCommitPlan() {
        return {
          headSha: 'head-current',
          treeHash: 'tree-current',
        };
      },
      async getCommitsSinceBase() {
        return [];
      },
    },
  };
}

/**
 * @param {{ markRunnerChangedWorktree(): void }} [git]
 * @returns {{
 *   runner: import('../../runner/types.js').CodexRunner;
 *   calls: { cwd: string, command: string, model: string, prompt: string }[];
 * }}
 */
function createFakeCodexRunner(git) {
  /** @type {{ cwd: string, command: string, model: string, prompt: string }[]} */
  const calls = [];

  return {
    calls,
    runner: {
      async run(options) {
        calls.push(options);
        if (options.prompt.includes('Use the pullops-pr-review skill.')) {
          return {
            status: 'approved',
            summary: `Approved child issue run ${calls.length}.`,
            comments: [],
            replies: [],
            directChanges: [],
            followUps: [],
          };
        }

        if (options.prompt.includes('Use the pullops-pr-finalize skill.')) {
          return {
            status: 'planned',
            summary: `Planned child issue finalization ${calls.length}.`,
            commitPlan: {
              commits: [
                {
                  header: 'feat(issue): implement child issue',
                  body: ['Finalize local child issue implementation.'],
                  footers: ['Refs: #34'],
                  files: ['src/file.js'],
                },
              ],
            },
            followUps: [],
          };
        }

        git?.markRunnerChangedWorktree();
        return {
          status: 'implemented',
          summary: `Implemented child issue run ${calls.length}.`,
          changes: [`Changed child issue run ${calls.length}.`],
          testPlan: ['Not run in fake test.'],
          followUps: [],
        };
      },
    },
  };
}
