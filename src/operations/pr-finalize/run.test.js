import assert from 'node:assert/strict';
import { execFile as nodeExecFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

import { DEFAULT_PULL_OPS_CONFIG } from '../../config/PullOpsConfig.js';
import { createGitClient } from '../../git/GitClient.js';
import {
  PULL_OPS_OPERATION_LABELS,
  PULL_OPS_STATUS_LABEL_NAMES,
} from '../../labels/pullOpsLabels.js';
import { createPrFinalizeCommitMessage, runPrFinalize } from './run.js';

const execFile = promisify(nodeExecFile);

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../../github/types.js').GitHubCheckRun} GitHubCheckRun
 * @typedef {import('../../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('../../github/types.js').GitHubIssueReference} GitHubIssueReference
 * @typedef {import('../../github/types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('../../github/types.js').GitHubPullRequestReviewContext} GitHubPullRequestReviewContext
 * @typedef {import('../../github/types.js').UpdatePullRequestBodyOptions} UpdatePullRequestBodyOptions
 * @typedef {import('../../github/types.js').EditLabelsOptions} EditLabelsOptions
 * @typedef {import('../../github/types.js').CommentOnPullRequestOptions} CommentOnPullRequestOptions
 * @typedef {import('../../runner/types.js').CodexRunOptions} CodexRunOptions
 */

describe('runPrFinalize', () => {
  it('01: rewrites a standalone Concrete Issue PR once and marks it ready when finalized-head checks are absent', async () => {
    const repository = await createTemporaryRepository();
    const reviewedTree = await readTreeHash(repository.workDir);
    const reviewedHead = await readHeadSha(repository.workDir);
    const codex = createFakeCodexRunner();
    const github = createFakeGitHub({
      pullRequest: createPullRequest({
        headSha: reviewedHead,
        body: createPullRequestBody({ reviewedTree }),
      }),
      reviewContext: createReviewContext({
        comments: [
          {
            body: 'A regular PR-level comment must not block PR finalize.',
            authorLogin: 'maintainer',
          },
        ],
      }),
      checksByRef: new Map([[reviewedHead, [createCheck({ name: 'test' })]]]),
    });

    const firstResult = await runPrFinalize(
      createContext({
        cwd: repository.workDir,
        githubClient: github.client,
        gitClient: createGitClientFor(repository.workDir),
        codexRunner: codex.runner,
      }),
    );

    assert.equal(firstResult.status, 'accepted');
    assert.equal(codex.calls.length, 0);
    const prFinalize = /** @type {{ commits: number, readyForReview: boolean }} */ (
      firstResult.prFinalize
    );
    assert.equal(prFinalize.commits, 1);
    assert.equal(prFinalize.readyForReview, true);
    assert.equal(await countCommitsSinceBase(repository.workDir), 1);
    assert.equal(await readTreeHash(repository.workDir), reviewedTree);
    assert.deepEqual(await readCommitMessages(repository.workDir), [
      [
        'feat(issue): implement #42',
        '',
        'Finalize standalone Concrete Issue #42 for rebase merge.',
        '',
        'Closes #42',
      ].join('\n'),
    ]);

    assert.equal(github.updatedBodies.length, 2);
    const finalizedBody = github.updatedBodies[0].body;
    const readyBody = github.updatedBodies[1].body;
    assert.equal(
      readMarker(readyBody, 'Finalized head:'),
      readMarker(finalizedBody, 'Finalized head:'),
    );
    assert.equal(readMarker(readyBody, 'Finalized tree:'), reviewedTree);
    assert.equal(readMarker(readyBody, 'Merge method:'), 'rebase');
    assert.match(readyBody, /Status: Ready for human rebase merge/);
    assert.match(readyBody, /Closes #42/);
    assert.deepEqual(github.readyPullRequests, [100]);
    assert.deepEqual(github.pullRequestLabelsRemoved, [
      {
        number: 100,
        labels: [PULL_OPS_OPERATION_LABELS.prFinalize, ...PULL_OPS_STATUS_LABEL_NAMES],
      },
    ]);
    assert.equal(github.comments.length, 0);
    assert.equal(github.pullRequestLabelsAdded.length, 0);
  });

  it('02: waits for pending finalized-head checks before marking a finalized PR ready', async () => {
    const repository = await createTemporaryRepository();
    const reviewedTree = await readTreeHash(repository.workDir);
    const finalizedHead = await readHeadSha(repository.workDir);
    const github = createFakeGitHub({
      pullRequest: createPullRequest({
        headSha: finalizedHead,
        body: createPullRequestBody({
          reviewedTree,
          finalizedTree: reviewedTree,
          finalizedHead,
          status: 'Finalized for rebase merge',
          lastOperation: PULL_OPS_OPERATION_LABELS.prFinalize,
        }),
      }),
      checksByRef: new Map([
        [
          finalizedHead,
          [createCheck({ state: 'in_progress', conclusion: undefined, bucket: undefined })],
        ],
      ]),
    });

    const pendingResult = await runPrFinalize(
      createContext({
        cwd: repository.workDir,
        githubClient: github.client,
        gitClient: createGitClientFor(repository.workDir),
      }),
    );

    assert.equal(pendingResult.status, 'accepted');
    assert.deepEqual(pendingResult.prFinalize, {
      waiting: true,
      stage: 'finalized-head',
      checkedRef: finalizedHead,
      checks: 1,
    });
    assert.equal(github.readyPullRequests.length, 0);
    assert.equal(github.pullRequestLabelsRemoved.length, 0);

    github.setChecksForRef(finalizedHead, [createCheck({ name: 'test' })]);

    const readyResult = await runPrFinalize(
      createContext({
        cwd: repository.workDir,
        githubClient: github.client,
        gitClient: createGitClientFor(repository.workDir),
      }),
    );

    assert.equal(readyResult.status, 'accepted');
    assert.deepEqual(github.readyPullRequests, [100]);
    assert.deepEqual(github.pullRequestLabelsRemoved, [
      {
        number: 100,
        labels: [PULL_OPS_OPERATION_LABELS.prFinalize, ...PULL_OPS_STATUS_LABEL_NAMES],
      },
    ]);
    assert.equal(github.pullRequestLabelsAdded.length, 0);
    assert.equal(github.comments.length, 0);
    assert.match(github.updatedBodies[0].body, /Status: Ready for human rebase merge/);
  });

  it('03: rewrites a Child Issue PR against its PRD branch with non-closing traceability', async () => {
    const repository = await createTemporaryChildRepository();
    const reviewedTree = await readTreeHash(repository.workDir);
    const reviewedHead = await readHeadSha(repository.workDir);
    const codex = createFakeCodexRunner();
    const childIssue = createIssue({
      parent: createIssueReference({ number: 7, title: 'PRD: Parent workflow' }),
      body: '## Parent\n\nPart of: #999\n\n## What to build\n\nDo child work.',
    });
    const github = createFakeGitHub({
      issue: childIssue,
      pullRequest: createPullRequest({
        headRefName: 'pullops/prd-7-issue-42',
        headSha: reviewedHead,
        baseRefName: 'pullops/prd-7',
        body: createPullRequestBody({
          reviewedTree,
          parentIssueNumber: 7,
        }),
      }),
      checksByRef: new Map([[reviewedHead, [createCheck({ name: 'test' })]]]),
    });

    const firstResult = await runPrFinalize(
      createContext({
        cwd: repository.workDir,
        githubClient: github.client,
        gitClient: createGitClientFor(repository.workDir),
        codexRunner: codex.runner,
      }),
    );

    assert.equal(firstResult.status, 'accepted');
    assert.equal(codex.calls.length, 0);
    assert.equal(await countCommitsSinceBase(repository.workDir, 'origin/pullops/prd-7'), 1);
    assert.equal(await readTreeHash(repository.workDir), reviewedTree);
    assert.deepEqual(await readCommitMessages(repository.workDir, 'origin/pullops/prd-7'), [
      [
        'feat(issue): implement #42',
        '',
        'Finalize Child Issue #42 for rebase merge into PRD #7.',
        '',
        'Refs: #42',
        'PRD: #7',
      ].join('\n'),
    ]);

    assert.equal(github.updatedBodies.length, 2);
    const finalizedBody = github.updatedBodies[0].body;
    const readyBody = github.updatedBodies[1].body;
    assert.equal(
      readMarker(readyBody, 'Finalized head:'),
      readMarker(finalizedBody, 'Finalized head:'),
    );
    assert.equal(readMarker(readyBody, 'Finalized tree:'), reviewedTree);
    assert.match(readyBody, /Refs #42/);
    assert.match(readyBody, /Part of #7/);
    assert.doesNotMatch(readyBody, /Closes #42/);
    assert.deepEqual(github.readyPullRequests, [100]);
    assert.deepEqual(github.pullRequestLabelsRemoved, [
      {
        number: 100,
        labels: [PULL_OPS_OPERATION_LABELS.prFinalize, ...PULL_OPS_STATUS_LABEL_NAMES],
      },
    ]);
    assert.equal(github.comments.length, 0);
    assert.match(readyBody, /Status: Ready for human rebase merge/);
  });

  it('04: blocks child PRs targeting default and non-child PRs targeting PRD branches', async () => {
    const childDefault = createFakeGitHub({
      issue: createIssue({
        parent: createIssueReference({ number: 7, title: 'PRD: Parent workflow' }),
      }),
      pullRequest: createPullRequest({
        headRefName: 'pullops/prd-7-issue-42',
        baseRefName: 'main',
        body: createPullRequestBody({
          parentIssueNumber: 7,
        }),
      }),
    });

    const childDefaultResult = await runPrFinalize(
      createContext({
        githubClient: childDefault.client,
      }),
    );

    assert.equal(childDefaultResult.status, 'blocked');
    assert.match(childDefault.comments[0].body, /targets default branch/);
    assert.match(childDefault.comments[0].body, /pullops\/prd-7/);

    const nonChildPrd = createFakeGitHub({
      issue: createIssue({
        body: '## Parent\n\nPart of: #7\n\n## What to build\n\nPretend to be a child.',
      }),
      pullRequest: createPullRequest({
        headRefName: 'pullops/prd-7-issue-42',
        baseRefName: 'pullops/prd-7',
        body: createPullRequestBody({
          parentIssueNumber: 7,
        }),
      }),
    });

    const nonChildPrdResult = await runPrFinalize(
      createContext({
        githubClient: nonChildPrd.client,
      }),
    );

    assert.equal(nonChildPrdResult.status, 'blocked');
    assert.match(nonChildPrd.comments[0].body, /not a native child/);
    assert.match(nonChildPrd.comments[0].body, /PRD issue #7/);
  });

  it('05: waits, routes, or blocks from reviewed-head check state before rewriting', async () => {
    const pending = await createReviewedScenario({
      checks: [createCheck({ state: 'in_progress', conclusion: undefined, bucket: undefined })],
    });

    const pendingResult = await runPrFinalize(pending.context);

    assert.equal(pendingResult.status, 'accepted');
    assert.deepEqual(pendingResult.prFinalize, {
      waiting: true,
      stage: 'reviewed-head',
      checkedRef: pending.reviewedHead,
      checks: 1,
    });
    assert.equal(await countCommitsSinceBase(pending.repository.workDir), 2);

    const failing = await createReviewedScenario({
      checks: [
        createCheck({
          name: 'test',
          conclusion: 'failure',
          bucket: 'fail',
        }),
      ],
    });

    const failingResult = await runPrFinalize(failing.context);

    assert.equal(failingResult.status, 'accepted');
    assert.deepEqual(failing.github.pullRequestLabelsAdded, [
      {
        number: 100,
        labels: [PULL_OPS_OPERATION_LABELS.prFixCi],
      },
    ]);
    assert.match(failing.github.comments[0].body, /Reviewed-head checks failed/);
    assert.equal(await countCommitsSinceBase(failing.repository.workDir), 2);

    const absent = await createReviewedScenario({ checks: [] });

    const absentResult = await runPrFinalize(absent.context);

    assert.equal(absentResult.status, 'blocked');
    assert.match(absent.github.comments[0].body, /no checks on reviewed head/);
    assert.equal(await countCommitsSinceBase(absent.repository.workDir), 2);
  });

  it('06: routes changed reviewed trees back to review while cycles remain and blocks when exhausted', async () => {
    const route = await createReviewedScenario({
      body: createPullRequestBody({
        reviewedTree: 'stale-reviewed-tree',
        reviewCycles: '1 / 3',
      }),
    });

    const routeResult = await runPrFinalize(route.context);

    assert.equal(routeResult.status, 'accepted');
    assert.deepEqual(route.github.pullRequestLabelsAdded, [
      {
        number: 100,
        labels: [PULL_OPS_OPERATION_LABELS.prReview],
      },
    ]);
    assert.doesNotMatch(route.github.updatedBodies[0].body, /Reviewed tree:/);
    assert.match(route.github.comments[0].body, /tree changed after approval/);

    const block = await createReviewedScenario({
      body: createPullRequestBody({
        reviewedTree: 'stale-reviewed-tree',
        reviewCycles: '3 / 3',
      }),
    });

    const blockResult = await runPrFinalize(block.context);

    assert.equal(blockResult.status, 'blocked');
    assert.match(block.github.comments[0].body, /Review Cycles are exhausted \(3 \/ 3\)/);
    assert.deepEqual(block.github.pullRequestLabelsAdded, [
      {
        number: 100,
        labels: ['pullops:status:blocked'],
      },
    ]);
  });

  it('07: blocks unresolved file review threads and unsuperseded requested-change reviews', async () => {
    const unresolvedThread = await createReviewedScenario({
      reviewContext: createReviewContext({
        unresolvedThreads: [
          {
            isResolved: false,
            comments: [
              {
                databaseId: 1,
                body: 'Please update this line.',
                authorLogin: 'reviewer',
                path: 'src/feature.js',
                line: 1,
              },
            ],
          },
        ],
      }),
    });

    const unresolvedResult = await runPrFinalize(unresolvedThread.context);

    assert.equal(unresolvedResult.status, 'blocked');
    assert.match(unresolvedThread.github.comments[0].body, /unresolved file review thread/);
    assert.equal(await countCommitsSinceBase(unresolvedThread.repository.workDir), 2);

    const requestedChanges = await createReviewedScenario({
      reviewContext: createReviewContext({
        reviews: [
          {
            state: 'CHANGES_REQUESTED',
            body: 'Needs an explanation.',
            authorLogin: 'reviewer',
            submittedAt: '2026-06-14T10:00:00Z',
          },
          {
            state: 'APPROVED',
            body: 'The explanation is fine.',
            authorLogin: 'reviewer',
            submittedAt: '2026-06-14T10:05:00Z',
          },
          {
            state: 'CHANGES_REQUESTED',
            body: 'This reviewer is still waiting.',
            authorLogin: 'maintainer',
            submittedAt: '2026-06-14T10:10:00Z',
          },
        ],
      }),
    });

    const requestedChangesResult = await runPrFinalize(requestedChanges.context);

    assert.equal(requestedChangesResult.status, 'blocked');
    assert.match(
      requestedChanges.github.comments[0].body,
      /requested-change review by @maintainer/,
    );
    assert.doesNotMatch(requestedChanges.github.comments[0].body, /@reviewer/);
  });

  it('08: refuses non-managed PRs and managed PRs without a reviewed tree', async () => {
    const nonManaged = await createReviewedScenario({
      body: '## Summary\n\nHuman PR.\n',
    });

    const nonManagedResult = await runPrFinalize(nonManaged.context);

    assert.equal(nonManagedResult.status, 'refused');
    assert.match(String(nonManagedResult.summary), /not a PullOps-managed PR/);
    assert.equal(nonManaged.github.updatedBodies.length, 0);

    const missingReviewedTree = await createReviewedScenario({
      body: createPullRequestBody({ reviewedTree: null }),
    });

    const missingReviewedTreeResult = await runPrFinalize(missingReviewedTree.context);

    assert.equal(missingReviewedTreeResult.status, 'refused');
    assert.match(String(missingReviewedTreeResult.summary), /Reviewed tree marker/);
    assert.match(missingReviewedTree.github.comments[0].body, /Reviewed tree marker/);
  });

  it('09: blocks incomplete Umbrella PRD PRs while native child issues remain open', async () => {
    const github = createFakeGitHub({
      issue: createIssue({
        number: 7,
        title: 'PRD: Parent workflow',
        subIssues: [
          createIssueReference({
            number: 21,
            title: 'First child',
            state: 'OPEN',
          }),
        ],
      }),
      pullRequest: createPullRequest({
        title: 'Prepare #7: PRD: Parent workflow',
        headRefName: 'pullops/prd-7',
        baseRefName: 'main',
        body: createParentPullRequestBody(),
      }),
    });

    const result = await runPrFinalize(
      createContext({
        githubClient: github.client,
      }),
    );

    assert.equal(result.status, 'blocked');
    assert.match(github.comments[0].body, /native Child Issues #21 remain open/);
    assert.match(github.comments[0].body, /Incomplete PRDs cannot become merge-ready/);
  });

  it('10: blocks Umbrella PRD PRs when closed native child issues are missing from history', async () => {
    const repository = await createTemporaryParentRepository({ childOrder: [21] });
    const reviewedTree = await readTreeHash(repository.workDir);
    const reviewedHead = await readHeadSha(repository.workDir);
    const github = createFakeGitHub({
      issue: createIssue({
        number: 7,
        title: 'PRD: Parent workflow',
        subIssues: [
          createIssueReference({
            number: 21,
            title: 'First child',
            state: 'CLOSED',
          }),
          createIssueReference({
            number: 22,
            title: 'Second child',
            state: 'CLOSED',
          }),
        ],
      }),
      pullRequest: createPullRequest({
        title: 'Prepare #7: PRD: Parent workflow',
        headRefName: 'pullops/prd-7',
        headSha: reviewedHead,
        baseRefName: 'main',
        body: createParentPullRequestBody({ reviewedTree }),
      }),
      checksByRef: new Map([[reviewedHead, [createCheck({ name: 'test' })]]]),
    });

    const result = await runPrFinalize(
      createContext({
        cwd: repository.workDir,
        githubClient: github.client,
        gitClient: createGitClientFor(repository.workDir),
      }),
    );

    assert.equal(result.status, 'blocked');
    assert.match(github.comments[0].body, /missing closed native Child Issues #22/);
    assert.equal(await countCommitsSinceBase(repository.workDir), 2);
  });

  it('11: finalizes Umbrella PRD PR commits in native child issue order and marks ready when finalized-head checks are absent', async () => {
    const repository = await createTemporaryParentRepository({ childOrder: [22, 21] });
    const reviewedTree = await readTreeHash(repository.workDir);
    const reviewedHead = await readHeadSha(repository.workDir);
    const codex = createFakeCodexRunner();
    const github = createFakeGitHub({
      issue: createIssue({
        number: 7,
        title: 'PRD: Parent workflow',
        subIssues: [
          createIssueReference({
            number: 21,
            title: 'First child',
            state: 'CLOSED',
          }),
          createIssueReference({
            number: 22,
            title: 'Second child',
            state: 'CLOSED',
          }),
        ],
      }),
      pullRequest: createPullRequest({
        title: 'Prepare #7: PRD: Parent workflow',
        headRefName: 'pullops/prd-7',
        headSha: reviewedHead,
        baseRefName: 'main',
        body: createParentPullRequestBody({ reviewedTree }),
      }),
      checksByRef: new Map([[reviewedHead, [createCheck({ name: 'test' })]]]),
    });

    const firstResult = await runPrFinalize(
      createContext({
        cwd: repository.workDir,
        githubClient: github.client,
        gitClient: createGitClientFor(repository.workDir),
        codexRunner: codex.runner,
      }),
    );

    assert.equal(firstResult.status, 'accepted');
    assert.equal(codex.calls.length, 0);
    assert.deepEqual(await readCommitMessages(repository.workDir), [
      createPrFinalizeCommitMessage(21, 7),
      createPrFinalizeCommitMessage(22, 7),
    ]);
    assert.equal(await countCommitsSinceBase(repository.workDir), 2);
    assert.equal(await readTreeHash(repository.workDir), reviewedTree);

    assert.equal(github.updatedBodies.length, 2);
    const finalizedBody = github.updatedBodies[0].body;
    const readyBody = github.updatedBodies[1].body;
    assert.equal(
      readMarker(readyBody, 'Finalized head:'),
      readMarker(finalizedBody, 'Finalized head:'),
    );
    assert.equal(readMarker(readyBody, 'Finalized tree:'), reviewedTree);
    assert.equal(readMarker(readyBody, 'Merge method:'), 'rebase');
    assert.match(readyBody, /Status: Ready for human rebase merge/);
    assert.match(readyBody, /Closes #7/);
    assert.doesNotMatch(readyBody, /#999 stale child/);
    assert.match(readyBody, /#21 First child \(closed\)/);
    assert.match(readyBody, /#22 Second child \(closed\)/);
    assert.equal(
      readyBody.indexOf('#21 First child') < readyBody.indexOf('#22 Second child'),
      true,
    );
    const prFinalize = /** @type {{ commits: number }} */ (firstResult.prFinalize);
    assert.equal(prFinalize.commits, 2);
    assert.deepEqual(github.readyPullRequests, [100]);
    assert.deepEqual(github.pullRequestLabelsRemoved.at(-1), {
      number: 100,
      labels: [PULL_OPS_OPERATION_LABELS.prFinalize, ...PULL_OPS_STATUS_LABEL_NAMES],
    });
  });

  it('12: finalizes already-ordered Umbrella PRD child commits that edit the same file', async () => {
    const repository = await createTemporaryParentRepository({
      childOrder: [21, 22],
      sharedChildFile: 'src/shared-child-work.js',
    });
    const reviewedTree = await readTreeHash(repository.workDir);
    const reviewedHead = await readHeadSha(repository.workDir);
    const codex = createFakeCodexRunner();
    const github = createFakeGitHub({
      issue: createParentIssueWithClosedChildren(),
      pullRequest: createPullRequest({
        title: 'Prepare #7: PRD: Parent workflow',
        headRefName: 'pullops/prd-7',
        headSha: reviewedHead,
        baseRefName: 'main',
        body: createParentPullRequestBody({ reviewedTree }),
      }),
      checksByRef: new Map([[reviewedHead, [createCheck({ name: 'test' })]]]),
    });

    const result = await runPrFinalize(
      createContext({
        cwd: repository.workDir,
        githubClient: github.client,
        gitClient: createGitClientFor(repository.workDir),
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(codex.calls.length, 0);
    assert.deepEqual(await readCommitMessages(repository.workDir), [
      createPrFinalizeCommitMessage(21, 7),
      createPrFinalizeCommitMessage(22, 7),
    ]);
    assert.equal(await countCommitsSinceBase(repository.workDir), 2);
    assert.equal(await readTreeHash(repository.workDir), reviewedTree);
    assert.equal(readMarker(github.updatedBodies[0].body, 'Finalized tree:'), reviewedTree);
  });

  it('13: blocks overlapping Umbrella PRD child file edits that are not in native child issue order', async () => {
    const repository = await createTemporaryParentRepository({
      childOrder: [22, 21],
      sharedChildFile: 'src/shared-child-work.js',
    });
    const reviewedTree = await readTreeHash(repository.workDir);
    const reviewedHead = await readHeadSha(repository.workDir);
    const codex = createFakeCodexRunner();
    const github = createFakeGitHub({
      issue: createParentIssueWithClosedChildren(),
      pullRequest: createPullRequest({
        title: 'Prepare #7: PRD: Parent workflow',
        headRefName: 'pullops/prd-7',
        headSha: reviewedHead,
        baseRefName: 'main',
        body: createParentPullRequestBody({ reviewedTree }),
      }),
      checksByRef: new Map([[reviewedHead, [createCheck({ name: 'test' })]]]),
    });

    const result = await runPrFinalize(
      createContext({
        cwd: repository.workDir,
        githubClient: github.client,
        gitClient: createGitClientFor(repository.workDir),
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'blocked');
    assert.equal(codex.calls.length, 0);
    assert.match(github.comments[0].body, /overlapping Child Issue file edits/);
    assert.match(github.comments[0].body, /src\/shared-child-work\.js/);
    assert.match(github.comments[0].body, /#21/);
    assert.match(github.comments[0].body, /#22/);
    assert.match(github.comments[0].body, /native Child Issue order/);
    assert.doesNotMatch(github.comments[0].body, /Commit Plan commit/);
    assert.equal(await countCommitsSinceBase(repository.workDir), 3);
  });

  it('14: invokes the fallback planner for ambiguous Umbrella PRD history by default', async () => {
    const repository = await createTemporaryAmbiguousParentRepository();
    const reviewedTree = await readTreeHash(repository.workDir);
    const reviewedHead = await readHeadSha(repository.workDir);
    const codex = createFakeCodexRunner({ output: createPlannerOutput() });
    const github = createFakeGitHub({
      issue: createParentIssueWithClosedChildren(),
      pullRequest: createPullRequest({
        title: 'Prepare #7: PRD: Parent workflow',
        headRefName: 'pullops/prd-7',
        headSha: reviewedHead,
        baseRefName: 'main',
        body: createParentPullRequestBody({ reviewedTree }),
      }),
      checksByRef: new Map([[reviewedHead, [createCheck({ name: 'test' })]]]),
    });

    const result = await runPrFinalize(
      createContext({
        cwd: repository.workDir,
        githubClient: github.client,
        gitClient: createGitClientFor(repository.workDir),
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(codex.calls.length, 1);
    assert.match(codex.calls[0].prompt, /Plan ambiguous PR Finalize history grouping/);
    assert.match(codex.calls[0].prompt, /Do not edit files, run commands, create commits/);
    assert.doesNotMatch(codex.calls[0].prompt, /"pullRequest"/);
    assert.deepEqual(await readCommitMessages(repository.workDir), [
      createPrFinalizeCommitMessage(21, 7),
      createPrFinalizeCommitMessage(22, 7),
    ]);
    assert.equal(await countCommitsSinceBase(repository.workDir), 2);
    assert.equal(await readTreeHash(repository.workDir), reviewedTree);
    assert.equal(readMarker(github.updatedBodies[0].body, 'Finalized tree:'), reviewedTree);
  });

  it('15: blocks ambiguous Umbrella PRD history when the fallback planner is disabled', async () => {
    const repository = await createTemporaryAmbiguousParentRepository();
    const reviewedTree = await readTreeHash(repository.workDir);
    const reviewedHead = await readHeadSha(repository.workDir);
    const codex = createFakeCodexRunner();
    const github = createFakeGitHub({
      issue: createParentIssueWithClosedChildren(),
      pullRequest: createPullRequest({
        title: 'Prepare #7: PRD: Parent workflow',
        headRefName: 'pullops/prd-7',
        headSha: reviewedHead,
        baseRefName: 'main',
        body: createParentPullRequestBody({ reviewedTree }),
      }),
      checksByRef: new Map([[reviewedHead, [createCheck({ name: 'test' })]]]),
    });

    const result = await runPrFinalize(
      createContext({
        cwd: repository.workDir,
        config: createConfig({
          prFinalize: {
            aiHistoryCleanup: false,
          },
        }),
        githubClient: github.client,
        gitClient: createGitClientFor(repository.workDir),
        codexRunner: codex.runner,
      }),
    );

    assert.equal(result.status, 'blocked');
    assert.equal(codex.calls.length, 0);
    assert.match(github.comments[0].body, /AI history cleanup fallback is disabled/);
    assert.equal(await countCommitsSinceBase(repository.workDir), 2);
  });

  it('16: rejects invalid fallback planner output before rewriting history', async () => {
    const repository = await createTemporaryAmbiguousParentRepository();
    const reviewedTree = await readTreeHash(repository.workDir);
    const reviewedHead = await readHeadSha(repository.workDir);
    const codex = createFakeCodexRunner({
      output: createPlannerOutput({
        commits: [
          createPlannerCommit({ issueNumber: 21, files: ['src/child-21.js'] }),
          createPlannerCommit({ issueNumber: 22, files: ['src/child-21.js'] }),
        ],
      }),
    });
    const github = createFakeGitHub({
      issue: createParentIssueWithClosedChildren(),
      pullRequest: createPullRequest({
        title: 'Prepare #7: PRD: Parent workflow',
        headRefName: 'pullops/prd-7',
        headSha: reviewedHead,
        baseRefName: 'main',
        body: createParentPullRequestBody({ reviewedTree }),
      }),
      checksByRef: new Map([[reviewedHead, [createCheck({ name: 'test' })]]]),
    });

    await assert.rejects(
      runPrFinalize(
        createContext({
          cwd: repository.workDir,
          githubClient: github.client,
          gitClient: createGitClientFor(repository.workDir),
          codexRunner: codex.runner,
        }),
      ),
      /assigns "src\/child-21\.js" more than once/,
    );

    assert.equal(codex.calls.length, 1);
    assert.match(github.comments[0].body, /Invalid PR Finalize Planner Output/);
    assert.equal(await countCommitsSinceBase(repository.workDir), 2);
  });

  it('17: rejects AI-proposed rewrites whose final tree differs from the reviewed tree', async () => {
    const repository = await createTemporaryAmbiguousParentRepository();
    const reviewedTree = await readTreeHash(repository.workDir);
    const reviewedHead = await readHeadSha(repository.workDir);
    const codex = createFakeCodexRunner({ output: createPlannerOutput() });
    const github = createFakeGitHub({
      issue: createParentIssueWithClosedChildren(),
      pullRequest: createPullRequest({
        title: 'Prepare #7: PRD: Parent workflow',
        headRefName: 'pullops/prd-7',
        headSha: reviewedHead,
        baseRefName: 'main',
        body: createParentPullRequestBody({ reviewedTree }),
      }),
      checksByRef: new Map([[reviewedHead, [createCheck({ name: 'test' })]]]),
    });
    const realGitClient = createGitClientFor(repository.workDir);

    await assert.rejects(
      runPrFinalize(
        createContext({
          cwd: repository.workDir,
          githubClient: github.client,
          gitClient: {
            ...realGitClient,
            async rewriteBranchWithCommitPlan(options) {
              const result = await realGitClient.rewriteBranchWithCommitPlan(options);
              return {
                ...result,
                treeHash: 'different-tree',
              };
            },
          },
          codexRunner: codex.runner,
        }),
      ),
      /Finalized tree different-tree did not match reviewed tree/,
    );

    assert.equal(codex.calls.length, 1);
    assert.match(github.comments[0].body, /Finalized tree different-tree did not match/);
  });
});

/**
 * @param {Partial<OperationRunnerContext>} overrides
 * @returns {OperationRunnerContext}
 */
function createContext(overrides = {}) {
  return {
    operation: 'pr-finalize',
    phase: 'run',
    runnerAdapter: 'codex-cli',
    target: {
      type: 'pr',
      number: 100,
    },
    cwd: '/workspace',
    config: DEFAULT_PULL_OPS_CONFIG,
    modelTier: 'high',
    model: 'gpt-5.5',
    githubClient: createFakeGitHub({
      pullRequest: createPullRequest(),
    }).client,
    gitClient: createGitClientFor('/workspace'),
    codexRunner: createFakeCodexRunner().runner,
    ...overrides,
  };
}

/**
 * @param {{ prFinalize?: { aiHistoryCleanup?: boolean } }} [overrides]
 * @returns {import('../../config/types.js').PullOpsConfig}
 */
function createConfig({ prFinalize } = {}) {
  return {
    ...DEFAULT_PULL_OPS_CONFIG,
    operations: {
      ...DEFAULT_PULL_OPS_CONFIG.operations,
      prFinalize: {
        ...DEFAULT_PULL_OPS_CONFIG.operations.prFinalize,
        ...prFinalize,
      },
    },
  };
}

/**
 * @param {{ commits?: ReturnType<typeof createPlannerCommit>[] }} [options]
 * @returns {string}
 */
function createPlannerOutput({
  commits = [
    createPlannerCommit({ issueNumber: 21, files: ['src/child-21.js'] }),
    createPlannerCommit({ issueNumber: 22, files: ['src/child-22.js'] }),
  ],
} = {}) {
  return JSON.stringify({
    status: 'planned',
    summary: 'Group ambiguous PRD history by closed Child Issue.',
    commitPlan: {
      commits,
    },
    followUps: [],
  });
}

/**
 * @param {{ issueNumber: number, files: string[] }} options
 * @returns {{ header: string, body: string[], footers: string[], files: string[] }}
 */
function createPlannerCommit({ issueNumber, files }) {
  return {
    header: `feat(issue): implement #${issueNumber}`,
    body: [`Finalize Child Issue #${issueNumber} for rebase merge into PRD #7.`],
    footers: [`Refs: #${issueNumber}`, 'PRD: #7'],
    files,
  };
}

/**
 * @param {object} options
 * @param {GitHubCheckRun[]} [options.checks]
 * @param {string} [options.body]
 * @param {GitHubPullRequestReviewContext} [options.reviewContext]
 * @returns {Promise<{
 *   repository: { root: string, originDir: string, workDir: string };
 *   reviewedTree: string;
 *   reviewedHead: string;
 *   github: ReturnType<typeof createFakeGitHub>;
 *   context: OperationRunnerContext;
 * }>}
 */
async function createReviewedScenario({ checks, body, reviewContext } = {}) {
  const repository = await createTemporaryRepository();
  const reviewedTree = await readTreeHash(repository.workDir);
  const reviewedHead = await readHeadSha(repository.workDir);
  const pullRequest = createPullRequest({
    headSha: reviewedHead,
    body: body ?? createPullRequestBody({ reviewedTree }),
  });
  const github = createFakeGitHub({
    pullRequest,
    reviewContext,
    checksByRef: new Map([[reviewedHead, checks ?? [createCheck({ name: 'test' })]]]),
  });

  return {
    repository,
    reviewedTree,
    reviewedHead,
    github,
    context: createContext({
      cwd: repository.workDir,
      githubClient: github.client,
      gitClient: createGitClientFor(repository.workDir),
    }),
  };
}

/**
 * @param {Partial<GitHubPullRequest>} [overrides]
 * @returns {GitHubPullRequest}
 */
function createPullRequest(overrides = {}) {
  return {
    number: 100,
    title: 'Implement #42: Add PR finalize',
    url: 'https://github.com/acme/widgets/pull/100',
    headRefName: 'pullops/issue-42',
    headSha: 'reviewed-head',
    baseRefName: 'main',
    body: createPullRequestBody(),
    isDraft: true,
    isCrossRepository: false,
    labels: [PULL_OPS_OPERATION_LABELS.prFinalize],
    ...overrides,
  };
}

/**
 * @param {object} [options]
 * @param {string | null} [options.reviewedTree]
 * @param {string} [options.finalizedTree]
 * @param {string} [options.finalizedHead]
 * @param {string} [options.reviewCycles]
 * @param {number} [options.parentIssueNumber]
 * @param {string} [options.status]
 * @param {string} [options.lastOperation]
 * @returns {string}
 */
function createPullRequestBody({
  reviewedTree = 'reviewed-tree',
  finalizedTree,
  finalizedHead,
  reviewCycles = '1 / 3',
  parentIssueNumber,
  status = 'Review approved',
  lastOperation = PULL_OPS_OPERATION_LABELS.prReview,
} = {}) {
  const traceability =
    parentIssueNumber === undefined
      ? ['Closes #42']
      : ['Refs #42', `Part of #${parentIssueNumber}`];

  return [
    '## Summary',
    '',
    'First-pass implementation summary.',
    '',
    '## Changes',
    '',
    '- First-pass change.',
    '',
    '## Test Plan',
    '',
    '- npm test',
    '',
    '## Traceability',
    '',
    ...traceability,
    '',
    '## PullOps',
    '',
    'Managed: yes',
    `Status: ${status}`,
    '',
    '<details>',
    '<summary>PullOps workflow state</summary>',
    '',
    `Review cycles: ${reviewCycles}`,
    'CI fix cycles: 0 / 2',
    'Source: Issue #42',
    ...(reviewedTree === null ? [] : [`Reviewed tree: ${reviewedTree}`]),
    ...(finalizedTree === undefined ? [] : [`Finalized tree: ${finalizedTree}`]),
    ...(finalizedHead === undefined ? [] : [`Finalized head: ${finalizedHead}`]),
    ...(finalizedTree === undefined && finalizedHead === undefined ? [] : ['Merge method: rebase']),
    `Last operation: ${lastOperation}`,
    '',
    '</details>',
  ].join('\n');
}

/**
 * @param {object} [options]
 * @param {string} [options.reviewedTree]
 * @param {string} [options.reviewCycles]
 * @returns {string}
 */
function createParentPullRequestBody({
  reviewedTree = 'reviewed-tree',
  reviewCycles = '1 / 3',
} = {}) {
  return [
    '## Summary',
    '',
    'Prepared an umbrella branch and draft PR for parent issue #7.',
    '',
    '## Child Issues',
    '',
    '- #999 stale child from a previous body (open)',
    '',
    '## Traceability',
    '',
    'Closes #7',
    '',
    '## PullOps',
    '',
    'Managed: yes',
    'Status: Review approved',
    '',
    '<details>',
    '<summary>PullOps workflow state</summary>',
    '',
    `Review cycles: ${reviewCycles}`,
    'CI fix cycles: 0 / 2',
    'Source: Parent Issue #7',
    `Reviewed tree: ${reviewedTree}`,
    'Last operation: pullops:pr:review',
    '',
    '</details>',
  ].join('\n');
}

/**
 * @param {Partial<GitHubIssue>} [overrides]
 * @returns {GitHubIssue}
 */
function createIssue(overrides = {}) {
  return {
    number: 42,
    title: 'Add PR finalize',
    body: '## What to build\n\nFinalize a PR before merge.',
    state: 'OPEN',
    url: 'https://github.com/acme/widgets/issues/42',
    authorLogin: 'maintainer',
    labels: [],
    parent: null,
    subIssues: [],
    ...overrides,
  };
}

/**
 * @returns {GitHubIssue}
 */
function createParentIssueWithClosedChildren() {
  return createIssue({
    number: 7,
    title: 'PRD: Parent workflow',
    body: '## Problem Statement\n\nGroup the child issue work.',
    subIssues: [
      createIssueReference({
        number: 21,
        title: 'First child',
        state: 'CLOSED',
      }),
      createIssueReference({
        number: 22,
        title: 'Second child',
        state: 'CLOSED',
      }),
    ],
  });
}

/**
 * @param {Partial<GitHubIssueReference>} [overrides]
 * @returns {GitHubIssueReference}
 */
function createIssueReference(overrides = {}) {
  return {
    number: 7,
    title: 'PRD: Parent workflow',
    url: 'https://github.com/acme/widgets/issues/7',
    state: 'OPEN',
    relationshipSource: 'native',
    ...overrides,
  };
}

/**
 * @param {object} [options]
 * @param {import('../../github/types.js').GitHubPullRequestComment[]} [options.comments]
 * @param {import('../../github/types.js').GitHubPullRequestReviewSummary[]} [options.reviews]
 * @param {import('../../github/types.js').GitHubPullRequestReviewThread[]} [options.unresolvedThreads]
 * @returns {GitHubPullRequestReviewContext}
 */
function createReviewContext({ comments = [], reviews = [], unresolvedThreads = [] } = {}) {
  return {
    comments,
    reviews,
    unresolvedThreads,
    files: [
      {
        path: 'src/feature.js',
        additions: 1,
        deletions: 1,
      },
    ],
  };
}

/**
 * @param {Partial<GitHubCheckRun>} [overrides]
 * @returns {GitHubCheckRun}
 */
function createCheck(overrides = {}) {
  return {
    name: 'test',
    state: 'completed',
    conclusion: 'success',
    bucket: 'pass',
    ...overrides,
  };
}

/**
 * @param {object} options
 * @param {GitHubPullRequest} options.pullRequest
 * @param {GitHubIssue} [options.issue]
 * @param {GitHubPullRequestReviewContext} [options.reviewContext]
 * @param {Map<string, GitHubCheckRun[]>} [options.checksByRef]
 * @returns {{
 *   updatedBodies: UpdatePullRequestBodyOptions[];
 *   pullRequestLabelsAdded: EditLabelsOptions[];
 *   pullRequestLabelsRemoved: EditLabelsOptions[];
 *   comments: CommentOnPullRequestOptions[];
 *   readyPullRequests: number[];
 *   setPullRequest: (pullRequest: GitHubPullRequest) => void;
 *   setChecksForRef: (ref: string, checks: GitHubCheckRun[]) => void;
 *   client: import('../../github/types.js').GitHubClient;
 * }}
 */
function createFakeGitHub({
  pullRequest,
  issue = createIssue(),
  reviewContext = createReviewContext(),
  checksByRef = new Map(),
}) {
  let currentPullRequest = pullRequest;
  const currentChecksByRef = new Map(checksByRef);
  /** @type {UpdatePullRequestBodyOptions[]} */
  const updatedBodies = [];
  /** @type {EditLabelsOptions[]} */
  const pullRequestLabelsAdded = [];
  /** @type {EditLabelsOptions[]} */
  const pullRequestLabelsRemoved = [];
  /** @type {CommentOnPullRequestOptions[]} */
  const comments = [];
  /** @type {number[]} */
  const readyPullRequests = [];

  return {
    updatedBodies,
    pullRequestLabelsAdded,
    pullRequestLabelsRemoved,
    comments,
    readyPullRequests,
    setPullRequest(nextPullRequest) {
      currentPullRequest = nextPullRequest;
    },
    setChecksForRef(ref, checks) {
      currentChecksByRef.set(ref, checks);
    },
    client: {
      async ensureLabels() {
        return {
          created: [],
          updated: [],
          alreadyCorrect: [],
        };
      },
      async getIssue() {
        return issue;
      },
      async getPullRequest() {
        return currentPullRequest;
      },
      async getPullRequestChecks() {
        throw new Error('getPullRequestChecks was not expected in this test.');
      },
      async getPullRequestChecksForRef(ref) {
        return currentChecksByRef.get(ref) ?? [];
      },
      async getPullRequestReviewContext() {
        return reviewContext;
      },
      async getPullRequestDiff() {
        throw new Error('getPullRequestDiff was not expected in this test.');
      },
      async findOpenPullRequestByHead() {
        throw new Error('findOpenPullRequestByHead was not expected in this test.');
      },
      async createDraftPullRequest() {
        throw new Error('createDraftPullRequest was not expected in this test.');
      },
      async addLabelsToIssue() {
        throw new Error('addLabelsToIssue was not expected in this test.');
      },
      async removeLabelsFromIssue() {
        throw new Error('removeLabelsFromIssue was not expected in this test.');
      },
      async addLabelsToPullRequest(options) {
        pullRequestLabelsAdded.push(options);
      },
      async removeLabelsFromPullRequest(options) {
        pullRequestLabelsRemoved.push(options);
      },
      async commentOnIssue() {
        throw new Error('commentOnIssue was not expected in this test.');
      },
      async closeIssue() {
        throw new Error('closeIssue was not expected in this test.');
      },
      async commentOnPullRequest(options) {
        comments.push(options);
      },
      async updatePullRequestBody(options) {
        updatedBodies.push(options);
      },
      async markPullRequestReadyForReview(number) {
        readyPullRequests.push(number);
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
 * @param {{ output?: unknown }} [options]
 * @returns {{ calls: CodexRunOptions[], runner: import('../../runner/types.js').CodexRunner }}
 */
function createFakeCodexRunner({ output } = {}) {
  /** @type {CodexRunOptions[]} */
  const calls = [];

  return {
    calls,
    runner: {
      async run(options) {
        calls.push(options);
        if (output !== undefined) {
          return output;
        }

        throw new Error('codexRunner.run was not expected in this test.');
      },
    },
  };
}

/**
 * @param {string} cwd
 * @returns {import('../../git/types.js').GitClient}
 */
function createGitClientFor(cwd) {
  return createGitClient({
    execFile: async (file, args) => await execFile(file, args, { cwd }),
  });
}

/**
 * @returns {Promise<{ root: string, originDir: string, workDir: string }>}
 */
async function createTemporaryRepository() {
  const root = await mkdtemp(join(tmpdir(), 'pullops-pr-finalize-'));
  const originDir = join(root, 'origin.git');
  const workDir = join(root, 'work');

  await mkdir(originDir, { recursive: true });
  await mkdir(workDir, { recursive: true });
  await git(originDir, ['init', '--bare']);
  await git(workDir, ['init', '--initial-branch=main']);
  await git(workDir, ['config', 'user.name', 'Test User']);
  await git(workDir, ['config', 'user.email', 'test@example.com']);
  await mkdir(join(workDir, 'src'), { recursive: true });
  await writeFile(join(workDir, 'README.md'), '# Test\n');
  await writeFile(join(workDir, 'src/feature.js'), 'export const value = 1;\n');
  await writeFile(join(workDir, 'src/old.js'), 'export const old = true;\n');
  await git(workDir, ['add', '--all']);
  await git(workDir, ['commit', '-m', 'chore: initial commit']);
  await git(workDir, ['remote', 'add', 'origin', originDir]);
  await git(workDir, ['push', '-u', 'origin', 'main']);
  await git(workDir, ['checkout', '-b', 'pullops/issue-42']);
  await writeFile(join(workDir, 'src/feature.js'), 'export const value = 42;\n');
  await git(workDir, ['add', '--all']);
  await git(workDir, ['commit', '-m', 'wip: update feature']);
  await writeFile(join(workDir, 'src/feature.test.js'), 'assert.equal(value, 42);\n');
  await git(workDir, ['rm', 'src/old.js']);
  await git(workDir, ['add', '--all']);
  await git(workDir, ['commit', '-m', 'wip: add coverage']);
  await git(workDir, ['push', '-u', 'origin', 'pullops/issue-42']);

  return { root, originDir, workDir };
}

/**
 * @returns {Promise<{ root: string, originDir: string, workDir: string }>}
 */
async function createTemporaryChildRepository() {
  const root = await mkdtemp(join(tmpdir(), 'pullops-pr-finalize-child-'));
  const originDir = join(root, 'origin.git');
  const workDir = join(root, 'work');

  await mkdir(originDir, { recursive: true });
  await mkdir(workDir, { recursive: true });
  await git(originDir, ['init', '--bare']);
  await git(workDir, ['init', '--initial-branch=main']);
  await git(workDir, ['config', 'user.name', 'Test User']);
  await git(workDir, ['config', 'user.email', 'test@example.com']);
  await mkdir(join(workDir, 'src'), { recursive: true });
  await writeFile(join(workDir, 'README.md'), '# Test\n');
  await writeFile(join(workDir, 'src/feature.js'), 'export const value = 1;\n');
  await writeFile(join(workDir, 'src/old.js'), 'export const old = true;\n');
  await git(workDir, ['add', '--all']);
  await git(workDir, ['commit', '-m', 'chore: initial commit']);
  await git(workDir, ['remote', 'add', 'origin', originDir]);
  await git(workDir, ['push', '-u', 'origin', 'main']);
  await git(workDir, ['checkout', '-b', 'pullops/prd-7']);
  await writeFile(join(workDir, 'PRD.md'), '# Parent workflow\n');
  await git(workDir, ['add', '--all']);
  await git(workDir, ['commit', '-m', 'chore(prd): prepare #7']);
  await git(workDir, ['push', '-u', 'origin', 'pullops/prd-7']);
  await git(workDir, ['checkout', '-b', 'pullops/prd-7-issue-42']);
  await writeFile(join(workDir, 'src/feature.js'), 'export const value = 42;\n');
  await git(workDir, ['add', '--all']);
  await git(workDir, ['commit', '-m', 'wip: update child feature']);
  await writeFile(join(workDir, 'src/feature.test.js'), 'assert.equal(value, 42);\n');
  await git(workDir, ['rm', 'src/old.js']);
  await git(workDir, ['add', '--all']);
  await git(workDir, ['commit', '-m', 'wip: add child coverage']);
  await git(workDir, ['push', '-u', 'origin', 'pullops/prd-7-issue-42']);

  return { root, originDir, workDir };
}

/**
 * @param {{ childOrder: number[], sharedChildFile?: string }} options
 * @returns {Promise<{ root: string, originDir: string, workDir: string }>}
 */
async function createTemporaryParentRepository({ childOrder, sharedChildFile }) {
  const root = await mkdtemp(join(tmpdir(), 'pullops-pr-finalize-parent-'));
  const originDir = join(root, 'origin.git');
  const workDir = join(root, 'work');

  await mkdir(originDir, { recursive: true });
  await mkdir(workDir, { recursive: true });
  await git(originDir, ['init', '--bare']);
  await git(workDir, ['init', '--initial-branch=main']);
  await git(workDir, ['config', 'user.name', 'Test User']);
  await git(workDir, ['config', 'user.email', 'test@example.com']);
  await mkdir(join(workDir, 'src'), { recursive: true });
  await writeFile(join(workDir, 'README.md'), '# Test\n');
  await git(workDir, ['add', '--all']);
  await git(workDir, ['commit', '-m', 'chore: initial commit']);
  await git(workDir, ['remote', 'add', 'origin', originDir]);
  await git(workDir, ['push', '-u', 'origin', 'main']);
  await git(workDir, ['checkout', '-b', 'pullops/prd-7']);
  await git(workDir, [
    'commit',
    '--allow-empty',
    '-m',
    ['chore(prd): prepare #7', '', 'Prepare umbrella branch.', '', 'Refs: #7'].join('\n'),
  ]);

  for (const [index, childIssueNumber] of childOrder.entries()) {
    if (sharedChildFile === undefined) {
      await writeFile(
        join(workDir, 'src', `child-${childIssueNumber}.js`),
        `export const child${childIssueNumber} = true;\n`,
      );
    } else {
      await writeFile(
        join(workDir, sharedChildFile),
        `export const completedChildren = [${childOrder.slice(0, index + 1).join(', ')}];\n`,
      );
    }
    await git(workDir, ['add', '--all']);
    await git(workDir, ['commit', '-m', createPrFinalizeCommitMessage(childIssueNumber, 7)]);
  }

  await git(workDir, ['push', '-u', 'origin', 'pullops/prd-7']);

  return { root, originDir, workDir };
}

/**
 * @returns {Promise<{ root: string, originDir: string, workDir: string }>}
 */
async function createTemporaryAmbiguousParentRepository() {
  const root = await mkdtemp(join(tmpdir(), 'pullops-pr-finalize-ambiguous-parent-'));
  const originDir = join(root, 'origin.git');
  const workDir = join(root, 'work');

  await mkdir(originDir, { recursive: true });
  await mkdir(workDir, { recursive: true });
  await git(originDir, ['init', '--bare']);
  await git(workDir, ['init', '--initial-branch=main']);
  await git(workDir, ['config', 'user.name', 'Test User']);
  await git(workDir, ['config', 'user.email', 'test@example.com']);
  await mkdir(join(workDir, 'src'), { recursive: true });
  await writeFile(join(workDir, 'README.md'), '# Test\n');
  await git(workDir, ['add', '--all']);
  await git(workDir, ['commit', '-m', 'chore: initial commit']);
  await git(workDir, ['remote', 'add', 'origin', originDir]);
  await git(workDir, ['push', '-u', 'origin', 'main']);
  await git(workDir, ['checkout', '-b', 'pullops/prd-7']);
  await git(workDir, [
    'commit',
    '--allow-empty',
    '-m',
    ['chore(prd): prepare #7', '', 'Prepare umbrella branch.', '', 'Refs: #7'].join('\n'),
  ]);
  await writeFile(join(workDir, 'src', 'child-21.js'), 'export const child21 = true;\n');
  await writeFile(join(workDir, 'src', 'child-22.js'), 'export const child22 = true;\n');
  await git(workDir, ['add', '--all']);
  await git(workDir, [
    'commit',
    '-m',
    ['feat: implement child work', '', 'This commit is missing PullOps traceability.'].join('\n'),
  ]);
  await git(workDir, ['push', '-u', 'origin', 'pullops/prd-7']);

  return { root, originDir, workDir };
}

/**
 * @param {string} workDir
 * @param {string} [baseRef]
 * @returns {Promise<number>}
 */
async function countCommitsSinceBase(workDir, baseRef = 'origin/main') {
  return Number(await gitOutput(workDir, ['rev-list', '--count', `${baseRef}..HEAD`]));
}

/**
 * @param {string} workDir
 * @param {string} [baseRef]
 * @returns {Promise<string[]>}
 */
async function readCommitMessages(workDir, baseRef = 'origin/main') {
  const stdout = await gitOutput(workDir, [
    'log',
    '--format=%B%x00',
    '--reverse',
    `${baseRef}..HEAD`,
  ]);
  return stdout
    .split('\0')
    .map(message => message.trim())
    .filter(Boolean);
}

/**
 * @param {string} workDir
 * @returns {Promise<string>}
 */
async function readTreeHash(workDir) {
  return await gitOutput(workDir, ['rev-parse', 'HEAD^{tree}']);
}

/**
 * @param {string} workDir
 * @returns {Promise<string>}
 */
async function readHeadSha(workDir) {
  return await gitOutput(workDir, ['rev-parse', 'HEAD']);
}

/**
 * @param {string} body
 * @param {string} prefix
 * @returns {string}
 */
function readMarker(body, prefix) {
  const pattern = new RegExp(`^${escapeRegExp(prefix)}\\s*(.+?)\\s*$`, 'im');
  const value = body.match(pattern)?.[1]?.trim();
  assert.ok(value !== undefined, `Expected body to include ${prefix}`);
  return value;
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<string>}
 */
async function gitOutput(cwd, args) {
  const result = await git(cwd, args);
  return result.stdout.trim();
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
async function git(cwd, args) {
  return await execFile('git', args, { cwd });
}
