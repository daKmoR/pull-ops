import { classifyCheckState } from '../../checks/checkState.js';
import {
  applyManagedPrTransition,
  readManagedPrState,
  refusePrOperationTarget,
} from '../../managed-pr/ManagedPrState.js';
import { requireOperationCatalogOperationLabelName } from '../operationCatalog.js';
import {
  readTicketPrFacts,
  readParentIssueFacts,
} from '../../spec-automation/ticketCoordination.js';
import {
  createParentBranchName,
  hasPullOpsBranchPrefix,
  parseTicketBranchName,
  parseParentBranchName,
} from '../branchNames.js';
import { executeOperationPhase } from '../runnerLifecycle.js';
import {
  blockLocalPullRequestOperation,
  completeLocalPullRequestRunRecord,
  formatPullRequest,
  runLocalRunnerStep,
  writeLocalPullRequestRunArtifact,
} from '../runLocalPullRequestOperation.js';
import { commentOnPullRequestWithOperationAudit } from '../auditComment.js';
import { GITHUB_ACTIONS_BOT_AUTHOR } from '../githubActionsBot.js';
import { validatePlannerCommitPlan } from './commitPlan.js';
import { validatePrFinalizeOutput } from './output.js';
import { updatePullRequestBodyForPrFinalize } from './prBody.js';
import { buildPrFinalizePrompt } from './prompt.js';
import { resumeSpecAutomationForParentIssue } from '../spec-automation/run.js';
import { readLocalRunStateRecordFromDirectory } from '../../local-run-state/localRunState.js';

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
  return await executeOperationPhase(prFinalizeDescriptor, 'run', context);
}

/** @type {import('../runnerLifecycle.types.js').OperationDescriptor} */
export const prFinalizeDescriptor = {
  operationReference: 'pr:finalize',
  createOperation: createPrFinalizeRunnerOperation,
  localRun: runLocalPrFinalize,
};

/**
 * @param {OperationRunnerContext} context
 * @param {import('../../local-run-state/types.js').LocalRunRecord} runRecord
 * @param {import('../runLocalPullRequestOperation.types.js').PreparedLocalPullRequestOperation} preparation
 * @returns {Promise<Record<string, unknown>>}
 */
async function runLocalPrFinalize(context, runRecord, preparation) {
  const baseBranch = preparation.pullRequest.baseRefName ?? context.config.baseBranch;
  const changedFiles = await context.gitClient.getChangedFilesSinceBase({ baseBranch });
  const commits =
    (await context.gitClient.getCommitsSinceBase?.({ baseBranch })) ??
    /** @type {GitCommit[]} */ ([]);
  const prompt = buildLocalPrFinalizePrompt({
    pullRequest: preparation.pullRequest,
    issue: preparation.issue,
    reviewContext: preparation.reviewContext,
    changedFiles,
    commits,
  });
  const validation = await runLocalRunnerStep(context, runRecord, {
    operationReference: 'pr:finalize',
    prompt,
    validate: validatePrFinalizeOutput,
  });

  if (!validation.valid) {
    return await blockLocalPullRequestOperation(context, runRecord, {
      pullRequest: preparation.pullRequest,
      reason: `Invalid PR Finalize Output: ${validation.reason}`,
    });
  }

  if (validation.value.status === 'blocked') {
    return await completeLocalPullRequestRunRecord(runRecord, {
      status: 'blocked',
      summary: validation.value.summary,
      operation: 'pr:finalize',
      pullRequest: formatPullRequest(preparation.pullRequest),
      failureReason: validation.value.failureReason,
    });
  }

  const commitPlan = validatePlannerCommitPlan({
    plannedCommits: validation.value.commitPlan.commits,
    changedFiles,
  });
  if (!commitPlan.valid) {
    return await blockLocalPullRequestOperation(context, runRecord, {
      pullRequest: preparation.pullRequest,
      reason: `Invalid PR Finalize Planner Output: ${commitPlan.reason}`,
    });
  }

  await writeLocalPullRequestRunArtifact(
    runRecord,
    'planned-commits.json',
    `${JSON.stringify(commitPlan.commits, null, 2)}\n`,
  );

  return await completeLocalPullRequestRunRecord(runRecord, {
    status: 'planned',
    summary: `Planned local dry-run pr:finalize for PR #${preparation.pullRequest.number}.`,
    operation: 'pr:finalize',
    pullRequest: formatPullRequest(preparation.pullRequest),
    prFinalize: {
      plannedCommits: commitPlan.commits.length,
      followUps: validation.value.followUps,
    },
  });
}

/**
 * @param {{
 *   pullRequest: GitHubPullRequest,
 *   issue: GitHubIssue,
 *   reviewContext: GitHubPullRequestReviewContext,
 *   changedFiles: string[],
 *   commits: GitCommit[],
 * }} options
 * @returns {string}
 */
function buildLocalPrFinalizePrompt({ pullRequest, issue, reviewContext, changedFiles, commits }) {
  return [
    'Use the pullops-pr-finalize skill.',
    '',
    `Goal: propose the Logical Commit Stack for local dry-run PR Finalize of PR #${pullRequest.number} — commit grouping and messages only: ${pullRequest.title}`,
    '',
    'Planner scope:',
    '- You are a planner: propose commit grouping and commit messages only. Do not edit files, run commands, create commits, reset, stage, push, edit labels, update PR bodies, change review state, change checks, change draft state, post GitHub comments, or merge the pull request.',
    '- PullOps will validate the output and keep the result in the Local Run Record.',
    '',
    'Linked issue or Spec context:',
    [`Issue #${issue.number}: ${issue.title}`, issue.body.trim() || '(empty)'].join('\n'),
    '',
    'Pull request body:',
    pullRequest.body.trim() || '(empty)',
    '',
    'Changed files that must be assigned exactly once:',
    formatLocalPlannerStringList(changedFiles),
    '',
    'Changed file summary:',
    formatLocalPlannerReviewFiles(reviewContext),
    '',
    'Current commits since base:',
    formatLocalPlannerCommits(commits),
    '',
    'Boundaries:',
    '- Include commitPlan.justification when the grouping is not obvious.',
    `- Commit headers are conventional commit headers, and footers include a relevant Refs: #<issue> footer, usually Refs: #${issue.number}.`,
    '- Return blocked if you cannot propose a safe grouping from the supplied information.',
    '',
    'Final response must be only JSON in this shape:',
    JSON.stringify(
      {
        status: 'planned',
        summary: 'One sentence summary of the history grouping plan.',
        commitPlan: {
          commits: [
            {
              header: 'feat(issue): implement #42',
              body: ['Explain the logical change in this commit.'],
              footers: ['Refs: #42'],
              files: ['src/example.js'],
            },
          ],
        },
        followUps: ['Optional follow-up that should not block this PR.'],
      },
      null,
      2,
    ),
    '',
    'If blocked, return only JSON in this shape:',
    JSON.stringify(
      {
        status: 'blocked',
        summary: 'Short blocked summary.',
        failureReason: 'Specific reason the history grouping plan could not be produced safely.',
      },
      null,
      2,
    ),
  ].join('\n');
}

/**
 * @param {string[]} items
 * @returns {string}
 */
function formatLocalPlannerStringList(items) {
  if (items.length === 0) {
    return '(none)';
  }

  return items.map(item => `- ${item}`).join('\n');
}

/**
 * @param {GitCommit[]} commits
 * @returns {string}
 */
function formatLocalPlannerCommits(commits) {
  if (commits.length === 0) {
    return '(none)';
  }

  return commits
    .map(commit =>
      [
        `- ${commit.sha} ${commit.subject}`,
        `  Files: ${commit.files.length === 0 ? '(none)' : commit.files.join(', ')}`,
        '  Message:',
        indentLocalPlannerValue(commit.body),
      ].join('\n'),
    )
    .join('\n');
}

/**
 * @param {GitHubPullRequestReviewContext} reviewContext
 * @returns {string}
 */
function formatLocalPlannerReviewFiles(reviewContext) {
  if (reviewContext.files.length === 0) {
    return '(none)';
  }

  return reviewContext.files
    .map(file => `- ${file.path} (+${file.additions} / -${file.deletions})`)
    .join('\n');
}

/**
 * @param {string} value
 * @returns {string}
 */
function indentLocalPlannerValue(value) {
  return value
    .split('\n')
    .map(line => `    ${line}`)
    .join('\n');
}

/**
 * `pr-finalize` is deterministic unless ambiguous Parent Issue history needs
 * the narrowed fallback planner. In an external runner workflow, prepare completes
 * deterministic paths and writes a prompt only for that fallback.
 *
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runPrFinalizeExternalRunnerPrepare(context) {
  return await executeOperationPhase(prFinalizeDescriptor, 'prepare', context);
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runPrFinalizeExternalRunnerFinalize(context) {
  return await executeOperationPhase(prFinalizeDescriptor, 'complete', context);
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<import('../runnerLifecycle.types.js').RunnerLifecycleOperation>}
 */
async function createPrFinalizeRunnerOperation(context) {
  const preparation = await preparePrFinalize(context);
  if (!preparation.ready) {
    return { status: 'settled', output: preparation.output };
  }

  if (preparation.mode !== 'planner') {
    return { status: 'settled', output: await completePrFinalize(context, preparation) };
  }

  const localRunStateRecord =
    context.localRunRecordDirectory === undefined
      ? undefined
      : await readLocalRunStateRecordFromDirectory(context.localRunRecordDirectory);

  return {
    status: 'runner',
    prompt: preparation.prompt,
    model: context.model,
    branch: preparation.pullRequest.headRefName,
    runOptions: {
      streamOutput: context.suppressRunnerOutput !== true,
      env: localRunStateRecord?.heartbeatEnvironment,
    },
    waiting: {
      summary: `Prepared external PR Finalize history planner for PR #${preparation.pullRequest.number}.`,
      details: {
        pullRequest: {
          number: preparation.pullRequest.number,
          url: preparation.pullRequest.url,
        },
      },
    },
    finalize: async rawOutput =>
      await completePrFinalizePlannerFallback(context, preparation, rawOutput),
    onRunnerFailure: async error => {
      await recordPullRequestFailure(context, preparation.pullRequest, getErrorMessage(error));
    },
  };
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
      ...(source.sourceKind === 'ticket' ? { parentIssueNumber: source.parentIssueNumber } : {}),
      ...(source.sourceKind === 'parentIssue' ? { tickets: source.tickets } : {}),
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
      tickets: source.tickets,
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
      tickets: source.tickets,
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
    ...(source.sourceKind === 'ticket' ? { parentIssueNumber: source.parentIssueNumber } : {}),
    ...(source.sourceKind === 'parentIssue' ? { tickets: source.tickets } : {}),
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

  const ticketFacts = await readTicketPrFacts(context, {
    sourceIssueNumber,
  });
  const sourceIssue =
    ticketFacts?.sourceIssue ?? (await context.githubClient.getIssue(sourceIssueNumber));
  const ticketBranch = parseTicketBranchName({
    branchPrefix: context.config.branchPrefix,
    branchName: pullRequest.headRefName,
  });
  const targetSpecBranch = parseParentBranchName({
    branchPrefix: context.config.branchPrefix,
    branchName: baseBranch,
  });

  if (ticketFacts !== undefined) {
    return await prepareTicketSource(context, pullRequest, {
      baseBranch,
      ticketBranch,
      ticketFacts,
    });
  }

  if (targetSpecBranch !== undefined) {
    return {
      ready: false,
      output: await blockPullRequest(
        context,
        pullRequest,
        [
          `PR #${pullRequest.number} targets Spec branch "${baseBranch}",`,
          `but source issue #${sourceIssue.number} is not a native ticket of`,
          `Spec issue #${targetSpecBranch.parentNumber}.`,
        ].join(' '),
      ),
    };
  }

  if (ticketBranch !== undefined) {
    return {
      ready: false,
      output: await blockPullRequest(
        context,
        pullRequest,
        [
          `PR #${pullRequest.number} uses Ticket branch "${pullRequest.headRefName}",`,
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
          `but that issue is a native ticket of issue #${sourceIssue.parent.number}.`,
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
          `Umbrella Spec PR #${pullRequest.number} uses head branch`,
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
          `Umbrella Spec PR #${pullRequest.number} targets "${baseBranch}",`,
          `but Parent Issue #${sourceIssue.number} must target default branch`,
          `"${context.config.baseBranch}".`,
        ].join(' '),
      ),
    };
  }

  const openTickets = parentFacts.openTickets;
  if (openTickets.length > 0) {
    return {
      ready: false,
      output: await blockPullRequest(
        context,
        pullRequest,
        [
          `Umbrella Spec PR #${pullRequest.number} is incomplete because native Tickets`,
          `${formatIssueList(openTickets)} remain open.`,
          'Incomplete specs cannot become merge-ready.',
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
    tickets: parentFacts.tickets,
    closedTickets: parentFacts.closedTickets,
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @param {object} options
 * @param {string} options.baseBranch
 * @param {{ parentNumber: number, issueNumber: number } | undefined} options.ticketBranch
 * @param {import('../../spec-automation/ticketCoordination.types.js').TicketPrFacts} options.ticketFacts
 * @returns {Promise<PrFinalizeSource>}
 */
async function prepareTicketSource(
  context,
  pullRequest,
  { baseBranch, ticketBranch, ticketFacts },
) {
  const { expectedBaseBranch, expectedTicketBranch, parentIssueNumber, sourceIssue } = ticketFacts;

  if (baseBranch === context.config.baseBranch) {
    return {
      ready: false,
      output: await blockPullRequest(
        context,
        pullRequest,
        [
          `Ticket #${sourceIssue.number} belongs to Spec issue #${parentIssueNumber},`,
          `but PR #${pullRequest.number} targets default branch "${context.config.baseBranch}".`,
          `It must target Spec branch "${expectedBaseBranch}".`,
        ].join(' '),
      ),
    };
  }

  if (ticketBranch === undefined) {
    return {
      ready: false,
      output: await blockPullRequest(
        context,
        pullRequest,
        [
          `Ticket PR #${pullRequest.number} uses head branch "${pullRequest.headRefName}",`,
          `but native Ticket #${sourceIssue.number} in Spec issue #${parentIssueNumber}`,
          `must use "${expectedTicketBranch}".`,
        ].join(' '),
      ),
    };
  }

  if (
    ticketBranch.issueNumber !== sourceIssue.number ||
    ticketBranch.parentNumber !== parentIssueNumber
  ) {
    return {
      ready: false,
      output: await blockPullRequest(
        context,
        pullRequest,
        [
          `Ticket PR #${pullRequest.number} head branch "${pullRequest.headRefName}"`,
          `does not match native Ticket #${sourceIssue.number} in`,
          `Spec issue #${parentIssueNumber}.`,
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
          `Ticket PR #${pullRequest.number} targets "${baseBranch}",`,
          `but native Ticket #${sourceIssue.number} must target`,
          `Spec branch "${expectedBaseBranch}".`,
        ].join(' '),
      ),
    };
  }

  return {
    ready: true,
    sourceKind: 'ticket',
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
          source.sourceKind === 'ticket' ? source.parentIssueNumber : undefined,
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
    closedTickets: source.closedTickets,
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
            `Umbrella Spec PR #${pullRequest.number} has no changed files to finalize.`,
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
          closedTickets: source.closedTickets,
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
        `Umbrella Spec PR #${pullRequest.number} has no ticket work to finalize.`,
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
 * @param {GitHubIssueReference[]} options.closedTickets
 * @returns {{ valid: true, commits: PlannedRewriteCommit[], existingCommitShas?: string[] } | { valid: false, reason: string, fallbackAllowed?: boolean }}
 */
function analyzeParentIssueHistory({ commits, parentIssueNumber, closedTickets }) {
  const closedTicketNumbers = new Set(closedTickets.map(ticket => ticket.number));
  /** @type {Map<number, Set<string>>} */
  const filesByTicket = new Map();
  /** @type {Array<{ ticketNumber: number, commit: GitCommit }>} */
  const ticketCommitEntries = [];
  /** @type {PlannedRewriteCommit[]} */
  const parentLevelCommits = [];

  for (const commit of commits) {
    const ticketNumber = readTicketNumberFromCommit({
      commit,
      parentIssueNumber,
      closedTicketNumbers,
    });

    if (ticketNumber !== undefined) {
      const files = filesByTicket.get(ticketNumber) ?? new Set();
      for (const file of commit.files) {
        files.add(file);
      }
      filesByTicket.set(ticketNumber, files);
      ticketCommitEntries.push({ ticketNumber, commit });
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
        `Umbrella Spec history contains commit ${commit.sha} that is not traceable to`,
        `a closed native Ticket of Spec #${parentIssueNumber} or explicit Spec-level work.`,
      ].join(' '),
      fallbackAllowed: true,
    };
  }

  const missingTickets = closedTickets.filter(ticket => !filesByTicket.has(ticket.number));
  if (missingTickets.length > 0) {
    return {
      valid: false,
      reason: [
        `Umbrella Spec history is missing closed native Tickets`,
        `${formatIssueList(missingTickets)}.`,
        'Closed ticket work cannot be omitted from the finalized Spec branch.',
      ].join(' '),
    };
  }

  const overlappingTicketFiles = findOverlappingTicketFiles(filesByTicket);
  if (overlappingTicketFiles.length > 0) {
    const reusableHistory = findReusableExistingTicketHistory({
      ticketCommitEntries,
      parentLevelCommits,
      parentIssueNumber,
      closedTickets,
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
        'Umbrella Spec history contains overlapping Ticket file edits:',
        `${formatOverlappingTicketFiles(overlappingTicketFiles)}.`,
        'PullOps can finalize overlapping ticket edits only when the existing history',
        'already contains one deterministic Ticket Commit per closed native Ticket',
        `in native Ticket order. ${reusableHistory.reason}`,
      ].join(' '),
    };
  }

  return {
    valid: true,
    commits: [
      ...parentLevelCommits,
      ...closedTickets.map(ticket => ({
        message: createPrFinalizeParentTicketCommitMessage(parentIssueNumber, ticket),
        files: [...(filesByTicket.get(ticket.number) ?? [])],
      })),
    ],
  };
}

/**
 * @param {Map<number, Set<string>>} filesByTicket
 * @returns {Array<{ file: string, ticketNumbers: number[] }>}
 */
function findOverlappingTicketFiles(filesByTicket) {
  /** @type {Map<string, number[]>} */
  const ticketNumbersByFile = new Map();

  for (const [ticketNumber, files] of filesByTicket.entries()) {
    for (const file of files) {
      const ticketNumbers = ticketNumbersByFile.get(file) ?? [];
      ticketNumbers.push(ticketNumber);
      ticketNumbersByFile.set(file, ticketNumbers);
    }
  }

  return [...ticketNumbersByFile.entries()]
    .filter(([, ticketNumbers]) => ticketNumbers.length > 1)
    .map(([file, ticketNumbers]) => ({ file, ticketNumbers }));
}

/**
 * @param {object} options
 * @param {Array<{ ticketNumber: number, commit: GitCommit }>} options.ticketCommitEntries
 * @param {PlannedRewriteCommit[]} options.parentLevelCommits
 * @param {number} options.parentIssueNumber
 * @param {GitHubIssueReference[]} options.closedTickets
 * @returns {{ valid: true, commitShas: string[] } | { valid: false, reason: string }}
 */
function findReusableExistingTicketHistory({
  ticketCommitEntries,
  parentLevelCommits,
  parentIssueNumber,
  closedTickets,
}) {
  if (parentLevelCommits.length > 0) {
    return {
      valid: false,
      reason: 'The existing history also contains explicit Spec-level file changes.',
    };
  }

  if (ticketCommitEntries.length !== closedTickets.length) {
    return {
      valid: false,
      reason: [
        `The existing history has ${ticketCommitEntries.length} Ticket commits,`,
        `but Spec #${parentIssueNumber} has ${closedTickets.length} closed native Tickets.`,
      ].join(' '),
    };
  }

  for (const [index, ticket] of closedTickets.entries()) {
    const entry = ticketCommitEntries[index];
    if (entry === undefined || entry.ticketNumber !== ticket.number) {
      return {
        valid: false,
        reason: [
          `The existing Ticket commit order is ${formatTicketCommitOrder(ticketCommitEntries)},`,
          `but native Ticket order is ${formatIssueList(closedTickets)}.`,
        ].join(' '),
      };
    }

    const expectedMessage = createPrFinalizeParentTicketCommitMessage(parentIssueNumber, ticket);
    if (entry.commit.body !== expectedMessage) {
      return {
        valid: false,
        reason: [
          `Commit ${entry.commit.sha} for Ticket #${ticket.number}`,
          'does not match the deterministic PR Finalize commit message.',
        ].join(' '),
      };
    }
  }

  return {
    valid: true,
    commitShas: ticketCommitEntries.map(entry => entry.commit.sha),
  };
}

/**
 * @param {Array<{ file: string, ticketNumbers: number[] }>} overlappingTicketFiles
 * @returns {string}
 */
function formatOverlappingTicketFiles(overlappingTicketFiles) {
  return overlappingTicketFiles
    .map(
      ({ file, ticketNumbers }) =>
        `${file} (${ticketNumbers.map(issueNumber => `#${issueNumber}`).join(', ')})`,
    )
    .join('; ');
}

/**
 * @param {Array<{ ticketNumber: number }>} ticketCommitEntries
 * @returns {string}
 */
function formatTicketCommitOrder(ticketCommitEntries) {
  if (ticketCommitEntries.length === 0) {
    return 'none';
  }

  return ticketCommitEntries.map(entry => `#${entry.ticketNumber}`).join(', ');
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
    operation: requireOperationCatalogOperationLabelName('pr-finalize'),
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
    ticketNumbers: preparation.tickets.map(ticket => ticket.number),
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
      tickets: preparation.tickets,
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
      tickets: preparation.tickets,
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
    tickets: preparation.tickets,
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
    tickets: preparation.tickets,
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
      `Finalize Ticket #${sourceIssueNumber} for rebase merge into Spec #${parentIssueNumber}.`,
      '',
      `Refs: #${sourceIssueNumber}`,
      `Spec: #${parentIssueNumber}`,
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
 * @param {GitHubIssueReference} ticket
 * @returns {string}
 */
export function createPrFinalizeParentTicketCommitMessage(parentIssueNumber, ticket) {
  return [
    `feat(issue): implement #${ticket.number}`,
    '',
    `Finalize Ticket #${ticket.number} for rebase merge into Spec #${parentIssueNumber}.`,
    '',
    `Refs: #${ticket.number}`,
    `Spec: #${parentIssueNumber}`,
  ].join('\n');
}

/**
 * @param {PrFinalizeSource & { ready: true }} source
 * @returns {number}
 */
function countExpectedFinalizedCommits(source) {
  if (source.sourceKind === 'parentIssue') {
    return source.closedTickets.length;
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
 * @param {Set<number>} options.closedTicketNumbers
 * @returns {number | undefined}
 */
function readTicketNumberFromCommit({ commit, parentIssueNumber, closedTicketNumbers }) {
  if (!commitReferencesSpec(commit, parentIssueNumber)) {
    return undefined;
  }

  const refs = readReferencedIssueNumbers(commit.body);
  return refs.find(issueNumber => closedTicketNumbers.has(issueNumber));
}

/**
 * @param {GitCommit} commit
 * @param {number} parentIssueNumber
 * @returns {boolean}
 */
function isParentLevelCommit(commit, parentIssueNumber) {
  const refs = readReferencedIssueNumbers(commit.body);
  return refs.includes(parentIssueNumber) && !commit.body.includes(`Spec: #${parentIssueNumber}`);
}

/**
 * @param {GitCommit} commit
 * @param {number} parentIssueNumber
 * @returns {boolean}
 */
function commitReferencesSpec(commit, parentIssueNumber) {
  return new RegExp(`^Spec:\\s+#${parentIssueNumber}\\s*$`, 'im').test(commit.body);
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
 * @param {GitHubIssueReference[] | undefined} options.tickets
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
    tickets,
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
    tickets,
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
    operation: requireOperationCatalogOperationLabelName('pr-finalize'),
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
      operation: requireOperationCatalogOperationLabelName('pr-finalize'),
      summary: readySummary,
    });
  }

  const specAutomation =
    parentIssueNumber === undefined
      ? undefined
      : context.resumeParentSpecAutomationAfterPrFinalize === false
        ? undefined
        : await resumeSpecAutomationForParentIssue(context, parentIssueNumber);

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
    ...(specAutomation === undefined ? {} : { specAutomation }),
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
    operation: requireOperationCatalogOperationLabelName('pr-finalize'),
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
      routedTo: requireOperationCatalogOperationLabelName('pr-review'),
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
    operation: requireOperationCatalogOperationLabelName('pr-finalize'),
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
      routedTo: requireOperationCatalogOperationLabelName('pr-fix-ci'),
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
      operation: requireOperationCatalogOperationLabelName('pr-finalize'),
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
      operation: requireOperationCatalogOperationLabelName('pr-finalize'),
      reason,
    });
    return;
  }

  await applyManagedPrTransition({
    githubClient: context.githubClient,
    outputDirectory: context.outputDirectory,
    pullRequest,
    operation: requireOperationCatalogOperationLabelName('pr-finalize'),
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
