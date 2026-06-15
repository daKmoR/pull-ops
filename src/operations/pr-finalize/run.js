import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  PULL_OPS_OPERATION_LABELS,
  PULL_OPS_STATUS_LABEL_NAMES,
  PULL_OPS_STATUS_LABELS,
} from '../../labels/pullOpsLabels.js';
import {
  createIssueBranchName,
  createParentBranchName,
  parseChildIssueBranchName,
  parseParentBranchName,
} from '../branchNames.js';
import { createSkippedCodexActionOutput } from '../codexAction.js';
import { readPullOpsPullRequestState } from '../pr-review/prBody.js';
import {
  updatePullRequestBodyForPrFinalize,
  updatePullRequestBodyForPrFinalizeFailure,
  updatePullRequestBodyForPrFinalizeReroute,
} from './prBody.js';

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../../git/types.js').GitCommit} GitCommit
 * @typedef {import('../../git/types.js').PlannedRewriteCommit} PlannedRewriteCommit
 * @typedef {import('../../github/types.js').GitHubCheckRun} GitHubCheckRun
 * @typedef {import('../../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('../../github/types.js').GitHubIssueReference} GitHubIssueReference
 * @typedef {import('../../github/types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('../../github/types.js').GitHubPullRequestReviewContext} GitHubPullRequestReviewContext
 * @typedef {import('./run.types.js').PrFinalizePreparation} PrFinalizePreparation
 * @typedef {import('./run.types.js').PrFinalizeSource} PrFinalizeSource
 * @typedef {import('./run.types.js').PrFinalizeSourceKind} PrFinalizeSourceKind
 */

export const GITHUB_ACTIONS_BOT_AUTHOR = {
  name: 'github-actions[bot]',
  email: '41898282+github-actions[bot]@users.noreply.github.com',
};

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runPrFinalize(context) {
  const preparation = await preparePrFinalize(context);
  if (!preparation.ready) {
    return preparation.output;
  }

  return await completePrFinalize(context, preparation);
}

/**
 * `pr-finalize` is deterministic. In a Codex Action workflow, the prepare
 * phase does the work and the runner step should be skipped by workflow glue.
 *
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runPrFinalizeCodexActionPrepare(context) {
  return await runPrFinalize(context);
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runPrFinalizeCodexActionFinalize(context) {
  if (context.runnerRan === false) {
    return createSkippedCodexActionOutput(context);
  }

  return await runPrFinalize(context);
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<PrFinalizePreparation>}
 */
async function preparePrFinalize(context) {
  assertPullRequestTarget(context);

  const pullRequest = await context.githubClient.getPullRequest(context.target.number);
  const state = readPullOpsPullRequestState(pullRequest.body);

  if (pullRequest.isCrossRepository === true) {
    return {
      ready: false,
      output: await refusePullRequest(
        context,
        pullRequest,
        `PullOps v1 only finalizes same-repository PRs for merge. PR #${pullRequest.number} comes from a fork.`,
        { updateBody: state.managed },
      ),
    };
  }

  if (!state.managed) {
    return {
      ready: false,
      output: await refusePullRequest(
        context,
        pullRequest,
        `PR #${pullRequest.number} is not a PullOps-managed PR.`,
        { updateBody: false },
      ),
    };
  }

  if (!hasPullOpsBranchPrefix(pullRequest.headRefName, context.config.branchPrefix)) {
    return {
      ready: false,
      output: await refusePullRequest(
        context,
        pullRequest,
        `PR #${pullRequest.number} head branch "${pullRequest.headRefName}" does not use the configured PullOps branch prefix.`,
        { updateBody: true },
      ),
    };
  }

  if (state.sourceIssueNumber === undefined || state.sourceKind === undefined) {
    return {
      ready: false,
      output: await refusePullRequest(
        context,
        pullRequest,
        `PR #${pullRequest.number} does not include a structured Source: Issue #<number> line.`,
        { updateBody: true },
      ),
    };
  }

  const baseBranch = pullRequest.baseRefName ?? context.config.baseBranch;
  const source = await preparePrFinalizeSource(context, pullRequest, {
    baseBranch,
    sourceIssueNumber: state.sourceIssueNumber,
    sourceKind: state.sourceKind,
  });
  if (!source.ready) {
    return source;
  }

  const currentTreeHash = await readCurrentTreeHash(context, pullRequest);
  const currentHeadSha = await readCurrentHeadSha(context, pullRequest);

  if (state.finalizedTreeHash !== undefined && state.finalizedHeadSha !== undefined) {
    if (currentTreeHash !== state.finalizedTreeHash) {
      return {
        ready: false,
        output: await routeOrBlockChangedTree(context, pullRequest, {
          currentTreeHash,
          expectedTreeHash: state.finalizedTreeHash,
          reviewCycle: state.reviewCycles.current,
          maxReviewCycles: state.reviewCycles.max,
        }),
      };
    }

    return {
      ready: true,
      mode: 'finalized',
      pullRequest,
      sourceKind: source.sourceKind,
      sourceIssueNumber: source.sourceIssueNumber,
      ...(source.sourceKind === 'childIssue'
        ? { parentIssueNumber: source.parentIssueNumber }
        : {}),
      ...(source.sourceKind === 'parentIssue' ? { childIssues: source.childIssues } : {}),
      baseBranch: source.baseBranch,
      currentTreeHash,
      finalizedTreeHash: state.finalizedTreeHash,
      finalizedHeadSha: currentHeadSha,
      commitCount: countExpectedFinalizedCommits(source),
    };
  }

  if (state.reviewedTreeHash === undefined) {
    return {
      ready: false,
      output: await refusePullRequest(
        context,
        pullRequest,
        `PR #${pullRequest.number} does not include a Reviewed tree marker from an approved PullOps review.`,
        { updateBody: true },
      ),
    };
  }

  if (currentTreeHash !== state.reviewedTreeHash) {
    return {
      ready: false,
      output: await routeOrBlockChangedTree(context, pullRequest, {
        currentTreeHash,
        expectedTreeHash: state.reviewedTreeHash,
        reviewCycle: state.reviewCycles.current,
        maxReviewCycles: state.reviewCycles.max,
      }),
    };
  }

  const reviewedHeadChecks = await context.githubClient.getPullRequestChecksForRef(currentHeadSha);
  const reviewedHeadCheckState = classifyChecks(reviewedHeadChecks);
  if (reviewedHeadCheckState === 'absent') {
    return {
      ready: false,
      output: await blockPullRequest(
        context,
        pullRequest,
        `PR #${pullRequest.number} has no checks on reviewed head ${currentHeadSha}. PullOps will not rewrite history without reviewed-head checks.`,
      ),
    };
  }

  if (reviewedHeadCheckState === 'pending') {
    return {
      ready: false,
      output: waitForChecks(pullRequest, {
        checkedRef: currentHeadSha,
        stage: 'reviewed-head',
        checks: reviewedHeadChecks,
      }),
    };
  }

  if (reviewedHeadCheckState === 'failed') {
    return {
      ready: false,
      output: await routePullRequestToPrFixCi(
        context,
        pullRequest,
        `Reviewed-head checks failed for PR #${pullRequest.number} at ${currentHeadSha}.`,
      ),
    };
  }

  const reviewContext = await context.githubClient.getPullRequestReviewContext(pullRequest.number);
  const blockingFeedback = findBlockingFeedback(reviewContext);
  if (blockingFeedback.length > 0) {
    return {
      ready: false,
      output: await blockPullRequest(
        context,
        pullRequest,
        [
          `PR #${pullRequest.number} still has unresolved actionable review feedback:`,
          blockingFeedback.join('; '),
        ].join(' '),
      ),
    };
  }

  const commitPlan = await createPrFinalizeCommitPlan(context, pullRequest, source);
  if (!commitPlan.ready) {
    return commitPlan;
  }

  return {
    ready: true,
    mode: 'rewrite',
    pullRequest,
    sourceKind: source.sourceKind,
    sourceIssueNumber: source.sourceIssueNumber,
    ...(source.sourceKind === 'childIssue' ? { parentIssueNumber: source.parentIssueNumber } : {}),
    ...(source.sourceKind === 'parentIssue' ? { childIssues: source.childIssues } : {}),
    baseBranch: source.baseBranch,
    currentTreeHash,
    reviewedTreeHash: state.reviewedTreeHash,
    commitPlan: commitPlan.commits,
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @param {object} options
 * @param {string} options.baseBranch
 * @param {number} options.sourceIssueNumber
 * @param {'issue' | 'parentIssue'} options.sourceKind
 * @returns {Promise<PrFinalizeSource>}
 */
async function preparePrFinalizeSource(
  context,
  pullRequest,
  { baseBranch, sourceIssueNumber, sourceKind },
) {
  if (sourceKind === 'parentIssue') {
    return await prepareParentIssueSource(context, pullRequest, {
      baseBranch,
      sourceIssueNumber,
    });
  }

  if (sourceKind !== 'issue') {
    return {
      ready: false,
      output: await refusePullRequest(
        context,
        pullRequest,
        [
          `PR #${pullRequest.number} is not a Concrete Issue PR that PR Finalize can rewrite.`,
          `Source kind: ${sourceKind}; base branch: ${baseBranch}.`,
        ].join(' '),
        { updateBody: true },
      ),
    };
  }

  const sourceIssue = await context.githubClient.getIssue(sourceIssueNumber);
  const nativeParentIssueNumber = sourceIssue.parent?.number;
  const childBranch = parseChildIssueBranchName({
    branchPrefix: context.config.branchPrefix,
    branchName: pullRequest.headRefName,
  });
  const targetPrdBranch = parseParentBranchName({
    branchPrefix: context.config.branchPrefix,
    branchName: baseBranch,
  });

  if (nativeParentIssueNumber !== undefined) {
    return await prepareChildIssueSource(context, pullRequest, {
      baseBranch,
      childBranch,
      nativeParentIssueNumber,
      sourceIssue,
    });
  }

  if (targetPrdBranch !== undefined) {
    return {
      ready: false,
      output: await blockPullRequest(
        context,
        pullRequest,
        [
          `PR #${pullRequest.number} targets PRD branch "${baseBranch}",`,
          `but source issue #${sourceIssue.number} is not a native child of`,
          `PRD issue #${targetPrdBranch.parentNumber}.`,
        ].join(' '),
      ),
    };
  }

  if (childBranch !== undefined) {
    return {
      ready: false,
      output: await blockPullRequest(
        context,
        pullRequest,
        [
          `PR #${pullRequest.number} uses Child Issue branch "${pullRequest.headRefName}",`,
          `but source issue #${sourceIssue.number} has no native parent issue.`,
        ].join(' '),
      ),
    };
  }

  if (baseBranch !== context.config.baseBranch) {
    return {
      ready: false,
      output: await refusePullRequest(
        context,
        pullRequest,
        [
          `PR #${pullRequest.number} is not a standalone Concrete Issue PR targeting`,
          `the default branch "${context.config.baseBranch}".`,
          `Base branch: ${baseBranch}.`,
        ].join(' '),
        { updateBody: true },
      ),
    };
  }

  return {
    ready: true,
    sourceKind: 'standalone',
    sourceIssueNumber: sourceIssue.number,
    baseBranch,
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @param {object} options
 * @param {string} options.baseBranch
 * @param {number} options.sourceIssueNumber
 * @returns {Promise<PrFinalizeSource>}
 */
async function prepareParentIssueSource(context, pullRequest, { baseBranch, sourceIssueNumber }) {
  const sourceIssue = await context.githubClient.getIssue(sourceIssueNumber);
  const parentBranch = parseParentBranchName({
    branchPrefix: context.config.branchPrefix,
    branchName: pullRequest.headRefName,
  });

  if (sourceIssue.parent !== null) {
    return {
      ready: false,
      output: await blockPullRequest(
        context,
        pullRequest,
        [
          `PR #${pullRequest.number} uses Parent Issue source #${sourceIssue.number},`,
          `but that issue is a native child of issue #${sourceIssue.parent.number}.`,
        ].join(' '),
      ),
    };
  }

  if (parentBranch?.parentNumber !== sourceIssue.number) {
    const expectedBranch = createParentBranchName({
      branchPrefix: context.config.branchPrefix,
      parentNumber: sourceIssue.number,
    });
    return {
      ready: false,
      output: await blockPullRequest(
        context,
        pullRequest,
        [
          `Umbrella PRD PR #${pullRequest.number} uses head branch`,
          `"${pullRequest.headRefName}", but Parent Issue #${sourceIssue.number}`,
          `must use "${expectedBranch}".`,
        ].join(' '),
      ),
    };
  }

  if (baseBranch !== context.config.baseBranch) {
    return {
      ready: false,
      output: await blockPullRequest(
        context,
        pullRequest,
        [
          `Umbrella PRD PR #${pullRequest.number} targets "${baseBranch}",`,
          `but Parent Issue #${sourceIssue.number} must target default branch`,
          `"${context.config.baseBranch}".`,
        ].join(' '),
      ),
    };
  }

  const openChildIssues = sourceIssue.subIssues.filter(childIssue => !isClosedIssue(childIssue));
  if (openChildIssues.length > 0) {
    return {
      ready: false,
      output: await blockPullRequest(
        context,
        pullRequest,
        [
          `Umbrella PRD PR #${pullRequest.number} is incomplete because native Child Issues`,
          `${formatIssueList(openChildIssues)} remain open.`,
          'Incomplete PRDs cannot become merge-ready.',
        ].join(' '),
      ),
    };
  }

  return {
    ready: true,
    sourceKind: 'parentIssue',
    sourceIssueNumber: sourceIssue.number,
    baseBranch,
    childIssues: sourceIssue.subIssues,
    closedChildIssues: sourceIssue.subIssues.filter(isClosedIssue),
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @param {object} options
 * @param {string} options.baseBranch
 * @param {{ parentNumber: number, issueNumber: number } | undefined} options.childBranch
 * @param {number} options.nativeParentIssueNumber
 * @param {GitHubIssue} options.sourceIssue
 * @returns {Promise<PrFinalizeSource>}
 */
async function prepareChildIssueSource(
  context,
  pullRequest,
  { baseBranch, childBranch, nativeParentIssueNumber, sourceIssue },
) {
  const expectedBaseBranch = createParentBranchName({
    branchPrefix: context.config.branchPrefix,
    parentNumber: nativeParentIssueNumber,
  });
  const expectedChildBranch = createIssueBranchName({
    branchPrefix: context.config.branchPrefix,
    parentNumber: nativeParentIssueNumber,
    issueNumber: sourceIssue.number,
  });

  if (baseBranch === context.config.baseBranch) {
    return {
      ready: false,
      output: await blockPullRequest(
        context,
        pullRequest,
        [
          `Child Issue #${sourceIssue.number} belongs to PRD issue #${nativeParentIssueNumber},`,
          `but PR #${pullRequest.number} targets default branch "${context.config.baseBranch}".`,
          `It must target PRD branch "${expectedBaseBranch}".`,
        ].join(' '),
      ),
    };
  }

  if (childBranch === undefined) {
    return {
      ready: false,
      output: await blockPullRequest(
        context,
        pullRequest,
        [
          `Child Issue PR #${pullRequest.number} uses head branch "${pullRequest.headRefName}",`,
          `but native Child Issue #${sourceIssue.number} in PRD issue #${nativeParentIssueNumber}`,
          `must use "${expectedChildBranch}".`,
        ].join(' '),
      ),
    };
  }

  if (
    childBranch.issueNumber !== sourceIssue.number ||
    childBranch.parentNumber !== nativeParentIssueNumber
  ) {
    return {
      ready: false,
      output: await blockPullRequest(
        context,
        pullRequest,
        [
          `Child Issue PR #${pullRequest.number} head branch "${pullRequest.headRefName}"`,
          `does not match native Child Issue #${sourceIssue.number} in`,
          `PRD issue #${nativeParentIssueNumber}.`,
        ].join(' '),
      ),
    };
  }

  if (baseBranch !== expectedBaseBranch) {
    return {
      ready: false,
      output: await blockPullRequest(
        context,
        pullRequest,
        [
          `Child Issue PR #${pullRequest.number} targets "${baseBranch}",`,
          `but native Child Issue #${sourceIssue.number} must target`,
          `PRD branch "${expectedBaseBranch}".`,
        ].join(' '),
      ),
    };
  }

  return {
    ready: true,
    sourceKind: 'childIssue',
    sourceIssueNumber: sourceIssue.number,
    parentIssueNumber: nativeParentIssueNumber,
    baseBranch,
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @param {PrFinalizeSource & { ready: true }} source
 * @returns {Promise<
 *   | { ready: false; output: Record<string, unknown> }
 *   | { ready: true; commits: PlannedRewriteCommit[] }
 * >}
 */
async function createPrFinalizeCommitPlan(context, pullRequest, source) {
  if (source.sourceKind === 'parentIssue') {
    return await createParentIssueCommitPlan(context, pullRequest, source);
  }

  const changedFiles = await readChangedFiles(context, pullRequest, {
    baseBranch: source.baseBranch,
  });
  if (changedFiles.length === 0) {
    return {
      ready: false,
      output: await refusePullRequest(
        context,
        pullRequest,
        `PR #${pullRequest.number} has no changed files to finalize.`,
        { updateBody: true },
      ),
    };
  }

  return {
    ready: true,
    commits: [
      {
        message: createPrFinalizeCommitMessage(
          source.sourceIssueNumber,
          source.sourceKind === 'childIssue' ? source.parentIssueNumber : undefined,
        ),
        files: changedFiles,
      },
    ],
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @param {PrFinalizeSource & { ready: true, sourceKind: 'parentIssue' }} source
 * @returns {Promise<
 *   | { ready: false; output: Record<string, unknown> }
 *   | { ready: true; commits: PlannedRewriteCommit[] }
 * >}
 */
async function createParentIssueCommitPlan(context, pullRequest, source) {
  let history;

  try {
    history = await readCommitsSinceBase(context, pullRequest, {
      baseBranch: source.baseBranch,
    });
  } catch (error) {
    await recordPullRequestFailure(context, pullRequest, getErrorMessage(error));
    throw error;
  }

  const analysis = analyzeParentIssueHistory({
    commits: history,
    parentIssueNumber: source.sourceIssueNumber,
    closedChildIssues: source.closedChildIssues,
  });

  if (!analysis.valid) {
    return {
      ready: false,
      output: await blockPullRequest(context, pullRequest, analysis.reason),
    };
  }

  if (analysis.commits.length === 0) {
    return {
      ready: false,
      output: await refusePullRequest(
        context,
        pullRequest,
        `Umbrella PRD PR #${pullRequest.number} has no child issue work to finalize.`,
        { updateBody: true },
      ),
    };
  }

  return {
    ready: true,
    commits: analysis.commits,
  };
}

/**
 * @param {object} options
 * @param {GitCommit[]} options.commits
 * @param {number} options.parentIssueNumber
 * @param {GitHubIssueReference[]} options.closedChildIssues
 * @returns {{ valid: true, commits: PlannedRewriteCommit[] } | { valid: false, reason: string }}
 */
function analyzeParentIssueHistory({ commits, parentIssueNumber, closedChildIssues }) {
  const closedChildNumbers = new Set(closedChildIssues.map(childIssue => childIssue.number));
  /** @type {Map<number, Set<string>>} */
  const filesByChildIssue = new Map();
  /** @type {PlannedRewriteCommit[]} */
  const parentLevelCommits = [];

  for (const commit of commits) {
    const childIssueNumber = readChildIssueNumberFromCommit({
      commit,
      parentIssueNumber,
      closedChildNumbers,
    });

    if (childIssueNumber !== undefined) {
      const files = filesByChildIssue.get(childIssueNumber) ?? new Set();
      for (const file of commit.files) {
        files.add(file);
      }
      filesByChildIssue.set(childIssueNumber, files);
      continue;
    }

    if (isParentLevelCommit(commit, parentIssueNumber)) {
      if (commit.files.length > 0) {
        parentLevelCommits.push({
          message: commit.body,
          files: commit.files,
        });
      }
      continue;
    }

    return {
      valid: false,
      reason: [
        `Umbrella PRD history contains commit ${commit.sha} that is not traceable to`,
        `a closed native Child Issue of PRD #${parentIssueNumber} or explicit PRD-level work.`,
      ].join(' '),
    };
  }

  const missingChildIssues = closedChildIssues.filter(
    childIssue => !filesByChildIssue.has(childIssue.number),
  );
  if (missingChildIssues.length > 0) {
    return {
      valid: false,
      reason: [
        `Umbrella PRD history is missing closed native Child Issues`,
        `${formatIssueList(missingChildIssues)}.`,
        'Closed child work cannot be omitted from the finalized PRD branch.',
      ].join(' '),
    };
  }

  return {
    valid: true,
    commits: [
      ...parentLevelCommits,
      ...closedChildIssues.map(childIssue => ({
        message: createPrFinalizeParentChildCommitMessage(parentIssueNumber, childIssue),
        files: [...(filesByChildIssue.get(childIssue.number) ?? [])],
      })),
    ],
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {PrFinalizePreparation & { ready: true }} preparation
 * @returns {Promise<Record<string, unknown>>}
 */
async function completePrFinalize(context, preparation) {
  if (preparation.mode === 'finalized') {
    return await completeFinalizedHeadChecks(context, preparation.pullRequest, {
      sourceIssueNumber: preparation.sourceIssueNumber,
      parentIssueNumber: preparation.parentIssueNumber,
      childIssues: preparation.childIssues,
      finalizedTreeHash: preparation.finalizedTreeHash,
      finalizedHeadSha: preparation.finalizedHeadSha,
      body: preparation.pullRequest.body,
      commitCount: preparation.commitCount,
    });
  }

  let rewriteResult;

  try {
    rewriteResult = await context.gitClient.rewriteBranchWithCommitPlan({
      baseBranch: preparation.baseBranch,
      branchName: preparation.pullRequest.headRefName,
      commits: preparation.commitPlan,
      author: GITHUB_ACTIONS_BOT_AUTHOR,
    });
  } catch (error) {
    await recordPullRequestFailure(context, preparation.pullRequest, getErrorMessage(error));
    throw error;
  }

  if (rewriteResult.treeHash !== preparation.reviewedTreeHash) {
    const reason = [
      `Finalized tree ${rewriteResult.treeHash} did not match reviewed tree`,
      `${preparation.reviewedTreeHash} for PR #${preparation.pullRequest.number}.`,
    ].join(' ');
    await recordPullRequestFailure(context, preparation.pullRequest, reason);
    throw new Error(reason);
  }

  const finalizedBody = updatePullRequestBodyForPrFinalize({
    body: preparation.pullRequest.body,
    sourceIssueNumber: preparation.sourceIssueNumber,
    parentIssueNumber: preparation.parentIssueNumber,
    childIssues: preparation.childIssues,
    finalizedTreeHash: rewriteResult.treeHash,
    finalizedHeadSha: rewriteResult.headSha,
  });
  await context.githubClient.updatePullRequestBody({
    number: preparation.pullRequest.number,
    body: finalizedBody,
  });

  return await completeFinalizedHeadChecks(context, preparation.pullRequest, {
    sourceIssueNumber: preparation.sourceIssueNumber,
    parentIssueNumber: preparation.parentIssueNumber,
    childIssues: preparation.childIssues,
    finalizedTreeHash: rewriteResult.treeHash,
    finalizedHeadSha: rewriteResult.headSha,
    body: finalizedBody,
    commitCount: preparation.commitPlan.length,
  });
}

/**
 * @param {number} sourceIssueNumber
 * @param {number | undefined} parentIssueNumber
 * @returns {string}
 */
export function createPrFinalizeCommitMessage(sourceIssueNumber, parentIssueNumber) {
  if (parentIssueNumber !== undefined) {
    return [
      `feat(issue): implement #${sourceIssueNumber}`,
      '',
      `Finalize Child Issue #${sourceIssueNumber} for rebase merge into PRD #${parentIssueNumber}.`,
      '',
      `Refs: #${sourceIssueNumber}`,
      `PRD: #${parentIssueNumber}`,
    ].join('\n');
  }

  return [
    `feat(issue): implement #${sourceIssueNumber}`,
    '',
    `Finalize standalone Concrete Issue #${sourceIssueNumber} for rebase merge.`,
    '',
    `Closes #${sourceIssueNumber}`,
  ].join('\n');
}

/**
 * @param {number} parentIssueNumber
 * @param {GitHubIssueReference} childIssue
 * @returns {string}
 */
export function createPrFinalizeParentChildCommitMessage(parentIssueNumber, childIssue) {
  return [
    `feat(issue): implement #${childIssue.number}`,
    '',
    `Finalize Child Issue #${childIssue.number} for rebase merge into PRD #${parentIssueNumber}.`,
    '',
    `Refs: #${childIssue.number}`,
    `PRD: #${parentIssueNumber}`,
  ].join('\n');
}

/**
 * @param {PrFinalizeSource & { ready: true }} source
 * @returns {number}
 */
function countExpectedFinalizedCommits(source) {
  if (source.sourceKind === 'parentIssue') {
    return source.closedChildIssues.length;
  }

  return 1;
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @param {{ baseBranch: string }} options
 * @returns {Promise<GitCommit[]>}
 */
async function readCommitsSinceBase(context, pullRequest, { baseBranch }) {
  if (context.gitClient.getCommitsSinceBase === undefined) {
    throw new Error(
      `Git client cannot inspect commits since ${baseBranch} for PR #${pullRequest.number}.`,
    );
  }

  return await context.gitClient.getCommitsSinceBase({ baseBranch });
}

/**
 * @param {object} options
 * @param {GitCommit} options.commit
 * @param {number} options.parentIssueNumber
 * @param {Set<number>} options.closedChildNumbers
 * @returns {number | undefined}
 */
function readChildIssueNumberFromCommit({ commit, parentIssueNumber, closedChildNumbers }) {
  if (!commitReferencesPrd(commit, parentIssueNumber)) {
    return undefined;
  }

  const refs = readReferencedIssueNumbers(commit.body);
  return refs.find(issueNumber => closedChildNumbers.has(issueNumber));
}

/**
 * @param {GitCommit} commit
 * @param {number} parentIssueNumber
 * @returns {boolean}
 */
function isParentLevelCommit(commit, parentIssueNumber) {
  const refs = readReferencedIssueNumbers(commit.body);
  return refs.includes(parentIssueNumber) && !commit.body.includes(`PRD: #${parentIssueNumber}`);
}

/**
 * @param {GitCommit} commit
 * @param {number} parentIssueNumber
 * @returns {boolean}
 */
function commitReferencesPrd(commit, parentIssueNumber) {
  return new RegExp(`^PRD:\\s+#${parentIssueNumber}\\s*$`, 'im').test(commit.body);
}

/**
 * @param {string} commitBody
 * @returns {number[]}
 */
function readReferencedIssueNumbers(commitBody) {
  /** @type {number[]} */
  const numbers = [];
  const pattern = /^Refs:\s+#(\d+)\s*$/gim;
  let match;

  while ((match = pattern.exec(commitBody)) !== null) {
    if (match[1] !== undefined) {
      numbers.push(Number(match[1]));
    }
  }

  return numbers;
}

/**
 * @param {GitHubIssueReference} issue
 * @returns {boolean}
 */
function isClosedIssue(issue) {
  return issue.state?.toUpperCase() === 'CLOSED';
}

/**
 * @param {GitHubIssueReference[]} issues
 * @returns {string}
 */
function formatIssueList(issues) {
  return issues.map(issue => `#${issue.number}`).join(', ');
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @param {object} options
 * @param {number} options.sourceIssueNumber
 * @param {number | undefined} options.parentIssueNumber
 * @param {GitHubIssueReference[] | undefined} options.childIssues
 * @param {string} options.finalizedTreeHash
 * @param {string} options.finalizedHeadSha
 * @param {string} options.body
 * @param {number} options.commitCount
 * @returns {Promise<Record<string, unknown>>}
 */
async function completeFinalizedHeadChecks(
  context,
  pullRequest,
  {
    sourceIssueNumber,
    parentIssueNumber,
    childIssues,
    finalizedTreeHash,
    finalizedHeadSha,
    body,
    commitCount,
  },
) {
  const checks = await context.githubClient.getPullRequestChecksForRef(finalizedHeadSha);
  const checkState = classifyChecks(checks);

  if (checkState === 'absent' || checkState === 'pending') {
    return waitForChecks(pullRequest, {
      checkedRef: finalizedHeadSha,
      stage: 'finalized-head',
      checks,
    });
  }

  if (checkState === 'failed') {
    return await routePullRequestToPrFixCi(
      context,
      pullRequest,
      `Finalized-head checks failed for PR #${pullRequest.number} at ${finalizedHeadSha}.`,
    );
  }

  await context.githubClient.updatePullRequestBody({
    number: pullRequest.number,
    body: updatePullRequestBodyForPrFinalize({
      body,
      sourceIssueNumber,
      parentIssueNumber,
      childIssues,
      finalizedTreeHash,
      finalizedHeadSha,
      status: 'ready',
    }),
  });

  if (pullRequest.isDraft) {
    await context.githubClient.markPullRequestReadyForReview(pullRequest.number);
  }

  await context.githubClient.removeLabelsFromPullRequest({
    number: pullRequest.number,
    labels: [PULL_OPS_OPERATION_LABELS.prFinalize, ...PULL_OPS_STATUS_LABEL_NAMES],
  });

  return {
    status: 'accepted',
    summary: `Finalized PullOps-managed PR #${pullRequest.number} for human rebase merge.`,
    pullRequest: {
      number: pullRequest.number,
      url: pullRequest.url,
    },
    prFinalize: {
      commits: commitCount,
      finalizedTree: finalizedTreeHash,
      finalizedHead: finalizedHeadSha,
      mergeMethod: 'rebase',
      readyForReview: true,
    },
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @returns {Promise<string>}
 */
async function readCurrentTreeHash(context, pullRequest) {
  try {
    return await context.gitClient.getCurrentTreeHash();
  } catch (error) {
    await recordPullRequestFailure(context, pullRequest, getErrorMessage(error));
    throw error;
  }
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @returns {Promise<string>}
 */
async function readCurrentHeadSha(context, pullRequest) {
  if (pullRequest.headSha !== undefined) {
    return pullRequest.headSha;
  }

  try {
    return await context.gitClient.getCurrentHeadSha();
  } catch (error) {
    await recordPullRequestFailure(context, pullRequest, getErrorMessage(error));
    throw error;
  }
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @param {{ baseBranch: string }} options
 * @returns {Promise<string[]>}
 */
async function readChangedFiles(context, pullRequest, { baseBranch }) {
  try {
    return await context.gitClient.getChangedFilesSinceBase({ baseBranch });
  } catch (error) {
    await recordPullRequestFailure(context, pullRequest, getErrorMessage(error));
    throw error;
  }
}

/**
 * @param {GitHubCheckRun[]} checks
 * @returns {'absent' | 'pending' | 'failed' | 'passed'}
 */
function classifyChecks(checks) {
  if (checks.length === 0) {
    return 'absent';
  }

  if (checks.some(isFailedCheck)) {
    return 'failed';
  }

  if (checks.some(isPendingCheck)) {
    return 'pending';
  }

  return 'passed';
}

/**
 * @param {GitHubCheckRun} check
 * @returns {boolean}
 */
function isFailedCheck(check) {
  const bucket = normalize(check.bucket);
  const conclusion = normalize(check.conclusion);
  const state = normalize(check.state);
  return (
    bucket === 'fail' ||
    ['failure', 'timed_out', 'action_required', 'startup_failure', 'cancelled'].includes(
      conclusion,
    ) ||
    ['failure', 'failed', 'error', 'timed_out', 'cancelled'].includes(state)
  );
}

/**
 * @param {GitHubCheckRun} check
 * @returns {boolean}
 */
function isPendingCheck(check) {
  const bucket = normalize(check.bucket);
  const state = normalize(check.state);
  return (
    bucket === 'pending' ||
    ['pending', 'queued', 'requested', 'waiting', 'in_progress'].includes(state) ||
    (!isPassingCheck(check) && !isFailedCheck(check))
  );
}

/**
 * @param {GitHubCheckRun} check
 * @returns {boolean}
 */
function isPassingCheck(check) {
  const bucket = normalize(check.bucket);
  const conclusion = normalize(check.conclusion);
  const state = normalize(check.state);
  return (
    bucket === 'pass' ||
    ['success', 'neutral', 'skipped'].includes(conclusion) ||
    state === 'success'
  );
}

/**
 * @param {string | undefined} value
 * @returns {string}
 */
function normalize(value) {
  return value === undefined ? '' : value.toLowerCase();
}

/**
 * @param {GitHubPullRequestReviewContext} reviewContext
 * @returns {string[]}
 */
function findBlockingFeedback(reviewContext) {
  const unresolvedFileThreads = reviewContext.unresolvedThreads.filter(thread =>
    thread.comments.some(comment => comment.path !== undefined),
  );
  const requestedChangeReviews = findUnsupersededRequestedChangeReviews(reviewContext);

  return [
    ...unresolvedFileThreads.map(thread => {
      const firstComment = thread.comments.find(comment => comment.path !== undefined);
      const location =
        firstComment?.path === undefined
          ? 'an unresolved file thread'
          : `${firstComment.path}${firstComment.line === undefined ? '' : `:${firstComment.line}`}`;
      return `unresolved file review thread at ${location}`;
    }),
    ...requestedChangeReviews.map(review => {
      const author =
        review.authorLogin === null || review.authorLogin.trim() === ''
          ? 'unknown reviewer'
          : `@${review.authorLogin}`;
      return `unsuperseded requested-change review by ${author}`;
    }),
  ];
}

/**
 * @param {GitHubPullRequestReviewContext} reviewContext
 * @returns {import('../../github/types.js').GitHubPullRequestReviewSummary[]}
 */
function findUnsupersededRequestedChangeReviews(reviewContext) {
  const latestReviewByAuthor = new Map();
  const orderedReviews = reviewContext.reviews
    .map((review, index) => ({ review, index }))
    .sort((left, right) => compareReviews(left, right));

  for (const { review } of orderedReviews) {
    const author = review.authorLogin ?? `review-${review.id ?? latestReviewByAuthor.size}`;
    if (review.state === 'CHANGES_REQUESTED' || review.state === 'APPROVED') {
      latestReviewByAuthor.set(author, review);
    }
  }

  return [...latestReviewByAuthor.values()].filter(review => review.state === 'CHANGES_REQUESTED');
}

/**
 * @param {{ review: import('../../github/types.js').GitHubPullRequestReviewSummary, index: number }} left
 * @param {{ review: import('../../github/types.js').GitHubPullRequestReviewSummary, index: number }} right
 * @returns {number}
 */
function compareReviews(left, right) {
  if (left.review.submittedAt !== undefined && right.review.submittedAt !== undefined) {
    return left.review.submittedAt.localeCompare(right.review.submittedAt);
  }

  return left.index - right.index;
}

/**
 * @param {GitHubPullRequest} pullRequest
 * @param {{ checkedRef: string, stage: 'reviewed-head' | 'finalized-head', checks: GitHubCheckRun[] }} options
 * @returns {Record<string, unknown>}
 */
function waitForChecks(pullRequest, { checkedRef, stage, checks }) {
  return {
    status: 'accepted',
    summary: `Waiting for ${stage} checks on PR #${pullRequest.number} at ${checkedRef}.`,
    pullRequest: {
      number: pullRequest.number,
      url: pullRequest.url,
    },
    prFinalize: {
      waiting: true,
      stage,
      checkedRef,
      checks: checks.length,
    },
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @param {{ currentTreeHash: string, expectedTreeHash: string, reviewCycle: number, maxReviewCycles: number }} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function routeOrBlockChangedTree(
  context,
  pullRequest,
  { currentTreeHash, expectedTreeHash, reviewCycle, maxReviewCycles },
) {
  const reason = [
    `PR #${pullRequest.number} tree changed after approval.`,
    `Expected ${expectedTreeHash}; found ${currentTreeHash}.`,
  ].join(' ');

  if (reviewCycle < maxReviewCycles) {
    return await routePullRequestToReview(context, pullRequest, reason);
  }

  return await blockPullRequest(
    context,
    pullRequest,
    `${reason} Review Cycles are exhausted (${reviewCycle} / ${maxReviewCycles}).`,
  );
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @param {string} reason
 * @returns {Promise<Record<string, unknown>>}
 */
async function routePullRequestToReview(context, pullRequest, reason) {
  await writeFailureReason(context, reason);
  await context.githubClient.updatePullRequestBody({
    number: pullRequest.number,
    body: updatePullRequestBodyForPrFinalizeReroute({
      body: pullRequest.body,
    }),
  });
  await context.githubClient.removeLabelsFromPullRequest({
    number: pullRequest.number,
    labels: [PULL_OPS_OPERATION_LABELS.prFinalize, ...PULL_OPS_STATUS_LABEL_NAMES],
  });
  await context.githubClient.addLabelsToPullRequest({
    number: pullRequest.number,
    labels: [PULL_OPS_OPERATION_LABELS.prReview],
  });
  await context.githubClient.commentOnPullRequest({
    number: pullRequest.number,
    body: [
      'PullOps routed `pullops run pr-finalize` back to review.',
      '',
      `Reason: ${reason}`,
    ].join('\n'),
  });

  return {
    status: 'accepted',
    summary: `Routed PR #${pullRequest.number} back to PullOps review.`,
    pullRequest: {
      number: pullRequest.number,
      url: pullRequest.url,
    },
    prFinalize: {
      routedTo: PULL_OPS_OPERATION_LABELS.prReview,
      reason,
    },
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @param {string} reason
 * @returns {Promise<Record<string, unknown>>}
 */
async function routePullRequestToPrFixCi(context, pullRequest, reason) {
  await writeFailureReason(context, reason);
  await context.githubClient.removeLabelsFromPullRequest({
    number: pullRequest.number,
    labels: [PULL_OPS_OPERATION_LABELS.prFinalize, ...PULL_OPS_STATUS_LABEL_NAMES],
  });
  await context.githubClient.addLabelsToPullRequest({
    number: pullRequest.number,
    labels: [PULL_OPS_OPERATION_LABELS.prFixCi],
  });
  await context.githubClient.commentOnPullRequest({
    number: pullRequest.number,
    body: ['PullOps routed `pullops run pr-finalize` to CI repair.', '', `Reason: ${reason}`].join(
      '\n',
    ),
  });

  return {
    status: 'accepted',
    summary: `Routed PR #${pullRequest.number} to PullOps CI repair.`,
    pullRequest: {
      number: pullRequest.number,
      url: pullRequest.url,
    },
    prFinalize: {
      routedTo: PULL_OPS_OPERATION_LABELS.prFixCi,
      reason,
    },
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @param {string} reason
 * @returns {Promise<Record<string, unknown>>}
 */
async function blockPullRequest(context, pullRequest, reason) {
  await recordPullRequestFailure(context, pullRequest, reason);

  return {
    status: 'blocked',
    summary: reason,
    pullRequest: {
      number: pullRequest.number,
      url: pullRequest.url,
    },
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @param {string} reason
 * @param {{ updateBody: boolean }} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function refusePullRequest(context, pullRequest, reason, { updateBody }) {
  await recordPullRequestFailure(context, pullRequest, reason, { updateBody });

  return {
    status: 'refused',
    summary: reason,
    pullRequest: {
      number: pullRequest.number,
      url: pullRequest.url,
    },
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @param {string} reason
 * @param {{ updateBody?: boolean }} [options]
 * @returns {Promise<void>}
 */
async function recordPullRequestFailure(context, pullRequest, reason, { updateBody = true } = {}) {
  await writeFailureReason(context, reason);

  if (updateBody) {
    await context.githubClient.updatePullRequestBody({
      number: pullRequest.number,
      body: updatePullRequestBodyForPrFinalizeFailure({
        body: pullRequest.body,
      }),
    });
  }

  await context.githubClient.addLabelsToPullRequest({
    number: pullRequest.number,
    labels: [PULL_OPS_STATUS_LABELS.blocked],
  });
  await context.githubClient.removeLabelsFromPullRequest({
    number: pullRequest.number,
    labels: [
      PULL_OPS_OPERATION_LABELS.prFinalize,
      PULL_OPS_STATUS_LABELS.inProgress,
      PULL_OPS_STATUS_LABELS.failed,
      PULL_OPS_STATUS_LABELS.prepared,
      PULL_OPS_STATUS_LABELS.done,
    ],
  });
  await context.githubClient.commentOnPullRequest({
    number: pullRequest.number,
    body: ['PullOps could not complete `pullops run pr-finalize`.', '', `Reason: ${reason}`].join(
      '\n',
    ),
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {string} reason
 * @returns {Promise<void>}
 */
async function writeFailureReason(context, reason) {
  if (context.outputDirectory === undefined || context.outputDirectory.trim() === '') {
    return;
  }

  await mkdir(context.outputDirectory, { recursive: true });
  await writeFile(join(context.outputDirectory, 'failure_reason.txt'), `${reason}\n`);
}

/**
 * @param {string} branchName
 * @param {string} branchPrefix
 * @returns {boolean}
 */
function hasPullOpsBranchPrefix(branchName, branchPrefix) {
  const normalizedPrefix =
    branchPrefix
      .split('/')
      .map(part => part.trim())
      .filter(Boolean)
      .join('/') || 'pullops';
  return branchName === normalizedPrefix || branchName.startsWith(`${normalizedPrefix}/`);
}

/**
 * @param {OperationRunnerContext} context
 * @returns {asserts context is OperationRunnerContext & { target: { type: 'pr', number: number } }}
 */
function assertPullRequestTarget(context) {
  if (context.target.type !== 'pr') {
    throw new Error('pr-finalize requires a pull request target.');
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
