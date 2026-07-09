import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { DEFAULT_PULL_OPS_CONFIG } from '../../config/PullOpsConfig.js';
import { PullOpsCli } from '../../cli/PullOpsCli.js';
import {
  resumeSpecAutomationForParentIssue,
  runSpecAutoAdvance,
  runSpecAutoComplete,
} from './run.js';

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
 * @typedef {import('../../runner/types.js').RunnerRunOptions} RunnerRunOptions
 */

/** @typedef {import('../../spec-automation/ticketCoordination.types.js').TicketAutomationResult} TicketAutomationResult */
/** @typedef {import('../../spec-automation/ticketCoordination.types.js').ParentReviewResult} ParentReviewResult */

describe('runSpecAutoAdvance', () => {
  it('01: prepares the Spec and starts currently unblocked open tickets only', async () => {
    const parent = createIssue({
      number: 12,
      labels: ['pullops:spec:auto-advance'],
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

    const result = await runSpecAutoAdvance(
      createContext({
        githubClient: github.client,
        gitClient: git.client,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.deepEqual(git.createdBranches, [
      {
        branchName: 'pullops/spec-12',
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
          headBranch: 'pullops/spec-12',
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
      readTicketResults(result).map(ticket => [ticket.issue.number, ticket.status]),
      [
        [34, 'started'],
        [35, 'blocked'],
        [36, 'closed'],
        [37, 'already-active'],
      ],
    );
  });

  it('02: ignores Part of body references that are not native Tickets', async () => {
    const parent = createIssue({
      number: 12,
      labels: ['pullops:spec:auto-advance'],
      subIssues: [],
    });
    const github = createFakeGitHub({
      issues: [
        parent,
        createIssue({ number: 34, body: 'Part of: #12' }),
        createIssue({ number: 35, body: 'Part of: #99' }),
      ],
      pullRequests: [
        createPullRequest({
          number: 200,
          headRefName: 'pullops/spec-12',
          baseRefName: 'main',
          body: parentPullRequestBody(12),
        }),
      ],
    });

    const result = await runSpecAutoAdvance(
      createContext({
        githubClient: github.client,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(readParentPullRequest(result)?.status, 'waiting-for-tickets');
    assert.deepEqual(github.issueLabelsAdded, []);
    assert.deepEqual(github.pullRequestLabelsAdded, []);
    assert.deepEqual(
      readTicketResults(result).map(ticket => ticket.issue.number),
      [],
    );
  });

  it('03: local dry-run drains the current unblocked ticket frontier without GitHub mutations', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-spec-local-dry-run-'));
    const parent = createIssue({
      number: 12,
      labels: ['pullops:spec:auto-advance'],
      subIssues: [issueReference(34), issueReference(35), issueReference(36), issueReference(37)],
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
    const fakeRunner = createFakeRunner(git);

    const result = await runSpecAutoAdvance(
      createContext({
        cwd,
        executionBackend: 'local',
        publicationMode: 'dry-run',
        githubClient: github.client,
        gitClient: git.client,
        runner: fakeRunner.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(result.publicationMode, 'dry-run');
    assert.match(String(result.summary), /2 ticket dry-run\(s\) completed/);
    assert.match(String(result.localRunRecord), /\.pullops\/runs\/.+spec-auto-advance-12$/);
    assert.equal(fakeRunner.calls.length, 6);
    assert.match(fakeRunner.calls[0].prompt, /Ticket 35/);
    assert.match(fakeRunner.calls[1].prompt, /Use the pullops-pr-review skill/);
    assert.match(fakeRunner.calls[2].prompt, /Use the pullops-pr-finalize skill/);
    assert.match(fakeRunner.calls[3].prompt, /Ticket 37/);
    assert.match(fakeRunner.calls[4].prompt, /Use the pullops-pr-review skill/);
    assert.match(fakeRunner.calls[5].prompt, /Use the pullops-pr-finalize skill/);
    assert.deepEqual(github.issueLabelsAdded, []);
    assert.deepEqual(github.createdPullRequests, []);
    assert.deepEqual(github.updatedPullRequestBodies, []);
    assert.deepEqual(github.pullRequestComments, []);
    assert.deepEqual(
      readTicketResults(result).map(ticket => [ticket.issue.number, ticket.status]),
      [
        [34, 'blocked'],
        [35, 'dry-run-completed'],
        [36, 'blocked'],
        [37, 'dry-run-completed'],
      ],
    );
    assert.deepEqual(
      git.checkouts.map(checkout => checkout.branchName),
      ['pullops/spec-12', 'pullops/spec-12-issue-35', 'pullops/spec-12-issue-37'],
    );
    assert.deepEqual(result.localNextSteps, [
      'Inspect local run evidence for tickets #35, #37.',
      'Publish with `pullops run spec:auto-advance <parent-issue-number> --publish pr` after reviewing the local branch.',
    ]);
  });

  it('04: local PR publication finalizes unblocked ticket PRs and restores the umbrella branch', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-spec-local-publish-'));
    const parent = createIssue({
      number: 12,
      labels: ['pullops:spec:auto-advance'],
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
    const fakeRunner = createFakeRunner(git);

    const result = await runSpecAutoAdvance(
      createContext({
        cwd,
        executionBackend: 'local',
        publicationMode: 'publish',
        githubClient: github.client,
        gitClient: git.client,
        runner: fakeRunner.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(result.publicationMode, 'publish');
    assert.equal(fakeRunner.calls.length, 6);
    assert.match(fakeRunner.calls[0].prompt, /Use the pullops-issue-implement skill/);
    assert.match(fakeRunner.calls[1].prompt, /Use the pullops-pr-review skill/);
    assert.match(fakeRunner.calls[2].prompt, /Use the pullops-pr-finalize skill/);
    assert.match(fakeRunner.calls[3].prompt, /Use the pullops-issue-implement skill/);
    assert.match(fakeRunner.calls[4].prompt, /Use the pullops-pr-review skill/);
    assert.match(fakeRunner.calls[5].prompt, /Use the pullops-pr-finalize skill/);
    assert.deepEqual(github.issueLabelsAdded, []);
    assert.deepEqual(github.pullRequestLabelsAdded, []);
    assert.deepEqual(
      readTicketResults(result).map(ticket => [ticket.issue.number, ticket.status]),
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
          headBranch: 'pullops/spec-12',
        },
        {
          baseBranch: 'pullops/spec-12',
          headBranch: 'pullops/spec-12-issue-34',
        },
        {
          baseBranch: 'pullops/spec-12',
          headBranch: 'pullops/spec-12-issue-35',
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
      ['pullops/spec-12', 'pullops/spec-12-issue-34', 'pullops/spec-12-issue-35'],
    );
    assert.equal(git.currentBranch, 'pullops/spec-12');
    assert.deepEqual(
      git.checkouts.map(checkout => checkout.branchName),
      [
        'pullops/spec-12',
        'pullops/spec-12-issue-34',
        'pullops/spec-12',
        'pullops/spec-12-issue-35',
        'pullops/spec-12',
        'pullops/spec-12',
      ],
    );
  });

  it('05: local Spec auto-advance preserves human review gates for existing ticket PRs', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-spec-local-human-gate-'));
    const parent = createIssue({
      number: 12,
      labels: ['pullops:spec:auto-advance'],
      subIssues: [issueReference(34)],
    });
    const github = createFakeGitHub({
      issues: [parent, createIssue({ number: 34, parent: issueReference(12) })],
      pullRequests: [
        createPullRequest({
          number: 200,
          headRefName: 'pullops/spec-12',
          baseRefName: 'main',
          body: parentPullRequestBody(12),
        }),
        createPullRequest({
          number: 101,
          headRefName: 'pullops/spec-12-issue-34',
          baseRefName: 'pullops/spec-12',
          body: finalizedTicketPullRequestBody(34),
          labels: [],
          isDraft: false,
        }),
      ],
    });
    const git = createFakeGit();
    const fakeRunner = createFakeRunner(git);

    const result = await runSpecAutoAdvance(
      createContext({
        cwd,
        executionBackend: 'local',
        publicationMode: 'publish',
        githubClient: github.client,
        gitClient: git.client,
        runner: fakeRunner.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(fakeRunner.calls.length, 0);
    assert.deepEqual(github.pullRequestLabelsAdded, []);
    assert.deepEqual(github.mergedPullRequests, []);
    assert.deepEqual(
      readTicketResults(result).map(ticket => [ticket.issue.number, ticket.status]),
      [[34, 'ready-for-human-merge']],
    );
    assert.equal(git.currentBranch, 'pullops/spec-12');
  });

  it('06: local dry-run reports umbrella review readiness without adding trigger labels', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-spec-local-umbrella-review-'));
    const parent = createIssue({
      number: 12,
      labels: ['pullops:spec:auto-advance'],
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
          headRefName: 'pullops/spec-12',
          baseRefName: 'main',
          body: parentPullRequestBody(12),
          isDraft: false,
        }),
      ],
    });
    const git = createFakeGit();
    const fakeRunner = createFakeRunner(git);

    const result = await runSpecAutoAdvance(
      createContext({
        cwd,
        executionBackend: 'local',
        publicationMode: 'dry-run',
        githubClient: github.client,
        gitClient: git.client,
        runner: fakeRunner.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(fakeRunner.calls.length, 0);
    assert.deepEqual(github.pullRequestLabelsAdded, []);
    assert.equal(readParentPullRequest(result)?.status, 'ready-for-review');
    assert.deepEqual(github.updatedPullRequestBodies, []);
    assert.deepEqual(result.localNextSteps, [
      'Umbrella PR is ready for human review after local dry-run; request review manually instead of adding trigger labels.',
    ]);
  });

  it('07: local dry-run records a follow-up when no native tickets are available', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-spec-local-no-tickets-'));
    const parent = createIssue({
      number: 12,
      labels: ['pullops:spec:auto-advance'],
      subIssues: [],
    });
    const github = createFakeGitHub({
      issues: [parent],
    });
    const git = createFakeGit();
    const fakeRunner = createFakeRunner(git);

    const result = await runSpecAutoAdvance(
      createContext({
        cwd,
        executionBackend: 'local',
        publicationMode: 'dry-run',
        githubClient: github.client,
        gitClient: git.client,
        runner: fakeRunner.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(fakeRunner.calls.length, 0);
    assert.deepEqual(github.pullRequestLabelsAdded, []);
    assert.equal(readParentPullRequest(result)?.status, 'waiting-for-tickets');
    assert.match(String(result.localRunRecord), /\.pullops\/runs\/.+spec-auto-advance-12$/);
    assert.deepEqual(result.localNextSteps, [
      'Add or reopen a native Ticket before rerunning local Spec auto-advance.',
    ]);
  });

  it('08: local Spec dry-run refuses a dirty worktree and still records a local run', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-spec-local-dirty-'));
    const github = createFakeGitHub({
      issues: [createIssue({ number: 12, labels: ['pullops:spec:auto-advance'] })],
    });
    const git = createFakeGit({ initialDirtyWorktree: true });

    await assert.rejects(
      runSpecAutoAdvance(
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
    assert.match(recordName, /spec-auto-advance-12$/);
    assert.match(
      await readFile(join(cwd, '.pullops', 'runs', recordName, 'failure-reason.txt'), 'utf8'),
      /clean worktree/,
    );
  });

  it('09: local Spec publish refuses a dirty worktree before preparing the umbrella branch', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-spec-local-publish-dirty-'));
    const github = createFakeGitHub({
      issues: [createIssue({ number: 12, labels: ['pullops:spec:auto-advance'] })],
    });
    const git = createFakeGit({ initialDirtyWorktree: true });

    await assert.rejects(
      runSpecAutoAdvance(
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

  it('10: local dry-run refuses ticket misuse without mutating GitHub state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-spec-local-ticket-misuse-'));
    const github = createFakeGitHub({
      issues: [
        createIssue({
          number: 34,
          labels: ['pullops:spec:auto-advance'],
          parent: issueReference(12),
        }),
      ],
    });
    const git = createFakeGit();

    const result = await runSpecAutoAdvance(
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
      }),
    );

    assert.equal(result.status, 'refused');
    assert.equal(result.mode, 'auto-advance');
    assert.equal(result.publicationMode, 'dry-run');
    assert.equal(result.refusalReason, 'wrong-target');
    assert.deepEqual(github.issueLabelsAdded, []);
    assert.deepEqual(github.createdPullRequests, []);
    assert.deepEqual(github.updatedPullRequestBodies, []);
    assert.deepEqual(github.pullRequestComments, []);
    assert.match(String(result.summary), /Spec automation can only run on a Parent Issue/);
    assert.equal(result.displayMessage, result.summary);
    assert.deepEqual(result.nextSteps, ['Run Spec auto-advance on Parent Issue #12 instead.']);
    assert.deepEqual(result.suggestedActions, [
      {
        kind: 'command',
        description: 'Run Spec auto-advance on Parent Issue #12 instead.',
        argv: ['pullops', 'run', 'spec:auto-advance', '12'],
        approvalRequired: false,
      },
    ]);
    assert.match(
      await readFile(join(String(result.localRunRecord), 'failure-reason.txt'), 'utf8'),
      /Spec automation can only run on a Parent Issue/,
    );
  });

  it('11: local PR publication continues after a no-op ticket implementation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-spec-local-publish-noop-ticket-'));
    const parent = createIssue({
      number: 12,
      labels: ['pullops:spec:auto-advance'],
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
    const fakeRunner = createFakeRunner(git);

    const result = await runSpecAutoAdvance(
      createContext({
        cwd,
        executionBackend: 'local',
        publicationMode: 'publish',
        githubClient: github.client,
        gitClient: git.client,
        runner: fakeRunner.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(fakeRunner.calls.length, 6);
    assert.deepEqual(
      fakeRunner.calls.map(call => call.prompt.match(/Use the ([^ ]+) skill/)?.[1]),
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
      readTicketResults(result).map(ticket => [ticket.issue.number, ticket.status]),
      [
        [34, 'published'],
        [35, 'published'],
      ],
    );
    assert.deepEqual(
      git.emptyCommits.map(commit => commit.message.split('\n')[0]),
      ['chore(spec): prepare #12', 'feat(issue): implement #34'],
    );
    assert.deepEqual(
      github.createdPullRequests.map(pullRequest => pullRequest.headBranch),
      ['pullops/spec-12', 'pullops/spec-12-issue-34', 'pullops/spec-12-issue-35'],
    );
    assert.equal(git.currentBranch, 'pullops/spec-12');
  });
});

describe('resumeSpecAutomationForParentIssue', () => {
  it('01: starts newly unblocked tickets after a blocking issue closes', async () => {
    const parent = createIssue({
      number: 12,
      labels: ['pullops:spec:auto-advance'],
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
          headRefName: 'pullops/spec-12',
          baseRefName: 'main',
          body: parentPullRequestBody(12),
        }),
      ],
    });

    const result = await resumeSpecAutomationForParentIssue(
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

describe('runSpecAutoComplete', () => {
  it('01: rebase-merges finalized ticket PRs and leaves ticket closure to pr-close-ticket', async () => {
    const parent = createIssue({
      number: 12,
      labels: ['pullops:spec:auto-complete'],
      subIssues: [issueReference(34)],
    });
    const github = createFakeGitHub({
      issues: [parent, createIssue({ number: 34, parent: issueReference(12) })],
      pullRequests: [
        createPullRequest({
          number: 200,
          headRefName: 'pullops/spec-12',
          baseRefName: 'main',
          body: parentPullRequestBody(12),
        }),
        createPullRequest({
          number: 101,
          headRefName: 'pullops/spec-12-issue-34',
          baseRefName: 'pullops/spec-12',
          body: finalizedTicketPullRequestBody(34),
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

    const result = await runSpecAutoComplete(
      createContext({
        operation: 'spec-auto-complete',
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
      readTicketResults(result).map(ticket => [ticket.issue.number, ticket.status]),
      [[34, 'merged']],
    );
  });

  it('02: does not start duplicate work for active ticket PRs', async () => {
    const parent = createIssue({
      number: 12,
      labels: ['pullops:spec:auto-complete'],
      subIssues: [issueReference(34)],
    });
    const github = createFakeGitHub({
      issues: [parent, createIssue({ number: 34, parent: issueReference(12) })],
      pullRequests: [
        createPullRequest({
          number: 200,
          headRefName: 'pullops/spec-12',
          baseRefName: 'main',
          body: parentPullRequestBody(12),
        }),
        createPullRequest({
          number: 101,
          headRefName: 'pullops/spec-12-issue-34',
          baseRefName: 'pullops/spec-12',
          body: ticketPullRequestBody(34),
          labels: ['pullops:pr:review'],
        }),
      ],
    });

    const result = await runSpecAutoComplete(
      createContext({
        operation: 'spec-auto-complete',
        githubClient: github.client,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.deepEqual(github.issueLabelsAdded, []);
    assert.deepEqual(github.pullRequestLabelsAdded, []);
    assert.deepEqual(github.mergedPullRequests, []);
    assert.deepEqual(
      readTicketResults(result).map(ticket => ticket.status),
      ['already-active'],
    );
  });

  it('03: local publish closes finalized tickets and PRs after integrating them into the umbrella branch', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-spec-local-auto-complete-publish-'));
    const parent = createIssue({
      number: 12,
      labels: ['pullops:spec:auto-complete'],
      subIssues: [issueReference(34)],
    });
    const github = createFakeGitHub({
      issues: [parent, createIssue({ number: 34, parent: issueReference(12) })],
      pullRequests: [
        createPullRequest({
          number: 200,
          headRefName: 'pullops/spec-12',
          baseRefName: 'main',
          body: parentPullRequestBody(12),
        }),
        createPullRequest({
          number: 101,
          headRefName: 'pullops/spec-12-issue-34',
          baseRefName: 'pullops/spec-12',
          body: finalizedTicketPullRequestBody(34),
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
        [
          'sha-200',
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
    const git = createFakeGit({
      commitsSinceBase: [
        ticketCommit({
          ticketNumber: 34,
          parentIssueNumber: 12,
          file: 'src/ticket-34.js',
        }),
      ],
      changedFilesSinceBase: ['src/ticket-34.js'],
    });
    const fakeRunner = createFakeRunner(git);

    const result = await runSpecAutoComplete(
      createContext({
        cwd,
        operation: 'spec-auto-complete',
        executionBackend: 'local',
        publicationMode: 'publish',
        githubClient: github.client,
        gitClient: git.client,
        runner: fakeRunner.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(result.mode, 'auto-complete');
    assert.equal(result.publicationMode, 'publish');
    assert.equal(fakeRunner.calls.length, 1);
    assert.match(fakeRunner.calls[0].prompt, /Goal: review PullOps-managed PR #200/);
    assert.deepEqual(github.mergedPullRequests, []);
    assert.deepEqual(github.closedIssues, [34]);
    assert.deepEqual(github.closedPullRequests, [101]);
    assert.deepEqual(github.pullRequestLabelsAdded, []);
    assert.deepEqual(
      github.pullRequestLabelsRemoved.map(edit => edit.number),
      [200, 200],
    );
    assert.deepEqual(github.readyPullRequests, [200]);
    assert.deepEqual(git.cherryPicks, [
      {
        branchName: 'pullops/spec-12',
        baseBranch: 'main',
        commitSha: 'head-finalized',
      },
    ]);
    assert.deepEqual(
      git.pushes.map(push => push.branchName),
      ['pullops/spec-12', 'pullops/spec-12'],
    );
    assert.deepEqual(
      git.rewrites.map(rewrite => rewrite.branchName),
      ['pullops/spec-12'],
    );
    assert.equal(git.currentBranch, 'pullops/spec-12');
    assert.deepEqual(
      readTicketResults(result).map(ticket => [
        ticket.issue.number,
        ticket.status,
        ticket.mergeMethod,
      ]),
      [[34, 'merged', 'local-cherry-pick']],
    );
    assert.equal(readParentPullRequest(result)?.status, 'finalized');
    assert.deepEqual(result.localNextSteps, [
      'Review the Umbrella PR branch and merge the Umbrella PR manually when ready; PullOps did not merge it into the default branch.',
    ]);
  });

  it('04: local publish does not cherry-pick the same finalized ticket twice after closing it', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-spec-local-auto-complete-rerun-'));
    const parent = createIssue({
      number: 12,
      labels: ['pullops:spec:auto-complete'],
      subIssues: [issueReference(34)],
    });
    const github = createFakeGitHub({
      issues: [parent, createIssue({ number: 34, parent: issueReference(12) })],
      pullRequests: [
        createPullRequest({
          number: 200,
          headRefName: 'pullops/spec-12',
          baseRefName: 'main',
          body: parentPullRequestBody(12),
        }),
        createPullRequest({
          number: 101,
          headRefName: 'pullops/spec-12-issue-34',
          baseRefName: 'pullops/spec-12',
          body: finalizedTicketPullRequestBody(34),
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
        [
          'sha-200',
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
    const git = createFakeGit({
      commitsSinceBase: [
        ticketCommit({
          ticketNumber: 34,
          parentIssueNumber: 12,
          file: 'src/ticket-34.js',
        }),
      ],
      changedFilesSinceBase: ['src/ticket-34.js'],
    });
    const fakeRunner = createFakeRunner(git);
    const context = createContext({
      cwd,
      operation: 'spec-auto-complete',
      executionBackend: 'local',
      publicationMode: 'publish',
      githubClient: github.client,
      gitClient: git.client,
      runner: fakeRunner.runner,
    });

    await runSpecAutoComplete(context);
    const rerun = await runSpecAutoComplete(context);

    assert.deepEqual(git.cherryPicks, [
      {
        branchName: 'pullops/spec-12',
        baseBranch: 'main',
        commitSha: 'head-finalized',
      },
    ]);
    assert.equal(fakeRunner.calls.length, 1);
    assert.deepEqual(
      git.rewrites.map(rewrite => rewrite.branchName),
      ['pullops/spec-12'],
    );
    assert.deepEqual(
      readTicketResults(rerun).map(ticket => [ticket.issue.number, ticket.status]),
      [[34, 'closed']],
    );
    assert.equal(readParentPullRequest(rerun)?.status, 'finalized');
    assert.deepEqual(rerun.localNextSteps, [
      'Review the Umbrella PR branch and merge the Umbrella PR manually when ready; PullOps did not merge it into the default branch.',
    ]);
  });

  it('05: local publish waits for parent checks without adding workflow trigger labels', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-spec-local-auto-complete-parent-checks-'));
    const parent = createIssue({
      number: 12,
      labels: ['pullops:spec:auto-complete'],
      subIssues: [
        {
          ...issueReference(34),
          state: 'CLOSED',
        },
      ],
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
          headRefName: 'pullops/spec-12',
          baseRefName: 'main',
          body: parentPullRequestBody(12),
        }),
      ],
      checksByRef: new Map([
        [
          'head-current',
          [
            {
              name: 'CI',
              state: 'queued',
              conclusion: undefined,
              bucket: 'pending',
            },
          ],
        ],
      ]),
    });
    const git = createFakeGit({
      commitsSinceBase: [
        ticketCommit({
          ticketNumber: 34,
          parentIssueNumber: 12,
          file: 'src/ticket-34.js',
        }),
      ],
      changedFilesSinceBase: ['src/ticket-34.js'],
    });
    const fakeRunner = createFakeRunner(git);

    const result = await runSpecAutoComplete(
      createContext({
        cwd,
        operation: 'spec-auto-complete',
        executionBackend: 'local',
        publicationMode: 'publish',
        githubClient: github.client,
        gitClient: git.client,
        runner: fakeRunner.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(fakeRunner.calls.length, 1);
    assert.match(fakeRunner.calls[0].prompt, /Goal: review PullOps-managed PR #200/);
    assert.equal(readParentPullRequest(result)?.status, 'waiting');
    assert.deepEqual(github.pullRequestLabelsAdded, []);
    assert.deepEqual(result.localNextSteps, [
      'Wait for Umbrella PR checks to finish, then rerun Spec auto-complete.',
    ]);
  });

  it('06: local publish resumes reviewed parent PRs at finalization without rerunning review', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-spec-local-auto-complete-parent-resume-'));
    const parent = createIssue({
      number: 12,
      labels: ['pullops:spec:auto-complete'],
      subIssues: [
        {
          ...issueReference(34),
          state: 'CLOSED',
        },
      ],
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
          headRefName: 'pullops/spec-12',
          baseRefName: 'main',
          body: reviewedParentPullRequestBody(12),
        }),
      ],
      checksByRef: new Map([
        [
          'head-current',
          [
            {
              name: 'CI',
              state: 'completed',
              conclusion: 'success',
              bucket: 'pass',
            },
          ],
        ],
      ]),
    });
    const git = createFakeGit({
      commitsSinceBase: [
        ticketCommit({
          ticketNumber: 34,
          parentIssueNumber: 12,
          file: 'src/ticket-34.js',
        }),
      ],
      changedFilesSinceBase: ['src/ticket-34.js'],
    });
    const fakeRunner = createFakeRunner(git);

    const result = await runSpecAutoComplete(
      createContext({
        cwd,
        operation: 'spec-auto-complete',
        executionBackend: 'local',
        publicationMode: 'publish',
        githubClient: github.client,
        gitClient: git.client,
        runner: fakeRunner.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(fakeRunner.calls.length, 0);
    assert.equal(readParentPullRequest(result)?.status, 'finalized');
    assert.deepEqual(github.pullRequestLabelsAdded, []);
    assert.deepEqual(github.readyPullRequests, [200]);
    assert.match(
      github.updatedPullRequestBodies.at(-1)?.body ?? '',
      /Status: Ready for human merge/,
    );
    assert.deepEqual(result.localNextSteps, [
      'Review the Umbrella PR branch and merge the Umbrella PR manually when ready; PullOps did not merge it into the default branch.',
    ]);
  });

  it('07: local auto-complete integrates finalized dry-run ticket branches locally', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-spec-local-auto-complete-advance-'));
    const parent = createIssue({
      number: 12,
      labels: ['pullops:spec:auto-complete'],
      subIssues: [issueReference(34)],
    });
    const github = createFakeGitHub({
      issues: [parent, createIssue({ number: 34, parent: issueReference(12) })],
    });
    const git = createFakeGit({ dirtyAfterRunner: true });
    const fakeRunner = createFakeRunner(git);

    const result = await runSpecAutoComplete(
      createContext({
        cwd,
        operation: 'spec-auto-complete',
        executionBackend: 'local',
        publicationMode: 'dry-run',
        githubClient: github.client,
        gitClient: git.client,
        runner: fakeRunner.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(result.mode, 'auto-complete');
    assert.equal(result.publicationMode, 'dry-run');
    assert.equal(fakeRunner.calls.length, 3);
    assert.match(fakeRunner.calls[0].prompt, /Ticket 34/);
    assert.match(fakeRunner.calls[1].prompt, /Use the pullops-pr-review skill/);
    assert.match(fakeRunner.calls[2].prompt, /Use the pullops-pr-finalize skill/);
    assert.deepEqual(github.issueLabelsAdded, []);
    assert.deepEqual(
      readTicketResults(result).map(ticket => [ticket.issue.number, ticket.status]),
      [[34, 'merged']],
    );
    assert.deepEqual(git.cherryPicks, [
      {
        branchName: 'pullops/spec-12',
        baseBranch: 'main',
        commitSha: 'head-current',
      },
    ]);
    assert.equal(git.currentBranch, 'pullops/spec-12');
    assert.deepEqual(result.localNextSteps, [
      'Inspect local run evidence for ticket #34.',
      'Inspect the local umbrella branch with finalized ticket commits applied.',
      'Publish with `pullops run spec:auto-complete <parent-issue-number> --publish pr` after reviewing the local branch.',
    ]);
  });

  it('08: local auto-complete leaves waiting ticket PRs unmerged on the umbrella branch', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-spec-local-auto-complete-waiting-'));
    const parent = createIssue({
      number: 12,
      labels: ['pullops:spec:auto-complete'],
      subIssues: [issueReference(34)],
    });
    const github = createFakeGitHub({
      issues: [parent, createIssue({ number: 34, parent: issueReference(12) })],
      pullRequests: [
        createPullRequest({
          number: 200,
          headRefName: 'pullops/spec-12',
          baseRefName: 'main',
          body: parentPullRequestBody(12),
        }),
        createPullRequest({
          number: 101,
          headRefName: 'pullops/spec-12-issue-34',
          baseRefName: 'pullops/spec-12',
          body: finalizedTicketPullRequestBody(34),
          labels: [],
          isDraft: true,
        }),
      ],
    });
    const git = createFakeGit();
    const fakeRunner = createFakeRunner(git);

    const result = await runSpecAutoComplete(
      createContext({
        cwd,
        operation: 'spec-auto-complete',
        executionBackend: 'local',
        publicationMode: 'publish',
        githubClient: github.client,
        gitClient: git.client,
        runner: fakeRunner.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.deepEqual(git.cherryPicks, []);
    assert.deepEqual(github.mergedPullRequests, []);
    assert.equal(git.currentBranch, 'pullops/spec-12');
    assert.deepEqual(
      readTicketResults(result).map(ticket => [ticket.issue.number, ticket.status]),
      [[34, 'waiting']],
    );
    assert.deepEqual(result.localNextSteps, [
      'Wait for ticket #34 to finish review or checks, then rerun Spec auto-complete.',
    ]);
  });

  it('09: local auto-complete reports conflicted finalized ticket merges and leaves the umbrella branch checked out', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-spec-local-auto-complete-conflict-'));
    const parent = createIssue({
      number: 12,
      labels: ['pullops:spec:auto-complete'],
      subIssues: [issueReference(34)],
    });
    const github = createFakeGitHub({
      issues: [parent, createIssue({ number: 34, parent: issueReference(12) })],
      pullRequests: [
        createPullRequest({
          number: 200,
          headRefName: 'pullops/spec-12',
          baseRefName: 'main',
          body: parentPullRequestBody(12),
        }),
        createPullRequest({
          number: 101,
          headRefName: 'pullops/spec-12-issue-34',
          baseRefName: 'pullops/spec-12',
          body: finalizedTicketPullRequestBody(34),
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
    const git = createFakeGit({ cherryPickConflicts: ['src/conflicted.js'] });
    const fakeRunner = createFakeRunner(git);

    const result = await runSpecAutoComplete(
      createContext({
        cwd,
        operation: 'spec-auto-complete',
        executionBackend: 'local',
        publicationMode: 'publish',
        githubClient: github.client,
        gitClient: git.client,
        runner: fakeRunner.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.deepEqual(github.mergedPullRequests, []);
    assert.deepEqual(
      readTicketResults(result).map(ticket => [
        ticket.issue.number,
        ticket.status,
        ticket.conflictedFiles,
      ]),
      [[34, 'blocked', ['src/conflicted.js']]],
    );
    assert.deepEqual(
      git.cherryPicks.map(cherryPick => cherryPick.branchName),
      ['pullops/spec-12'],
    );
    assert.deepEqual(git.checkouts, [
      {
        branchName: 'pullops/spec-12',
        baseBranch: 'main',
      },
    ]);
    assert.deepEqual(git.pushes, []);
    assert.equal(git.currentBranch, 'pullops/spec-12');
    assert.deepEqual(result.localNextSteps, [
      'Resolve the blocker for ticket #34, then rerun Spec auto-complete.',
    ]);
  });

  it('10: local dry-run auto-complete advances through virtual dependency frontiers', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-spec-local-auto-complete-frontiers-'));
    const parent = createIssue({
      number: 12,
      labels: ['pullops:spec:auto-complete'],
      subIssues: [issueReference(35), issueReference(34), issueReference(36), issueReference(37)],
    });
    const github = createFakeGitHub({
      issues: [
        parent,
        createIssue({ number: 35, body: 'Blocked by: #34', parent: issueReference(12) }),
        createIssue({ number: 34, parent: issueReference(12) }),
        createIssue({ number: 36, body: 'Blocked by: #35', parent: issueReference(12) }),
        createIssue({ number: 37, body: 'Blocked by: #99', parent: issueReference(12) }),
        createIssue({ number: 99 }),
      ],
    });
    const git = createFakeGit({ dirtyAfterRunner: true });
    const fakeRunner = createFakeRunner(git);

    const result = await runSpecAutoComplete(
      createContext({
        cwd,
        operation: 'spec-auto-complete',
        executionBackend: 'local',
        publicationMode: 'dry-run',
        githubClient: github.client,
        gitClient: git.client,
        runner: fakeRunner.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(result.publicationMode, 'dry-run');
    assert.equal(fakeRunner.calls.length, 9);
    assert.match(fakeRunner.calls[0].prompt, /Ticket 34/);
    assert.match(fakeRunner.calls[3].prompt, /Ticket 35/);
    assert.match(fakeRunner.calls[6].prompt, /Ticket 36/);
    assert.deepEqual(github.issueLabelsAdded, []);
    assert.deepEqual(github.pullRequestLabelsAdded, []);
    assert.deepEqual(github.createdPullRequests, []);
    assert.deepEqual(github.updatedPullRequestBodies, []);
    assert.deepEqual(github.pullRequestComments, []);
    assert.deepEqual(github.mergedPullRequests, []);
    assert.deepEqual(github.closedIssues, []);
    assert.deepEqual(git.pushes, []);
    assert.deepEqual(
      readTicketResults(result).map(ticket => [
        ticket.issue.number,
        ticket.status,
        ticket.dependencyDecision?.satisfiedByVirtualCompletions,
        ticket.dependencyDecision?.remainingBlockedBy,
      ]),
      [
        [34, 'merged', undefined, undefined],
        [35, 'merged', [34], []],
        [36, 'merged', [35], []],
        [37, 'blocked', [], [99]],
      ],
    );
    assert.deepEqual(
      git.cherryPicks.map(cherryPick => [cherryPick.branchName, cherryPick.commitSha]),
      [
        ['pullops/spec-12', 'head-current'],
        ['pullops/spec-12', 'head-current'],
        ['pullops/spec-12', 'head-current'],
      ],
    );
    assert.deepEqual(
      git.rebases.map(rebase => [rebase.branchName, rebase.baseBranch, rebase.preferLocalBase]),
      [
        ['pullops/spec-12-issue-34', 'pullops/spec-12', true],
        ['pullops/spec-12-issue-35', 'pullops/spec-12', true],
        ['pullops/spec-12-issue-36', 'pullops/spec-12', true],
      ],
    );
    assert.equal(
      git.events.indexOf('rebase:pullops/spec-12-issue-35:pullops/spec-12') >
        git.events.indexOf('cherry-pick:pullops/spec-12:head-current'),
      true,
    );
    assert.equal(git.currentBranch, 'pullops/spec-12');
    assert.deepEqual(result.virtualCompletedTickets, [34, 35, 36]);
    assert.deepEqual(result.remainingBlockedTickets, [37]);
    assert.deepEqual(result.localNextSteps, [
      'Inspect local run evidence for tickets #34, #35, #36.',
      'Inspect the local umbrella branch with finalized ticket commits applied.',
      'Resolve the blocker for ticket #37, then rerun Spec auto-complete.',
    ]);

    const runRecord = String(result.localRunRecord);
    const ticket35 = readTicketResults(result).find(ticket => ticket.issue.number === 35);
    assert.equal(typeof ticket35?.localRunRecord, 'string');
    assert.match(runRecord, /\.pullops\/runs\/.+spec-auto-complete-12$/);
    assert.deepEqual(
      JSON.parse(await readFile(join(runRecord, 'result.json'), 'utf8')).remainingBlockedTickets,
      [37],
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(String(ticket35?.localRunRecord), 'metadata.json'), 'utf8'))
        .virtualCompletedIssueNumbers,
      [34],
    );
  });

  it('11: local dry-run auto-complete does not virtually complete active ticket PRs', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-spec-local-auto-complete-active-pr-'));
    const parent = createIssue({
      number: 12,
      labels: ['pullops:spec:auto-complete'],
      subIssues: [issueReference(34), issueReference(35)],
    });
    const github = createFakeGitHub({
      issues: [
        parent,
        createIssue({ number: 34, parent: issueReference(12) }),
        createIssue({ number: 35, body: 'Blocked by: #34', parent: issueReference(12) }),
      ],
      pullRequests: [
        createPullRequest({
          number: 200,
          headRefName: 'pullops/spec-12',
          baseRefName: 'main',
          body: parentPullRequestBody(12),
        }),
        createPullRequest({
          number: 101,
          headRefName: 'pullops/spec-12-issue-34',
          baseRefName: 'pullops/spec-12',
          body: ticketPullRequestBody(34),
          labels: ['pullops:pr:review'],
        }),
      ],
    });
    const git = createFakeGit();
    const fakeRunner = createFakeRunner(git);

    const result = await runSpecAutoComplete(
      createContext({
        cwd,
        operation: 'spec-auto-complete',
        executionBackend: 'local',
        publicationMode: 'dry-run',
        githubClient: github.client,
        gitClient: git.client,
        runner: fakeRunner.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(fakeRunner.calls.length, 0);
    assert.deepEqual(github.issueLabelsAdded, []);
    assert.deepEqual(github.pullRequestLabelsAdded, []);
    assert.deepEqual(github.createdPullRequests, []);
    assert.deepEqual(github.updatedPullRequestBodies, []);
    assert.deepEqual(github.pullRequestComments, []);
    assert.deepEqual(github.mergedPullRequests, []);
    assert.deepEqual(
      readTicketResults(result).map(ticket => [
        ticket.issue.number,
        ticket.status,
        ticket.dependencyDecision?.remainingBlockedBy,
      ]),
      [
        [34, 'waiting', undefined],
        [35, 'blocked', [34]],
      ],
    );
    assert.deepEqual(result.virtualCompletedTickets, []);
    assert.deepEqual(result.remainingBlockedTickets, [35]);
    assert.deepEqual(result.localNextSteps, [
      'Wait for ticket #34 to finish review or checks, then rerun Spec auto-complete.',
    ]);
  });

  it('12: local publish auto-complete integrates newly published ticket PRs through dependency frontiers', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-spec-local-auto-complete-publish-frontier-'));
    const parent = createIssue({
      number: 12,
      labels: ['pullops:spec:auto-complete'],
      subIssues: [issueReference(35), issueReference(34)],
    });
    const github = createFakeGitHub({
      issues: [
        parent,
        createIssue({ number: 35, body: 'Blocked by: #34', parent: issueReference(12) }),
        createIssue({ number: 34, parent: issueReference(12) }),
      ],
      checksByRef: new Map([
        [
          'sha-301',
          [
            {
              name: 'CI',
              state: 'success',
              conclusion: 'success',
              bucket: 'pass',
            },
          ],
        ],
        [
          'head-current',
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
    const git = createFakeGit({
      dirtyAfterRunner: true,
      commitsSinceBase: [
        ticketCommit({
          ticketNumber: 34,
          parentIssueNumber: 12,
          file: 'src/ticket-34.js',
        }),
        ticketCommit({
          ticketNumber: 35,
          parentIssueNumber: 12,
          file: 'src/ticket-35.js',
        }),
      ],
      changedFilesSinceBase: ['src/ticket-34.js', 'src/ticket-35.js'],
    });
    const fakeRunner = createFakeRunner(git);

    const result = await runSpecAutoComplete(
      createContext({
        cwd,
        operation: 'spec-auto-complete',
        executionBackend: 'local',
        publicationMode: 'publish',
        githubClient: github.client,
        gitClient: git.client,
        runner: fakeRunner.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(result.publicationMode, 'publish');
    assert.deepEqual(
      github.createdPullRequests.map(pullRequest => ({
        baseBranch: pullRequest.baseBranch,
        headBranch: pullRequest.headBranch,
      })),
      [
        {
          baseBranch: 'main',
          headBranch: 'pullops/spec-12',
        },
        {
          baseBranch: 'pullops/spec-12',
          headBranch: 'pullops/spec-12-issue-34',
        },
        {
          baseBranch: 'pullops/spec-12',
          headBranch: 'pullops/spec-12-issue-35',
        },
      ],
    );
    assert.deepEqual(github.closedIssues, [34, 35]);
    assert.deepEqual(github.closedPullRequests, [302, 303]);
    assert.deepEqual(
      readTicketResults(result).map(ticket => [
        ticket.issue.number,
        ticket.status,
        ticket.dependencyDecision?.satisfiedByClosedIssues,
      ]),
      [
        [34, 'merged', undefined],
        [35, 'merged', [34]],
      ],
    );
    assert.deepEqual(
      git.cherryPicks.map(cherryPick => cherryPick.branchName),
      ['pullops/spec-12', 'pullops/spec-12'],
    );
    assert.deepEqual(
      git.rewrites.map(rewrite => [rewrite.branchName, rewrite.commits.length]),
      [
        ['pullops/spec-12-issue-34', 1],
        ['pullops/spec-12-issue-35', 1],
        ['pullops/spec-12', 2],
      ],
    );
    assert.deepEqual(github.readyPullRequests, [302, 303, 301]);
    assert.equal(readParentPullRequest(result)?.status, 'finalized');
    assert.deepEqual(result.localNextSteps, [
      'Review the Umbrella PR branch and merge the Umbrella PR manually when ready; PullOps did not merge it into the default branch.',
    ]);
    assert.equal(
      github.createdPullRequests.some(
        pullRequest => pullRequest.headBranch === 'pullops/spec-12-issue-34',
      ),
      true,
    );
    assert.equal(
      github.createdPullRequests.some(
        pullRequest => pullRequest.headBranch === 'pullops/spec-12-issue-35',
      ),
      true,
    );
  });

  it('13: local publish auto-complete resumes an existing ticket PR through review and finalize', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-spec-local-auto-complete-existing-pr-'));
    const parent = createIssue({
      number: 12,
      labels: ['pullops:spec:auto-complete'],
      subIssues: [issueReference(34)],
    });
    const github = createFakeGitHub({
      issues: [parent, createIssue({ number: 34, parent: issueReference(12) })],
      pullRequests: [
        createPullRequest({
          number: 200,
          headRefName: 'pullops/spec-12',
          baseRefName: 'main',
          body: parentPullRequestBody(12),
        }),
        createPullRequest({
          number: 101,
          headRefName: 'pullops/spec-12-issue-34',
          baseRefName: 'pullops/spec-12',
          body: ticketPullRequestBody(34),
          isDraft: true,
        }),
      ],
      checksByRef: new Map([
        [
          'sha-101',
          [
            {
              name: 'CI',
              state: 'success',
              conclusion: 'success',
              bucket: 'pass',
            },
          ],
        ],
        [
          'head-current',
          [
            {
              name: 'CI',
              state: 'success',
              conclusion: 'success',
              bucket: 'pass',
            },
          ],
        ],
        [
          'sha-200',
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
    const git = createFakeGit({
      commitsSinceBase: [
        ticketCommit({
          ticketNumber: 34,
          parentIssueNumber: 12,
          file: 'src/ticket-34.js',
        }),
      ],
      changedFilesSinceBase: ['src/ticket-34.js'],
    });
    const fakeRunner = createFakeRunner(git);

    const result = await runSpecAutoComplete(
      createContext({
        cwd,
        operation: 'spec-auto-complete',
        executionBackend: 'local',
        publicationMode: 'publish',
        githubClient: github.client,
        gitClient: git.client,
        runner: fakeRunner.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(
      fakeRunner.calls.some(call => call.prompt.includes('Use the pullops-issue-implement skill.')),
      false,
    );
    assert.equal(fakeRunner.calls.length, 2);
    assert.match(fakeRunner.calls[0].prompt, /Use the pullops-pr-review skill/);
    assert.match(fakeRunner.calls[1].prompt, /Goal: review PullOps-managed PR #200/);
    assert.deepEqual(github.createdPullRequests, []);
    assert.deepEqual(github.closedIssues, [34]);
    assert.deepEqual(github.closedPullRequests, [101]);
    assert.deepEqual(github.mergedPullRequests, []);
    assert.deepEqual(github.readyPullRequests, [101, 200]);
    assert.equal(git.cherryPicks.length, 1);
    assert.deepEqual(
      readTicketResults(result).map(ticket => [ticket.issue.number, ticket.status]),
      [[34, 'merged']],
    );
    assert.equal(readParentPullRequest(result)?.status, 'finalized');
    const parentStatePath = join(String(result.localRunRecord), 'state.json');
    const parentState = JSON.parse(await readFile(parentStatePath, 'utf8'));
    const parentRunLink = {
      runId: parentState.runId,
      operationReference: parentState.operationReference,
      normalizedOperationReference: parentState.normalizedOperationReference,
      target: parentState.target,
      statePath: parentStatePath,
    };
    assert.equal(parentState.childRuns.length, 1);
    assert.equal(parentState.childRuns[0].status, 'merged');
    assert.equal(parentState.childRuns[0].operationReference, 'pr:finalize');
    assert.equal(parentState.childRuns[0].target.number, 34);
    assert.match(parentState.childRuns[0].statePath, /pr-finalize-101\/state\.json$/);
    const ticketState = JSON.parse(await readFile(parentState.childRuns[0].statePath, 'utf8'));
    assert.deepEqual(ticketState.parentRun, parentRunLink);
    for (const call of fakeRunner.calls) {
      assert(call.env);
      const nestedStatePath = call.env.PULLOPS_RUN_STATE_PATH;
      assert(nestedStatePath);
      assert.notEqual(nestedStatePath, parentStatePath);
      const nestedState = JSON.parse(await readFile(nestedStatePath, 'utf8'));
      assert.deepEqual(nestedState.parentRun, parentRunLink);
    }
  });

  it('14: local publish auto-complete integrates newly published ticket PRs when hosted checks are absent', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-spec-local-auto-complete-new-pr-checks-'));
    const parent = createIssue({
      number: 12,
      labels: ['pullops:spec:auto-complete'],
      subIssues: [issueReference(34)],
    });
    const github = createFakeGitHub({
      issues: [parent, createIssue({ number: 34, parent: issueReference(12) })],
    });
    const git = createFakeGit({
      dirtyAfterRunner: true,
      commitsSinceBase: [
        ticketCommit({
          ticketNumber: 34,
          parentIssueNumber: 12,
          file: 'src/ticket-34.js',
        }),
      ],
      changedFilesSinceBase: ['src/ticket-34.js'],
    });
    const fakeRunner = createFakeRunner(git);

    const result = await runSpecAutoComplete(
      createContext({
        cwd,
        operation: 'spec-auto-complete',
        executionBackend: 'local',
        publicationMode: 'publish',
        githubClient: github.client,
        gitClient: git.client,
        runner: fakeRunner.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(fakeRunner.calls.length, 4);
    assert.match(fakeRunner.calls[0].prompt, /Use the pullops-issue-implement skill/);
    assert.match(fakeRunner.calls[1].prompt, /Use the pullops-pr-review skill/);
    assert.match(fakeRunner.calls[2].prompt, /Use the pullops-pr-finalize skill/);
    assert.match(fakeRunner.calls[3].prompt, /Goal: review PullOps-managed PR #301/);
    assert.deepEqual(github.closedIssues, [34]);
    assert.deepEqual(github.closedPullRequests, [302]);
    assert.deepEqual(
      git.cherryPicks.map(cherryPick => cherryPick.branchName),
      ['pullops/spec-12'],
    );
    assert.deepEqual(
      github.createdPullRequests.map(pullRequest => ({
        baseBranch: pullRequest.baseBranch,
        headBranch: pullRequest.headBranch,
      })),
      [
        {
          baseBranch: 'main',
          headBranch: 'pullops/spec-12',
        },
        {
          baseBranch: 'pullops/spec-12',
          headBranch: 'pullops/spec-12-issue-34',
        },
      ],
    );
    assert.deepEqual(
      readTicketResults(result).map(ticket => [ticket.issue.number, ticket.status]),
      [[34, 'merged']],
    );
    assert.equal(readParentPullRequest(result)?.status, 'finalized');
    assert.deepEqual(result.localNextSteps, [
      'Review the Umbrella PR branch and merge the Umbrella PR manually when ready; PullOps did not merge it into the default branch.',
    ]);
  });

  it('15: local publish auto-complete reruns integrate existing finalized ticket PRs when hosted checks are absent', async () => {
    const cwd = await mkdtemp(
      join(tmpdir(), 'pullops-spec-local-auto-complete-existing-finalized-checks-'),
    );
    const parent = createIssue({
      number: 12,
      labels: ['pullops:spec:auto-complete'],
      subIssues: [issueReference(34)],
    });
    const github = createFakeGitHub({
      issues: [parent, createIssue({ number: 34, parent: issueReference(12) })],
      pullRequests: [
        createPullRequest({
          number: 200,
          headRefName: 'pullops/spec-12',
          baseRefName: 'main',
          body: parentPullRequestBody(12),
        }),
        createPullRequest({
          number: 101,
          headRefName: 'pullops/spec-12-issue-34',
          baseRefName: 'pullops/spec-12',
          body: finalizedTicketPullRequestBody(34),
          isDraft: false,
        }),
      ],
    });
    const git = createFakeGit({
      commitsSinceBase: [
        ticketCommit({
          ticketNumber: 34,
          parentIssueNumber: 12,
          file: 'src/ticket-34.js',
        }),
      ],
      changedFilesSinceBase: ['src/ticket-34.js'],
    });
    const fakeRunner = createFakeRunner(git);

    const result = await runSpecAutoComplete(
      createContext({
        cwd,
        operation: 'spec-auto-complete',
        executionBackend: 'local',
        publicationMode: 'publish',
        githubClient: github.client,
        gitClient: git.client,
        runner: fakeRunner.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(fakeRunner.calls.length, 1);
    assert.match(fakeRunner.calls[0].prompt, /Goal: review PullOps-managed PR #200/);
    assert.deepEqual(github.closedIssues, [34]);
    assert.deepEqual(github.closedPullRequests, [101]);
    assert.deepEqual(github.mergedPullRequests, []);
    assert.deepEqual(
      git.cherryPicks.map(cherryPick => cherryPick.branchName),
      ['pullops/spec-12'],
    );
    assert.deepEqual(
      readTicketResults(result).map(ticket => [ticket.issue.number, ticket.status]),
      [[34, 'merged']],
    );
    assert.equal(readParentPullRequest(result)?.status, 'finalized');
    assert.deepEqual(result.localNextSteps, [
      'Review the Umbrella PR branch and merge the Umbrella PR manually when ready; PullOps did not merge it into the default branch.',
    ]);
  });

  it('16: operation-only local auto-complete does not virtually unblock later tickets', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-spec-local-auto-complete-operation-only-'));
    const parent = createIssue({
      number: 12,
      labels: ['pullops:spec:auto-complete'],
      subIssues: [issueReference(34), issueReference(35)],
    });
    const github = createFakeGitHub({
      issues: [
        parent,
        createIssue({ number: 34, parent: issueReference(12) }),
        createIssue({ number: 35, body: 'Blocked by: #34', parent: issueReference(12) }),
      ],
    });
    const git = createFakeGit({ dirtyAfterRunner: true });
    const fakeRunner = createFakeRunner(git);

    const result = await runSpecAutoComplete(
      createContext({
        cwd,
        operation: 'spec-auto-complete',
        executionBackend: 'local',
        publicationMode: 'dry-run',
        runGoal: 'operation',
        githubClient: github.client,
        gitClient: git.client,
        runner: fakeRunner.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(fakeRunner.calls.length, 1);
    assert.match(fakeRunner.calls[0].prompt, /Ticket 34/);
    assert.deepEqual(
      readTicketResults(result).map(ticket => [
        ticket.issue.number,
        ticket.status,
        ticket.dependencyDecision?.remainingBlockedBy,
      ]),
      [
        [34, 'dry-run-completed', undefined],
        [35, 'blocked', [34]],
      ],
    );
    assert.deepEqual(result.virtualCompletedTickets, []);
    assert.deepEqual(result.remainingBlockedTickets, [35]);
  });

  it('17: finalized local auto-complete reports the ticket phase that blocked', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-spec-local-auto-complete-blocked-phase-'));
    const parent = createIssue({
      number: 12,
      labels: ['pullops:spec:auto-complete'],
      subIssues: [issueReference(34)],
    });
    const github = createFakeGitHub({
      issues: [parent, createIssue({ number: 34, parent: issueReference(12) })],
    });
    const git = createFakeGit({ dirtyAfterRunner: true });
    const fakeRunner = createFakeRunnerWithBlockedReview({ git });

    const result = await runSpecAutoComplete(
      createContext({
        cwd,
        operation: 'spec-auto-complete',
        executionBackend: 'local',
        publicationMode: 'dry-run',
        githubClient: github.client,
        gitClient: git.client,
        runner: fakeRunner.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(fakeRunner.calls.length, 2);
    assert.deepEqual(
      readTicketResults(result).map(ticket => [
        ticket.issue.number,
        ticket.status,
        ticket.blockedPhase,
        ticket.blockedOperation,
      ]),
      [[34, 'blocked', 'review', 'pr:review']],
    );
    assert.deepEqual(result.remainingBlockedTickets, [34]);
  });

  it('18: local dry-run auto-complete virtually completes already-integrated ticket branches', async () => {
    const cwd = await mkdtemp(
      join(tmpdir(), 'pullops-spec-local-auto-complete-integrated-ticket-'),
    );
    const parent = createIssue({
      number: 12,
      labels: ['pullops:spec:auto-complete'],
      subIssues: [issueReference(34), issueReference(35)],
    });
    const github = createFakeGitHub({
      issues: [
        parent,
        createIssue({ number: 34, parent: issueReference(12) }),
        createIssue({ number: 35, body: 'Blocked by: #34', parent: issueReference(12) }),
      ],
    });
    const git = createFakeGit({
      dirtyAfterRunner: true,
      branchesWithoutUnappliedCommits: ['pullops/spec-12-issue-34'],
    });
    const fakeRunner = createFakeRunner(git);

    const result = await runSpecAutoComplete(
      createContext({
        cwd,
        operation: 'spec-auto-complete',
        executionBackend: 'local',
        publicationMode: 'dry-run',
        githubClient: github.client,
        gitClient: git.client,
        runner: fakeRunner.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(fakeRunner.calls.length, 3);
    assert.match(fakeRunner.calls[0].prompt, /Ticket 35/);
    assert.deepEqual(
      readTicketResults(result).map(ticket => [
        ticket.issue.number,
        ticket.status,
        ticket.dependencyDecision?.satisfiedByVirtualCompletions,
        ticket.dependencyDecision?.remainingBlockedBy,
      ]),
      [
        [34, 'dry-run-completed', undefined, undefined],
        [35, 'merged', [34], []],
      ],
    );
    assert.deepEqual(git.cherryPicks, [
      {
        branchName: 'pullops/spec-12',
        baseBranch: 'main',
        commitSha: 'head-current',
      },
    ]);
    assert.equal(git.currentBranch, 'pullops/spec-12');
    assert.deepEqual(result.virtualCompletedTickets, [34, 35]);
    assert.deepEqual(result.remainingBlockedTickets, []);
    assert.deepEqual(git.branchApplicationChecks, [
      {
        branchName: 'pullops/spec-12-issue-34',
        baseBranch: 'pullops/spec-12',
        preferLocalBase: true,
      },
      {
        branchName: 'pullops/spec-12-issue-35',
        baseBranch: 'pullops/spec-12',
        preferLocalBase: true,
      },
    ]);
  });

  it('19: local auto-complete emits parent progress events while ticket coordination advances', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-spec-local-auto-complete-progress-'));
    const parent = createIssue({
      number: 12,
      labels: ['pullops:spec:auto-complete'],
      subIssues: [issueReference(34), issueReference(35)],
    });
    const github = createFakeGitHub({
      issues: [
        parent,
        createIssue({ number: 34, parent: issueReference(12) }),
        createIssue({ number: 35, body: 'Blocked by: #34', parent: issueReference(12) }),
      ],
    });
    const git = createFakeGit({
      dirtyAfterRunner: true,
      branchesWithoutUnappliedCommits: ['pullops/spec-12-issue-34'],
    });
    const fakeRunner = createFakeRunner(git);
    const progressWriter = createProgressEventWriterSpy();
    /** @type {string[]} */
    const progressMessages = [];

    await runSpecAutoComplete(
      createContext({
        cwd,
        operation: 'spec-auto-complete',
        executionBackend: 'local',
        publicationMode: 'dry-run',
        githubClient: github.client,
        gitClient: git.client,
        runner: fakeRunner.runner,
        localRunRecordDirectory: join(
          cwd,
          '.pullops',
          'runs',
          '2026-06-20T010203000Z-spec-auto-complete-12',
        ),
        progressEventWriter: progressWriter,
        parentEventSink: createFakeParentEventSink().sink,
        progress(message) {
          progressMessages.push(message);
        },
      }),
    );

    assert.deepEqual(progressWriter.boundRunRecords, [
      join(cwd, '.pullops', 'runs', '2026-06-20T010203000Z-spec-auto-complete-12'),
    ]);
    assert.deepEqual(
      progressWriter.events.map(event => event.event),
      [
        'run.started',
        'phase.started',
        'ticket.started',
        'ticket.completed',
        'ticket.started',
        'ticket.progress',
        'ticket.progress',
        'ticket.progress',
        'ticket.progress',
        'ticket.completed',
        'phase.completed',
      ],
    );
    assert.equal(
      progressWriter.events[0]?.message,
      'Starting local Spec auto-complete for issue #12.',
    );
    assert.equal(
      /** @type {{ ticket?: { number: number } }} */ (progressWriter.events[2] ?? {}).ticket
        ?.number,
      34,
    );
    assert.equal(progressWriter.events[3]?.status, 'dry-run-completed');
    const childRunRecord = /** @type {{ localRunRecord?: string }} */ (
      progressWriter.events[5] ?? {}
    ).localRunRecord;
    assert.match(String(childRunRecord), /\.pullops\/runs\/.+issue-implement-35$/);
    assert.deepEqual(
      progressWriter.events.slice(5, 9).map(event => event.progressMessage),
      [
        `Local Run Record: ${childRunRecord}`,
        'Checking local worktree.',
        'Starting the PullOps runner.',
        'PullOps runner finished.',
      ],
    );
    assert.equal(progressWriter.events[9]?.status, 'merged');
    assert.deepEqual(
      /** @type {{ ticketCounts?: Record<string, number> }} */ (progressWriter.events[10] ?? {})
        .ticketCounts,
      {
        total: 2,
        completed: 2,
        blocked: 0,
      },
    );
    assert.deepEqual(progressMessages, []);
    assert.equal(
      fakeRunner.calls.every(call => call.streamOutput === false),
      true,
    );
  });

  it('19b: local auto-complete emits child heartbeat events without nested stdout', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-spec-local-ticket-heartbeats-'));
    const parent = createIssue({
      number: 12,
      labels: ['pullops:spec:auto-complete'],
      subIssues: [issueReference(34)],
    });
    const github = createFakeGitHub({
      issues: [parent, createIssue({ number: 34, parent: issueReference(12) })],
    });
    const git = createFakeGit({ dirtyAfterRunner: true });
    const stdout = createWritableBuffer();
    const stderr = createWritableBuffer();
    /** @type {RunnerRunOptions[]} */
    const codexCalls = [];
    /** @type {NodeJS.ProcessEnv | undefined} */
    let ticketHeartbeatEnvironment;
    const fakeRunner = {
      calls: codexCalls,
      runner: {
        /**
         * @param {RunnerRunOptions} options
         */
        async run(options) {
          codexCalls.push(options);
          assert.equal(options.streamOutput, false);
          assert(options.env);
          ticketHeartbeatEnvironment = options.env;
          assert.match(
            String(options.env.PULLOPS_PARENT_EVENT_SINK_URL),
            /^http:\/\/127\.0\.0\.1:/,
          );
          assert.match(String(options.env.PULLOPS_PARENT_RUN_ID), /spec-auto-complete-12$/);
          assert.equal(options.env.PULLOPS_TICKET_NUMBER, '34');

          for (const summary of ['building ticket', 'testing ticket']) {
            const stdout = createWritableBuffer();
            /** @type {PullOpsCli} */
            const cli = new PullOpsCli({
              cwd,
              stdout,
              stderr: createWritableBuffer(),
              githubClient: github.client,
              gitClient: git.client,
              env: options.env,
            });
            assert.equal(await cli.run(['heartbeat', '--summary', summary]), 0);
            assert.equal(JSON.parse(stdout.text).runState.heartbeatSummary, summary);
          }

          git.markRunnerChangedWorktree();
          return {
            status: 'implemented',
            summary: 'Implemented ticket run.',
            changes: ['Changed ticket code.'],
            testPlan: ['Not run in fake test.'],
            followUps: [],
          };
        },
      },
    };

    const cli = new PullOpsCli({
      cwd,
      stdout,
      stderr,
      githubClient: github.client,
      gitClient: git.client,
      runner: fakeRunner.runner,
      env: {
        GITHUB_REPOSITORY: 'owner/repo',
      },
      operationRunner: runSpecAutoComplete,
    });

    const exitCode = await cli.run([
      'run',
      'spec:auto-complete',
      '12',
      '--events',
      'jsonl',
      '--until',
      'operation',
    ]);

    assert.equal(exitCode, 0);
    assert.equal(stderr.text, '');
    assert.equal(fakeRunner.calls.length, 1);
    assert(ticketHeartbeatEnvironment);
    const ticketHeartbeatEnv =
      /** @type {import('../../parent-event-sink/types.js').PullOpsParentEventSinkChildEnvironment} */ (
        ticketHeartbeatEnvironment
      );
    const events = stdout.text
      .trimEnd()
      .split('\n')
      .map(line => JSON.parse(line));
    assert.deepEqual(
      events.map(event => event.event).filter(event => event !== 'child.heartbeat'),
      [
        'run.started',
        'phase.started',
        'ticket.started',
        'ticket.progress',
        'ticket.progress',
        'ticket.progress',
        'ticket.progress',
        'ticket.completed',
        'phase.completed',
        'waiting',
        'run.summary',
      ],
    );
    const heartbeatEvents = events.filter(event => event.event === 'child.heartbeat');
    assert.deepEqual(
      heartbeatEvents.map(event => event.heartbeatCount),
      [1, 2],
    );
    assert.deepEqual(
      heartbeatEvents.map(event => event.heartbeatSummary),
      ['building ticket', 'testing ticket'],
    );
    for (const heartbeat of heartbeatEvents) {
      const ticket = /** @type {{ number?: number }} */ (heartbeat.ticket);
      assert.equal(ticket.number, 34);
      assert.match(String(heartbeat.childRunId), /issue-implement-34$/);
      assert.match(String(heartbeat.localRunRecord), /\.pullops\/runs\/.+issue-implement-34$/);
      assert.match(String(heartbeat.childRunStatePath), /issue-implement-34\/state\.json$/);
      assert.equal(heartbeat.completedNonHeartbeatStepsSinceHeartbeat, 0);
      assert.equal(typeof heartbeat.heartbeatAt, 'string');
      assert.equal(typeof heartbeat.leaseExpiresAt, 'string');
    }
    assert.equal(
      events.findIndex(event => event.event === 'child.heartbeat') <
        events.findIndex(event => event.event === 'ticket.completed'),
      true,
    );
    assert.equal(
      events.findIndex(event => event.event === 'child.heartbeat') <
        events.findIndex(event => event.event === 'run.summary'),
      true,
    );
    const summaryEvent = events.at(-1);
    assert.equal(summaryEvent?.event, 'run.summary');
    assert.equal(summaryEvent?.status, 'blocked');
    assert.equal(summaryEvent?.runId, ticketHeartbeatEnv.PULLOPS_PARENT_RUN_ID);
    const runRecord = String(summaryEvent?.localRunRecord);
    assert.match(runRecord, /\.pullops\/runs\/.+spec-auto-complete-12$/);
    assert.equal(await readFile(join(runRecord, 'events.jsonl'), 'utf8'), stdout.text);

    await assert.rejects(async () => {
      await fetch(String(ticketHeartbeatEnv.PULLOPS_PARENT_EVENT_SINK_URL), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${ticketHeartbeatEnv.PULLOPS_PARENT_EVENT_SINK_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: 'heartbeat',
          parentRunId: ticketHeartbeatEnv.PULLOPS_PARENT_RUN_ID,
          childRunId: ticketHeartbeatEnv.PULLOPS_CHILD_RUN_ID,
          ticketNumber: Number(ticketHeartbeatEnv.PULLOPS_TICKET_NUMBER),
          localRunRecord: ticketHeartbeatEnv.PULLOPS_CHILD_LOCAL_RUN_RECORD,
          childRunStatePath: ticketHeartbeatEnv.PULLOPS_CHILD_RUN_STATE_PATH,
          heartbeatAt: '2026-06-20T01:02:04.000Z',
          leaseExpiresAt: '2026-06-20T01:07:04.000Z',
          heartbeatCount: 3,
          heartbeatSummary: 'post-run heartbeat',
          completedNonHeartbeatStepsSinceHeartbeat: 0,
        }),
      });
    });
  });

  it('20: local publish auto-complete executes ticket external runner handoffs and continues', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-spec-local-external-handoff-'));
    const parent = createIssue({
      number: 12,
      labels: ['pullops:spec:auto-complete'],
      subIssues: [issueReference(34)],
    });
    const github = createFakeGitHub({
      issues: [parent, createIssue({ number: 34, parent: issueReference(12) })],
    });
    const git = createFakeGit({
      commitsSinceBase: [
        ticketCommit({
          ticketNumber: 34,
          parentIssueNumber: 12,
          file: 'src/file.js',
        }),
      ],
    });
    /** @type {import('../../runner/types.js').ExternalRunnerJob[]} */
    const workerJobs = [];
    /** @type {import('../../runner/types.js').ExternalRunnerCommand[]} */
    const runnerCommands = [];

    const result = await runSpecAutoComplete(
      createContext({
        cwd,
        operation: 'spec-auto-complete',
        executionBackend: 'local',
        publicationMode: 'publish',
        githubClient: github.client,
        gitClient: git.client,
        externalRunnerJobRunner: async runnerJob => {
          workerJobs.push(runnerJob);
          assert.equal(runnerJob.cwd, cwd);
          assert.match(runnerJob.promptFile, /runner_prompt\.md$/);
          assert.match(runnerJob.outputFile, /runner_output\.json$/);
          assert.match(runnerJob.resultFile, /runner_result\.json$/);
          assert.equal(typeof runnerJob.workerPrompt, 'string');
          assert.equal(typeof runnerJob.model, 'string');
          assert.equal(typeof runnerJob.branch, 'string');
          assert.deepEqual(Object.keys(runnerJob.completionCommands).sort(), [
            'cancelled',
            'failed',
            'skipped',
            'success',
          ]);
          await writeFile(
            runnerJob.outputFile,
            `${JSON.stringify({
              status: 'accepted',
              summary: `Worker completed ${workerJobs.length}.`,
            })}\n`,
          );
          return { status: 'success' };
        },
        externalRunnerCommandRunner: createFakeExternalRunnerCommandRunner({
          cwd,
          github,
          runnerCommands,
        }),
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(readParentPullRequest(result)?.status, 'finalized');
    assert.deepEqual(
      readTicketResults(result).map(ticket => [ticket.issue.number, ticket.status]),
      [[34, 'merged']],
    );
    assert.deepEqual(
      workerJobs.map(job => job.completeCommand.argv[job.completeCommand.argv.indexOf('run') + 1]),
      ['issue-implement', 'pr-review', 'pr-review'],
    );
    assert.equal(
      workerJobs.every(job => job.workerPrompt.includes('External runner artifact contract:')),
      true,
    );
    assert.deepEqual(
      runnerCommands
        .filter(command => command.argv.includes('runner-result'))
        .map(command => command.argv[command.argv.indexOf('--status') + 1]),
      ['success', 'success', 'success'],
    );
    assert.deepEqual(
      runnerCommands
        .filter(command => command.argv.includes('run'))
        .map(command => command.argv[command.argv.indexOf('run') + 1]),
      ['issue-implement', 'pr-review', 'pr-review'],
    );

    const parentState = JSON.parse(
      await readFile(join(String(result.localRunRecord), 'state.json'), 'utf8'),
    );
    assert.equal(parentState.childRuns.length >= 1, true);
    const childRun = parentState.childRuns.find(
      /** @param {Record<string, unknown>} run */
      run => run.operationReference === 'issue:implement',
    );
    assert(childRun);
    assert.equal(childRun.status, 'merged');
    assert.deepEqual(childRun.target, { type: 'issue', number: 34 });
    const ticketState = JSON.parse(await readFile(String(childRun.statePath), 'utf8'));
    assert.equal(ticketState.status, 'accepted');
    assert.equal(ticketState.parentRun.runId, parentState.runId);
    assert.equal(ticketState.runnerJob.cwd, cwd);
    assert.match(ticketState.runnerJob.outputFile, /runner_output\.json$/);
    assert.deepEqual(github.closedIssues, [34]);
    assert.deepEqual(github.closedPullRequests, [302]);
    assert.deepEqual(
      git.cherryPicks.map(pick => pick.commitSha),
      ['head-current'],
    );
  });

  it('21: local publish auto-complete surfaces manager-owned ticket external runner handoffs', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-spec-local-external-waiting-'));
    const parent = createIssue({
      number: 12,
      labels: ['pullops:spec:auto-complete'],
      subIssues: [issueReference(34)],
    });
    const github = createFakeGitHub({
      issues: [parent, createIssue({ number: 34, parent: issueReference(12) })],
    });
    const git = createFakeGit({
      commitsSinceBase: [
        ticketCommit({
          ticketNumber: 34,
          parentIssueNumber: 12,
          file: 'src/file.js',
        }),
      ],
    });

    const result = await runSpecAutoComplete(
      createContext({
        cwd,
        operation: 'spec-auto-complete',
        runnerAdapter: 'external',
        executionBackend: 'local',
        publicationMode: 'publish',
        githubClient: github.client,
        gitClient: git.client,
      }),
    );

    assert.equal(result.status, 'waiting');
    const runnerJob = /** @type {import('../../runner/types.js').ExternalRunnerJob} */ (
      result.runnerJob
    );
    assert.equal(runnerJob.cwd, cwd);
    assert.match(runnerJob.outputFile, /runner_output\.json$/);
    assert.equal(
      runnerJob.completeCommand.argv[runnerJob.completeCommand.argv.indexOf('run') + 1],
      'issue-implement',
    );
    assert.deepEqual(
      readTicketResults(result).map(ticket => [
        ticket.issue.number,
        ticket.status,
        ticket.runnerJob,
      ]),
      [[34, 'waiting', externalRunnerJobReference(runnerJob)]],
    );

    const parentState = JSON.parse(
      await readFile(join(String(result.localRunRecord), 'state.json'), 'utf8'),
    );
    assert.equal(parentState.status, 'waiting');
    assert.deepEqual(parentState.runnerJob, runnerJob);
    assert.equal(parentState.childRuns.length, 1);
    assert.equal(parentState.childRuns[0].status, 'waiting');

    const ticketState = JSON.parse(await readFile(parentState.childRuns[0].statePath, 'utf8'));
    assert.equal(ticketState.status, 'waiting');
    assert.deepEqual(ticketState.runnerJob, runnerJob);
  });

  it('21b: local publish auto-complete surfaces ticket PR external runner handoffs', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-spec-local-pr-external-waiting-'));
    const parent = createIssue({
      number: 12,
      labels: ['pullops:spec:auto-complete'],
      subIssues: [issueReference(34)],
    });
    const github = createFakeGitHub({
      issues: [parent, createIssue({ number: 34, parent: issueReference(12) })],
      pullRequests: [
        createPullRequest({
          number: 200,
          headRefName: 'pullops/spec-12',
          baseRefName: 'main',
          body: parentPullRequestBody(12),
        }),
        createPullRequest({
          number: 101,
          headRefName: 'pullops/spec-12-issue-34',
          baseRefName: 'pullops/spec-12',
          body: ticketPullRequestBody(34),
        }),
      ],
    });

    const result = await runSpecAutoComplete(
      createContext({
        cwd,
        operation: 'spec-auto-complete',
        runnerAdapter: 'external',
        executionBackend: 'local',
        publicationMode: 'publish',
        githubClient: github.client,
        gitClient: createFakeGit().client,
      }),
    );

    assert.equal(result.status, 'waiting');
    const runnerJob = /** @type {import('../../runner/types.js').ExternalRunnerJob} */ (
      result.runnerJob
    );
    assert.equal(
      runnerJob.completeCommand.argv[runnerJob.completeCommand.argv.indexOf('run') + 1],
      'pr-review',
    );
    assert.deepEqual(
      readTicketResults(result).map(ticket => [
        ticket.issue.number,
        ticket.status,
        ticket.blockedOperation,
        ticket.runnerJob,
      ]),
      [[34, 'waiting', 'pr:review', externalRunnerJobReference(runnerJob)]],
    );

    const parentState = JSON.parse(
      await readFile(join(String(result.localRunRecord), 'state.json'), 'utf8'),
    );
    assert.equal(parentState.status, 'waiting');
    assert.deepEqual(parentState.runnerJob, runnerJob);
    assert.equal(parentState.childRuns.length, 1);
    assert.equal(parentState.childRuns[0].operationReference, 'pr:review');
    assert.deepEqual(parentState.childRuns[0].target, { type: 'issue', number: 34 });
    assert.equal(parentState.childRuns[0].status, 'waiting');

    const ticketPrState = JSON.parse(await readFile(parentState.childRuns[0].statePath, 'utf8'));
    assert.deepEqual(ticketPrState.target, { type: 'pr', number: 101 });
    assert.equal(ticketPrState.status, 'waiting');
    assert.deepEqual(ticketPrState.runnerJob, runnerJob);
  });

  it('22: local dry-run auto-complete records child run links in parent run state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-spec-local-ticket-run-state-'));
    const parent = createIssue({
      number: 12,
      labels: ['pullops:spec:auto-complete'],
      subIssues: [issueReference(34)],
    });
    const github = createFakeGitHub({
      issues: [parent, createIssue({ number: 34, parent: issueReference(12) })],
    });
    const git = createFakeGit({ dirtyAfterRunner: true });
    let inspectedDuringRun = false;
    /** @type {unknown[]} */
    const codexCalls = [];
    const fakeRunner = {
      calls: codexCalls,
      runner: {
        async run(/** @type {unknown} */ options) {
          codexCalls.push(options);
          if (!inspectedDuringRun) {
            inspectedDuringRun = true;
            const runDirectories = await readdir(join(cwd, '.pullops', 'runs'));
            const parentRunDirectory = runDirectories.find(name =>
              name.endsWith('spec-auto-complete-12'),
            );
            const childRunDirectory = runDirectories.find(name =>
              name.endsWith('issue-implement-34'),
            );
            assert(parentRunDirectory);
            assert(childRunDirectory);

            const parentStatePath = join(cwd, '.pullops', 'runs', parentRunDirectory, 'state.json');
            const ticketStatePath = join(cwd, '.pullops', 'runs', childRunDirectory, 'state.json');
            const expectedParentRunLink = {
              runId: parentRunDirectory,
              operationReference: 'spec:auto-complete',
              normalizedOperationReference: 'spec-auto-complete',
              target: {
                type: 'issue',
                number: 12,
              },
              statePath: parentStatePath,
            };
            const parentState = JSON.parse(await readFile(parentStatePath, 'utf8'));
            const ticketState = JSON.parse(await readFile(ticketStatePath, 'utf8'));

            assert.equal(parentState.childRuns.length, 1);
            assert.equal(parentState.childRuns[0].runId, childRunDirectory);
            assert.equal(parentState.childRuns[0].operationReference, 'issue:implement');
            assert.equal(parentState.childRuns[0].status, 'running');
            assert.equal(parentState.childRuns[0].statePath, ticketStatePath);
            assert.deepEqual(ticketState.parentRun, expectedParentRunLink);
          }

          git.markRunnerChangedWorktree();
          return {
            status: 'implemented',
            summary: 'Implemented ticket run.',
            changes: ['Changed ticket code.'],
            testPlan: ['npm test'],
            followUps: [],
          };
        },
      },
    };

    const result = await runSpecAutoComplete(
      createContext({
        cwd,
        operation: 'spec-auto-complete',
        executionBackend: 'local',
        publicationMode: 'dry-run',
        runGoal: 'operation',
        githubClient: github.client,
        gitClient: git.client,
        runner: fakeRunner.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(fakeRunner.calls.length, 1);
    const parentStatePath = join(String(result.localRunRecord), 'state.json');
    const parentState = JSON.parse(await readFile(parentStatePath, 'utf8'));
    const expectedParentRunLink = {
      runId: parentState.runId,
      operationReference: parentState.operationReference,
      normalizedOperationReference: parentState.normalizedOperationReference,
      target: parentState.target,
      statePath: parentStatePath,
    };
    assert.equal(parentState.childRuns.length, 1);
    assert.equal(parentState.childRuns[0].status, 'dry-run-completed');
    assert.equal(parentState.childRuns[0].operationReference, 'issue:implement');
    assert.equal(parentState.childRuns[0].target.number, 34);
    assert.match(parentState.childRuns[0].statePath, /issue-implement-34\/state\.json$/);
    const ticketState = JSON.parse(await readFile(parentState.childRuns[0].statePath, 'utf8'));
    assert.deepEqual(ticketState.parentRun, expectedParentRunLink);
    assert.equal(ticketState.status, 'accepted');
  });

  it('22: local dry-run auto-complete records blocked ticket classifications in parent run state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-spec-local-ticket-run-blocked-'));
    const parent = createIssue({
      number: 12,
      labels: ['pullops:spec:auto-complete'],
      subIssues: [issueReference(35)],
    });
    const github = createFakeGitHub({
      issues: [
        parent,
        createIssue({ number: 35, body: 'Blocked by: #99', parent: issueReference(12) }),
        createIssue({ number: 99 }),
      ],
    });

    const result = await runSpecAutoComplete(
      createContext({
        cwd,
        operation: 'spec-auto-complete',
        executionBackend: 'local',
        publicationMode: 'dry-run',
        githubClient: github.client,
        gitClient: createFakeGit().client,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.deepEqual(
      readTicketResults(result).map(ticket => [
        ticket.issue.number,
        ticket.status,
        ticket.blockedBy,
      ]),
      [[35, 'blocked', [99]]],
    );
    const parentState = JSON.parse(
      await readFile(join(String(result.localRunRecord), 'state.json'), 'utf8'),
    );
    assert.equal(parentState.childRuns.length, 1);
    assert.equal(parentState.childRuns[0].status, 'blocked');
    assert.equal(parentState.childRuns[0].operationReference, 'issue:implement');
    assert.equal(parentState.childRuns[0].target.number, 35);
    assert.match(parentState.childRuns[0].statePath, /issue-implement-35\/state\.json$/);
    const ticketState = JSON.parse(await readFile(parentState.childRuns[0].statePath, 'utf8'));
    assert.equal(ticketState.status, 'blocked');
    assert.deepEqual(ticketState.parentRun, {
      runId: parentState.runId,
      operationReference: parentState.operationReference,
      normalizedOperationReference: parentState.normalizedOperationReference,
      target: parentState.target,
      statePath: join(String(result.localRunRecord), 'state.json'),
    });
  });
});

/**
 * @param {Partial<OperationRunnerContext>} overrides
 * @returns {OperationRunnerContext}
 */
function createContext(overrides = {}) {
  return {
    operation: 'spec-auto-advance',
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
    runner: {
      async run() {
        throw new Error('runner.run was not expected in this test.');
      },
    },
    ...overrides,
  };
}

/**
 * @returns {import('../../cli/types.js').OperationProgressEventWriter & {
 *   boundRunRecords: string[],
 *   events: Record<string, unknown>[],
 * }}
 */
function createProgressEventWriterSpy() {
  /** @type {string[]} */
  const boundRunRecords = [];
  /** @type {Record<string, unknown>[]} */
  const events = [];
  return {
    runId: '2026-06-20T010203000Z-spec-auto-complete-12',
    operationLabelReference: 'spec:auto-complete',
    target: {
      type: 'issue',
      number: 12,
    },
    boundRunRecords,
    events,
    async bindLocalRunRecord(localRunRecord) {
      boundRunRecords.push(localRunRecord);
    },
    async emit(event, details = {}) {
      const emitted = {
        event,
        ...details,
      };
      events.push(emitted);
      return emitted;
    },
  };
}

/**
 * @param {{ progressWriter?: ReturnType<typeof createProgressEventWriterSpy> }} [options]
 * @returns {{
 *   sink: import('../../parent-event-sink/types.js').PullOpsParentEventSink,
 *   fetch: typeof globalThis.fetch,
 * }}
 */
function createFakeParentEventSink({ progressWriter } = {}) {
  /** @type {Map<string, import('../../parent-event-sink/types.js').PullOpsParentEventSinkChildRoute>} */
  const routes = new Map();
  const endpoint = 'http://127.0.0.1:12345/events';
  const token = 'test-parent-event-sink-token';

  return {
    sink: {
      endpoint,
      token,
      createChildEnvironment(route) {
        routes.set(route.childRunLink.runId, route);
        return {
          PULLOPS_PARENT_EVENT_SINK_URL: endpoint,
          PULLOPS_PARENT_EVENT_SINK_TOKEN: token,
          PULLOPS_PARENT_RUN_ID: '2026-06-20T010203000Z-spec-auto-complete-12',
          PULLOPS_CHILD_RUN_ID: route.childRunLink.runId,
          PULLOPS_TICKET_NUMBER: String(route.ticketNumber),
          PULLOPS_CHILD_LOCAL_RUN_RECORD: route.localRunRecord,
          PULLOPS_CHILD_RUN_STATE_PATH: route.childRunLink.statePath,
        };
      },
      closeChildRoute(childRunId) {
        routes.delete(childRunId);
      },
      async close() {},
    },
    async fetch(url, options = {}) {
      assert.equal(url, endpoint);
      assert.equal(options.method, 'POST');
      assert.equal(
        /** @type {Record<string, string>} */ (options.headers).authorization,
        `Bearer ${token}`,
      );
      const payload = JSON.parse(String(options.body));
      const childRunId = String(payload.childRunId);
      const route = routes.get(childRunId);
      assert(route);
      await progressWriter?.emit('child.heartbeat', {
        phase: 'ticket-coordination',
        ticket: {
          number: route.ticketNumber,
        },
        childRunId,
        localRunRecord: payload.localRunRecord,
        childRunStatePath: payload.childRunStatePath,
        heartbeatAt: payload.heartbeatAt,
        leaseExpiresAt: payload.leaseExpiresAt,
        heartbeatCount: payload.heartbeatCount,
        heartbeatSummary: payload.heartbeatSummary,
        completedNonHeartbeatStepsSinceHeartbeat: payload.completedNonHeartbeatStepsSinceHeartbeat,
      });
      return /** @type {Response} */ ({ ok: true, status: 202 });
    },
  };
}

function createWritableBuffer() {
  return {
    text: '',
    /**
     * @param {string | Uint8Array} chunk
     */
    write(chunk) {
      this.text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    },
  };
}

/**
 * @param {object} options
 * @param {string} options.cwd
 * @param {ReturnType<typeof createFakeGitHub>} options.github
 * @param {import('../../runner/types.js').ExternalRunnerCommand[]} options.runnerCommands
 * @returns {import('../../runner/types.js').ExternalRunnerCommandRunner}
 */
function createFakeExternalRunnerCommandRunner({ cwd, github, runnerCommands }) {
  return async command => {
    runnerCommands.push(command);

    if (command.argv.includes('runner-result')) {
      const status = readCommandOption(command, '--status');
      const file = readCommandOption(command, '--file');
      await writeFile(
        file,
        `${JSON.stringify({
          schemaVersion: 1,
          status,
        })}\n`,
      );
      return {
        status: 'accepted',
        summary: `Wrote external runner result to ${file}.`,
      };
    }

    const operation = command.argv[command.argv.indexOf('run') + 1];
    if (operation === 'issue-implement') {
      const issueNumber = Number(readCommandOption(command, '--issue'));
      const pullRequest = await github.client.createDraftPullRequest({
        title: `Implement #${issueNumber}: Ticket ${issueNumber}`,
        body: ticketPullRequestBody(issueNumber),
        baseBranch: 'pullops/spec-12',
        headBranch: `pullops/spec-12-issue-${issueNumber}`,
      });
      return {
        status: 'accepted',
        summary: `Opened draft PullOps-managed PR #${pullRequest.number} for issue #${issueNumber}.`,
        issue: {
          number: issueNumber,
          url: `https://github.com/acme/widgets/issues/${issueNumber}`,
        },
        pullRequest: {
          number: pullRequest.number,
          url: pullRequest.url,
          branch: pullRequest.headRefName,
          draft: pullRequest.isDraft,
        },
      };
    }

    if (operation === 'pr-review') {
      const pullRequestNumber = Number(readCommandOption(command, '--pr'));
      const pullRequest = await github.client.getPullRequest(pullRequestNumber);
      const parentIssueNumber = readParentIssueNumberFromPullRequestBody(pullRequest.body);
      const ticketNumber = readTicketNumberFromPullRequestBody(pullRequest.body);
      await github.client.updatePullRequestBody({
        number: pullRequest.number,
        body:
          parentIssueNumber === undefined
            ? reviewedTicketPullRequestBody(ticketNumber ?? 34)
            : reviewedParentPullRequestBody(parentIssueNumber),
      });
      return {
        status: 'approved',
        summary: `Approved PR #${pullRequest.number}.`,
        reviewResult: 'approved',
        pullRequest: {
          number: pullRequest.number,
          url: pullRequest.url,
        },
      };
    }

    throw new Error(`Unexpected fake external runner command in ${cwd}: ${command.argv.join(' ')}`);
  };
}

/**
 * @param {import('../../runner/types.js').ExternalRunnerCommand} command
 * @param {string} option
 * @returns {string}
 */
function readCommandOption(command, option) {
  const index = command.argv.indexOf(option);
  assert.notEqual(index, -1);
  const value = command.argv[index + 1];
  assert(value);
  return value;
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
  title = number === 12 ? 'Spec: Parent workflow' : `Ticket ${number}`,
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
    title: number === 12 ? 'Spec: Parent workflow' : `Ticket ${number}`,
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
  headRefName = 'pullops/spec-12-issue-34',
  baseRefName = 'pullops/spec-12',
  body = ticketPullRequestBody(34),
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
function ticketPullRequestBody(issueNumber) {
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
function reviewedTicketPullRequestBody(issueNumber) {
  return [
    '## PullOps',
    '',
    'Managed: yes',
    'Status: Review approved',
    '',
    '<details>',
    '<summary>PullOps workflow state</summary>',
    '',
    `Source: Issue #${issueNumber}`,
    'Review cycles: 1 / 3',
    'Reviewed tree: tree-current',
    'Last operation: pullops:pr:review',
    '',
    '</details>',
  ].join('\n');
}

/**
 * @param {number} issueNumber
 * @returns {string}
 */
function finalizedTicketPullRequestBody(issueNumber) {
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
    'Last operation: pullops:spec:prepare',
    '',
    '</details>',
  ].join('\n');
}

/**
 * @param {number} issueNumber
 * @returns {string}
 */
function reviewedParentPullRequestBody(issueNumber) {
  return [
    '## PullOps',
    '',
    'Managed: yes',
    'Status: Review approved',
    '',
    '<details>',
    '<summary>PullOps workflow state</summary>',
    '',
    `Source: Parent Issue #${issueNumber}`,
    'Review cycles: 1 / 3',
    'Reviewed tree: tree-current',
    'Last operation: pullops:pr:review',
    '',
    '</details>',
  ].join('\n');
}

/**
 * @param {string} body
 * @returns {number | undefined}
 */
function readTicketNumberFromPullRequestBody(body) {
  const match = body.match(/Source: Issue #(\d+)/);
  return match === null ? undefined : Number(match[1]);
}

/**
 * @param {string} body
 * @returns {number | undefined}
 */
function readParentIssueNumberFromPullRequestBody(body) {
  const match = body.match(/Source: Parent Issue #(\d+)/);
  return match === null ? undefined : Number(match[1]);
}

/**
 * @param {object} options
 * @param {number} options.ticketNumber
 * @param {number} options.parentIssueNumber
 * @param {string} options.file
 * @returns {import('../../git/types.js').GitCommit}
 */
function ticketCommit({ ticketNumber, parentIssueNumber, file }) {
  return {
    sha: `ticket-${ticketNumber}`,
    subject: `feat(issue): implement #${ticketNumber}`,
    body: [
      `feat(issue): implement #${ticketNumber}`,
      '',
      `Finalize Ticket #${ticketNumber} for rebase merge into Spec #${parentIssueNumber}.`,
      '',
      `Refs: #${ticketNumber}`,
      `Spec: #${parentIssueNumber}`,
    ].join('\n'),
    files: [file],
  };
}

/**
 * @param {Record<string, unknown>} result
 * @returns {TicketAutomationResult[]}
 */
function readTicketResults(result) {
  return /** @type {TicketAutomationResult[]} */ (result.tickets);
}

/**
 * @param {import('../../runner/types.js').ExternalRunnerJob} runnerJob
 * @returns {import('../../runner/types.js').ExternalRunnerJobReference}
 */
function externalRunnerJobReference(runnerJob) {
  return {
    cwd: runnerJob.cwd,
    promptFile: runnerJob.promptFile,
    outputFile: runnerJob.outputFile,
    resultFile: runnerJob.resultFile,
    model: runnerJob.model,
    branch: runnerJob.branch,
  };
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
 * @param {GitHubPullRequest[]} [options.pullRequests]
 * @param {Map<string, GitHubCheckRun[]>} [options.checksByRef]
 * @returns {{
 *   client: import('../../github/types.js').GitHubClient;
 *   issueLabelsAdded: EditLabelsOptions[];
 *   pullRequestLabelsAdded: EditLabelsOptions[];
 *   pullRequestLabelsRemoved: EditLabelsOptions[];
 *   createdPullRequests: CreateDraftPullRequestOptions[];
 *   updatedPullRequestBodies: { number: number, body: string }[];
 *   pullRequestComments: { number: number, body: string }[];
 *   pullRequestReviews: import('../../github/types.js').PublishPullRequestReviewOptions[];
 *   mergedPullRequests: MergePullRequestOptions[];
 *   closedIssues: number[];
 *   closedPullRequests: number[];
 *   readyPullRequests: number[];
 * }}
 */
function createFakeGitHub({ issues, pullRequests = [], checksByRef = new Map() }) {
  const issuesByNumber = new Map(issues.map(issue => [issue.number, issue]));
  const pullRequestsByHead = new Map(
    pullRequests.map(pullRequest => [pullRequest.headRefName, pullRequest]),
  );
  const pullRequestsByNumber = new Map(
    pullRequests.map(pullRequest => [pullRequest.number, pullRequest]),
  );
  /** @type {EditLabelsOptions[]} */
  const issueLabelsAdded = [];
  /** @type {EditLabelsOptions[]} */
  const issueLabelsRemoved = [];
  /** @type {EditLabelsOptions[]} */
  const pullRequestLabelsAdded = [];
  /** @type {EditLabelsOptions[]} */
  const pullRequestLabelsRemoved = [];
  /** @type {CreateDraftPullRequestOptions[]} */
  const createdPullRequests = [];
  /** @type {{ number: number, body: string }[]} */
  const updatedPullRequestBodies = [];
  /** @type {{ number: number, body: string }[]} */
  const pullRequestComments = [];
  /** @type {import('../../github/types.js').PublishPullRequestReviewOptions[]} */
  const pullRequestReviews = [];
  /** @type {MergePullRequestOptions[]} */
  const mergedPullRequests = [];
  /** @type {number[]} */
  const closedIssues = [];
  /** @type {number[]} */
  const closedPullRequests = [];
  /** @type {number[]} */
  const readyPullRequests = [];

  return {
    issueLabelsAdded,
    pullRequestLabelsAdded,
    pullRequestLabelsRemoved,
    createdPullRequests,
    updatedPullRequestBodies,
    pullRequestComments,
    pullRequestReviews,
    mergedPullRequests,
    closedIssues,
    closedPullRequests,
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
      async getPullRequest(number) {
        const pullRequest = pullRequestsByNumber.get(number);
        if (pullRequest === undefined) {
          throw new Error(`Unexpected pull request lookup #${number}.`);
        }
        return pullRequest;
      },
      async getPullRequestChecks() {
        throw new Error('getPullRequestChecks was not expected in this test.');
      },
      async getPullRequestChecksForRef(ref) {
        return checksByRef.get(ref) ?? [];
      },
      async getPullRequestReviewContext() {
        return {
          comments: [],
          reviews: [],
          unresolvedThreads: [],
          files: [],
        };
      },
      async getPullRequestDiff() {
        return {
          patch: 'diff --git a/src/file.js b/src/file.js\n',
        };
      },
      async findOpenPullRequestByHead(headBranch) {
        const pullRequest = pullRequestsByHead.get(headBranch);
        return pullRequest?.state === 'CLOSED' ? undefined : pullRequest;
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
        pullRequestsByNumber.set(pullRequest.number, pullRequest);
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
        const pullRequest = pullRequestsByNumber.get(options.number);
        if (pullRequest !== undefined) {
          pullRequest.labels = [...new Set([...(pullRequest.labels ?? []), ...options.labels])];
        }
      },
      async removeLabelsFromPullRequest(options) {
        pullRequestLabelsRemoved.push(options);
        const pullRequest = pullRequestsByNumber.get(options.number);
        if (pullRequest !== undefined) {
          pullRequest.labels = (pullRequest.labels ?? []).filter(
            label => !options.labels.includes(label),
          );
        }
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
      async closePullRequest(options) {
        closedPullRequests.push(options.number);
        const pullRequest = pullRequestsByNumber.get(options.number);
        if (pullRequest !== undefined) {
          pullRequest.state = 'CLOSED';
        }
      },
      async commentOnPullRequest(options) {
        pullRequestComments.push(options);
      },
      async updatePullRequestBody(options) {
        updatedPullRequestBodies.push(options);
        const pullRequest = pullRequestsByNumber.get(options.number);
        if (pullRequest !== undefined) {
          pullRequest.body = options.body;
        }
      },
      async markPullRequestReadyForReview(number) {
        readyPullRequests.push(number);
        const pullRequest = pullRequestsByNumber.get(number);
        if (pullRequest !== undefined) {
          pullRequest.isDraft = false;
        }
      },
      async publishPullRequestReview(options) {
        pullRequestReviews.push(options);
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
 * @param {import('../../git/types.js').GitCommit[]} [options.commitsSinceBase]
 * @param {string[]} [options.changedFilesSinceBase]
 * @param {string[]} [options.branchesWithoutUnappliedCommits]
 * @returns {{
 *   client: import('../../git/types.js').GitClient;
 *   createdBranches: { branchName: string, baseBranch: string }[];
 *   checkouts: { branchName: string, baseBranch: string }[];
 *   branchApplicationChecks: import('../../git/types.js').HasUnappliedCommitsSinceBaseOptions[];
 *   cherryPicks: { branchName: string, baseBranch: string, commitSha: string }[];
 *   rebases: import('../../git/types.js').RebaseExistingBranchOntoBaseOptions[];
 *   events: string[];
 *   rewrites: import('../../git/types.js').RewriteBranchWithCommitPlanOptions[];
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
  commitsSinceBase = [],
  changedFilesSinceBase = ['src/file.js'],
  branchesWithoutUnappliedCommits = [],
} = {}) {
  /** @type {{ branchName: string, baseBranch: string }[]} */
  const createdBranches = [];
  /** @type {{ branchName: string, baseBranch: string }[]} */
  const checkouts = [];
  /** @type {import('../../git/types.js').HasUnappliedCommitsSinceBaseOptions[]} */
  const branchApplicationChecks = [];
  /** @type {{ branchName: string, baseBranch: string, commitSha: string }[]} */
  const cherryPicks = [];
  /** @type {import('../../git/types.js').RebaseExistingBranchOntoBaseOptions[]} */
  const rebases = [];
  /** @type {string[]} */
  const events = [];
  /** @type {import('../../git/types.js').RewriteBranchWithCommitPlanOptions[]} */
  const rewrites = [];
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
    branchApplicationChecks,
    cherryPicks,
    rebases,
    events,
    rewrites,
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
        events.push(`checkout:${options.branchName}`);
        currentBranch = options.branchName;
      },
      async getCurrentBranch() {
        return currentBranch;
      },
      async hasUnappliedCommitsSinceBase(options) {
        branchApplicationChecks.push(options);
        return !branchesWithoutUnappliedCommits.includes(options.branchName);
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
        events.push(`cherry-pick:${options.branchName}:${options.commitSha}`);
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
      async rebaseExistingBranchOntoBase(options) {
        rebases.push(options);
        events.push(`rebase:${options.branchName}:${options.baseBranch}`);
        currentBranch = options.branchName;
        return {
          status: 'rebased',
          headSha: 'head-current',
          treeHash: 'tree-current',
        };
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
        return isFakeParentBranch(currentBranch) ? changedFilesSinceBase : ['src/file.js'];
      },
      async rewriteBranchWithCommitPlan(options) {
        rewrites.push(options);
        if (options.push !== false) {
          pushes.push({ branchName: options.branchName });
        }
        return {
          headSha: 'head-current',
          treeHash: 'tree-current',
        };
      },
      async getCommitsSinceBase() {
        return isFakeParentBranch(currentBranch) ? commitsSinceBase : [];
      },
    },
  };
}

/**
 * @param {string} branchName
 * @returns {boolean}
 */
function isFakeParentBranch(branchName) {
  return /^pullops\/spec-\d+$/.test(branchName);
}

/**
 * @param {{ markRunnerChangedWorktree(): void }} [git]
 * @returns {{
 *   runner: import('../../runner/types.js').Runner;
 *   calls: RunnerRunOptions[];
 * }}
 */
function createFakeRunner(git) {
  /** @type {RunnerRunOptions[]} */
  const calls = [];

  return {
    calls,
    runner: {
      async run(options) {
        calls.push(options);
        if (options.prompt.includes('Use the pullops-pr-review skill.')) {
          return {
            status: 'approved',
            summary: `Approved ticket run ${calls.length}.`,
            comments: [],
            replies: [],
            directChanges: [],
            followUps: [],
          };
        }

        if (options.prompt.includes('Use the pullops-pr-finalize skill.')) {
          return {
            status: 'planned',
            summary: `Planned ticket finalization ${calls.length}.`,
            commitPlan: {
              commits: [
                {
                  header: 'feat(issue): implement ticket',
                  body: ['Finalize local ticket implementation.'],
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
          summary: `Implemented ticket run ${calls.length}.`,
          changes: [`Changed ticket run ${calls.length}.`],
          testPlan: ['Not run in fake test.'],
          followUps: [],
        };
      },
    },
  };
}

/**
 * @param {object} options
 * @param {{ markRunnerChangedWorktree(): void }} options.git
 * @returns {{
 *   runner: import('../../runner/types.js').Runner;
 *   calls: RunnerRunOptions[];
 * }}
 */
function createFakeRunnerWithBlockedReview({ git }) {
  /** @type {RunnerRunOptions[]} */
  const calls = [];

  return {
    calls,
    runner: {
      async run(options) {
        calls.push(options);
        if (options.prompt.includes('Use the pullops-pr-review skill.')) {
          return {
            status: 'blocked',
            summary: 'Review could not complete.',
            failureReason: 'Review phase blocked.',
            comments: [],
            replies: [],
            directChanges: [],
            followUps: [],
          };
        }

        git.markRunnerChangedWorktree();
        return {
          status: 'implemented',
          summary: `Implemented ticket run ${calls.length}.`,
          changes: [`Changed ticket run ${calls.length}.`],
          testPlan: ['Not run in fake test.'],
          followUps: [],
        };
      },
    },
  };
}
