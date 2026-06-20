import { classifyCheckState } from '../../checks/checkState.js';
import { PULL_OPS_OPERATION_LABELS } from '../../labels/pullOpsLabels.js';
import {
  applyManagedPrTransition,
  readManagedPrState,
  refusePrOperationTarget,
} from '../../managed-pr/ManagedPrState.js';
import {
  readChildIssuePrFacts,
  readParentIssueFacts,
} from '../../prd-automation/childCoordination.js';
import {
  createParentBranchName,
  hasPullOpsBranchPrefix,
  parseChildIssueBranchName,
  parseParentBranchName,
} from '../branchNames.js';
import {
  createSkippedCodexActionOutput,
  getCodexActionFiles,
  readCodexActionOutput,
  writeCodexActionPrompt,
} from '../codexAction.js';
import { commentOnPullRequestWithOperationAudit } from '../auditComment.js';
import { GITHUB_ACTIONS_BOT_AUTHOR } from '../githubActionsBot.js';
import { validatePlannerCommitPlan } from './commitPlan.js';
import { validatePrFinalizeOutput } from './output.js';
import { updatePullRequestBodyForPrFinalize } from './prBody.js';
import { buildPrFinalizePrompt } from './prompt.js';
import { resumePrdAutomationForParentIssue } from '../prd-automation/run.js';

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../../git/types.js').GitCommit} GitCommit
 * @typedef {import('../../git/types.js').PlannedRewriteCommit} PlannedRewriteCommit
 * @typedef {import('../../github/types.js').GitHubCheckRun} GitHubCheckRun
 * @typedef {import('../../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('../../github/types.js').GitHubIssueReference} GitHubIssueReference
 * @typedef {import('../../github/types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('../../github/types.js').GitHubPullRequestReviewContext} GitHubPullRequestReviewContext
 * @typedef {import('./output.types.js').PlannedCommit} PlannedCommit
 * @typedef {import('./run.types.js').PrFinalizePreparation} PrFinalizePreparation
 * @typedef {import('./run.types.js').PrFinalizeSource} PrFinalizeSource
 * @typedef {import('./run.types.js').PrFinalizeSourceKind} PrFinalizeSourceKind
 */

export { GITHUB_ACTIONS_BOT_AUTHOR } from '../githubActionsBot.js';

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runPrFinalize(context) {
  const preparation = await preparePrFinalize(context);
  if (!preparation.ready) {
    return preparation.output;
  }

  if (preparation.mode === 'planner') {
    let rawOutput;

    try {
      rawOutput = await context.codexRunner.run({
        cwd: context.cwd,
        command: context.config.runner.command,
        model: context.model,
        prompt: preparation.prompt,
      });
    } catch (error) {
      await recordPullRequestFailure(context, preparation.pullRequest, getErrorMessage(error));
      throw error;
    }

    return await completePrFinalizePlannerFallback(context, preparation, rawOutput);
  }

  return await completePrFinalize(context, preparation);
}

/**
 * `pr-finalize` is deterministic unless ambiguous Parent Issue history needs
 * the narrowed fallback planner. In a Codex Action workflow, prepare completes
 * deterministic paths and writes a prompt only for that fallback.
 *
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runPrFinalizeCodexActionPrepare(context) {
  const preparation = await preparePrFinalize(context);
  if (!preparation.ready) {
    return preparation.output;
  }

  if (preparation.mode !== 'planner') {
    return await completePrFinalize(context, preparation);
  }

  try {
    await writeCodexActionPrompt(context, preparation.prompt);
  } catch (error) {
    await recordPullRequestFailure(context, preparation.pullRequest, getErrorMessage(error));
    throw error;
  }

  const files = getCodexActionFiles(context);
  return {
    status: 'accepted',
    summary: `Prepared Codex Action PR Finalize history planner for PR #${preparation.pullRequest.number}.`,
    pullRequest: {
      number: preparation.pullRequest.number,
      url: preparation.pullRequest.url,
    },
    codexAction: {
      promptFile: files.promptFile,
      outputFile: files.outputFile,
      model: context.model,
      branch: preparation.pullRequest.headRefName,
    },
  };
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runPrFinalizeCodexActionFinalize(context) {
  if (context.runnerRan === false) {
    return createSkippedCodexActionOutput(context);
  }

  const preparation = await preparePrFinalize(context);
  if (!preparation.ready) {
    return preparation.output;
  }

  if (preparation.mode !== 'planner') {
    return await completePrFinalize(context, preparation);
  }

  let rawOutput;

  try {
    rawOutput = await readCodexActionOutput(context);
  } catch (error) {
    await recordPullRequestFailure(context, preparation.pullRequest, getErrorMessage(error));
    throw error;
  }

  return await completePrFinalizePlannerFallback(context, preparation, rawOutput);
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<PrFinalizePreparation>}
 */
async function preparePrFinalize(context) {
  assertPullRequestTarget(context);

  const pullRequest = await context.githubClient.getPullRequest(context.target.number);
  const state = readManagedPrState(pullRequest.body);

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

  if (
    !hasPullOpsBranchPrefix({
      branchName: pullRequest.headRefName,
      branchPrefix: context.config.branchPrefix,
    })
  ) {
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
  const reviewedHeadCheckState = classifyCheckState(reviewedHeadChecks);
  if (reviewedHeadCheckState === 'absent' && context.allowAbsentReviewedHeadChecks !== true) {
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

  if (commitPlan.mode === 'planner') {
    if (source.sourceKind !== 'parentIssue') {
      throw new Error('PR Finalize planner fallback is only supported for Parent Issue PRs.');
    }

    return {
      ready: true,
      mode: 'planner',
      pullRequest,
      sourceKind: 'parentIssue',
      sourceIssueNumber: source.sourceIssueNumber,
      childIssues: source.childIssues,
      baseBranch: source.baseBranch,
      currentTreeHash,
      reviewedTreeHash: state.reviewedTreeHash,
      reviewedHeadSha: currentHeadSha,
      changedFiles: commitPlan.changedFiles,
      prompt: commitPlan.prompt,
    };
  }

  if (commitPlan.mode === 'existing-commits') {
    if (source.sourceKind !== 'parentIssue') {
      throw new Error('Existing commit PR Finalize is only supported for Parent Issue PRs.');
    }

    return {
      ready: true,
      mode: 'existing-commits',
      pullRequest,
      sourceKind: 'parentIssue',
      sourceIssueNumber: source.sourceIssueNumber,
      childIssues: source.childIssues,
      baseBranch: source.baseBranch,
      currentTreeHash,
      reviewedTreeHash: state.reviewedTreeHash,
      reviewedHeadSha: currentHeadSha,
      changedFiles: commitPlan.changedFiles,
      commitShas: commitPlan.commitShas,
      commitCount: commitPlan.commitCount,
    };
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
    reviewedHeadSha: currentHeadSha,
    changedFiles: commitPlan.changedFiles,
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

  const childFacts = await readChildIssuePrFacts(context, {
    sourceIssueNumber,
  });
  const sourceIssue =
    childFacts?.sourceIssue ?? (await context.githubClient.getIssue(sourceIssueNumber));
  const childBranch = parseChildIssueBranchName({
    branchPrefix: context.config.branchPrefix,
    branchName: pullRequest.headRefName,
  });
  const targetPrdBranch = parseParentBranchName({
    branchPrefix: context.config.branchPrefix,
    branchName: baseBranch,
  });

  if (childFacts !== undefined) {
    return await prepareChildIssueSource(context, pullRequest, {
      baseBranch,
      childBranch,
      childFacts,
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
  const parentFacts = await readParentIssueFacts(context, {
    parentIssueNumber: sourceIssueNumber,
  });
  const sourceIssue = parentFacts.parentIssue;
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

  const openChildIssues = parentFacts.openChildIssues;
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
    parentIssue: sourceIssue,
    childIssues: parentFacts.childIssues,
    closedChildIssues: parentFacts.closedChildIssues,
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @param {object} options
 * @param {string} options.baseBranch
 * @param {{ parentNumber: number, issueNumber: number } | undefined} options.childBranch
 * @param {import('../../prd-automation/childCoordination.types.js').ChildIssuePrFacts} options.childFacts
 * @returns {Promise<PrFinalizeSource>}
 */
async function prepareChildIssueSource(
  context,
  pullRequest,
  { baseBranch, childBranch, childFacts },
) {
  const { expectedBaseBranch, expectedChildBranch, parentIssueNumber, sourceIssue } = childFacts;

  if (baseBranch === context.config.baseBranch) {
    return {
      ready: false,
      output: await blockPullRequest(
        context,
        pullRequest,
        [
          `Child Issue #${sourceIssue.number} belongs to PRD issue #${parentIssueNumber},`,
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
          `but native Child Issue #${sourceIssue.number} in PRD issue #${parentIssueNumber}`,
          `must use "${expectedChildBranch}".`,
        ].join(' '),
      ),
    };
  }

  if (
    childBranch.issueNumber !== sourceIssue.number ||
    childBranch.parentNumber !== parentIssueNumber
  ) {
    return {
      ready: false,
      output: await blockPullRequest(
        context,
        pullRequest,
        [
          `Child Issue PR #${pullRequest.number} head branch "${pullRequest.headRefName}"`,
          `does not match native Child Issue #${sourceIssue.number} in`,
          `PRD issue #${parentIssueNumber}.`,
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
    parentIssueNumber,
    baseBranch,
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @param {PrFinalizeSource & { ready: true }} source
 * @returns {Promise<
 *   | { ready: false; output: Record<string, unknown> }
 *   | { ready: true; mode: 'rewrite'; commits: PlannedRewriteCommit[], changedFiles: string[] }
 *   | { ready: true; mode: 'existing-commits'; commitShas: string[], commitCount: number, changedFiles: string[] }
 *   | { ready: true; mode: 'planner'; prompt: string; changedFiles: string[] }
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
    mode: 'rewrite',
    changedFiles,
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
 *   | { ready: true; mode: 'rewrite'; commits: PlannedRewriteCommit[], changedFiles: string[] }
 *   | { ready: true; mode: 'existing-commits'; commitShas: string[], commitCount: number, changedFiles: string[] }
 *   | { ready: true; mode: 'planner'; prompt: string; changedFiles: string[] }
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
    if (analysis.fallbackAllowed === true) {
      if (!context.config.operations.prFinalize.aiHistoryCleanup) {
        return {
          ready: false,
          output: await blockPullRequest(
            context,
            pullRequest,
            [
              analysis.reason,
              'AI history cleanup fallback is disabled by PullOps config operations.prFinalize.aiHistoryCleanup=false.',
            ].join(' '),
          ),
        };
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
            `Umbrella PRD PR #${pullRequest.number} has no changed files to finalize.`,
            { updateBody: true },
          ),
        };
      }

      const reviewContext = await context.githubClient.getPullRequestReviewContext(
        pullRequest.number,
      );

      return {
        ready: true,
        mode: 'planner',
        changedFiles,
        prompt: buildPrFinalizePrompt({
          pullRequest,
          parentIssue: source.parentIssue,
          closedChildIssues: source.closedChildIssues,
          ambiguousReason: analysis.reason,
          commits: history,
          reviewContext,
          changedFiles,
        }),
      };
    }

    return {
      ready: false,
      output: await blockPullRequest(context, pullRequest, analysis.reason),
    };
  }

  if (analysis.existingCommitShas !== undefined) {
    return {
      ready: true,
      mode: 'existing-commits',
      commitShas: analysis.existingCommitShas,
      commitCount: analysis.existingCommitShas.length,
      changedFiles: readUniqueFiles(history),
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
    mode: 'rewrite',
    changedFiles: readUniqueFiles(analysis.commits),
    commits: analysis.commits,
  };
}

/**
 * @param {{ files: string[] }[]} commits
 * @returns {string[]}
 */
function readUniqueFiles(commits) {
  /** @type {string[]} */
  const files = [];
  /** @type {Set<string>} */
  const seenFiles = new Set();

  for (const commit of commits) {
    for (const file of commit.files) {
      if (seenFiles.has(file)) {
        continue;
      }

      seenFiles.add(file);
      files.push(file);
    }
  }

  return files;
}

/**
 * @param {object} options
 * @param {GitCommit[]} options.commits
 * @param {number} options.parentIssueNumber
 * @param {GitHubIssueReference[]} options.closedChildIssues
 * @returns {{ valid: true, commits: PlannedRewriteCommit[], existingCommitShas?: string[] } | { valid: false, reason: string, fallbackAllowed?: boolean }}
 */
function analyzeParentIssueHistory({ commits, parentIssueNumber, closedChildIssues }) {
  const closedChildNumbers = new Set(closedChildIssues.map(childIssue => childIssue.number));
  /** @type {Map<number, Set<string>>} */
  const filesByChildIssue = new Map();
  /** @type {Array<{ childIssueNumber: number, commit: GitCommit }>} */
  const childCommitEntries = [];
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
      childCommitEntries.push({ childIssueNumber, commit });
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
      fallbackAllowed: true,
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

  const overlappingChildFiles = findOverlappingChildFiles(filesByChildIssue);
  if (overlappingChildFiles.length > 0) {
    const reusableHistory = findReusableExistingChildHistory({
      childCommitEntries,
      parentLevelCommits,
      parentIssueNumber,
      closedChildIssues,
    });

    if (reusableHistory.valid) {
      return {
        valid: true,
        commits: [],
        existingCommitShas: reusableHistory.commitShas,
      };
    }

    return {
      valid: false,
      reason: [
        'Umbrella PRD history contains overlapping Child Issue file edits:',
        `${formatOverlappingChildFiles(overlappingChildFiles)}.`,
        'PullOps can finalize overlapping child edits only when the existing history',
        'already contains one deterministic Child Issue Commit per closed native Child Issue',
        `in native Child Issue order. ${reusableHistory.reason}`,
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
 * @param {Map<number, Set<string>>} filesByChildIssue
 * @returns {Array<{ file: string, childIssueNumbers: number[] }>}
 */
function findOverlappingChildFiles(filesByChildIssue) {
  /** @type {Map<string, number[]>} */
  const childIssueNumbersByFile = new Map();

  for (const [childIssueNumber, files] of filesByChildIssue.entries()) {
    for (const file of files) {
      const childIssueNumbers = childIssueNumbersByFile.get(file) ?? [];
      childIssueNumbers.push(childIssueNumber);
      childIssueNumbersByFile.set(file, childIssueNumbers);
    }
  }

  return [...childIssueNumbersByFile.entries()]
    .filter(([, childIssueNumbers]) => childIssueNumbers.length > 1)
    .map(([file, childIssueNumbers]) => ({ file, childIssueNumbers }));
}

/**
 * @param {object} options
 * @param {Array<{ childIssueNumber: number, commit: GitCommit }>} options.childCommitEntries
 * @param {PlannedRewriteCommit[]} options.parentLevelCommits
 * @param {number} options.parentIssueNumber
 * @param {GitHubIssueReference[]} options.closedChildIssues
 * @returns {{ valid: true, commitShas: string[] } | { valid: false, reason: string }}
 */
function findReusableExistingChildHistory({
  childCommitEntries,
  parentLevelCommits,
  parentIssueNumber,
  closedChildIssues,
}) {
  if (parentLevelCommits.length > 0) {
    return {
      valid: false,
      reason: 'The existing history also contains explicit PRD-level file changes.',
    };
  }

  if (childCommitEntries.length !== closedChildIssues.length) {
    return {
      valid: false,
      reason: [
        `The existing history has ${childCommitEntries.length} Child Issue commits,`,
        `but PRD #${parentIssueNumber} has ${closedChildIssues.length} closed native Child Issues.`,
      ].join(' '),
    };
  }

  for (const [index, childIssue] of closedChildIssues.entries()) {
    const entry = childCommitEntries[index];
    if (entry === undefined || entry.childIssueNumber !== childIssue.number) {
      return {
        valid: false,
        reason: [
          `The existing Child Issue commit order is ${formatChildCommitOrder(childCommitEntries)},`,
          `but native Child Issue order is ${formatIssueList(closedChildIssues)}.`,
        ].join(' '),
      };
    }

    const expectedMessage = createPrFinalizeParentChildCommitMessage(parentIssueNumber, childIssue);
    if (entry.commit.body !== expectedMessage) {
      return {
        valid: false,
        reason: [
          `Commit ${entry.commit.sha} for Child Issue #${childIssue.number}`,
          'does not match the deterministic PR Finalize commit message.',
        ].join(' '),
      };
    }
  }

  return {
    valid: true,
    commitShas: childCommitEntries.map(entry => entry.commit.sha),
  };
}

/**
 * @param {Array<{ file: string, childIssueNumbers: number[] }>} overlappingChildFiles
 * @returns {string}
 */
function formatOverlappingChildFiles(overlappingChildFiles) {
  return overlappingChildFiles
    .map(
      ({ file, childIssueNumbers }) =>
        `${file} (${childIssueNumbers.map(issueNumber => `#${issueNumber}`).join(', ')})`,
    )
    .join('; ');
}

/**
 * @param {Array<{ childIssueNumber: number }>} childCommitEntries
 * @returns {string}
 */
function formatChildCommitOrder(childCommitEntries) {
  if (childCommitEntries.length === 0) {
    return 'none';
  }

  return childCommitEntries.map(entry => `#${entry.childIssueNumber}`).join(', ');
}

/**
 * @param {OperationRunnerContext} context
 * @param {PrFinalizePreparation & { ready: true, mode: 'planner' }} preparation
 * @param {unknown} rawOutput
 * @returns {Promise<Record<string, unknown>>}
 */
async function completePrFinalizePlannerFallback(context, preparation, rawOutput) {
  await commentOnPullRequestWithOperationAudit(context, {
    pullRequestNumber: preparation.pullRequest.number,
    operation: PULL_OPS_OPERATION_LABELS.prFinalize,
  });

  const validatedOutput = validatePrFinalizeOutput(rawOutput);

  if (!validatedOutput.valid) {
    const reason = `Invalid PR Finalize Planner Output: ${validatedOutput.reason}`;
    await recordPullRequestFailure(context, preparation.pullRequest, reason);
    throw new Error(reason);
  }

  if (validatedOutput.value.status === 'blocked') {
    await recordPullRequestFailure(
      context,
      preparation.pullRequest,
      validatedOutput.value.failureReason,
    );

    return {
      status: 'blocked',
      summary: validatedOutput.value.summary,
      pullRequest: {
        number: preparation.pullRequest.number,
        url: preparation.pullRequest.url,
      },
    };
  }

  const commitPlan = validatePlannerCommitPlan({
    plannedCommits: validatedOutput.value.commitPlan.commits,
    changedFiles: preparation.changedFiles,
    parentIssueNumber: preparation.sourceIssueNumber,
    childIssueNumbers: preparation.childIssues.map(childIssue => childIssue.number),
  });
  if (!commitPlan.valid) {
    const reason = `Invalid PR Finalize Planner Output: ${commitPlan.reason}`;
    await recordPullRequestFailure(context, preparation.pullRequest, reason);
    throw new Error(reason);
  }

  return await completePrFinalize(
    context,
    {
      ready: true,
      mode: 'rewrite',
      pullRequest: preparation.pullRequest,
      sourceKind: preparation.sourceKind,
      sourceIssueNumber: preparation.sourceIssueNumber,
      childIssues: preparation.childIssues,
      baseBranch: preparation.baseBranch,
      currentTreeHash: preparation.currentTreeHash,
      reviewedTreeHash: preparation.reviewedTreeHash,
      reviewedHeadSha: preparation.reviewedHeadSha,
      changedFiles: preparation.changedFiles,
      commitPlan: commitPlan.commits,
    },
    { operationAuditRecorded: true },
  );
}

/**
 * @param {OperationRunnerContext} context
 * @param {PrFinalizePreparation & { ready: true }} preparation
 * @param {{ operationAuditRecorded?: boolean }} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
async function completePrFinalize(context, preparation, { operationAuditRecorded = false } = {}) {
  if (preparation.mode === 'planner') {
    throw new Error('PR Finalize planner preparation must be completed with planner output.');
  }

  if (preparation.mode === 'finalized') {
    return await completeFinalizedHeadChecks(context, preparation.pullRequest, {
      sourceIssueNumber: preparation.sourceIssueNumber,
      parentIssueNumber: preparation.parentIssueNumber,
      childIssues: preparation.childIssues,
      finalizedTreeHash: preparation.finalizedTreeHash,
      finalizedHeadSha: preparation.finalizedHeadSha,
      body: preparation.pullRequest.body,
      commitCount: preparation.commitCount,
      operationAuditRecorded,
    });
  }

  let rewriteResult;

  try {
    if (preparation.mode === 'existing-commits') {
      if (context.gitClient.rewriteBranchWithExistingCommits === undefined) {
        throw new Error('Git client cannot rewrite a branch with existing commits.');
      }

      rewriteResult = await context.gitClient.rewriteBranchWithExistingCommits({
        baseBranch: preparation.baseBranch,
        branchName: preparation.pullRequest.headRefName,
        commitShas: preparation.commitShas,
        committer: GITHUB_ACTIONS_BOT_AUTHOR,
      });
    } else {
      rewriteResult = await context.gitClient.rewriteBranchWithCommitPlan({
        baseBranch: preparation.baseBranch,
        branchName: preparation.pullRequest.headRefName,
        commits: preparation.commitPlan,
        author: GITHUB_ACTIONS_BOT_AUTHOR,
      });
    }
  } catch (error) {
    await recordPullRequestFailure(context, preparation.pullRequest, getErrorMessage(error));
    throw error;
  }

  if (!(await rewritePreservesReviewedContent(context, preparation, rewriteResult))) {
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
    commitCount:
      preparation.mode === 'existing-commits'
        ? preparation.commitCount
        : preparation.commitPlan.length,
    operationAuditRecorded,
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {PrFinalizePreparation & { ready: true, mode: 'rewrite' | 'existing-commits' }} preparation
 * @param {import('../../git/types.js').GitRewriteResult} rewriteResult
 * @returns {Promise<boolean>}
 */
async function rewritePreservesReviewedContent(context, preparation, rewriteResult) {
  if (rewriteResult.treeHash === preparation.reviewedTreeHash) {
    return true;
  }

  if (context.gitClient.arePathsEqualBetweenRevisions === undefined) {
    return false;
  }

  try {
    return await context.gitClient.arePathsEqualBetweenRevisions({
      leftRevision: preparation.reviewedHeadSha,
      rightRevision: rewriteResult.headSha,
      paths: preparation.changedFiles,
    });
  } catch (error) {
    await recordPullRequestFailure(context, preparation.pullRequest, getErrorMessage(error));
    throw error;
  }
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
 * @param {boolean} options.operationAuditRecorded
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
    operationAuditRecorded,
  },
) {
  const checks = await context.githubClient.getPullRequestChecksForRef(finalizedHeadSha);
  const checkState = classifyCheckState(checks);

  if (checkState === 'pending') {
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

  const readyBody = updatePullRequestBodyForPrFinalize({
    body,
    sourceIssueNumber,
    parentIssueNumber,
    childIssues,
    finalizedTreeHash,
    finalizedHeadSha,
    status: 'ready',
  });
  const readySummary = createPrFinalizeReadySummary(pullRequest);
  const shouldRecordReadyAudit = await shouldRecordPrFinalizeReadyAudit(context, pullRequest, {
    operationAuditRecorded,
  });
  await applyManagedPrTransition({
    githubClient: context.githubClient,
    outputDirectory: context.outputDirectory,
    pullRequest: {
      ...pullRequest,
      body: readyBody,
    },
    operation: PULL_OPS_OPERATION_LABELS.prFinalize,
    suppressFollowUpOperationLabels: context.suppressFollowUpOperationLabels,
    outcome: {
      kind: 'ready',
      finalizedTreeHash,
      finalizedHeadSha,
    },
  });

  if (pullRequest.isDraft) {
    await context.githubClient.markPullRequestReadyForReview(pullRequest.number);
  }

  if (shouldRecordReadyAudit) {
    await commentOnPullRequestWithOperationAudit(context, {
      pullRequestNumber: pullRequest.number,
      operation: PULL_OPS_OPERATION_LABELS.prFinalize,
      summary: readySummary,
    });
  }

  const prdAutomation =
    parentIssueNumber === undefined
      ? undefined
      : context.resumeParentPrdAutomationAfterPrFinalize === false
        ? undefined
        : await resumePrdAutomationForParentIssue(context, parentIssueNumber);

  return {
    status: 'accepted',
    summary: readySummary,
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
    ...(prdAutomation === undefined ? {} : { prdAutomation }),
  };
}

/**
 * @param {GitHubPullRequest} pullRequest
 * @returns {string}
 */
function createPrFinalizeReadySummary(pullRequest) {
  return `Finalized PullOps-managed PR #${pullRequest.number} for human rebase merge.`;
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @param {{ operationAuditRecorded: boolean }} options
 * @returns {Promise<boolean>}
 */
async function shouldRecordPrFinalizeReadyAudit(context, pullRequest, { operationAuditRecorded }) {
  if (operationAuditRecorded) {
    return false;
  }

  const state = readManagedPrState(pullRequest.body);
  if (state.status !== 'Ready for human merge') {
    return true;
  }

  const reviewContext = await context.githubClient.getPullRequestReviewContext(pullRequest.number);
  return !hasPrFinalizeAuditComment(reviewContext);
}

/**
 * @param {GitHubPullRequestReviewContext} reviewContext
 * @returns {boolean}
 */
function hasPrFinalizeAuditComment(reviewContext) {
  return reviewContext.comments.some(comment =>
    /<summary>\s*PullOps operation audit\s*<\/summary>[\s\S]*Operation:\s*pullops:pr:finalize/i.test(
      comment.body,
    ),
  );
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
  await applyManagedPrTransition({
    githubClient: context.githubClient,
    outputDirectory: context.outputDirectory,
    pullRequest,
    operation: PULL_OPS_OPERATION_LABELS.prFinalize,
    suppressFollowUpOperationLabels: context.suppressFollowUpOperationLabels,
    outcome: {
      kind: 'route-to-review',
      reason,
    },
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
  await applyManagedPrTransition({
    githubClient: context.githubClient,
    outputDirectory: context.outputDirectory,
    pullRequest,
    operation: PULL_OPS_OPERATION_LABELS.prFinalize,
    suppressFollowUpOperationLabels: context.suppressFollowUpOperationLabels,
    outcome: {
      kind: 'route-to-ci-fix',
      reason,
    },
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
  if (updateBody) {
    await recordPullRequestFailure(context, pullRequest, reason, { updateBody });
  } else {
    await refusePrOperationTarget({
      githubClient: context.githubClient,
      outputDirectory: context.outputDirectory,
      pullRequest,
      operation: PULL_OPS_OPERATION_LABELS.prFinalize,
      reason,
    });
  }

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
  if (!updateBody) {
    await refusePrOperationTarget({
      githubClient: context.githubClient,
      outputDirectory: context.outputDirectory,
      pullRequest,
      operation: PULL_OPS_OPERATION_LABELS.prFinalize,
      reason,
    });
    return;
  }

  await applyManagedPrTransition({
    githubClient: context.githubClient,
    outputDirectory: context.outputDirectory,
    pullRequest,
    operation: PULL_OPS_OPERATION_LABELS.prFinalize,
    suppressFollowUpOperationLabels: context.suppressFollowUpOperationLabels,
    outcome: {
      kind: 'blocked',
      reason,
    },
  });
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
