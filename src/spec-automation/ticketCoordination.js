import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { classifyCheckState } from '../checks/checkState.js';
import { PULL_OPS_STATUS_LABELS } from '../labels/pullOpsLabels.js';
import {
  hasActiveManagedPrWorkflow,
  isFinalizedForRebase,
  readManagedPrState,
  requestManagedPrReview,
  resumeManagedPrWorkflow,
} from '../managed-pr/ManagedPrState.js';
import {
  chooseNextManagedPrOperationFromState,
  getNextManagedPrOperation,
} from '../managed-pr/transitionPolicy.js';
import {
  createIssueBranchName,
  createParentBranchName,
  parseTicketBranchName,
} from '../operations/branchNames.js';
import { GITHUB_ACTIONS_BOT_AUTHOR } from '../operations/githubActionsBot.js';
import { requireOperationCatalogOperationLabelName } from '../operations/operationCatalog.js';
import {
  createLocalSpecAutoCompleteTicketProgressEvent,
  createLocalSpecAutoCompleteParentWaitingEvent,
  createLocalSpecAutoCompletePhaseCompletedEvent,
} from '../operations/spec-automation/eventStream.js';
import { createIssueSnapshot } from '../issue-store/issueSnapshot.js';
import {
  createSpecPreparePullRequestBodyForIssue,
  runSpecPrepare,
} from '../operations/spec-prepare/run.js';
import {
  DEFAULT_LOCAL_RUN_HEARTBEAT_INTERVAL_MS,
  DEFAULT_LOCAL_RUN_LEASE_DURATION_MS,
  LOCAL_RUN_HEARTBEAT_COMMAND,
} from '../run-supervision/runSupervision.js';
import {
  createLocalRunLink,
  initializeLocalRunState,
  mapLocalRunResultStatusToTerminalStatus,
  recordLocalRunChildRun,
  recordLocalRunTerminalStatus,
  recordLocalRunWaitingForRunner,
} from '../local-run-state/localRunState.js';
import {
  createRunRecordLocation,
  normalizeOperationReferenceForPath,
} from '../local-run-record/localRunRecord.js';
import { startPullOpsParentEventSink } from '../parent-event-sink/parentEventSink.js';
import {
  createExternalRunnerJobReference,
  isExecutableExternalRunnerJob,
  isExternalRunnerWaitingOutput,
} from '../runner/externalRunnerHandoff.js';

/**
 * @typedef {import('../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('../github/types.js').GitHubIssueReference} GitHubIssueReference
 * @typedef {import('../github/types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('./ticketCoordination.types.js').TicketAutomationResult} TicketAutomationResult
 * @typedef {import('./ticketCoordination.types.js').TicketDependencyDecision} TicketDependencyDecision
 * @typedef {import('./ticketCoordination.types.js').TicketCloseResult} TicketCloseResult
 * @typedef {import('./ticketCoordination.types.js').TicketRunner} TicketRunner
 * @typedef {import('./ticketCoordination.types.js').TicketPrFacts} TicketPrFacts
 * @typedef {import('./ticketCoordination.types.js').IssueWorkTarget} IssueWorkTarget
 * @typedef {import('./ticketCoordination.types.js').ParentIssueFacts} ParentIssueFacts
 * @typedef {import('./ticketCoordination.types.js').ParentReviewResult} ParentReviewResult
 * @typedef {import('./ticketCoordination.types.js').SpecAutomationMode} SpecAutomationMode
 * @typedef {import('./ticketCoordination.types.js').SpecAutomationResult} SpecAutomationResult
 * @typedef {import('../local-run-state/types.js').LocalRunRecord} LocalRunRecord
 * @typedef {import('../local-run-state/types.js').LocalRunChildRun} LocalRunChildRun
 * @typedef {import('../local-run-state/types.js').LocalRunRunLink} LocalRunRunLink
 * @typedef {import('../parent-event-sink/types.js').PullOpsParentEventSink} PullOpsParentEventSink
 * @typedef {'pr-review' | 'pr-address-review' | 'pr-fix-ci' | 'pr-resolve-conflicts' | 'pr-finalize'} PullRequestOperationName
 * @typedef {{
 *   pullRequestNumber: number,
 *   operation: PullRequestOperationName,
 *   parentRun?: LocalRunRunLink,
 * }} PullRequestOperationRequest
 */

/** @type {ReadonlySet<string>} */
const ACTIVE_CHILD_ISSUE_LABELS = new Set([
  requireOperationCatalogOperationLabelName('issue-implement'),
]);

// Runaway guard only. Managed PR review/address-review budgets are enforced by
// the PR operations through the managed PR state stored in the pull request body.
const MAX_PUBLISHED_UMBRELLA_PARENT_OPERATION_STEPS = 25;

/**
 * @param {OperationRunnerContext} context
 * @param {{ parentIssueNumber: number, mode: SpecAutomationMode }} options
 * @returns {Promise<SpecAutomationResult>}
 */
export async function coordinateSpecAutomation(context, { parentIssueNumber, mode }) {
  const parentIssue = await context.githubClient.getIssue(parentIssueNumber);
  return await coordinateParentIssue(context, { parentIssue, mode });
}

/**
 * @param {OperationRunnerContext} context
 * @param {object} options
 * @param {number} options.parentIssueNumber
 * @param {TicketRunner} options.runTicket
 * @param {(request: PullRequestOperationRequest) => Promise<Record<string, unknown>>} [options.runParentPullRequestOperation]
 * @param {(request: PullRequestOperationRequest) => Promise<Record<string, unknown>>} [options.runTicketPullRequestOperation]
 * @returns {Promise<SpecAutomationResult>}
 */
export async function coordinateLocalSpecAutoAdvance(
  context,
  { parentIssueNumber, runTicket, runParentPullRequestOperation, runTicketPullRequestOperation },
) {
  return await coordinateLocalSpecAutomation(context, {
    parentIssueNumber,
    mode: 'auto-advance',
    runTicket,
    runParentPullRequestOperation,
    runTicketPullRequestOperation,
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {object} options
 * @param {number} options.parentIssueNumber
 * @param {TicketRunner} options.runTicket
 * @param {(request: PullRequestOperationRequest) => Promise<Record<string, unknown>>} [options.runParentPullRequestOperation]
 * @param {(request: PullRequestOperationRequest) => Promise<Record<string, unknown>>} [options.runTicketPullRequestOperation]
 * @returns {Promise<SpecAutomationResult>}
 */
export async function coordinateLocalSpecAutoComplete(
  context,
  { parentIssueNumber, runTicket, runParentPullRequestOperation, runTicketPullRequestOperation },
) {
  return await coordinateLocalSpecAutomation(context, {
    parentIssueNumber,
    mode: 'auto-complete',
    runTicket,
    runParentPullRequestOperation,
    runTicketPullRequestOperation,
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {object} options
 * @param {number} options.parentIssueNumber
 * @param {SpecAutomationMode} options.mode
 * @param {TicketRunner} options.runTicket
 * @param {(request: PullRequestOperationRequest) => Promise<Record<string, unknown>>} [options.runParentPullRequestOperation]
 * @param {(request: PullRequestOperationRequest) => Promise<Record<string, unknown>>} [options.runTicketPullRequestOperation]
 * @returns {Promise<SpecAutomationResult>}
 */
async function coordinateLocalSpecAutomation(
  context,
  {
    parentIssueNumber,
    mode,
    runTicket,
    runParentPullRequestOperation,
    runTicketPullRequestOperation,
  },
) {
  const publicationMode = context.publicationMode ?? 'dry-run';
  const operationReference = readLocalSpecOperationReference(mode);
  const runRecord = await createLocalSpecRunRecord(context, {
    operationReference,
    targetNumber: parentIssueNumber,
    publicationMode,
  });
  const parentRun = runRecord.runLink;
  const parentEventSink = await maybeStartLocalSpecParentEventSink(context, { mode, parentRun });
  const runContext = parentEventSink === undefined ? context : { ...context, parentEventSink };

  try {
    await emitLocalSpecAutoCompleteRunStarted(runContext, parentIssueNumber);
    await emitLocalSpecAutoCompletePhaseStarted(runContext, parentIssueNumber);
    await requireCleanLocalSpecWorktree(runContext, runRecord, {
      operationReference,
      parentIssueNumber,
      mode,
      publicationMode,
    });
    const parentIssue = await runContext.githubClient.getIssue(parentIssueNumber);
    if (parentIssue.state !== 'OPEN') {
      await emitLocalSpecAutoCompletePhaseCompleted(runContext, [], parentIssue.number);
      return await completeLocalSpecRunRecord(runRecord, {
        status: 'skipped',
        summary: `Spec issue #${parentIssue.number} is ${parentIssue.state.toLowerCase()}.`,
        issue: parentIssue.number,
        mode,
      });
    }

    const nativeParentIssueNumber = getNativeParentIssueNumber(parentIssue);
    if (nativeParentIssueNumber !== undefined) {
      const result = await refuseLocalSpecAutomation(runRecord, parentIssue, {
        reason: [
          `Issue #${parentIssue.number} is already part of parent issue #${nativeParentIssueNumber}.`,
          'Spec automation can only run on a Parent Issue.',
        ].join(' '),
        mode,
        publicationMode,
      });
      await emitLocalSpecAutoCompletePhaseCompleted(runContext, [], parentIssue.number);
      return await completeLocalSpecRunRecord(runRecord, result);
    }

    const parentBranchName = createParentBranchName({
      branchPrefix: runContext.config.branchPrefix,
      parentNumber: parentIssue.number,
    });
    const preparation = await prepareLocalSpecAutomation(runContext, parentIssue, {
      parentBranchName,
      publicationMode,
    });
    const tickets = await readNativeTickets(runContext, parentIssue);
    /** @type {TicketAutomationResult[]} */
    const ticketResults = [];
    /** @type {number[]} */
    let virtualCompletedTickets = [];
    let preserveInspectableBranchState = false;
    const completeThroughDependencyFrontiers =
      mode === 'auto-complete' && runContext.runGoal !== 'operation';

    if (publicationMode === 'publish') {
      await checkoutLocalSpecBase(runContext, { parentBranchName });
    }

    if (completeThroughDependencyFrontiers && publicationMode === 'dry-run') {
      const dryRun = await coordinateLocalAutoCompleteDryRunTickets(runContext, {
        parentIssue,
        parentBranchName,
        tickets,
        parentRun,
        runTicket,
      });
      ticketResults.push(...dryRun.ticketResults);
      virtualCompletedTickets = dryRun.virtualCompletedTickets;
      preserveInspectableBranchState = dryRun.preserveInspectableBranchState;
    } else if (completeThroughDependencyFrontiers && publicationMode === 'publish') {
      const published = await coordinateLocalAutoCompletePublishTickets(runContext, {
        parentIssue,
        parentBranchName,
        tickets,
        parentRun,
        runTicket,
        runTicketPullRequestOperation,
      });
      ticketResults.push(...published.ticketResults);
      preserveInspectableBranchState = published.preserveInspectableBranchState;
    } else {
      for (const ticket of tickets) {
        await emitLocalSpecAutoCompleteTicketStarted(runContext, ticket);
        const localResult = await coordinateLocalTicket(runContext, {
          parentIssue,
          parentBranchName,
          ticket,
          parentRun,
          mode: completeThroughDependencyFrontiers ? mode : 'auto-advance',
          publicationMode,
          runTicket,
          runTicketPullRequestOperation,
        });
        await recordLocalSpecTicketResult(runContext, ticketResults, localResult.ticketResult);
        preserveInspectableBranchState =
          preserveInspectableBranchState ||
          shouldPreserveInspectableBranchState(localResult.ticketResult);

        if (
          publicationMode === 'publish' &&
          localResult.restoreSpecBase &&
          !preserveInspectableBranchState
        ) {
          await checkoutLocalSpecBase(runContext, { parentBranchName });
        }

        if (completeThroughDependencyFrontiers && localResult.stop) {
          break;
        }
      }
    }

    const refreshedPreparation =
      publicationMode === 'publish' && didIntegrateTicketWork(ticketResults)
        ? await ensureSpecPrepared(runContext, parentIssue, { forceRefresh: true })
        : preparation;

    if (publicationMode === 'publish' && !preserveInspectableBranchState) {
      await checkoutLocalSpecBase(runContext, { parentBranchName });
    }

    const parentReviewFacts =
      completeThroughDependencyFrontiers && publicationMode === 'dry-run'
        ? createLocalDryRunParentReviewFacts({ parentIssue, tickets, ticketResults })
        : { parentIssue, tickets };
    const parentPullRequest =
      completeThroughDependencyFrontiers &&
      publicationMode === 'publish' &&
      !preserveInspectableBranchState
        ? await completePublishedLocalUmbrellaPullRequest(runContext, {
            parentIssue,
            parentIssueNumber: parentIssue.number,
            parentBranchName,
            tickets,
            parentRun,
            runParentPullRequestOperation,
          })
        : await requestUmbrellaReviewIfComplete(runContext, {
            parentIssue: parentReviewFacts.parentIssue,
            parentIssueNumber: parentIssue.number,
            parentBranchName,
            tickets: parentReviewFacts.tickets,
            requestReview: false,
          });

    await emitLocalSpecAutoCompletePhaseCompleted(runContext, ticketResults, parentIssue.number);
    await emitLocalSpecAutoCompleteParentWaiting(runContext, parentPullRequest);
    const waitingRunnerJob = readWaitingRunnerJob({ ticketResults, parentPullRequest });

    return await completeLocalSpecRunRecord(runRecord, {
      status: waitingRunnerJob === undefined ? 'accepted' : 'waiting',
      summary: summarizeLocalSpecAutomation({
        mode,
        parentIssue,
        ticketResults,
        publicationMode,
      }),
      mode,
      issue: {
        number: parentIssue.number,
        url: parentIssue.url,
      },
      preparation: refreshedPreparation,
      tickets: ticketResults.map(compactTicketResultRunnerJob),
      parentPullRequest: compactParentResultRunnerJob(parentPullRequest),
      publicationMode,
      branch: parentBranchName,
      virtualCompletedTickets,
      remainingBlockedTickets: ticketResults
        .filter(ticketResult => ticketResult.status === 'blocked')
        .map(ticketResult => ticketResult.issue.number),
      localNextSteps: buildLocalNextSteps({
        mode,
        ticketResults,
        publicationMode,
        parentPullRequest,
      }),
      ...(waitingRunnerJob === undefined ? {} : { runnerJob: waitingRunnerJob }),
    });
  } catch (error) {
    await writeLocalSpecRunArtifact(runRecord, 'error.txt', `${getErrorMessage(error)}\n`);
    const terminalStatus = readKnownLocalSpecRunBoundaryTerminalStatus(error) ?? 'failed';
    await recordLocalRunTerminalStatus({
      statePath: runRecord.statePath,
      status: terminalStatus,
      summary: getErrorMessage(error),
      phase: 'run',
    });
    throw attachLocalRunRecordToError(error, runRecord.directory);
  } finally {
    await parentEventSink?.close();
  }
}

/**
 * @param {OperationRunnerContext} context
 * @param {number} parentIssueNumber
 * @returns {Promise<SpecAutomationResult>}
 */
export async function resumeSpecAutomationForParentIssue(context, parentIssueNumber) {
  const parentIssue = await context.githubClient.getIssue(parentIssueNumber);
  const mode = readSpecAutomationMode(parentIssue.labels);

  if (mode === undefined) {
    return {
      status: 'skipped',
      summary: `Spec issue #${parentIssue.number} has no active Spec automation mode label.`,
      issue: parentIssue.number,
    };
  }

  return await coordinateParentIssue(context, { parentIssue, mode });
}

/**
 * @param {OperationRunnerContext} context
 * @param {{ issueNumber: number }} options
 * @returns {Promise<IssueWorkTarget>}
 */
export async function readIssueWorkTarget(context, { issueNumber }) {
  const issue = await context.githubClient.getIssue(issueNumber);
  const parentIssueNumber = getNativeParentIssueNumber(issue);
  const branchName = createIssueBranchName({
    branchPrefix: context.config.branchPrefix,
    issueNumber: issue.number,
    parentNumber: parentIssueNumber,
  });
  const baseBranch =
    parentIssueNumber === undefined
      ? context.config.baseBranch
      : createParentBranchName({
          branchPrefix: context.config.branchPrefix,
          parentNumber: parentIssueNumber,
        });

  return {
    issue,
    parentIssueNumber,
    branchName,
    baseBranch,
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {{ issue: GitHubIssue }} options
 * @returns {Promise<GitHubIssue[]>}
 */
export async function readBlockingDependencies(context, { issue }) {
  return await findBlockingDependencies(context, issue);
}

/**
 * @param {OperationRunnerContext} context
 * @param {{ pullRequestNumber: number }} options
 * @returns {Promise<TicketCloseResult>}
 */
export async function closeMergedTicketPullRequest(context, { pullRequestNumber }) {
  const pullRequest = await context.githubClient.getPullRequest(pullRequestNumber);
  if (pullRequest.isCrossRepository === true) {
    return skipped(pullRequest, `PR #${pullRequest.number} is not a same-repository PR.`);
  }

  const ticketBranch = parseTicketBranchName({
    branchPrefix: context.config.branchPrefix,
    branchName: pullRequest.headRefName,
  });

  if (ticketBranch === undefined) {
    return skipped(pullRequest, `PR #${pullRequest.number} is not a Spec ticket PR.`);
  }

  const expectedBaseBranch = createParentBranchName({
    branchPrefix: context.config.branchPrefix,
    parentNumber: ticketBranch.parentNumber,
  });

  if (pullRequest.baseRefName !== expectedBaseBranch) {
    return skipped(
      pullRequest,
      `PR #${pullRequest.number} does not target expected Spec branch ${expectedBaseBranch}.`,
    );
  }

  if (!isMergedPullRequest(pullRequest)) {
    return skipped(pullRequest, `PR #${pullRequest.number} is not merged.`);
  }

  const issue = await context.githubClient.getIssue(ticketBranch.issueNumber);
  const actualParentIssueNumber = getNativeParentIssueNumber(issue);

  if (actualParentIssueNumber !== ticketBranch.parentNumber) {
    return skipped(
      pullRequest,
      [
        `Issue #${issue.number} is not part of Spec issue #${ticketBranch.parentNumber}.`,
        'PullOps will not close it from this ticket PR.',
      ].join(' '),
    );
  }

  const alreadyClosed = issue.state === 'CLOSED';
  if (!alreadyClosed) {
    await closeTicket(context, {
      issue,
      pullRequest,
      expectedBaseBranch,
    });
  }

  const specAutomation = await resumeSpecAutomationForParentIssue(
    context,
    ticketBranch.parentNumber,
  );
  const parentPullRequest = await requestUmbrellaReviewIfComplete(context, {
    parentIssueNumber: ticketBranch.parentNumber,
  });

  return {
    status: 'accepted',
    summary: alreadyClosed
      ? `Ticket issue #${issue.number} is already closed.`
      : `Closed ticket #${issue.number} after PR #${pullRequest.number} merged into ${expectedBaseBranch}.`,
    issue: {
      number: issue.number,
      url: issue.url,
    },
    pullRequest: formatPullRequest(pullRequest),
    specAutomation,
    parentPullRequest,
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {{ parentIssueNumber: number }} options
 * @returns {Promise<ParentIssueFacts>}
 */
export async function readParentIssueFacts(context, { parentIssueNumber }) {
  const parentIssue = await context.githubClient.getIssue(parentIssueNumber);
  const tickets = parentIssue.subIssues;
  return {
    parentIssue,
    tickets,
    closedTickets: tickets.filter(isClosedIssueReference),
    openTickets: tickets.filter(ticket => !isClosedIssueReference(ticket)),
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {{ sourceIssueNumber: number }} options
 * @returns {Promise<TicketPrFacts | undefined>}
 */
export async function readTicketPrFacts(context, { sourceIssueNumber }) {
  const sourceIssue = await context.githubClient.getIssue(sourceIssueNumber);
  const parentIssueNumber = getNativeParentIssueNumber(sourceIssue);

  if (parentIssueNumber === undefined) {
    return undefined;
  }

  return {
    sourceIssue,
    parentIssueNumber,
    expectedBaseBranch: createParentBranchName({
      branchPrefix: context.config.branchPrefix,
      parentNumber: parentIssueNumber,
    }),
    expectedTicketBranch: createIssueBranchName({
      branchPrefix: context.config.branchPrefix,
      parentNumber: parentIssueNumber,
      issueNumber: sourceIssue.number,
    }),
  };
}

/**
 * @param {GitHubIssue} issue
 * @returns {number | undefined}
 */
export function getNativeParentIssueNumber(issue) {
  return issue.parent?.number;
}

/**
 * @param {OperationRunnerContext} context
 * @param {{ parentIssue: GitHubIssue, mode: SpecAutomationMode }} options
 * @returns {Promise<SpecAutomationResult>}
 */
async function coordinateParentIssue(context, { parentIssue, mode }) {
  if (parentIssue.state !== 'OPEN') {
    return {
      status: 'skipped',
      summary: `Spec issue #${parentIssue.number} is ${parentIssue.state.toLowerCase()}.`,
      issue: parentIssue.number,
      mode,
    };
  }

  const parentIssueNumber = getNativeParentIssueNumber(parentIssue);
  if (parentIssueNumber !== undefined) {
    return await blockSpecAutomation(context, parentIssue, {
      reason: [
        `Issue #${parentIssue.number} is already part of parent issue #${parentIssueNumber}.`,
        'Spec automation can only run on a Parent Issue.',
      ].join(' '),
      mode,
    });
  }

  const parentBranchName = createParentBranchName({
    branchPrefix: context.config.branchPrefix,
    parentNumber: parentIssue.number,
  });
  const preparation = await ensureSpecPrepared(context, parentIssue);
  const tickets = await readNativeTickets(context, parentIssue);
  /** @type {TicketAutomationResult[]} */
  const ticketResults = [];

  for (const ticket of tickets) {
    ticketResults.push(
      await coordinateTicket(context, {
        parentIssue,
        parentBranchName,
        ticket,
        mode,
      }),
    );
  }

  const parentPullRequest = await requestUmbrellaReviewIfComplete(context, {
    parentIssue,
    parentIssueNumber: parentIssue.number,
    parentBranchName,
    tickets,
  });

  return {
    status: 'accepted',
    summary: summarizeSpecAutomation({
      mode,
      parentIssue,
      ticketResults,
      parentPullRequest,
    }),
    mode,
    issue: {
      number: parentIssue.number,
      url: parentIssue.url,
    },
    preparation,
    tickets: ticketResults,
    parentPullRequest,
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubIssue} parentIssue
 * @param {{ forceRefresh?: boolean }} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
async function ensureSpecPrepared(context, parentIssue, { forceRefresh = false } = {}) {
  const branchName = createParentBranchName({
    branchPrefix: context.config.branchPrefix,
    parentNumber: parentIssue.number,
  });
  const existingPullRequest = await context.githubClient.findOpenPullRequestByHead(branchName);
  const existingState =
    existingPullRequest === undefined ? undefined : readManagedPrState(existingPullRequest.body);
  if (
    existingPullRequest !== undefined &&
    existingState !== undefined &&
    !forceRefresh &&
    (isFinalizedForRebase(existingState) ||
      selectLocalParentPullRequestOperation(existingPullRequest) !== 'pr-review')
  ) {
    return {
      status: 'accepted',
      summary: `Umbrella PR #${existingPullRequest.number} for parent issue #${parentIssue.number} is already prepared.`,
      issue: {
        number: parentIssue.number,
        url: parentIssue.url,
      },
      pullRequest: {
        number: existingPullRequest.number,
        url: existingPullRequest.url,
        branch: branchName,
        draft: existingPullRequest.isDraft,
      },
    };
  }

  return await runSpecPrepare({
    ...context,
    operation: 'spec-prepare',
    target: {
      type: 'issue',
      number: parentIssue.number,
    },
  });
}

/**
 * @param {TicketAutomationResult[]} ticketResults
 * @returns {boolean}
 */
function didIntegrateTicketWork(ticketResults) {
  return ticketResults.some(ticketResult => ticketResult.status === 'merged');
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubIssue} parentIssue
 * @param {{ parentBranchName: string, publicationMode: 'dry-run' | 'publish' }} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function prepareLocalSpecAutomation(
  context,
  parentIssue,
  { parentBranchName, publicationMode },
) {
  if (publicationMode === 'publish') {
    return await ensureSpecPrepared(context, parentIssue);
  }

  await checkoutLocalSpecBase(context, { parentBranchName });
  return await inspectLocalSpecPreparation(context, parentIssue, parentBranchName);
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubIssue} parentIssue
 * @param {string} parentBranchName
 * @returns {Promise<Record<string, unknown>>}
 */
async function inspectLocalSpecPreparation(context, parentIssue, parentBranchName) {
  const existingPullRequest =
    await context.githubClient.findOpenPullRequestByHead(parentBranchName);
  if (existingPullRequest !== undefined) {
    return {
      status: 'accepted',
      summary: `Inspected existing umbrella PR #${existingPullRequest.number} for parent issue #${parentIssue.number} without GitHub mutations.`,
      issue: {
        number: parentIssue.number,
        url: parentIssue.url,
      },
      pullRequest: {
        number: existingPullRequest.number,
        url: existingPullRequest.url,
        branch: parentBranchName,
        draft: existingPullRequest.isDraft,
      },
    };
  }

  return {
    status: 'accepted',
    summary: `Prepared local Spec automation context for parent issue #${parentIssue.number} without GitHub mutations.`,
    issue: {
      number: parentIssue.number,
      url: parentIssue.url,
    },
    branch: parentBranchName,
    publicationMode: 'dry-run',
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubIssue} parentIssue
 * @returns {Promise<GitHubIssue[]>}
 */
async function readNativeTickets(context, parentIssue) {
  /** @type {GitHubIssue[]} */
  const tickets = [];

  for (const reference of parentIssue.subIssues) {
    const ticket = await context.githubClient.getIssue(reference.number);
    if (getNativeParentIssueNumber(ticket) === parentIssue.number) {
      tickets.push(ticket);
    }
  }

  return tickets;
}

/**
 * @param {OperationRunnerContext} context
 * @param {object} options
 * @param {GitHubIssue} options.parentIssue
 * @param {string} options.parentBranchName
 * @param {GitHubIssue} options.ticket
 * @param {SpecAutomationMode} options.mode
 * @returns {Promise<TicketAutomationResult>}
 */
async function coordinateTicket(context, { parentIssue, parentBranchName, ticket, mode }) {
  if (ticket.state !== 'OPEN') {
    return createTicketResult({
      issue: ticket,
      status: 'closed',
      summary: `Ticket issue #${ticket.number} is closed.`,
    });
  }

  const parentIssueNumber = getNativeParentIssueNumber(ticket);
  if (parentIssueNumber !== parentIssue.number) {
    return createTicketResult({
      issue: ticket,
      status: 'skipped',
      summary: `Issue #${ticket.number} is not part of Spec issue #${parentIssue.number}.`,
    });
  }

  const blockingDependencies = await findBlockingDependencies(context, ticket);
  if (blockingDependencies.length > 0) {
    return createTicketResult({
      issue: ticket,
      status: 'blocked',
      summary: `Ticket issue #${ticket.number} is blocked by ${formatIssueNumbers(
        blockingDependencies,
      )}.`,
      extra: {
        blockedBy: blockingDependencies.map(issue => issue.number),
      },
    });
  }

  const ticketBranchName = createIssueBranchName({
    branchPrefix: context.config.branchPrefix,
    parentNumber: parentIssue.number,
    issueNumber: ticket.number,
  });
  const pullRequest = await context.githubClient.findOpenPullRequestByHead(ticketBranchName);

  if (pullRequest !== undefined) {
    return await coordinateTicketPullRequest(context, {
      ticket,
      parentIssue,
      parentBranchName,
      pullRequest,
      mode,
    });
  }

  if (hasAnyLabel(ticket.labels, ACTIVE_CHILD_ISSUE_LABELS)) {
    return createTicketResult({
      issue: ticket,
      status: 'already-active',
      summary: `Ticket issue #${ticket.number} already has active PullOps issue automation.`,
      extra: { labels: ticket.labels },
    });
  }

  if (ticket.labels.includes(PULL_OPS_STATUS_LABELS.humanRequired)) {
    return createTicketResult({
      issue: ticket,
      status: 'human-required',
      summary: `Ticket issue #${ticket.number} needs human attention before PullOps automation can continue.`,
      extra: { labels: ticket.labels },
    });
  }

  await context.githubClient.addLabelsToIssue({
    number: ticket.number,
    labels: [requireOperationCatalogOperationLabelName('issue-implement')],
  });

  return createTicketResult({
    issue: ticket,
    status: 'started',
    summary: `Started implementation for unblocked ticket #${ticket.number}.`,
    extra: { branch: ticketBranchName },
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {object} options
 * @param {GitHubIssue} options.parentIssue
 * @param {string} options.parentBranchName
 * @param {GitHubIssue[]} options.tickets
 * @param {LocalRunRunLink} options.parentRun
 * @param {TicketRunner} options.runTicket
 * @returns {Promise<{
 *   ticketResults: TicketAutomationResult[],
 *   virtualCompletedTickets: number[],
 *   preserveInspectableBranchState: boolean,
 * }>}
 */
async function coordinateLocalAutoCompleteDryRunTickets(
  context,
  { parentIssue, parentBranchName, tickets, parentRun, runTicket },
) {
  /** @type {TicketAutomationResult[]} */
  const ticketResults = [];
  /** @type {Set<number>} */
  const pendingIssueNumbers = new Set(tickets.map(ticket => ticket.number));
  /** @type {Set<number>} */
  const virtualCompletedIssueNumbers = new Set();
  /** @type {TicketAutomationResult | undefined} */
  let localBlocker;
  let preserveInspectableBranchState = false;

  while (pendingIssueNumbers.size > 0 && localBlocker === undefined) {
    let progressed = false;

    for (const ticket of tickets) {
      if (!pendingIssueNumbers.has(ticket.number)) {
        continue;
      }

      const dependencyFacts = await readTicketDependencyDecision(context, {
        issue: ticket,
        virtualCompletedIssueNumbers,
      });
      if (
        shouldDeferLocalAutoCompleteTicket({
          parentIssue,
          ticket,
          dependencyFacts,
        })
      ) {
        continue;
      }

      await emitLocalSpecAutoCompleteTicketStarted(context, ticket);
      const alreadyIntegrated = await readAlreadyIntegratedLocalDryRunTicket(context, {
        parentIssue,
        parentBranchName,
        ticket,
        dependencyFacts,
      });
      if (alreadyIntegrated !== undefined) {
        await recordObservedLocalSpecChildRun(context, {
          parentRun,
          ticket,
          ticketResult: alreadyIntegrated,
        });
        await recordLocalDryRunTicketResult(context, {
          ticketResults,
          pendingIssueNumbers,
          virtualCompletedIssueNumbers,
          ticketResult: alreadyIntegrated,
        });
        progressed = true;
        continue;
      }

      const localResult = await coordinateLocalTicket(context, {
        parentIssue,
        parentBranchName,
        parentRun,
        ticket,
        mode: 'auto-complete',
        publicationMode: 'dry-run',
        runTicket,
        dependencyFacts,
      });

      await recordLocalDryRunTicketResult(context, {
        ticketResults,
        pendingIssueNumbers,
        virtualCompletedIssueNumbers,
        ticketResult: localResult.ticketResult,
      });
      preserveInspectableBranchState =
        preserveInspectableBranchState ||
        shouldPreserveInspectableBranchState(localResult.ticketResult);
      progressed = true;

      if (localResult.stop) {
        localBlocker = localResult.ticketResult;
        break;
      }
    }

    if (!progressed) {
      break;
    }
  }

  for (const ticket of tickets) {
    if (!pendingIssueNumbers.has(ticket.number)) {
      continue;
    }

    const dependencyFacts = await readTicketDependencyDecision(context, {
      issue: ticket,
      virtualCompletedIssueNumbers,
    });
    const ticketResult =
      dependencyFacts.blockingDependencies.length > 0
        ? blockedByDependencyTicketResult(ticket, dependencyFacts)
        : blockedByLocalAutoCompletePhaseResult(ticket, localBlocker);
    await emitLocalSpecAutoCompleteTicketStarted(context, ticket);
    await recordObservedLocalSpecChildRun(context, {
      parentRun,
      ticket,
      ticketResult,
    });
    await recordLocalDryRunTicketResult(context, {
      ticketResults,
      pendingIssueNumbers,
      virtualCompletedIssueNumbers,
      ticketResult,
    });
  }

  return {
    ticketResults,
    virtualCompletedTickets: [...virtualCompletedIssueNumbers],
    preserveInspectableBranchState,
  };
}

/**
 * @param {object} options
 * @param {GitHubIssue} options.parentIssue
 * @param {GitHubIssue[]} options.tickets
 * @param {TicketAutomationResult[]} options.ticketResults
 * @returns {{ parentIssue: GitHubIssue, tickets: GitHubIssue[] }}
 */
function createLocalDryRunParentReviewFacts({ parentIssue, tickets, ticketResults }) {
  const completedIssueNumbers = new Set(
    ticketResults
      .filter(isLocalDryRunVirtualCompletion)
      .map(ticketResult => ticketResult.issue.number),
  );

  return {
    parentIssue: {
      ...parentIssue,
      subIssues: parentIssue.subIssues.map(reference =>
        completedIssueNumbers.has(reference.number)
          ? {
              ...reference,
              state: 'CLOSED',
            }
          : reference,
      ),
    },
    tickets: tickets.map(ticket =>
      completedIssueNumbers.has(ticket.number)
        ? {
            ...ticket,
            state: 'CLOSED',
          }
        : ticket,
    ),
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {object} options
 * @param {GitHubIssue} options.parentIssue
 * @param {string} options.parentBranchName
 * @param {GitHubIssue[]} options.tickets
 * @param {LocalRunRunLink} options.parentRun
 * @param {TicketRunner} options.runTicket
 * @param {(request: PullRequestOperationRequest) => Promise<Record<string, unknown>>} [options.runTicketPullRequestOperation]
 * @returns {Promise<{
 *   ticketResults: TicketAutomationResult[],
 *   preserveInspectableBranchState: boolean,
 * }>}
 */
async function coordinateLocalAutoCompletePublishTickets(
  context,
  { parentIssue, parentBranchName, tickets, parentRun, runTicket, runTicketPullRequestOperation },
) {
  /** @type {TicketAutomationResult[]} */
  const ticketResults = [];
  /** @type {Set<number>} */
  const pendingIssueNumbers = new Set(tickets.map(ticket => ticket.number));
  /** @type {TicketAutomationResult | undefined} */
  let localBlocker;
  let preserveInspectableBranchState = false;

  while (pendingIssueNumbers.size > 0 && localBlocker === undefined) {
    let progressed = false;

    for (const ticket of tickets) {
      if (!pendingIssueNumbers.has(ticket.number)) {
        continue;
      }

      const dependencyFacts = await readTicketDependencyDecision(context, {
        issue: ticket,
        virtualCompletedIssueNumbers: new Set(),
      });
      if (
        shouldDeferLocalAutoCompleteTicket({
          parentIssue,
          ticket,
          dependencyFacts,
        })
      ) {
        continue;
      }

      await emitLocalSpecAutoCompleteTicketStarted(context, ticket);
      const localResult = await coordinateLocalTicket(context, {
        parentIssue,
        parentBranchName,
        parentRun,
        ticket,
        mode: 'auto-complete',
        publicationMode: 'publish',
        runTicket,
        runTicketPullRequestOperation,
        dependencyFacts,
      });
      await recordLocalSpecTicketResult(context, ticketResults, localResult.ticketResult);
      pendingIssueNumbers.delete(ticket.number);
      preserveInspectableBranchState =
        preserveInspectableBranchState ||
        shouldPreserveInspectableBranchState(localResult.ticketResult);
      progressed = true;

      if (localResult.restoreSpecBase && !preserveInspectableBranchState) {
        await checkoutLocalSpecBase(context, { parentBranchName });
      }

      if (localResult.stop) {
        localBlocker = localResult.ticketResult;
        break;
      }
    }

    if (!progressed) {
      break;
    }
  }

  for (const ticket of tickets) {
    if (!pendingIssueNumbers.has(ticket.number)) {
      continue;
    }

    const dependencyFacts = await readTicketDependencyDecision(context, {
      issue: ticket,
      virtualCompletedIssueNumbers: new Set(),
    });
    const ticketResult =
      dependencyFacts.blockingDependencies.length > 0
        ? blockedByDependencyTicketResult(ticket, dependencyFacts)
        : blockedByLocalAutoCompletePhaseResult(ticket, localBlocker);
    await emitLocalSpecAutoCompleteTicketStarted(context, ticket);
    await recordObservedLocalSpecChildRun(context, {
      parentRun,
      ticket,
      ticketResult,
    });
    await recordLocalSpecTicketResult(context, ticketResults, ticketResult);
    pendingIssueNumbers.delete(ticket.number);
  }

  return {
    ticketResults,
    preserveInspectableBranchState,
  };
}

/**
 * @param {object} options
 * @param {GitHubIssue} options.parentIssue
 * @param {GitHubIssue} options.ticket
 * @param {{ blockingDependencies: GitHubIssue[] }} options.dependencyFacts
 * @returns {boolean}
 */
function shouldDeferLocalAutoCompleteTicket({ parentIssue, ticket, dependencyFacts }) {
  return (
    ticket.state === 'OPEN' &&
    getNativeParentIssueNumber(ticket) === parentIssue.number &&
    dependencyFacts.blockingDependencies.length > 0
  );
}

/**
 * @param {OperationRunnerContext} context
 * @param {TicketAutomationResult[]} ticketResults
 * @param {TicketAutomationResult} ticketResult
 * @returns {Promise<void>}
 */
async function recordLocalSpecTicketResult(context, ticketResults, ticketResult) {
  ticketResults.push(ticketResult);
  await emitLocalSpecAutoCompleteTicketProgress(context, ticketResult);
}

/**
 * @param {LocalRunRunLink | undefined} parentRun
 * @param {LocalRunRunLink} childRunLink
 * @param {Date} startedAt
 * @param {{ status: string, summary: string }} ticketResult
 * @returns {Promise<void>}
 */
async function recordLocalSpecChildRunState(parentRun, childRunLink, startedAt, ticketResult) {
  if (parentRun === undefined) {
    return;
  }

  await recordLocalRunChildRun({
    statePath: parentRun.statePath,
    childRun: {
      ...childRunLink,
      status: ticketResult.status,
      startedAt: startedAt.toISOString(),
      updatedAt: new Date().toISOString(),
      summary: ticketResult.summary,
    },
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {object} options
 * @param {LocalRunRunLink | undefined} options.parentRun
 * @param {GitHubIssue} options.ticket
 * @param {TicketAutomationResult} options.ticketResult
 * @returns {Promise<void>}
 */
async function recordObservedLocalSpecChildRun(context, { parentRun, ticket, ticketResult }) {
  if (parentRun === undefined) {
    return;
  }

  const recordedAt = new Date();
  const childRunLink = await createObservedLocalSpecChildRunLink(context, {
    parentRun,
    ticket,
    ticketResult,
    recordedAt,
  });
  await recordLocalSpecChildRunState(parentRun, childRunLink, recordedAt, ticketResult);
}

/**
 * @param {OperationRunnerContext} context
 * @param {object} options
 * @param {LocalRunRunLink} options.parentRun
 * @param {GitHubIssue} options.ticket
 * @param {TicketAutomationResult} options.ticketResult
 * @param {Date} options.recordedAt
 * @returns {Promise<LocalRunRunLink>}
 */
async function createObservedLocalSpecChildRunLink(
  context,
  { parentRun, ticket, ticketResult, recordedAt },
) {
  const operationReference = readLocalSpecChildRunOperationReference(ticketResult);
  if (
    typeof ticketResult.localRunRecord === 'string' &&
    ticketResult.localRunRecord.trim() !== ''
  ) {
    return createLocalRunLink({
      runRecordDirectory: ticketResult.localRunRecord,
      operationReference,
      target: {
        type: 'issue',
        number: ticket.number,
      },
    });
  }

  const runRecordDirectory = createRunRecordLocation({
    cwd: context.cwd,
    operationReference,
    targetReference: ticket.number,
    createdAt: recordedAt,
  }).directory;
  const stateRecord = await initializeLocalRunState({
    runRecordDirectory,
    operationReference,
    target: {
      type: 'issue',
      number: ticket.number,
    },
    publicationMode: ticketResult.publicationMode ?? context.publicationMode ?? 'dry-run',
    createdAt: recordedAt,
    parentRun,
  });
  const terminalStatus = mapObservedLocalSpecTicketStatusToTerminalStatus(ticketResult.status);
  if (terminalStatus === undefined) {
    await recordLocalRunWaitingForRunner({
      statePath: stateRecord.statePath,
      summary: ticketResult.summary,
      phase: readObservedLocalSpecTicketPhase(ticketResult, operationReference),
      runnerJob:
        ticketResult.runnerJob !== undefined &&
        isExecutableExternalRunnerJob(ticketResult.runnerJob)
          ? ticketResult.runnerJob
          : undefined,
    });
    return stateRecord.runLink;
  }

  await recordLocalRunTerminalStatus({
    statePath: stateRecord.statePath,
    status: terminalStatus,
    summary: ticketResult.summary,
    phase: readObservedLocalSpecTicketPhase(ticketResult, operationReference),
  });
  return stateRecord.runLink;
}

/**
 * @param {TicketAutomationResult} ticketResult
 * @returns {string}
 */
function readLocalSpecChildRunOperationReference(ticketResult) {
  if (
    typeof ticketResult.blockedOperation === 'string' &&
    ticketResult.blockedOperation.trim() !== ''
  ) {
    return ticketResult.blockedOperation;
  }

  if (
    typeof ticketResult.nextOperation === 'string' &&
    isLocalTicketPullRequestOperation(ticketResult.nextOperation)
  ) {
    return operationReferenceForPullRequestOperation(ticketResult.nextOperation);
  }

  if (ticketResult.pullRequest !== undefined) {
    return ticketResult.status === 'merged' || ticketResult.mergeMethod !== undefined
      ? 'pr:finalize'
      : 'pr:review';
  }

  return 'issue:implement';
}

const OBSERVED_LOCAL_SPEC_TICKET_ACCEPTED_STATUSES = new Set([
  'accepted',
  'closed',
  'dry-run-completed',
  'finalized',
  'merged',
  'ready-for-human-merge',
  'skipped',
]);

/**
 * @param {string} status
 * @returns {import('../local-run-state/types.js').LocalRunTerminalStatus | undefined}
 */
function mapObservedLocalSpecTicketStatusToTerminalStatus(status) {
  if (status === 'blocked' || status === 'human-required') {
    return 'blocked';
  }

  if (status === 'failed') {
    return 'failed';
  }

  if (status === 'refused') {
    return 'refused';
  }

  if (OBSERVED_LOCAL_SPEC_TICKET_ACCEPTED_STATUSES.has(status)) {
    return 'accepted';
  }

  return undefined;
}

/**
 * @param {TicketAutomationResult} ticketResult
 * @param {string} operationReference
 * @returns {string}
 */
function readObservedLocalSpecTicketPhase(ticketResult, operationReference) {
  if (typeof ticketResult.blockedPhase === 'string' && ticketResult.blockedPhase.trim() !== '') {
    return ticketResult.blockedPhase;
  }

  if (operationReference === 'pr:review') {
    return 'review';
  }

  if (operationReference === 'pr:address-review') {
    return 'address-review';
  }

  if (operationReference === 'pr:finalize') {
    return 'finalization';
  }

  return 'run';
}

/**
 * @param {object} options
 * @param {LocalRunRunLink | undefined} options.parentRun
 * @param {LocalRunRunLink} options.childRunLink
 * @param {Date} options.childRunStartedAt
 * @param {TicketAutomationResult} options.ticketResult
 * @param {string} options.summary
 * @returns {Promise<TicketAutomationResult>}
 */
async function blockPublishedLocalChildRun({
  parentRun,
  childRunLink,
  childRunStartedAt,
  ticketResult,
  summary,
}) {
  const blockedTicket = {
    ...ticketResult,
    status: 'blocked',
    summary,
  };
  await recordLocalSpecChildRunState(parentRun, childRunLink, childRunStartedAt, blockedTicket);
  return blockedTicket;
}

/**
 * @param {OperationRunnerContext} context
 * @param {object} options
 * @param {TicketAutomationResult[]} options.ticketResults
 * @param {Set<number>} options.pendingIssueNumbers
 * @param {Set<number>} options.virtualCompletedIssueNumbers
 * @param {TicketAutomationResult} options.ticketResult
 * @returns {Promise<void>}
 */
async function recordLocalDryRunTicketResult(
  context,
  { ticketResults, pendingIssueNumbers, virtualCompletedIssueNumbers, ticketResult },
) {
  await recordLocalSpecTicketResult(context, ticketResults, ticketResult);
  pendingIssueNumbers.delete(ticketResult.issue.number);

  if (isLocalDryRunVirtualCompletion(ticketResult)) {
    virtualCompletedIssueNumbers.add(ticketResult.issue.number);
  }
}

/**
 * @param {OperationRunnerContext} context
 * @param {object} options
 * @param {GitHubIssue} options.parentIssue
 * @param {string} options.parentBranchName
 * @param {GitHubIssue} options.ticket
 * @param {{ decision: TicketDependencyDecision }} options.dependencyFacts
 * @returns {Promise<TicketAutomationResult | undefined>}
 */
async function readAlreadyIntegratedLocalDryRunTicket(
  context,
  { parentIssue, parentBranchName, ticket, dependencyFacts },
) {
  if (context.gitClient.hasUnappliedCommitsSinceBase === undefined) {
    return undefined;
  }

  const ticketBranchName = createIssueBranchName({
    branchPrefix: context.config.branchPrefix,
    parentNumber: parentIssue.number,
    issueNumber: ticket.number,
  });
  const hasUnappliedCommits = await context.gitClient.hasUnappliedCommitsSinceBase({
    branchName: ticketBranchName,
    baseBranch: parentBranchName,
    preferLocalBase: true,
  });
  if (hasUnappliedCommits) {
    return undefined;
  }

  return createTicketResult({
    issue: ticket,
    status: 'dry-run-completed',
    summary: [
      `Ticket issue #${ticket.number} already has no unapplied commits relative to`,
      `${parentBranchName}; treating it as completed for local Spec auto-complete.`,
    ].join(' '),
    extra: {
      branch: ticketBranchName,
      publicationMode: 'dry-run',
      ...createDependencyDecisionExtra(dependencyFacts.decision),
    },
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {object} options
 * @param {GitHubIssue} options.parentIssue
 * @param {string} options.parentBranchName
 * @param {LocalRunRunLink} options.parentRun
 * @param {GitHubIssue} options.ticket
 * @param {SpecAutomationMode} options.mode
 * @param {'dry-run' | 'publish'} options.publicationMode
 * @param {TicketRunner} options.runTicket
 * @param {(request: PullRequestOperationRequest) => Promise<Record<string, unknown>>} [options.runTicketPullRequestOperation]
 * @param {{ decision: TicketDependencyDecision, blockingDependencies: GitHubIssue[] }} [options.dependencyFacts]
 * @returns {Promise<{ ticketResult: TicketAutomationResult, stop: boolean, restoreSpecBase: boolean }>}
 */
async function coordinateLocalTicket(
  context,
  {
    parentIssue,
    parentBranchName,
    parentRun,
    ticket,
    mode,
    publicationMode,
    runTicket,
    runTicketPullRequestOperation,
    dependencyFacts,
  },
) {
  if (ticket.state !== 'OPEN') {
    return localTicketAutomation({
      ticketResult: createTicketResult({
        issue: ticket,
        status: 'closed',
        summary: `Ticket issue #${ticket.number} is closed.`,
      }),
    });
  }

  const parentIssueNumber = getNativeParentIssueNumber(ticket);
  if (parentIssueNumber !== parentIssue.number) {
    return localTicketAutomation({
      ticketResult: createTicketResult({
        issue: ticket,
        status: 'skipped',
        summary: `Issue #${ticket.number} is not part of Spec issue #${parentIssue.number}.`,
      }),
    });
  }

  const resolvedDependencyFacts =
    dependencyFacts ??
    (await readTicketDependencyDecision(context, {
      issue: ticket,
      virtualCompletedIssueNumbers: new Set(),
    }));
  const { blockingDependencies } = resolvedDependencyFacts;
  if (blockingDependencies.length > 0) {
    const ticketResult = createTicketResult({
      issue: ticket,
      status: 'blocked',
      summary: `Ticket issue #${ticket.number} is blocked by ${formatIssueNumbers(
        blockingDependencies,
      )}.`,
      extra: withDependencyDecision(
        {
          blockedBy: blockingDependencies.map(issue => issue.number),
        },
        resolvedDependencyFacts.decision,
      ),
    });
    await recordObservedLocalSpecChildRun(context, {
      parentRun,
      ticket,
      ticketResult,
    });
    return localTicketAutomation({
      ticketResult,
    });
  }

  const dependencyDecisionExtra = createDependencyDecisionExtra(resolvedDependencyFacts.decision);

  const ticketBranchName = createIssueBranchName({
    branchPrefix: context.config.branchPrefix,
    parentNumber: parentIssue.number,
    issueNumber: ticket.number,
  });
  const pullRequest = await context.githubClient.findOpenPullRequestByHead(ticketBranchName);

  if (pullRequest !== undefined) {
    const ticketResult =
      mode === 'auto-complete'
        ? await coordinateLocalTicketPullRequest(context, {
            ticket,
            parentIssue,
            parentBranchName,
            parentRun,
            pullRequest,
            publicationMode,
            runTicketPullRequestOperation,
          })
        : inspectLocalTicketPullRequest({
            ticket,
            parentBranchName,
            pullRequest,
          });
    const observedTicket = {
      ...ticketResult,
      ...dependencyDecisionExtra,
    };
    await recordObservedLocalSpecChildRun(context, {
      parentRun,
      ticket,
      ticketResult: observedTicket,
    });

    return localTicketAutomation({
      ticketResult: observedTicket,
      stop: ticketResult.status === 'blocked',
      restoreSpecBase: publicationMode === 'publish',
    });
  }

  if (hasAnyLabel(ticket.labels, ACTIVE_CHILD_ISSUE_LABELS)) {
    const ticketResult = createTicketResult({
      issue: ticket,
      status: 'already-active',
      summary: `Ticket issue #${ticket.number} already has active PullOps issue automation.`,
      extra: {
        labels: ticket.labels,
        ...dependencyDecisionExtra,
      },
    });
    await recordObservedLocalSpecChildRun(context, {
      parentRun,
      ticket,
      ticketResult,
    });
    return localTicketAutomation({
      ticketResult,
    });
  }

  if (ticket.labels.includes(PULL_OPS_STATUS_LABELS.humanRequired)) {
    const ticketResult = createTicketResult({
      issue: ticket,
      status: 'human-required',
      summary: `Ticket issue #${ticket.number} needs human attention before PullOps automation can continue.`,
      extra: {
        labels: ticket.labels,
        ...dependencyDecisionExtra,
      },
    });
    await recordObservedLocalSpecChildRun(context, {
      parentRun,
      ticket,
      ticketResult,
    });
    return localTicketAutomation({
      ticketResult,
    });
  }

  const childRunStartedAt = new Date();
  const childRunLocation = createRunRecordLocation({
    cwd: context.cwd,
    operationReference: 'issue:implement',
    targetReference: ticket.number,
  });
  const childRunLink = createLocalRunLink({
    runRecordDirectory: childRunLocation.directory,
    operationReference: 'issue:implement',
    target: {
      type: 'issue',
      number: ticket.number,
    },
    statePath: join(childRunLocation.directory, 'state.json'),
  });
  const parentEventSinkEnvironment = context.parentEventSink?.createChildEnvironment({
    childRunLink,
    ticketNumber: ticket.number,
    localRunRecord: childRunLocation.directory,
  });
  if (parentRun !== undefined) {
    await recordLocalRunChildRun({
      statePath: parentRun.statePath,
      childRun: {
        ...childRunLink,
        status: 'running',
        startedAt: childRunStartedAt.toISOString(),
        updatedAt: childRunStartedAt.toISOString(),
        summary: `Started implementation for ticket #${ticket.number}.`,
      },
    });
  }

  const progressReporter = createLocalSpecAutoCompleteTicketProgressReporter(context, ticket);
  /** @type {Record<string, unknown>} */
  let output;
  try {
    output = await runTicket(ticket.number, {
      virtualCompletedIssueNumbers: resolvedDependencyFacts.decision.satisfiedByVirtualCompletions,
      ...(progressReporter === undefined ? {} : { progress: progressReporter.progress }),
      localRunRecordDirectory: childRunLocation.directory,
      parentRun,
      ...(parentEventSinkEnvironment === undefined ? {} : { parentEventSinkEnvironment }),
    });
  } catch (error) {
    context.parentEventSink?.closeChildRoute(childRunLink.runId);
    await progressReporter?.flush();
    if (parentRun !== undefined) {
      await recordLocalSpecChildRunState(parentRun, childRunLink, childRunStartedAt, {
        status: 'failed',
        summary: getErrorMessage(error),
      });
    }
    throw error;
  }
  context.parentEventSink?.closeChildRoute(childRunLink.runId);
  await progressReporter?.flush();
  if (isExternalRunnerWaitingOutput(output)) {
    const ticketResult = createTicketResult({
      issue: ticket,
      status: 'waiting',
      summary: String(output.summary),
      extra: {
        branch: readOutputBranch(output, ticketBranchName),
        localRunRecord: readOutputString(output, 'localRunRecord'),
        publicationMode,
        blockedPhase: 'prepare',
        blockedOperation: 'issue:implement',
        runnerJob: output.runnerJob,
        ...dependencyDecisionExtra,
      },
    });
    if (parentRun !== undefined) {
      await recordLocalSpecChildRunState(parentRun, childRunLink, childRunStartedAt, ticketResult);
    }
    return localTicketAutomation({
      ticketResult,
      stop: true,
      restoreSpecBase: publicationMode === 'publish',
    });
  }

  const status =
    output.status === 'blocked' ? 'blocked' : localImplementedTicketStatus(publicationMode);
  const ticketResult = createTicketResult({
    issue: ticket,
    status,
    summary: String(output.summary),
    extra: {
      branch: readOutputBranch(output, ticketBranchName),
      pullRequest: readOutputPullRequest(output),
      localRunRecord: readOutputString(output, 'localRunRecord'),
      publicationMode,
      ...readOutputBlocker(output),
      ...dependencyDecisionExtra,
    },
  });

  if (mode === 'auto-complete' && publicationMode === 'dry-run' && output.status !== 'blocked') {
    const integrated = await integrateLocalDryRunTicketBranch(context, {
      parentBranchName,
      ticket,
      ticketBranchName: ticketResult.branch ?? ticketBranchName,
      output,
      localRunRecord: ticketResult.localRunRecord,
    });
    const finalTicket = {
      ...integrated,
      ...dependencyDecisionExtra,
    };
    if (parentRun !== undefined) {
      await recordLocalSpecChildRunState(parentRun, childRunLink, childRunStartedAt, finalTicket);
    }
    return localTicketAutomation({
      ticketResult: finalTicket,
      stop: integrated.status === 'blocked',
      restoreSpecBase: true,
    });
  }

  if (mode === 'auto-complete' && publicationMode === 'publish' && output.status !== 'blocked') {
    const pullRequest = await context.githubClient.findOpenPullRequestByHead(ticketBranchName);
    if (pullRequest === undefined) {
      return localTicketAutomation({
        ticketResult: await blockPublishedLocalChildRun({
          parentRun,
          childRunLink,
          childRunStartedAt,
          ticketResult,
          summary: [
            `Ticket issue #${ticket.number} was published,`,
            'but PullOps could not find its open Ticket PR for integration.',
          ].join(' '),
        }),
        stop: true,
        restoreSpecBase: true,
      });
    }

    const integrated = await coordinateLocalTicketPullRequest(context, {
      ticket,
      parentIssue,
      parentBranchName,
      parentRun,
      pullRequest,
      publicationMode,
      runTicketPullRequestOperation,
    });
    const finalTicket = {
      ...integrated,
      ...(integrated.localRunRecord === undefined && ticketResult.localRunRecord !== undefined
        ? { localRunRecord: ticketResult.localRunRecord }
        : {}),
      publicationMode,
      ...dependencyDecisionExtra,
    };
    if (parentRun !== undefined) {
      await recordLocalSpecChildRunState(parentRun, childRunLink, childRunStartedAt, finalTicket);
    }
    return localTicketAutomation({
      ticketResult: finalTicket,
      stop: integrated.status === 'blocked',
      restoreSpecBase: true,
    });
  }

  if (parentRun !== undefined) {
    await recordLocalSpecChildRunState(parentRun, childRunLink, childRunStartedAt, ticketResult);
  }
  return localTicketAutomation({
    ticketResult,
    stop: output.status === 'blocked',
    restoreSpecBase: publicationMode === 'publish',
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {object} options
 * @param {string} options.parentBranchName
 * @param {GitHubIssue} options.ticket
 * @param {string} options.ticketBranchName
 * @param {Record<string, unknown>} options.output
 * @param {string | undefined} options.localRunRecord
 * @returns {Promise<TicketAutomationResult>}
 */
async function integrateLocalDryRunTicketBranch(
  context,
  { parentBranchName, ticket, ticketBranchName, output, localRunRecord },
) {
  if (context.gitClient.cherryPickCommitOntoBranch === undefined) {
    return createTicketResult({
      issue: ticket,
      status: 'blocked',
      summary: 'Git client cannot locally integrate finalized ticket dry-run branches.',
      extra: {
        branch: ticketBranchName,
        publicationMode: 'dry-run',
        ...(localRunRecord === undefined ? {} : { localRunRecord }),
        blockedPhase: 'integration',
      },
    });
  }

  const finalizedHeadSha = await readLocalDryRunTicketFinalizedHeadSha(context, {
    ticketBranchName,
    output,
  });
  if (finalizedHeadSha === undefined) {
    return createTicketResult({
      issue: ticket,
      status: 'blocked',
      summary: `Ticket issue #${ticket.number} completed locally, but PullOps could not identify the finalized ticket branch head.`,
      extra: {
        branch: ticketBranchName,
        publicationMode: 'dry-run',
        ...(localRunRecord === undefined ? {} : { localRunRecord }),
        blockedPhase: 'integration',
      },
    });
  }

  const integration = await context.gitClient.cherryPickCommitOntoBranch({
    branchName: parentBranchName,
    baseBranch: context.config.baseBranch,
    commitSha: finalizedHeadSha,
    committer: GITHUB_ACTIONS_BOT_AUTHOR,
  });

  if (integration.status === 'conflicts') {
    return createTicketResult({
      issue: ticket,
      status: 'blocked',
      summary: `Ticket issue #${ticket.number} could not be merged locally into ${parentBranchName} without conflicts.`,
      extra: {
        branch: ticketBranchName,
        publicationMode: 'dry-run',
        ...(localRunRecord === undefined ? {} : { localRunRecord }),
        mergeMethod: 'local-cherry-pick',
        conflictedFiles: integration.conflictedFiles,
        blockedPhase: 'integration',
      },
    });
  }

  return createTicketResult({
    issue: ticket,
    status: 'merged',
    summary: `Merged finalized local dry-run ticket #${ticket.number} into ${parentBranchName}.`,
    extra: {
      branch: ticketBranchName,
      publicationMode: 'dry-run',
      ...(localRunRecord === undefined ? {} : { localRunRecord }),
      mergeMethod: 'local-cherry-pick',
      finalizedHeadSha,
      headSha: integration.headSha,
      treeHash: integration.treeHash,
    },
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {{ ticketBranchName: string, output: Record<string, unknown> }} options
 * @returns {Promise<string | undefined>}
 */
async function readLocalDryRunTicketFinalizedHeadSha(context, { ticketBranchName, output }) {
  const prFinalize = readRecordProperty(output, 'prFinalize');
  const finalizedHead = prFinalize?.finalizedHead;
  if (typeof finalizedHead === 'string' && finalizedHead.trim() !== '') {
    return finalizedHead;
  }

  const currentBranch = await context.gitClient.getCurrentBranch?.();
  if (currentBranch !== undefined && currentBranch !== ticketBranchName) {
    return undefined;
  }

  return await context.gitClient.getCurrentHeadSha();
}

/**
 * @param {GitHubIssue} ticket
 * @param {{ decision: TicketDependencyDecision, blockingDependencies: GitHubIssue[] }} dependencyFacts
 * @returns {TicketAutomationResult}
 */
function blockedByDependencyTicketResult(ticket, dependencyFacts) {
  const { blockingDependencies } = dependencyFacts;
  return createTicketResult({
    issue: ticket,
    status: 'blocked',
    summary: `Ticket issue #${ticket.number} is blocked by ${formatIssueNumbers(
      blockingDependencies,
    )}.`,
    extra: withDependencyDecision(
      {
        blockedBy: blockingDependencies.map(issue => issue.number),
      },
      dependencyFacts.decision,
    ),
  });
}

/**
 * @param {GitHubIssue} ticket
 * @param {TicketAutomationResult | undefined} localBlocker
 * @returns {TicketAutomationResult}
 */
function blockedByLocalAutoCompletePhaseResult(ticket, localBlocker) {
  if (localBlocker === undefined) {
    return createTicketResult({
      issue: ticket,
      status: 'blocked',
      summary: `Ticket issue #${ticket.number} was not reachable during local Spec auto-complete.`,
    });
  }

  return createTicketResult({
    issue: ticket,
    status: 'blocked',
    summary: `Ticket issue #${ticket.number} was not started because local Spec auto-complete stopped at ticket #${localBlocker.issue.number}.`,
    extra: { blockedBy: [localBlocker.issue.number] },
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {object} options
 * @param {GitHubIssue} options.issue
 * @param {ReadonlySet<number>} options.virtualCompletedIssueNumbers
 * @returns {Promise<{ decision: TicketDependencyDecision, blockingDependencies: GitHubIssue[] }>}
 */
async function readTicketDependencyDecision(context, { issue, virtualCompletedIssueNumbers }) {
  const dependencyNumbers = createIssueSnapshot(issue).blockedBy;
  /** @type {number[]} */
  const satisfiedByClosedIssues = [];
  /** @type {number[]} */
  const satisfiedByVirtualCompletions = [];
  /** @type {GitHubIssue[]} */
  const blockingDependencies = [];

  for (const dependencyNumber of dependencyNumbers) {
    const dependency = await context.githubClient.getIssue(dependencyNumber);
    if (createIssueSnapshot(dependency).isDone) {
      satisfiedByClosedIssues.push(dependencyNumber);
      continue;
    }

    if (virtualCompletedIssueNumbers.has(dependencyNumber)) {
      satisfiedByVirtualCompletions.push(dependencyNumber);
      continue;
    }

    blockingDependencies.push(dependency);
  }

  const remainingBlockedBy = blockingDependencies.map(dependency => dependency.number);
  return {
    decision: {
      blockedBy: dependencyNumbers,
      satisfiedByClosedIssues,
      satisfiedByVirtualCompletions,
      remainingBlockedBy,
    },
    blockingDependencies,
  };
}

/**
 * @param {Partial<TicketAutomationResult>} extra
 * @param {TicketDependencyDecision} decision
 * @returns {Partial<TicketAutomationResult>}
 */
function withDependencyDecision(extra, decision) {
  return {
    ...extra,
    ...createDependencyDecisionExtra(decision),
  };
}

/**
 * @param {TicketDependencyDecision} decision
 * @returns {Partial<TicketAutomationResult>}
 */
function createDependencyDecisionExtra(decision) {
  return decision.blockedBy.length === 0 ? {} : { dependencyDecision: decision };
}

/**
 * @param {TicketAutomationResult} ticketResult
 * @returns {boolean}
 */
function isLocalDryRunVirtualCompletion(ticketResult) {
  return ticketResult.status === 'dry-run-completed' || ticketResult.status === 'merged';
}

/**
 * @param {object} options
 * @param {GitHubIssue} options.ticket
 * @param {string} options.parentBranchName
 * @param {GitHubPullRequest} options.pullRequest
 * @returns {TicketAutomationResult}
 */
function inspectLocalTicketPullRequest({ ticket, parentBranchName, pullRequest }) {
  if (pullRequest.baseRefName !== parentBranchName) {
    return ticketPullRequestResult({
      issue: ticket,
      pullRequest,
      status: 'skipped',
      summary: `Ticket PR #${pullRequest.number} does not target ${parentBranchName}.`,
    });
  }

  const state = readManagedPrState(pullRequest.body);
  if (!state.managed || state.sourceIssueNumber !== ticket.number) {
    return ticketPullRequestResult({
      issue: ticket,
      pullRequest,
      status: 'skipped',
      summary: `Ticket PR #${pullRequest.number} is not the PullOps-managed PR for ticket #${ticket.number}.`,
    });
  }

  return ticketPullRequestResult({
    issue: ticket,
    pullRequest,
    status: isFinalizedForRebase(state) ? 'ready-for-human-merge' : 'waiting',
    summary: isFinalizedForRebase(state)
      ? `Ticket PR #${pullRequest.number} is finalized for human merge.`
      : `Ticket PR #${pullRequest.number} is waiting for human review or merge gates.`,
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {object} options
 * @param {GitHubIssue} options.ticket
 * @param {GitHubIssue} options.parentIssue
 * @param {string} options.parentBranchName
 * @param {LocalRunRunLink | undefined} options.parentRun
 * @param {GitHubPullRequest} options.pullRequest
 * @param {'dry-run' | 'publish'} options.publicationMode
 * @param {(request: PullRequestOperationRequest) => Promise<Record<string, unknown>>} [options.runTicketPullRequestOperation]
 * @returns {Promise<TicketAutomationResult>}
 */
async function coordinateLocalTicketPullRequest(
  context,
  {
    ticket,
    parentIssue,
    parentBranchName,
    parentRun,
    pullRequest,
    publicationMode,
    runTicketPullRequestOperation,
  },
) {
  if (pullRequest.baseRefName !== parentBranchName) {
    return ticketPullRequestResult({
      issue: ticket,
      pullRequest,
      status: 'skipped',
      summary: `Ticket PR #${pullRequest.number} does not target ${parentBranchName}.`,
    });
  }

  const state = readManagedPrState(pullRequest.body);
  if (!state.managed || state.sourceIssueNumber !== ticket.number) {
    return ticketPullRequestResult({
      issue: ticket,
      pullRequest,
      status: 'skipped',
      summary: `Ticket PR #${pullRequest.number} is not the PullOps-managed PR for ticket #${ticket.number}.`,
    });
  }

  if (!isFinalizedForRebase(state)) {
    if (publicationMode === 'publish' && runTicketPullRequestOperation !== undefined) {
      return await continuePublishedLocalTicketPullRequest(context, {
        ticket,
        parentIssue,
        parentBranchName,
        parentRun,
        pullRequest,
        runTicketPullRequestOperation,
      });
    }

    return ticketPullRequestResult({
      issue: ticket,
      pullRequest,
      status: 'waiting',
      summary: `Ticket PR #${pullRequest.number} is waiting for human review or merge gates.`,
    });
  }

  return await mergeFinalizedTicketPullRequestLocally(context, {
    ticket,
    parentIssue,
    parentBranchName,
    pullRequest,
    finalizedHeadSha: state.finalizedHeadSha,
    publicationMode,
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {object} options
 * @param {GitHubIssue} options.ticket
 * @param {GitHubIssue} options.parentIssue
 * @param {string} options.parentBranchName
 * @param {LocalRunRunLink | undefined} options.parentRun
 * @param {GitHubPullRequest} options.pullRequest
 * @param {(request: PullRequestOperationRequest) => Promise<Record<string, unknown>>} options.runTicketPullRequestOperation
 * @returns {Promise<TicketAutomationResult>}
 */
async function continuePublishedLocalTicketPullRequest(
  context,
  { ticket, parentIssue, parentBranchName, parentRun, pullRequest, runTicketPullRequestOperation },
) {
  /** @type {GitHubPullRequest} */
  let currentPullRequest = pullRequest;
  /** @type {string | undefined} */
  let latestLocalRunRecord;

  for (let iteration = 0; iteration < 8; iteration += 1) {
    const nextOperation = selectLocalTicketPullRequestOperation(currentPullRequest);
    if (nextOperation === undefined) {
      break;
    }

    if (!isLocalTicketPullRequestOperation(nextOperation)) {
      return ticketPullRequestResult({
        issue: ticket,
        pullRequest: currentPullRequest,
        status: 'blocked',
        summary: `Ticket PR #${currentPullRequest.number} needs ${nextOperation} before local auto-complete can continue.`,
        extra: {
          nextOperation,
          blockedPhase: 'pull-request-automation',
          blockedOperation: nextOperation,
        },
      });
    }

    await checkoutLocalPullRequestHead(context, { pullRequest: currentPullRequest });

    const output = await runTicketPullRequestOperation({
      pullRequestNumber: currentPullRequest.number,
      operation: nextOperation,
      ...(parentRun === undefined ? {} : { parentRun }),
    });
    latestLocalRunRecord = readOutputString(output, 'localRunRecord') ?? latestLocalRunRecord;
    if (isExternalRunnerWaitingOutput(output)) {
      return withTicketLocalRunRecord(
        ticketPullRequestResult({
          issue: ticket,
          pullRequest: currentPullRequest,
          status: 'waiting',
          summary: String(
            output.summary ??
              `Ticket PR #${currentPullRequest.number} is waiting for ${nextOperation}.`,
          ),
          extra: {
            nextOperation,
            blockedPhase: phaseForPullRequestOperation(nextOperation),
            blockedOperation: operationReferenceForPullRequestOperation(nextOperation),
            runnerJob: output.runnerJob,
          },
        }),
        latestLocalRunRecord,
      );
    }

    if (output.status === 'blocked' || output.status === 'refused') {
      const blockedPhase =
        readOutputString(output, 'blockedPhase') ?? phaseForPullRequestOperation(nextOperation);
      const blockedOperation =
        readOutputString(output, 'blockedOperation') ??
        operationReferenceForPullRequestOperation(nextOperation);
      return withTicketLocalRunRecord(
        ticketPullRequestResult({
          issue: ticket,
          pullRequest: currentPullRequest,
          status: 'blocked',
          summary: String(
            output.summary ?? `Ticket PR #${currentPullRequest.number} could not continue.`,
          ),
          extra: {
            nextOperation,
            blockedPhase,
            blockedOperation,
          },
        }),
        latestLocalRunRecord,
      );
    }

    const finalized = readRecordProperty(output, 'prFinalize');
    if (finalized?.waiting === true) {
      return withTicketLocalRunRecord(
        ticketPullRequestResult({
          issue: ticket,
          pullRequest: currentPullRequest,
          status: 'waiting',
          summary: String(
            output.summary ??
              `Ticket PR #${currentPullRequest.number} is waiting for finalized-head checks.`,
          ),
          extra: {
            nextOperation,
            blockedPhase: 'checks',
            blockedOperation: 'pr:finalize',
          },
        }),
        latestLocalRunRecord,
      );
    }

    currentPullRequest = await context.githubClient.getPullRequest(currentPullRequest.number);
    const state = readManagedPrState(currentPullRequest.body);
    if (isFinalizedForRebase(state)) {
      return withTicketLocalRunRecord(
        await mergeFinalizedTicketPullRequestLocally(context, {
          ticket,
          parentIssue,
          parentBranchName,
          pullRequest: currentPullRequest,
          finalizedHeadSha: state.finalizedHeadSha,
          publicationMode: 'publish',
        }),
        latestLocalRunRecord,
      );
    }
  }

  const state = readManagedPrState(currentPullRequest.body);
  if (isFinalizedForRebase(state)) {
    return withTicketLocalRunRecord(
      await mergeFinalizedTicketPullRequestLocally(context, {
        ticket,
        parentIssue,
        parentBranchName,
        pullRequest: currentPullRequest,
        finalizedHeadSha: state.finalizedHeadSha,
        publicationMode: 'publish',
      }),
      latestLocalRunRecord,
    );
  }

  return withTicketLocalRunRecord(
    ticketPullRequestResult({
      issue: ticket,
      pullRequest: currentPullRequest,
      status: 'waiting',
      summary: `Ticket PR #${currentPullRequest.number} is waiting for human review or merge gates.`,
      extra: {
        blockedPhase: 'review',
        blockedOperation: 'pr:review',
      },
    }),
    latestLocalRunRecord,
  );
}

/**
 * @param {object} options
 * @param {TicketAutomationResult} options.ticketResult
 * @param {boolean} [options.stop]
 * @param {boolean} [options.restoreSpecBase]
 * @returns {{ ticketResult: TicketAutomationResult, stop: boolean, restoreSpecBase: boolean }}
 */
function localTicketAutomation({ ticketResult, stop = false, restoreSpecBase = false }) {
  return { ticketResult, stop, restoreSpecBase };
}

/**
 * @param {TicketAutomationResult} ticketResult
 * @returns {boolean}
 */
function shouldPreserveInspectableBranchState(ticketResult) {
  return ticketResult.status === 'blocked' && (ticketResult.conflictedFiles?.length ?? 0) > 0;
}

/**
 * @param {OperationRunnerContext} context
 * @param {object} options
 * @param {GitHubIssue} options.ticket
 * @param {GitHubIssue} options.parentIssue
 * @param {string} options.parentBranchName
 * @param {GitHubPullRequest} options.pullRequest
 * @param {SpecAutomationMode} options.mode
 * @returns {Promise<TicketAutomationResult>}
 */
async function coordinateTicketPullRequest(
  context,
  { ticket, parentIssue, parentBranchName, pullRequest, mode },
) {
  if (pullRequest.baseRefName !== parentBranchName) {
    return ticketPullRequestResult({
      issue: ticket,
      pullRequest,
      status: 'skipped',
      summary: `Ticket PR #${pullRequest.number} does not target ${parentBranchName}.`,
    });
  }

  const state = readManagedPrState(pullRequest.body);
  if (!state.managed || state.sourceIssueNumber !== ticket.number) {
    return ticketPullRequestResult({
      issue: ticket,
      pullRequest,
      status: 'skipped',
      summary: `Ticket PR #${pullRequest.number} is not the PullOps-managed PR for ticket #${ticket.number}.`,
    });
  }

  if (mode === 'auto-complete' && isFinalizedForRebase(state)) {
    return await mergeFinalizedTicketPullRequest(context, {
      ticket,
      parentIssue,
      pullRequest,
      finalizedHeadSha: state.finalizedHeadSha,
    });
  }

  const workflow = await resumeManagedPrWorkflow({
    githubClient: context.githubClient,
    pullRequest,
  });

  if (workflow.status === 'resumed') {
    return ticketPullRequestResult({
      issue: ticket,
      pullRequest,
      status: 'resumed',
      summary: `Resumed ticket PR #${pullRequest.number} with ${workflow.nextOperation}.`,
      extra: { nextOperation: workflow.nextOperation },
    });
  }

  if (workflow.status === 'already-active') {
    return ticketPullRequestResult({
      issue: ticket,
      pullRequest,
      status: 'already-active',
      summary: `Ticket PR #${pullRequest.number} already has active PullOps PR automation.`,
      extra: { labels: workflow.labels ?? [] },
    });
  }

  return ticketPullRequestResult({
    issue: ticket,
    pullRequest,
    status: isFinalizedForRebase(state) ? 'ready-for-human-merge' : 'waiting',
    summary: isFinalizedForRebase(state)
      ? `Ticket PR #${pullRequest.number} is finalized for human merge.`
      : `Ticket PR #${pullRequest.number} is waiting for human attention.`,
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {object} options
 * @param {GitHubIssue} options.ticket
 * @param {GitHubIssue} options.parentIssue
 * @param {GitHubPullRequest} options.pullRequest
 * @param {string} options.finalizedHeadSha
 * @returns {Promise<TicketAutomationResult>}
 */
async function mergeFinalizedTicketPullRequest(
  context,
  { ticket, parentIssue, pullRequest, finalizedHeadSha },
) {
  if (context.githubClient.mergePullRequest === undefined) {
    return ticketPullRequestResult({
      issue: ticket,
      pullRequest,
      status: 'blocked',
      summary: 'GitHub client cannot merge pull requests.',
    });
  }

  if (pullRequest.isDraft) {
    return ticketPullRequestResult({
      issue: ticket,
      pullRequest,
      status: 'waiting',
      summary: `Ticket PR #${pullRequest.number} is still a draft.`,
    });
  }

  const checks = await context.githubClient.getPullRequestChecksForRef(finalizedHeadSha);
  const checkState = classifyCheckState(checks);
  if (checkState === 'pending') {
    return ticketPullRequestResult({
      issue: ticket,
      pullRequest,
      status: 'waiting',
      summary: `Ticket PR #${pullRequest.number} is waiting for finalized-head checks.`,
      extra: { checks: checks.length },
    });
  }

  if (checkState === 'failed') {
    await context.githubClient.addLabelsToPullRequest({
      number: pullRequest.number,
      labels: [requireOperationCatalogOperationLabelName('pr-fix-ci')],
    });
    return ticketPullRequestResult({
      issue: ticket,
      pullRequest,
      status: 'routed-to-ci-repair',
      summary: `Ticket PR #${pullRequest.number} finalized-head checks failed; routed to CI repair.`,
      extra: { checks: checks.length },
    });
  }

  await context.githubClient.mergePullRequest({
    number: pullRequest.number,
    method: 'rebase',
  });

  return ticketPullRequestResult({
    issue: ticket,
    pullRequest,
    status: 'merged',
    summary: `Merged finalized ticket PR #${pullRequest.number} into Spec issue #${parentIssue.number}.`,
    extra: { mergeMethod: 'rebase' },
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {object} options
 * @param {GitHubIssue} options.ticket
 * @param {GitHubIssue} options.parentIssue
 * @param {string} options.parentBranchName
 * @param {GitHubPullRequest} options.pullRequest
 * @param {string} options.finalizedHeadSha
 * @param {'dry-run' | 'publish'} options.publicationMode
 * @returns {Promise<TicketAutomationResult>}
 */
async function mergeFinalizedTicketPullRequestLocally(
  context,
  { ticket, parentIssue, parentBranchName, pullRequest, finalizedHeadSha, publicationMode },
) {
  if (context.gitClient.cherryPickCommitOntoBranch === undefined) {
    return ticketPullRequestResult({
      issue: ticket,
      pullRequest,
      status: 'blocked',
      summary: 'Git client cannot locally integrate finalized ticket pull requests.',
      extra: {
        blockedPhase: 'integration',
      },
    });
  }

  if (pullRequest.isDraft) {
    return ticketPullRequestResult({
      issue: ticket,
      pullRequest,
      status: 'waiting',
      summary: `Ticket PR #${pullRequest.number} is still a draft.`,
      extra: {
        blockedPhase: 'review',
        blockedOperation: 'pr:review',
      },
    });
  }

  const checks = await context.githubClient.getPullRequestChecksForRef(finalizedHeadSha);
  const checkState = classifyCheckState(checks);
  if (checkState === 'pending') {
    return ticketPullRequestResult({
      issue: ticket,
      pullRequest,
      status: 'waiting',
      summary: `Ticket PR #${pullRequest.number} is waiting for finalized-head checks.`,
      extra: { checks: checks.length, blockedPhase: 'checks', blockedOperation: 'pr:finalize' },
    });
  }

  if (checkState === 'failed') {
    return ticketPullRequestResult({
      issue: ticket,
      pullRequest,
      status: 'blocked',
      summary: `Ticket PR #${pullRequest.number} finalized-head checks failed; repair CI before local auto-complete can merge it.`,
      extra: { checks: checks.length, blockedPhase: 'checks', blockedOperation: 'pr:finalize' },
    });
  }

  const integration = await context.gitClient.cherryPickCommitOntoBranch({
    branchName: parentBranchName,
    baseBranch: context.config.baseBranch,
    commitSha: finalizedHeadSha,
    committer: GITHUB_ACTIONS_BOT_AUTHOR,
  });

  if (integration.status === 'conflicts') {
    return ticketPullRequestResult({
      issue: ticket,
      pullRequest,
      status: 'blocked',
      summary: `Ticket PR #${pullRequest.number} could not be merged locally into ${parentBranchName} without conflicts.`,
      extra: {
        mergeMethod: 'local-cherry-pick',
        conflictedFiles: integration.conflictedFiles,
        blockedPhase: 'integration',
      },
    });
  }

  if (publicationMode === 'publish') {
    const pushResult = await context.gitClient.pushBranchWithLease({
      branchName: parentBranchName,
    });
    if (pushResult.status === 'stale-lease') {
      return ticketPullRequestResult({
        issue: ticket,
        pullRequest,
        status: 'blocked',
        summary: `Remote branch ${parentBranchName} changed while local auto-complete was merging ticket PR #${pullRequest.number}.`,
        extra: { mergeMethod: 'local-cherry-pick', blockedPhase: 'integration' },
      });
    }

    await closeTicket(context, {
      issue: ticket,
      pullRequest,
      expectedBaseBranch: parentBranchName,
    });
    await closeIntegratedTicketPullRequest(context, { pullRequest });
    ticket.state = 'CLOSED';
    markParentTicketReferenceClosed(parentIssue, ticket.number);
  }

  return ticketPullRequestResult({
    issue: ticket,
    pullRequest,
    status: 'merged',
    summary: `Merged finalized ticket PR #${pullRequest.number} locally into Spec issue #${parentIssue.number}.`,
    extra: {
      mergeMethod: 'local-cherry-pick',
      finalizedHeadSha,
      headSha: integration.headSha,
      treeHash: integration.treeHash,
    },
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {{ pullRequest: GitHubPullRequest }} options
 * @returns {Promise<void>}
 */
async function closeIntegratedTicketPullRequest(context, { pullRequest }) {
  if (context.githubClient.closePullRequest === undefined) {
    return;
  }

  await context.githubClient.closePullRequest({ number: pullRequest.number });
}

/**
 * @param {GitHubIssue} parentIssue
 * @param {number} ticketNumber
 * @returns {void}
 */
function markParentTicketReferenceClosed(parentIssue, ticketNumber) {
  parentIssue.subIssues = parentIssue.subIssues.map(ticket =>
    ticket.number === ticketNumber
      ? {
          ...ticket,
          state: 'CLOSED',
        }
      : ticket,
  );
}

/**
 * @param {OperationRunnerContext} context
 * @param {{
 *   parentIssue?: GitHubIssue,
 *   parentIssueNumber: number,
 *   parentBranchName?: string,
 *   tickets?: GitHubIssue[],
 *   requestReview?: boolean,
 * }} options
 * @returns {Promise<ParentReviewResult>}
 */
async function requestUmbrellaReviewIfComplete(
  context,
  { parentIssue, parentIssueNumber, parentBranchName, tickets, requestReview = true },
) {
  const resolvedParentIssue =
    parentIssue ??
    (tickets === undefined ? await context.githubClient.getIssue(parentIssueNumber) : undefined);
  const resolvedTickets = tickets ?? resolvedParentIssue?.subIssues ?? [];
  if (resolvedTickets.length === 0) {
    return {
      status: 'waiting-for-tickets',
      ...(resolvedParentIssue === undefined
        ? {}
        : {
            issue: {
              number: resolvedParentIssue.number,
              url: resolvedParentIssue.url,
            },
          }),
    };
  }

  const openTickets = resolvedTickets.filter(ticket => ticket.state !== 'CLOSED');
  if (openTickets.length > 0) {
    return {
      status: 'waiting',
      ...(resolvedParentIssue === undefined
        ? {}
        : {
            issue: {
              number: resolvedParentIssue.number,
              url: resolvedParentIssue.url,
            },
          }),
      openTickets: openTickets.map(ticket => ticket.number),
    };
  }

  const branchName =
    parentBranchName ??
    createParentBranchName({
      branchPrefix: context.config.branchPrefix,
      parentNumber: parentIssueNumber,
    });
  const pullRequest = await context.githubClient.findOpenPullRequestByHead(branchName);
  if (pullRequest === undefined) {
    return {
      status: 'missing',
      branch: branchName,
    };
  }

  if (isFinalizedForRebase(readManagedPrState(pullRequest.body))) {
    return inspectManagedPrForLocalReview(pullRequest);
  }

  let reviewPullRequest = pullRequest;
  const nextLocalOperation = selectLocalParentPullRequestOperation(pullRequest);
  if (resolvedParentIssue !== undefined && nextLocalOperation === 'pr-review') {
    const refreshedBody = await createSpecPreparePullRequestBodyForIssue(context, {
      issue: resolvedParentIssue,
      branchName,
    });
    if (requestReview || context.publicationMode === 'publish') {
      await context.githubClient.updatePullRequestBody({
        number: pullRequest.number,
        body: refreshedBody,
      });
    }
    reviewPullRequest = {
      ...pullRequest,
      body: refreshedBody,
    };
  }

  if (!requestReview) {
    return inspectManagedPrForLocalReview(reviewPullRequest);
  }

  return await requestManagedPrReview({
    githubClient: context.githubClient,
    pullRequest: reviewPullRequest,
  });
}

/**
 * @param {GitHubPullRequest} pullRequest
 * @returns {ParentReviewResult}
 */
function inspectManagedPrForLocalReview(pullRequest) {
  if (hasActiveManagedPrWorkflow(pullRequest.labels)) {
    return {
      status: 'already-active',
      pullRequest: formatPullRequest(pullRequest),
      labels: pullRequest.labels ?? [],
    };
  }

  const state = readManagedPrState(pullRequest.body);
  if (!state.managed) {
    return {
      status: 'not-managed',
      pullRequest: formatPullRequest(pullRequest),
    };
  }

  if (isFinalizedForRebase(state)) {
    return {
      status: 'finalized',
      pullRequest: formatPullRequest(pullRequest),
    };
  }

  const nextOperation = selectLocalParentPullRequestOperation(pullRequest);
  if (nextOperation === 'pr-finalize') {
    return {
      status: 'ready-for-finalize',
      pullRequest: formatPullRequest(pullRequest),
      nextOperation: requireOperationCatalogOperationLabelName('pr-finalize'),
    };
  }

  if (nextOperation === 'pr-address-review') {
    return {
      status: 'ready-for-address-review',
      pullRequest: formatPullRequest(pullRequest),
      nextOperation: requireOperationCatalogOperationLabelName('pr-address-review'),
    };
  }

  return {
    status: 'ready-for-review',
    pullRequest: formatPullRequest(pullRequest),
    nextOperation: requireOperationCatalogOperationLabelName('pr-review'),
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {{
 *   parentIssue: GitHubIssue,
 *   parentIssueNumber: number,
 *   parentBranchName: string,
 *   tickets: GitHubIssue[],
 *   parentRun: LocalRunRunLink,
 *   runParentPullRequestOperation?: (request: PullRequestOperationRequest) => Promise<Record<string, unknown>>,
 * }} options
 * @returns {Promise<ParentReviewResult>}
 */
async function completePublishedLocalUmbrellaPullRequest(
  context,
  {
    parentIssue,
    parentIssueNumber,
    parentBranchName,
    tickets,
    parentRun,
    runParentPullRequestOperation,
  },
) {
  const inspected = await requestUmbrellaReviewIfComplete(context, {
    parentIssue,
    parentIssueNumber,
    parentBranchName,
    tickets,
    requestReview: false,
  });

  if (!isPublishedUmbrellaOperationReady(inspected.status)) {
    return inspected;
  }

  if (runParentPullRequestOperation === undefined) {
    return {
      ...inspected,
      status: 'blocked',
      summary: 'Local Spec auto-complete cannot run Umbrella PR review/finalize operations.',
    };
  }

  const pullRequestNumber = inspected.pullRequest?.number;
  if (pullRequestNumber === undefined) {
    return {
      ...inspected,
      status: 'blocked',
      summary: `Umbrella PR for parent issue #${parentIssueNumber} is ready, but its pull request number is unavailable.`,
    };
  }

  /** @type {Record<string, unknown> | undefined} */
  let review;
  /** @type {Record<string, unknown>[]} */
  const addressReviews = [];
  /** @type {string[]} */
  const localRunRecords = [];
  const parentPullRequestNumber = pullRequestNumber;
  const parentPullRequestOperationRunner = runParentPullRequestOperation;
  let parentOperationSteps = 0;

  /**
   * @param {PullRequestOperationName} operation
   * @returns {Promise<Record<string, unknown>>}
   */
  async function runTrackedParentPullRequestOperation(operation) {
    if (parentOperationSteps >= MAX_PUBLISHED_UMBRELLA_PARENT_OPERATION_STEPS) {
      return {
        status: 'blocked',
        summary: `Umbrella PR parent operation loop budget was exhausted for PR #${parentPullRequestNumber}.`,
      };
    }

    parentOperationSteps += 1;
    const output = await parentPullRequestOperationRunner({
      pullRequestNumber: parentPullRequestNumber,
      operation,
      parentRun,
    });
    recordParentOperationRunRecord(localRunRecords, output);
    return output;
  }

  /** @type {PullRequestOperationName} */
  let nextOperation =
    inspected.status === 'ready-for-address-review'
      ? 'pr-address-review'
      : inspected.status === 'ready-for-finalize'
        ? 'pr-finalize'
        : 'pr-review';
  /** @type {Record<string, unknown> | undefined} */
  let finalize;

  while (true) {
    const output = await runTrackedParentPullRequestOperation(nextOperation);
    if (isExternalRunnerWaitingOutput(output)) {
      return {
        ...inspected,
        status: 'waiting',
        summary: String(
          output.summary ?? `Umbrella PR #${pullRequestNumber} is waiting for ${nextOperation}.`,
        ),
        review,
        addressReviews,
        localRunRecords,
        nextOperation: operationReferenceForPullRequestOperation(nextOperation),
        runnerJob: output.runnerJob,
      };
    }

    if (output.status === 'blocked' || output.status === 'refused') {
      return completeBlockedPublishedUmbrellaPullRequest(inspected, {
        review,
        addressReviews,
        ...(nextOperation === 'pr-finalize' ? { finalize: output } : {}),
        localRunRecords,
        summary: String(
          output.summary ?? `Umbrella PR ${nextOperation} blocked on PR #${pullRequestNumber}.`,
        ),
      });
    }

    if (nextOperation === 'pr-address-review') {
      addressReviews.push(output);
      nextOperation = requireNextPullRequestOperation('pr-address-review', 'addressed');
      continue;
    }

    if (nextOperation === 'pr-review') {
      review = output;
      if (review.reviewResult === 'approved') {
        nextOperation = requireNextPullRequestOperation('pr-review', 'approved');
        continue;
      }

      if (review.reviewResult === 'changes_requested') {
        nextOperation = requireNextPullRequestOperation('pr-review', 'changes-requested');
        continue;
      }

      return completeBlockedPublishedUmbrellaPullRequest(inspected, {
        review,
        addressReviews,
        localRunRecords,
        summary: `Umbrella PR review did not approve PR #${pullRequestNumber}.`,
      });
    }

    if (nextOperation === 'pr-fix-ci') {
      nextOperation = requireNextPullRequestOperation('pr-fix-ci', 'fixed');
      continue;
    }

    if (nextOperation === 'pr-resolve-conflicts') {
      nextOperation = requireNextPullRequestOperation('pr-resolve-conflicts', 'resolved');
      continue;
    }

    finalize = output;
    const prFinalize = readRecordProperty(finalize, 'prFinalize');
    if (prFinalize?.waiting === true) {
      return {
        ...inspected,
        status: 'waiting',
        review,
        addressReviews,
        finalize,
        localRunRecords,
        nextOperation: requireOperationCatalogOperationLabelName('pr-finalize'),
      };
    }

    const routedOperation = readRoutedParentPullRequestOperation(prFinalize?.routedTo);
    if (routedOperation !== undefined) {
      nextOperation = routedOperation;
      continue;
    }

    if (typeof prFinalize?.routedTo === 'string') {
      return {
        ...inspected,
        status: 'blocked',
        summary: String(
          finalize.summary ?? `Umbrella PR finalization routed to ${prFinalize.routedTo}.`,
        ),
        review,
        addressReviews,
        finalize,
        localRunRecords,
        nextOperation: prFinalize.routedTo,
      };
    }

    return {
      ...inspected,
      status: 'finalized',
      review,
      addressReviews,
      finalize,
      localRunRecords,
    };
  }
}

/**
 * Consult the PullOps-Managed PR Transition graph for the operation that
 * follows one local automation outcome. Local automation loops only drive
 * operations with a defined continuation, so a terminal edge here is a
 * routing bug, not a workflow state.
 *
 * @param {import('../managed-pr/transitionPolicy.types.js').ManagedPrOperationName} operation
 * @param {string} outcomeKind
 * @returns {PullRequestOperationName}
 */
function requireNextPullRequestOperation(operation, outcomeKind) {
  const nextOperation = getNextManagedPrOperation({ operation, outcomeKind });
  if (nextOperation === undefined || !isLocalTicketPullRequestOperation(nextOperation)) {
    throw new Error(
      `The PullOps-Managed PR Transition graph has no local automation edge for ${operation} + ${outcomeKind}.`,
    );
  }

  return nextOperation;
}

/**
 * @param {unknown} routedTo
 * @returns {PullRequestOperationName | undefined}
 */
function readRoutedParentPullRequestOperation(routedTo) {
  if (
    routedTo === requireOperationCatalogOperationLabelName('pr-review') ||
    routedTo === 'pr:review' ||
    routedTo === 'pr-review'
  ) {
    return 'pr-review';
  }

  if (
    routedTo === requireOperationCatalogOperationLabelName('pr-address-review') ||
    routedTo === 'pr:address-review' ||
    routedTo === 'pr-address-review'
  ) {
    return 'pr-address-review';
  }

  if (
    routedTo === requireOperationCatalogOperationLabelName('pr-finalize') ||
    routedTo === 'pr:finalize' ||
    routedTo === 'pr-finalize'
  ) {
    return 'pr-finalize';
  }

  if (
    routedTo === requireOperationCatalogOperationLabelName('pr-fix-ci') ||
    routedTo === 'pr:fix-ci' ||
    routedTo === 'pr-fix-ci'
  ) {
    return 'pr-fix-ci';
  }

  if (
    routedTo === requireOperationCatalogOperationLabelName('pr-resolve-conflicts') ||
    routedTo === 'pr:resolve-conflicts' ||
    routedTo === 'pr-resolve-conflicts'
  ) {
    return 'pr-resolve-conflicts';
  }

  return undefined;
}

/**
 * @param {ParentReviewResult} inspected
 * @param {{
 *   summary: string,
 *   review?: Record<string, unknown>,
 *   addressReviews: Record<string, unknown>[],
 *   finalize?: Record<string, unknown>,
 *   localRunRecords: string[],
 * }} options
 * @returns {ParentReviewResult}
 */
function completeBlockedPublishedUmbrellaPullRequest(
  inspected,
  { summary, review, addressReviews, finalize, localRunRecords },
) {
  return {
    ...inspected,
    status: 'blocked',
    summary,
    ...(review === undefined ? {} : { review }),
    addressReviews,
    ...(finalize === undefined ? {} : { finalize }),
    localRunRecords,
  };
}

/**
 * @param {string[]} localRunRecords
 * @param {Record<string, unknown>} output
 * @returns {void}
 */
function recordParentOperationRunRecord(localRunRecords, output) {
  const runRecord = readOutputString(output, 'localRunRecord');
  if (runRecord !== undefined) {
    localRunRecords.push(runRecord);
  }
}

/**
 * @param {TicketAutomationResult} ticketResult
 * @param {string | undefined} localRunRecord
 * @returns {TicketAutomationResult}
 */
function withTicketLocalRunRecord(ticketResult, localRunRecord) {
  return localRunRecord === undefined ? ticketResult : { ...ticketResult, localRunRecord };
}

/**
 * @param {Record<string, unknown>} output
 * @param {string} key
 * @returns {Record<string, unknown> | undefined}
 */
function readRecordProperty(output, key) {
  const value = output[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubIssue} issue
 * @returns {Promise<GitHubIssue[]>}
 */
async function findBlockingDependencies(context, issue) {
  const dependencyNumbers = createIssueSnapshot(issue).blockedBy;
  /** @type {GitHubIssue[]} */
  const blockingDependencies = [];

  for (const dependencyNumber of dependencyNumbers) {
    const dependency = await context.githubClient.getIssue(dependencyNumber);
    if (!createIssueSnapshot(dependency).isDone) {
      blockingDependencies.push(dependency);
    }
  }

  return blockingDependencies;
}

/**
 * @param {OperationRunnerContext} context
 * @param {{ issue: GitHubIssue, pullRequest: GitHubPullRequest, expectedBaseBranch: string }} options
 * @returns {Promise<void>}
 */
async function closeTicket(context, { issue, pullRequest, expectedBaseBranch }) {
  await context.githubClient.closeIssue({
    number: issue.number,
    comment: [
      `PullOps closed this Ticket because PR #${pullRequest.number} merged into`,
      `the Spec branch \`${expectedBaseBranch}\`.`,
    ].join(' '),
  });
  await context.githubClient.removeLabelsFromIssue({
    number: issue.number,
    labels: [
      requireOperationCatalogOperationLabelName('issue-implement'),
      PULL_OPS_STATUS_LABELS.humanRequired,
    ],
  });
}

/**
 * @param {GitHubIssueReference} issue
 * @returns {boolean}
 */
function isClosedIssueReference(issue) {
  return issue.state === 'CLOSED';
}

/**
 * @param {GitHubPullRequest} pullRequest
 * @param {string} summary
 * @returns {TicketCloseResult}
 */
function skipped(pullRequest, summary) {
  return {
    status: 'skipped',
    summary,
    pullRequest: formatPullRequest(pullRequest),
  };
}

/**
 * @param {GitHubPullRequest} pullRequest
 * @returns {boolean}
 */
function isMergedPullRequest(pullRequest) {
  return pullRequest.state === 'MERGED' || pullRequest.mergedAt !== undefined;
}

/**
 * @param {string[] | undefined} labels
 * @returns {SpecAutomationMode | undefined}
 */
function readSpecAutomationMode(labels) {
  if (labels?.includes(requireOperationCatalogOperationLabelName('spec-auto-complete'))) {
    return 'auto-complete';
  }

  if (labels?.includes(requireOperationCatalogOperationLabelName('spec-auto-advance'))) {
    return 'auto-advance';
  }

  return undefined;
}

/**
 * @param {string[]} labels
 * @param {ReadonlySet<string>} candidates
 * @returns {boolean}
 */
function hasAnyLabel(labels, candidates) {
  return labels.some(label => candidates.has(label));
}

/** @type {ReadonlySet<PullRequestOperationName>} */
const LOCAL_CHILD_PULL_REQUEST_OPERATIONS = new Set([
  'pr-review',
  'pr-address-review',
  'pr-fix-ci',
  'pr-resolve-conflicts',
  'pr-finalize',
]);

/**
 * @param {string} operation
 * @returns {operation is PullRequestOperationName}
 */
function isLocalTicketPullRequestOperation(operation) {
  return LOCAL_CHILD_PULL_REQUEST_OPERATIONS.has(
    /** @type {PullRequestOperationName} */ (operation),
  );
}

/**
 * @param {GitHubPullRequest} pullRequest
 * @returns {string | undefined}
 */
function selectLocalTicketPullRequestOperation(pullRequest) {
  const labels = pullRequest.labels ?? [];
  for (const label of labels) {
    if (label === PULL_OPS_STATUS_LABELS.humanRequired) {
      continue;
    }

    const localOperation = readLocalPullRequestOperationFromLabel(label);
    if (localOperation !== undefined) {
      return localOperation;
    }

    if (
      label.startsWith('pullops:pr:') &&
      label !== requireOperationCatalogOperationLabelName('pr-review') &&
      label !== requireOperationCatalogOperationLabelName('pr-address-review') &&
      label !== requireOperationCatalogOperationLabelName('pr-fix-ci') &&
      label !== requireOperationCatalogOperationLabelName('pr-resolve-conflicts') &&
      label !== requireOperationCatalogOperationLabelName('pr-finalize')
    ) {
      return label;
    }
  }

  const state = readManagedPrState(pullRequest.body);
  if (isFinalizedForRebase(state)) {
    return undefined;
  }

  return chooseNextManagedPrOperationFromState({ state, profile: 'local-drive' });
}

/**
 * @param {GitHubPullRequest} pullRequest
 * @returns {PullRequestOperationName | undefined}
 */
function selectLocalParentPullRequestOperation(pullRequest) {
  for (const label of pullRequest.labels ?? []) {
    const localOperation = readLocalPullRequestOperationFromLabel(label);
    if (localOperation !== undefined) {
      return localOperation;
    }
  }

  const state = readManagedPrState(pullRequest.body);
  if (isFinalizedForRebase(state)) {
    return undefined;
  }

  // Parent umbrella PRs default to a fresh review when no recorded state
  // routes elsewhere.
  const nextOperation = chooseNextManagedPrOperationFromState({ state, profile: 'local-drive' });
  return nextOperation !== undefined && isLocalTicketPullRequestOperation(nextOperation)
    ? nextOperation
    : 'pr-review';
}

/**
 * @param {string} label
 * @returns {PullRequestOperationName | undefined}
 */
function readLocalPullRequestOperationFromLabel(label) {
  if (label === requireOperationCatalogOperationLabelName('pr-review')) {
    return 'pr-review';
  }

  if (label === requireOperationCatalogOperationLabelName('pr-address-review')) {
    return 'pr-address-review';
  }

  if (label === requireOperationCatalogOperationLabelName('pr-fix-ci')) {
    return 'pr-fix-ci';
  }

  if (label === requireOperationCatalogOperationLabelName('pr-resolve-conflicts')) {
    return 'pr-resolve-conflicts';
  }

  if (label === requireOperationCatalogOperationLabelName('pr-finalize')) {
    return 'pr-finalize';
  }

  return undefined;
}

/**
 * @param {string} status
 * @returns {boolean}
 */
function isPublishedUmbrellaOperationReady(status) {
  return (
    status === 'ready-for-review' ||
    status === 'ready-for-address-review' ||
    status === 'ready-for-finalize'
  );
}

/**
 * @param {PullRequestOperationName} operation
 * @returns {'review' | 'address-review' | 'checks' | 'conflict-resolution' | 'finalization'}
 */
function phaseForPullRequestOperation(operation) {
  if (operation === 'pr-review') {
    return 'review';
  }

  if (operation === 'pr-address-review') {
    return 'address-review';
  }

  if (operation === 'pr-fix-ci') {
    return 'checks';
  }

  if (operation === 'pr-resolve-conflicts') {
    return 'conflict-resolution';
  }

  return 'finalization';
}

/**
 * @param {PullRequestOperationName} operation
 * @returns {'pr:review' | 'pr:address-review' | 'pr:fix-ci' | 'pr:resolve-conflicts' | 'pr:finalize'}
 */
function operationReferenceForPullRequestOperation(operation) {
  if (operation === 'pr-review') {
    return 'pr:review';
  }

  if (operation === 'pr-address-review') {
    return 'pr:address-review';
  }

  if (operation === 'pr-fix-ci') {
    return 'pr:fix-ci';
  }

  if (operation === 'pr-resolve-conflicts') {
    return 'pr:resolve-conflicts';
  }

  return 'pr:finalize';
}

/**
 * @param {object} options
 * @param {GitHubIssue} options.issue
 * @param {string} options.status
 * @param {string} options.summary
 * @param {Partial<TicketAutomationResult>} [options.extra]
 * @returns {TicketAutomationResult}
 */
function createTicketResult({ issue, status, summary, extra = {} }) {
  return {
    issue: {
      number: issue.number,
      url: issue.url,
    },
    status,
    summary,
    ...extra,
  };
}

/**
 * @param {object} options
 * @param {TicketAutomationResult[]} options.ticketResults
 * @param {ParentReviewResult | undefined} options.parentPullRequest
 * @returns {import('../runner/types.js').ExternalRunnerJob | undefined}
 */
function readWaitingRunnerJob({ ticketResults, parentPullRequest }) {
  const waitingTicket = ticketResults.find(
    ticketResult => ticketResult.status === 'waiting' && ticketResult.runnerJob !== undefined,
  );
  if (
    waitingTicket?.runnerJob !== undefined &&
    isExecutableExternalRunnerJob(waitingTicket.runnerJob)
  ) {
    return waitingTicket.runnerJob;
  }

  if (
    parentPullRequest?.status === 'waiting' &&
    parentPullRequest.runnerJob !== undefined &&
    isExecutableExternalRunnerJob(parentPullRequest.runnerJob)
  ) {
    return parentPullRequest.runnerJob;
  }

  return undefined;
}

/**
 * Result payloads reference child runner jobs compactly; the executable
 * handoff stays only on the result's top-level `runnerJob` and in each run's
 * Local Run State.
 *
 * @param {TicketAutomationResult} ticketResult
 * @returns {TicketAutomationResult}
 */
function compactTicketResultRunnerJob(ticketResult) {
  if (
    ticketResult.runnerJob === undefined ||
    !isExecutableExternalRunnerJob(ticketResult.runnerJob)
  ) {
    return ticketResult;
  }

  return { ...ticketResult, runnerJob: createExternalRunnerJobReference(ticketResult.runnerJob) };
}

/**
 * @param {ParentReviewResult | undefined} parentPullRequest
 * @returns {ParentReviewResult | undefined}
 */
function compactParentResultRunnerJob(parentPullRequest) {
  if (
    parentPullRequest?.runnerJob === undefined ||
    !isExecutableExternalRunnerJob(parentPullRequest.runnerJob)
  ) {
    return parentPullRequest;
  }

  return {
    ...parentPullRequest,
    runnerJob: createExternalRunnerJobReference(parentPullRequest.runnerJob),
  };
}

/**
 * @param {object} options
 * @param {GitHubIssue} options.issue
 * @param {GitHubPullRequest} options.pullRequest
 * @param {string} options.status
 * @param {string} options.summary
 * @param {Partial<TicketAutomationResult>} [options.extra]
 * @returns {TicketAutomationResult}
 */
function ticketPullRequestResult({ issue, pullRequest, status, summary, extra = {} }) {
  return createTicketResult({
    issue,
    status,
    summary,
    extra: {
      pullRequest: formatPullRequest(pullRequest),
      ...extra,
    },
  });
}

/**
 * @param {GitHubPullRequest} pullRequest
 * @returns {{ number: number, url: string, baseBranch: string | undefined, headBranch: string }}
 */
function formatPullRequest(pullRequest) {
  return {
    number: pullRequest.number,
    url: pullRequest.url,
    baseBranch: pullRequest.baseRefName,
    headBranch: pullRequest.headRefName,
  };
}

/**
 * @param {object} options
 * @param {SpecAutomationMode} options.mode
 * @param {GitHubIssue} options.parentIssue
 * @param {TicketAutomationResult[]} options.ticketResults
 * @param {ParentReviewResult} options.parentPullRequest
 * @returns {string}
 */
function summarizeSpecAutomation({ mode, parentIssue, ticketResults, parentPullRequest }) {
  const started = countTicketsByStatus(ticketResults, 'started');
  const resumed = countTicketsByStatus(ticketResults, 'resumed');
  const merged = countTicketsByStatus(ticketResults, 'merged');
  const blocked = countTicketsByStatus(ticketResults, 'blocked');
  const parts = [
    `Ran Spec ${mode} for issue #${parentIssue.number}.`,
    `${started} ticket(s) started.`,
    `${resumed} ticket PR(s) resumed.`,
  ];

  if (mode === 'auto-complete') {
    parts.push(`${merged} finalized ticket PR(s) merged.`);
  }

  if (blocked > 0) {
    parts.push(`${blocked} ticket(s) blocked by dependencies.`);
  }

  if (parentPullRequest.status === 'review-requested') {
    parts.push('Requested umbrella PR review.');
  }

  if (parentPullRequest.status === 'waiting-for-tickets') {
    parts.push('Waiting for Tickets.');
  }

  return parts.join(' ');
}

/**
 * @param {object} options
 * @param {SpecAutomationMode} options.mode
 * @param {GitHubIssue} options.parentIssue
 * @param {TicketAutomationResult[]} options.ticketResults
 * @param {'dry-run' | 'publish'} options.publicationMode
 * @returns {string}
 */
function summarizeLocalSpecAutomation({ mode, parentIssue, ticketResults, publicationMode }) {
  const dryRunCompleted = countTicketsByStatus(ticketResults, 'dry-run-completed');
  const published = countTicketsByStatus(ticketResults, 'published');
  const merged = countTicketsByStatus(ticketResults, 'merged');
  const blocked = countTicketsByStatus(ticketResults, 'blocked');
  const waiting = countTicketsByStatus(ticketResults, 'waiting');
  const readyForHumanMerge = countTicketsByStatus(ticketResults, 'ready-for-human-merge');
  const parts = [`Ran local Spec ${mode} for issue #${parentIssue.number}.`];

  if (publicationMode === 'dry-run') {
    parts.push(`${dryRunCompleted + merged} ticket dry-run(s) completed.`);
  } else {
    parts.push(`${published} ticket PR(s) published.`);
  }

  if (mode === 'auto-complete') {
    parts.push(
      publicationMode === 'dry-run'
        ? `${merged} finalized ticket branch(es) merged locally.`
        : `${merged} finalized ticket PR(s) merged locally.`,
    );
  }

  if (blocked > 0) {
    parts.push(`${blocked} ticket(s) blocked.`);
  }

  if (waiting > 0 || readyForHumanMerge > 0) {
    parts.push(`${waiting + readyForHumanMerge} ticket PR(s) left for human review or merge.`);
  }

  return parts.join(' ');
}

/**
 * @param {{ directory: string }} runRecord
 * @param {GitHubIssue} issue
 * @param {{
 *   reason: string,
 *   mode: SpecAutomationMode,
 *   publicationMode: 'dry-run' | 'publish',
 * }} options
 * @returns {Promise<SpecAutomationResult>}
 */
async function refuseLocalSpecAutomation(runRecord, issue, { reason, mode, publicationMode }) {
  const targetNumber = issue.parent?.number ?? issue.number;
  const operationReference = readLocalSpecOperationReference(mode);
  const nextStep = `Run Spec ${mode} on Parent Issue #${targetNumber} instead.`;
  await writeLocalSpecRunArtifact(runRecord, 'failure-reason.txt', `${reason}\n`);
  return {
    status: 'refused',
    summary: reason,
    displayMessage: reason,
    refusalReason: 'wrong-target',
    issue: issue.number,
    mode,
    publicationMode,
    nextSteps: [nextStep],
    suggestedActions: [
      {
        kind: 'command',
        description: nextStep,
        argv: [
          'pullops',
          'run',
          operationReference,
          String(targetNumber),
          ...(publicationMode === 'publish' ? ['--publish', 'pr'] : []),
        ],
        approvalRequired: false,
      },
    ],
  };
}

/**
 * @param {SpecAutomationMode} mode
 * @returns {'spec:auto-advance' | 'spec:auto-complete'}
 */
function readLocalSpecOperationReference(mode) {
  return mode === 'auto-complete' ? 'spec:auto-complete' : 'spec:auto-advance';
}

/**
 * @param {OperationRunnerContext} context
 * @param {{
 *   operationReference: 'spec:auto-advance' | 'spec:auto-complete',
 *   targetNumber: number,
 *   publicationMode: 'dry-run' | 'publish',
 * }} options
 * @returns {Promise<LocalRunRecord>}
 */
async function createLocalSpecRunRecord(
  context,
  { operationReference, targetNumber, publicationMode },
) {
  const normalizedReference = normalizeOperationReferenceForPath(operationReference);
  const createdAt = new Date();
  const directory =
    context.localRunRecordDirectory ??
    createRunRecordLocation({
      cwd: context.cwd,
      operationReference,
      targetReference: targetNumber,
    }).directory;

  await mkdir(directory, { recursive: true });
  await writeLocalSpecRunArtifact(
    { directory },
    'metadata.json',
    `${JSON.stringify(
      {
        operationReference,
        normalizedOperationReference: normalizedReference,
        target: {
          type: context.target.type,
          number: targetNumber,
        },
        publicationMode,
        runGoal: context.runGoal ?? 'operation',
        createdAt: createdAt.toISOString(),
        heartbeatCommand: LOCAL_RUN_HEARTBEAT_COMMAND,
        heartbeatIntervalMs: DEFAULT_LOCAL_RUN_HEARTBEAT_INTERVAL_MS,
        leaseDurationMs: DEFAULT_LOCAL_RUN_LEASE_DURATION_MS,
      },
      null,
      2,
    )}\n`,
  );
  await context.progressEventWriter?.bindLocalRunRecord(directory);

  const stateRecord = await initializeLocalRunState({
    runRecordDirectory: directory,
    operationReference,
    target: {
      type: context.target.type,
      number: targetNumber,
    },
    publicationMode,
    runGoal: context.runGoal ?? 'operation',
    createdAt,
  });

  return {
    directory,
    statePath: stateRecord.statePath,
    heartbeatEnvironment: stateRecord.heartbeatEnvironment,
    runLink: stateRecord.runLink,
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {{
 *   mode: SpecAutomationMode,
 *   parentRun: LocalRunRunLink,
 * }} options
 * @returns {Promise<PullOpsParentEventSink | undefined>}
 */
async function maybeStartLocalSpecParentEventSink(context, { mode, parentRun }) {
  if (mode !== 'auto-complete' || context.progressEventWriter === undefined) {
    return undefined;
  }
  if (context.parentEventSink !== undefined) {
    return context.parentEventSink;
  }

  return await startPullOpsParentEventSink({
    parentRun,
    progressEventWriter: context.progressEventWriter,
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {{ directory: string }} runRecord
 * @param {{
 *   operationReference: 'spec:auto-advance' | 'spec:auto-complete',
 *   parentIssueNumber: number,
 *   mode: SpecAutomationMode,
 *   publicationMode: 'dry-run' | 'publish',
 * }} options
 * @returns {Promise<void>}
 */
async function requireCleanLocalSpecWorktree(
  context,
  runRecord,
  { operationReference, parentIssueNumber, mode, publicationMode },
) {
  if (!(await context.gitClient.hasChanges())) {
    return;
  }

  const nextStep = 'Commit, stash, or discard existing changes and run PullOps again.';
  const reason = [
    `Local ${operationReference} requires a clean worktree before PullOps reads or mutates branch state.`,
    nextStep,
  ].join(' ');
  await writeLocalSpecRunArtifact(runRecord, 'failure-reason.txt', `${reason}\n`);
  throw createKnownLocalSpecRunBoundaryError({
    message: reason,
    localRunRecord: runRecord.directory,
    output: {
      status: 'refused',
      summary: reason,
      displayMessage: reason,
      refusalReason: 'dirty-worktree',
      issue: parentIssueNumber,
      mode,
      publicationMode,
      nextSteps: [nextStep],
      suggestedActions: [
        {
          kind: 'command',
          description: `Rerun Spec ${mode} after the worktree is clean.`,
          argv: [
            'pullops',
            'run',
            operationReference,
            String(parentIssueNumber),
            ...(publicationMode === 'publish' ? ['--publish', 'pr'] : []),
          ],
          approvalRequired: true,
          approvalReason:
            'Existing local changes require maintainer approval before rerunning PullOps.',
        },
      ],
    },
  });
}

/**
 * @param {LocalRunRecord} runRecord
 * @param {SpecAutomationResult} result
 * @returns {Promise<SpecAutomationResult>}
 */
async function completeLocalSpecRunRecord(runRecord, result) {
  const withRunRecord = {
    ...result,
    localRunRecord: runRecord.directory,
  };
  if (result.status === 'waiting') {
    const runnerJob = readResultRunnerJob(result);
    if (runnerJob === undefined) {
      throw new Error('Waiting local Spec run result must include runnerJob.');
    }

    await writeLocalSpecRunArtifact(
      runRecord,
      'result.json',
      `${JSON.stringify(withRunRecord, null, 2)}\n`,
    );
    await recordLocalRunWaitingForRunner({
      statePath: runRecord.statePath,
      summary: result.summary,
      phase: 'run',
      runnerJob,
    });
    return withRunRecord;
  }

  const terminalStatus = mapLocalRunResultStatusToTerminalStatus(
    /** @type {import('../local-run-state/types.js').LocalRunResultStatus} */ (result.status),
  );
  const terminalSummary = result.summary;

  await writeLocalSpecRunArtifact(
    runRecord,
    'result.json',
    `${JSON.stringify(withRunRecord, null, 2)}\n`,
  );
  await recordLocalRunTerminalStatus({
    statePath: runRecord.statePath,
    status: terminalStatus,
    summary: terminalSummary,
    phase: 'run',
  });
  return withRunRecord;
}

/**
 * @param {SpecAutomationResult} result
 * @returns {import('../runner/types.js').ExternalRunnerJob | undefined}
 */
function readResultRunnerJob(result) {
  return isExternalRunnerWaitingOutput(result) ? result.runnerJob : undefined;
}

/**
 * @param {OperationRunnerContext} context
 * @param {number} parentIssueNumber
 * @returns {Promise<void>}
 */
async function emitLocalSpecAutoCompleteRunStarted(context, parentIssueNumber) {
  if (context.progressEventWriter === undefined) {
    return;
  }

  await context.progressEventWriter.emit('run.started', {
    phase: 'run',
    message: `Starting local Spec auto-complete for issue #${parentIssueNumber}.`,
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {number} parentIssueNumber
 * @returns {Promise<void>}
 */
async function emitLocalSpecAutoCompletePhaseStarted(context, parentIssueNumber) {
  if (context.progressEventWriter === undefined) {
    return;
  }

  await context.progressEventWriter.emit('phase.started', {
    phase: 'ticket-coordination',
    message: `Coordinating tickets for issue #${parentIssueNumber}.`,
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubIssue} ticket
 * @returns {Promise<void>}
 */
async function emitLocalSpecAutoCompleteTicketStarted(context, ticket) {
  if (context.progressEventWriter === undefined) {
    return;
  }

  await context.progressEventWriter.emit('ticket.started', {
    phase: 'ticket-coordination',
    ticket: {
      number: ticket.number,
      url: ticket.url,
    },
    message: `Coordinating ticket #${ticket.number}.`,
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {TicketAutomationResult} ticketResult
 * @returns {Promise<void>}
 */
async function emitLocalSpecAutoCompleteTicketProgress(context, ticketResult) {
  if (context.progressEventWriter === undefined) {
    return;
  }

  const progressEvent = createLocalSpecAutoCompleteTicketProgressEvent(ticketResult);
  await context.progressEventWriter.emit(progressEvent.event, progressEvent.details);
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubIssue} ticket
 * @returns {{ progress(message: string): void, flush(): Promise<void> } | undefined}
 */
function createLocalSpecAutoCompleteTicketProgressReporter(context, ticket) {
  if (context.progressEventWriter === undefined) {
    return undefined;
  }

  /** @type {Promise<void>} */
  let pending = Promise.resolve();

  return {
    progress(message) {
      pending = pending.then(async () => {
        await emitLocalSpecAutoCompleteTicketProgressMessage(context, ticket, message);
      });
    },
    async flush() {
      await pending;
    },
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubIssue} ticket
 * @param {string} progressMessage
 * @returns {Promise<void>}
 */
async function emitLocalSpecAutoCompleteTicketProgressMessage(context, ticket, progressMessage) {
  if (context.progressEventWriter === undefined) {
    return;
  }

  await context.progressEventWriter.emit('ticket.progress', {
    phase: 'ticket-coordination',
    ticket: {
      number: ticket.number,
      url: ticket.url,
    },
    message: progressMessage,
    progressMessage,
    ...readLocalRunRecordProgress(progressMessage),
  });
}

/**
 * @param {string} progressMessage
 * @returns {{ localRunRecord: string } | {}}
 */
function readLocalRunRecordProgress(progressMessage) {
  const prefix = 'Local Run Record: ';
  if (!progressMessage.startsWith(prefix)) {
    return {};
  }

  return {
    localRunRecord: progressMessage.slice(prefix.length),
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {TicketAutomationResult[]} ticketResults
 * @param {number} parentIssueNumber
 * @returns {Promise<void>}
 */
async function emitLocalSpecAutoCompletePhaseCompleted(context, ticketResults, parentIssueNumber) {
  if (context.progressEventWriter === undefined) {
    return;
  }

  await context.progressEventWriter.emit(
    'phase.completed',
    createLocalSpecAutoCompletePhaseCompletedEvent({
      tickets: ticketResults,
      targetNumber: parentIssueNumber,
    }),
  );
}

/**
 * @param {OperationRunnerContext} context
 * @param {ParentReviewResult | undefined} parentPullRequest
 * @returns {Promise<void>}
 */
async function emitLocalSpecAutoCompleteParentWaiting(context, parentPullRequest) {
  if (context.progressEventWriter === undefined) {
    return;
  }

  const waitingEvent = createLocalSpecAutoCompleteParentWaitingEvent(parentPullRequest);
  if (waitingEvent === undefined) {
    return;
  }

  await context.progressEventWriter.emit('waiting', waitingEvent);
}

/**
 * @param {{ directory: string }} runRecord
 * @param {string} fileName
 * @param {string} contents
 * @returns {Promise<void>}
 */
async function writeLocalSpecRunArtifact(runRecord, fileName, contents) {
  await writeFile(join(runRecord.directory, fileName), contents);
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {unknown} error
 * @returns {import('../local-run-state/types.js').LocalRunTerminalStatus | undefined}
 */
function readKnownLocalSpecRunBoundaryTerminalStatus(error) {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const boundary = /** @type {{ localSpecRunBoundary?: unknown }} */ (error).localSpecRunBoundary;
  if (typeof boundary !== 'object' || boundary === null) {
    return undefined;
  }

  const status = /** @type {{ status?: unknown }} */ (boundary).status;
  switch (status) {
    case 'blocked':
    case 'refused':
    case 'failed':
      return mapLocalRunResultStatusToTerminalStatus(status);
    default:
      return undefined;
  }
}

/**
 * @param {{
 *   message: string,
 *   localRunRecord: string,
 *   output: SpecAutomationResult,
 * }} options
 * @returns {Error & { localRunRecord: string, localSpecRunBoundary: SpecAutomationResult }}
 */
function createKnownLocalSpecRunBoundaryError({ message, localRunRecord, output }) {
  return Object.assign(new Error(`${message} Local Run Record: ${localRunRecord}`), {
    localRunRecord,
    localSpecRunBoundary: output,
  });
}

/**
 * @param {unknown} error
 * @param {string} localRunRecord
 * @returns {unknown}
 */
function attachLocalRunRecordToError(error, localRunRecord) {
  if (typeof error === 'object' && error !== null) {
    return Object.assign(error, { localRunRecord });
  }

  return Object.assign(new Error(getErrorMessage(error)), { localRunRecord });
}

/**
 * @param {object} options
 * @param {SpecAutomationMode} options.mode
 * @param {TicketAutomationResult[]} options.ticketResults
 * @param {'dry-run' | 'publish'} options.publicationMode
 * @param {ParentReviewResult | undefined} options.parentPullRequest
 * @returns {string[]}
 */
function buildLocalNextSteps({ mode, ticketResults, publicationMode, parentPullRequest }) {
  if (publicationMode === 'dry-run') {
    if (mode === 'auto-complete') {
      return buildLocalAutoCompleteDryRunNextSteps({ ticketResults, parentPullRequest, mode });
    }

    const completed = ticketResults.filter(
      ticketResult => ticketResult.status === 'dry-run-completed',
    );
    if (completed.length > 0) {
      const completedIssueNumbers = completed
        .map(ticketResult => `#${ticketResult.issue.number}`)
        .join(', ');
      const completedIssueLabel = completed.length === 1 ? 'ticket' : 'tickets';
      return [
        `Inspect local run evidence for ${completedIssueLabel} ${completedIssueNumbers}.`,
        `Publish with \`pullops run spec:${mode} <parent-issue-number> --publish pr\` after reviewing the local branch.`,
      ];
    }

    const merged = ticketResults.filter(ticketResult => ticketResult.status === 'merged');
    if (merged.length > 0) {
      return [
        'Inspect the local umbrella branch with finalized ticket PR commits applied.',
        `Publish with \`pullops run spec:${mode} <parent-issue-number> --publish pr\` after reviewing the local branch.`,
      ];
    }

    return buildLocalFollowUpWithoutRunnableTicket(parentPullRequest, publicationMode, mode);
  }

  const blocked = ticketResults.find(ticketResult => ticketResult.status === 'blocked');
  if (blocked !== undefined) {
    return [`Resolve the blocker for ticket #${blocked.issue.number}, then rerun Spec ${mode}.`];
  }

  const waiting = ticketResults.find(ticketResult => ticketResult.status === 'waiting');
  if (waiting !== undefined) {
    if (waiting.runnerJob !== undefined) {
      return [
        `Execute the external runner handoff for ticket #${waiting.issue.number}, then rerun Spec ${mode}.`,
      ];
    }

    return [
      `Wait for ticket #${waiting.issue.number} to finish review or checks, then rerun Spec ${mode}.`,
    ];
  }

  if (parentPullRequest?.status === 'ready-for-review') {
    return [
      'Umbrella PR is ready for human review; request review manually after verifying the refreshed Spec context.',
    ];
  }

  if (parentPullRequest?.status === 'blocked') {
    return ['Resolve the Umbrella PR automation blocker, then rerun Spec auto-complete.'];
  }

  if (parentPullRequest?.status === 'waiting' && (parentPullRequest.openTickets?.length ?? 0) > 0) {
    return [
      `Wait for open Tickets to close, then rerun Spec ${mode} before the final Umbrella PR merge.`,
    ];
  }

  if (parentPullRequest?.status === 'waiting') {
    return ['Wait for Umbrella PR checks to finish, then rerun Spec auto-complete.'];
  }

  if (mode === 'auto-complete') {
    return [
      'Review the Umbrella PR branch and merge the Umbrella PR manually when ready; PullOps did not merge it into the default branch.',
    ];
  }

  return ['Review and merge the published Ticket PRs before completing the umbrella Spec PR.'];
}

/**
 * @param {object} options
 * @param {TicketAutomationResult[]} options.ticketResults
 * @param {ParentReviewResult | undefined} options.parentPullRequest
 * @param {SpecAutomationMode} options.mode
 * @returns {string[]}
 */
function buildLocalAutoCompleteDryRunNextSteps({ ticketResults, parentPullRequest, mode }) {
  /** @type {string[]} */
  const steps = [];
  const merged = ticketResults.filter(ticketResult => ticketResult.status === 'merged');
  const completed = ticketResults.filter(
    ticketResult => ticketResult.status === 'dry-run-completed' || ticketResult.status === 'merged',
  );

  if (completed.length > 0) {
    const completedIssueNumbers = completed
      .map(ticketResult => `#${ticketResult.issue.number}`)
      .join(', ');
    const completedIssueLabel = completed.length === 1 ? 'ticket' : 'tickets';
    steps.push(`Inspect local run evidence for ${completedIssueLabel} ${completedIssueNumbers}.`);
  }

  if (merged.length > 0) {
    steps.push('Inspect the local umbrella branch with finalized ticket commits applied.');
  }

  const waiting = ticketResults.find(ticketResult => ticketResult.status === 'waiting');
  if (waiting !== undefined) {
    if (waiting.runnerJob !== undefined) {
      steps.push(
        `Execute the external runner handoff for ticket #${waiting.issue.number}, then rerun Spec ${mode}.`,
      );
      return steps;
    }

    steps.push(
      `Wait for ticket #${waiting.issue.number} to finish review or checks, then rerun Spec ${mode}.`,
    );
    return steps;
  }

  const blocked = ticketResults.find(ticketResult => ticketResult.status === 'blocked');
  if (blocked !== undefined) {
    steps.push(`Resolve the blocker for ticket #${blocked.issue.number}, then rerun Spec ${mode}.`);
    return steps;
  }

  if (completed.length > 0) {
    steps.push(
      `Publish with \`pullops run spec:${mode} <parent-issue-number> --publish pr\` after reviewing the local branch.`,
    );
    return steps;
  }

  return buildLocalFollowUpWithoutRunnableTicket(parentPullRequest, 'dry-run', mode);
}

/**
 * @param {ParentReviewResult | undefined} parentPullRequest
 * @param {'dry-run' | 'publish'} publicationMode
 * @param {SpecAutomationMode} mode
 * @returns {string[]}
 */
function buildLocalFollowUpWithoutRunnableTicket(parentPullRequest, publicationMode, mode) {
  if (parentPullRequest?.status === 'ready-for-review') {
    return [
      `Umbrella PR is ready for human review after local ${publicationMode}; request review manually instead of adding trigger labels.`,
    ];
  }

  if (parentPullRequest?.status === 'waiting-for-tickets') {
    return [`Add or reopen a native Ticket before rerunning local Spec ${mode}.`];
  }

  return ['No runnable ticket was available for local dry-run.'];
}

/**
 * @param {TicketAutomationResult[]} ticketResults
 * @param {string} status
 * @returns {number}
 */
function countTicketsByStatus(ticketResults, status) {
  return ticketResults.filter(ticketResult => ticketResult.status === status).length;
}

/**
 * @param {GitHubIssue[]} issues
 * @returns {string}
 */
function formatIssueNumbers(issues) {
  return issues.map(issue => `#${issue.number}`).join(', ');
}

/**
 * @param {'dry-run' | 'publish'} publicationMode
 * @returns {'dry-run-completed' | 'published'}
 */
function localImplementedTicketStatus(publicationMode) {
  return publicationMode === 'publish' ? 'published' : 'dry-run-completed';
}

/**
 * @param {Record<string, unknown>} output
 * @param {string} fallback
 * @returns {string}
 */
function readOutputBranch(output, fallback) {
  const branch = readOutputString(output, 'branch');
  if (branch !== undefined) {
    return branch;
  }

  const pullRequest = readOutputPullRequest(output);
  return pullRequest?.headBranch ?? fallback;
}

/**
 * @param {Record<string, unknown>} output
 * @param {string} key
 * @returns {string | undefined}
 */
function readOutputString(output, key) {
  const value = output[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * @param {Record<string, unknown>} output
 * @returns {Partial<TicketAutomationResult>}
 */
function readOutputBlocker(output) {
  const blockedPhase = readOutputString(output, 'blockedPhase');
  const blockedOperation = readOutputString(output, 'blockedOperation');
  return {
    ...(blockedPhase === undefined ? {} : { blockedPhase }),
    ...(blockedOperation === undefined ? {} : { blockedOperation }),
  };
}

/**
 * @param {Record<string, unknown>} output
 * @returns {{ number: number, url: string, baseBranch?: string, headBranch: string } | undefined}
 */
function readOutputPullRequest(output) {
  const value = output.pullRequest;
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const pullRequest = /** @type {Record<string, unknown>} */ (value);
  if (
    typeof pullRequest.number !== 'number' ||
    typeof pullRequest.url !== 'string' ||
    typeof pullRequest.branch !== 'string'
  ) {
    return undefined;
  }

  return {
    number: pullRequest.number,
    url: pullRequest.url,
    headBranch: pullRequest.branch,
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {{ parentBranchName: string }} options
 * @returns {Promise<void>}
 */
async function checkoutLocalSpecBase(context, { parentBranchName }) {
  if (context.gitClient.fetchRemoteRefs === undefined) {
    throw new Error('Git client does not support local remote ref fetching.');
  }

  if (context.gitClient.checkoutPullOpsBranch === undefined) {
    throw new Error('Git client does not support local PullOps branch checkout.');
  }

  await context.gitClient.fetchRemoteRefs({
    requiredBranchNames: [context.config.baseBranch],
    optionalBranchNames: [parentBranchName],
  });
  await context.gitClient.checkoutPullOpsBranch({
    branchName: parentBranchName,
    baseBranch: context.config.baseBranch,
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {{ pullRequest: GitHubPullRequest }} options
 * @returns {Promise<void>}
 */
async function checkoutLocalPullRequestHead(context, { pullRequest }) {
  if (context.gitClient.fetchRemoteRefs === undefined) {
    throw new Error('Git client does not support local remote ref fetching.');
  }

  if (context.gitClient.checkoutPullOpsBranch === undefined) {
    throw new Error('Git client does not support local PullOps branch checkout.');
  }

  const baseBranch = pullRequest.baseRefName ?? context.config.baseBranch;
  await context.gitClient.fetchRemoteRefs({
    requiredBranchNames: [baseBranch],
    optionalBranchNames: [pullRequest.headRefName],
  });
  await context.gitClient.checkoutPullOpsBranch({
    branchName: pullRequest.headRefName,
    baseBranch,
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubIssue} issue
 * @param {{ reason: string, mode: SpecAutomationMode }} options
 * @returns {Promise<SpecAutomationResult>}
 */
async function blockSpecAutomation(context, issue, { reason, mode }) {
  await context.githubClient.addLabelsToIssue({
    number: issue.number,
    labels: [PULL_OPS_STATUS_LABELS.humanRequired],
  });
  await context.githubClient.removeLabelsFromIssue({
    number: issue.number,
    labels: [
      requireOperationCatalogOperationLabelName('spec-auto-advance'),
      requireOperationCatalogOperationLabelName('spec-auto-complete'),
    ],
  });
  await context.githubClient.commentOnIssue({
    number: issue.number,
    body: [
      `PullOps could not complete \`pullops run spec:${mode}\`.`,
      '',
      `Reason: ${reason}`,
    ].join('\n'),
  });

  return {
    status: 'blocked',
    summary: reason,
    mode,
    issue: issue.number,
  };
}
