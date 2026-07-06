import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { readManagedPrState } from '../managed-pr/ManagedPrState.js';
import { hasPullOpsBranchPrefix } from './branchNames.js';
import { GITHUB_ACTIONS_BOT_AUTHOR } from './githubActionsBot.js';
import {
  DEFAULT_LOCAL_RUN_HEARTBEAT_INTERVAL_MS,
  DEFAULT_LOCAL_RUN_LEASE_DURATION_MS,
  LOCAL_RUN_HEARTBEAT_COMMAND,
  initializeLocalRunState,
  mapLocalRunResultStatusToTerminalStatus,
  normalizeOperationReferenceForPath,
  recordLocalRunTerminalStatus,
} from '../local-run-state/localRunState.js';
import { getOperationCatalogOperationLabelReferenceForWorkflowOperation } from './operationCatalog.js';

/**
 * @typedef {import('../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../github/types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('../local-run-state/types.js').LocalRunRecord} LocalRunRecord
 * @typedef {import('./runLocalPullRequestOperation.types.js').RunLocalPullRequestOperationOptions} RunLocalPullRequestOperationOptions
 */

/**
 * Run one PR operation on the local Execution Backend: create the Local Run
 * Record, guard the worktree, apply the shared PullOps-Managed PR guardrails,
 * and hand the prepared operation to the Operation Module's local flow.
 *
 * @param {OperationRunnerContext} context
 * @param {RunLocalPullRequestOperationOptions} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runLocalPullRequestOperation(context, options = {}) {
  assertPullRequestTarget(context);

  const operationReference = readLocalPullRequestOperationReference(context.operation);
  const runRecord = await createLocalPullRequestRunRecord(context, {
    operationReference: operationReference ?? context.operation,
  });

  try {
    await requireCleanLocalPullRequestWorktree(
      context,
      runRecord,
      operationReference ?? context.operation,
    );

    if (operationReference === undefined) {
      return await blockLocalPullRequestOperation(context, runRecord, {
        reason: `Local pull request execution is not registered for ${context.operation}.`,
      });
    }

    const preparation = await prepareLocalPullRequestOperation(context, runRecord, {
      operationReference,
    });
    if (!preparation.ready) {
      return preparation.output;
    }

    if (options.runPrepared === undefined) {
      return await blockLocalPullRequestOperation(context, runRecord, {
        pullRequest: preparation.pullRequest,
        reason: `Local dry-run execution is not implemented yet for ${operationReference}.`,
      });
    }

    return await options.runPrepared(context, runRecord, preparation);
  } catch (error) {
    await writeLocalPullRequestRunArtifact(runRecord, 'error.txt', `${getErrorMessage(error)}\n`);
    await recordLocalRunTerminalStatus({
      statePath: runRecord.statePath,
      status: 'failed',
      summary: getErrorMessage(error),
      phase: 'run',
    });
    throw error;
  }
}

/**
 * Run one inline CLI runner step for an Operation Module's local flow:
 * record the prompt artifact, run the runner with the Local Run Record's
 * heartbeat environment, record the raw output artifact, and validate.
 *
 * @template T
 * @param {OperationRunnerContext} context
 * @param {LocalRunRecord} runRecord
 * @param {{
 *   operationReference: string,
 *   prompt: string,
 *   validate: (value: unknown) => { valid: true, value: T } | { valid: false, reason: string },
 * }} options
 * @returns {Promise<{ valid: true, value: T } | { valid: false, reason: string }>}
 */
export async function runLocalCodexOperation(
  context,
  runRecord,
  { operationReference, prompt, validate },
) {
  await writeLocalPullRequestRunArtifact(
    runRecord,
    `${normalizeOperationReferenceForPath(operationReference)}-prompt.md`,
    prompt,
  );
  const rawOutput = await context.codexRunner.run({
    cwd: context.cwd,
    command: context.config.runner.command,
    model: context.model,
    prompt,
    streamOutput: context.suppressRunnerOutput !== true,
    env: runRecord.heartbeatEnvironment,
  });
  await writeLocalPullRequestRunArtifact(
    runRecord,
    `${normalizeOperationReferenceForPath(operationReference)}-raw-output.txt`,
    formatArtifactValue(rawOutput),
  );
  return validate(rawOutput);
}

/**
 * @param {OperationRunnerContext} context
 * @param {LocalRunRecord} runRecord
 * @param {{ operationReference: string }} options
 * @returns {Promise<
 *   | ({ ready: true } & import('./runLocalPullRequestOperation.types.js').PreparedLocalPullRequestOperation)
 *   | { ready: false, output: Record<string, unknown> }
 * >}
 */
async function prepareLocalPullRequestOperation(context, runRecord, { operationReference }) {
  const pullRequest = await context.githubClient.getPullRequest(context.target.number);
  const state = readManagedPrState(pullRequest.body);

  if (pullRequest.isCrossRepository === true) {
    return {
      ready: false,
      output: await blockLocalPullRequestOperation(context, runRecord, {
        pullRequest,
        reason: `PullOps local PR operations only support same-repository PRs. PR #${pullRequest.number} comes from a fork.`,
      }),
    };
  }

  if (!state.managed) {
    return {
      ready: false,
      output: await blockLocalPullRequestOperation(context, runRecord, {
        pullRequest,
        reason: `PR #${pullRequest.number} is not a PullOps-managed PR.`,
      }),
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
      output: await blockLocalPullRequestOperation(context, runRecord, {
        pullRequest,
        reason: `PR #${pullRequest.number} head branch "${pullRequest.headRefName}" does not use the configured PullOps branch prefix.`,
      }),
    };
  }

  if (state.sourceIssueNumber === undefined) {
    return {
      ready: false,
      output: await blockLocalPullRequestOperation(context, runRecord, {
        pullRequest,
        reason: `PR #${pullRequest.number} does not include a structured Source: Issue #<number> line.`,
      }),
    };
  }

  if (
    operationReference === 'pr:address-review' &&
    state.reviewCycles.current >= state.reviewCycles.max
  ) {
    return {
      ready: false,
      output: await blockLocalPullRequestOperation(context, runRecord, {
        pullRequest,
        reason: `Review cycle budget exhausted for PR #${pullRequest.number}: ${state.reviewCycles.current} / ${state.reviewCycles.max}.`,
      }),
    };
  }

  const issue = await context.githubClient.getIssue(state.sourceIssueNumber);
  if (operationReference === 'pr:review' && state.sourceKind === 'parentIssue') {
    const openChildIssues = issue.subIssues.filter(childIssue => !isClosedIssue(childIssue));
    if (openChildIssues.length > 0) {
      return {
        ready: false,
        output: await blockLocalPullRequestOperation(context, runRecord, {
          pullRequest,
          reason: [
            `Umbrella PRD PR #${pullRequest.number} is incomplete because native Child Issues`,
            `${formatIssueList(openChildIssues)} remain open.`,
            'Incomplete PRDs cannot be approved.',
          ].join(' '),
        }),
      };
    }
  }

  const reviewContext = await context.githubClient.getPullRequestReviewContext(pullRequest.number);
  const diff = await context.githubClient.getPullRequestDiff(pullRequest.number);

  return {
    ready: true,
    pullRequest,
    issue,
    reviewContext,
    diff,
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {{ message: string }} options
 * @returns {Promise<boolean>}
 */
export async function commitLocalChangesIfPresent(context, { message }) {
  if (!(await context.gitClient.hasChanges())) {
    return false;
  }

  await context.gitClient.commitAll({
    message,
    author: GITHUB_ACTIONS_BOT_AUTHOR,
  });
  return true;
}

/**
 * @param {OperationRunnerContext} context
 * @param {{ directory: string }} runRecord
 * @param {string} operationReference
 * @returns {Promise<void>}
 */
async function requireCleanLocalPullRequestWorktree(context, runRecord, operationReference) {
  if (!(await context.gitClient.hasChanges())) {
    return;
  }

  const reason = [
    `Local ${operationReference} requires a clean worktree before PullOps reads or mutates branch state.`,
    'Commit, stash, or discard existing changes and run PullOps again.',
  ].join(' ');
  await writeLocalPullRequestRunArtifact(runRecord, 'failure-reason.txt', `${reason}\n`);
  throw new Error(`${reason} Local Run Record: ${runRecord.directory}`);
}

/**
 * @param {OperationRunnerContext} context
 * @param {{ operationReference: string }} options
 * @returns {Promise<LocalRunRecord>}
 */
async function createLocalPullRequestRunRecord(context, { operationReference }) {
  const normalizedReference = normalizeOperationReferenceForPath(operationReference);
  const createdAt = new Date();
  const timestamp = createdAt.toISOString().replaceAll(':', '').replaceAll('.', '');
  const directory = join(
    context.cwd,
    '.pullops',
    'runs',
    `${timestamp}-${normalizedReference}-${context.target.number}`,
  );

  await mkdir(directory, { recursive: true });
  await writeLocalPullRequestRunArtifact(
    { directory },
    'metadata.json',
    `${JSON.stringify(
      {
        operation: context.operation,
        operationReference,
        normalizedOperationReference: normalizedReference,
        target: context.target,
        publicationMode: context.publicationMode ?? 'dry-run',
        runGoal: context.runGoal ?? 'operation',
        modelTier: context.modelTier,
        model: context.model,
        createdAt: createdAt.toISOString(),
        heartbeatCommand: LOCAL_RUN_HEARTBEAT_COMMAND,
        heartbeatIntervalMs: DEFAULT_LOCAL_RUN_HEARTBEAT_INTERVAL_MS,
        leaseDurationMs: DEFAULT_LOCAL_RUN_LEASE_DURATION_MS,
      },
      null,
      2,
    )}\n`,
  );

  const stateRecord = await initializeLocalRunState({
    runRecordDirectory: directory,
    operationReference,
    target: context.target,
    publicationMode: context.publicationMode ?? 'dry-run',
    runGoal: context.runGoal ?? 'operation',
    createdAt,
    ...(context.parentRun === undefined ? {} : { parentRun: context.parentRun }),
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
 * @param {LocalRunRecord} runRecord
 * @param {{ reason: string, pullRequest?: GitHubPullRequest }} options
 * @returns {Promise<Record<string, unknown>>}
 */
export async function blockLocalPullRequestOperation(context, runRecord, { reason, pullRequest }) {
  await writeLocalPullRequestRunArtifact(runRecord, 'failure-reason.txt', `${reason}\n`);
  return await completeLocalPullRequestRunRecord(runRecord, {
    status: 'blocked',
    summary: reason,
    operation: readLocalPullRequestOperationReference(context.operation) ?? context.operation,
    target: context.target,
    ...(pullRequest === undefined ? {} : { pullRequest: formatPullRequest(pullRequest) }),
  });
}

/**
 * @param {string} operationName
 * @returns {string | undefined}
 */
function readLocalPullRequestOperationReference(operationName) {
  return getOperationCatalogOperationLabelReferenceForWorkflowOperation(operationName)?.reference;
}

/**
 * @param {LocalRunRecord} runRecord
 * @param {Record<string, unknown>} result
 * @returns {Promise<Record<string, unknown>>}
 */
export async function completeLocalPullRequestRunRecord(runRecord, result) {
  const withRunRecord = {
    ...result,
    publicationMode: 'dry-run',
    localRunRecord: runRecord.directory,
  };
  const terminalStatus = mapLocalRunResultStatusToTerminalStatus(
    /** @type {import('../local-run-state/types.js').LocalRunResultStatus} */ (result.status),
  );
  const terminalSummary = /** @type {string} */ (result.summary);

  await writeLocalPullRequestRunArtifact(
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
 * @param {GitHubPullRequest} pullRequest
 * @returns {{ number: number, url: string }}
 */
export function formatPullRequest(pullRequest) {
  return {
    number: pullRequest.number,
    url: pullRequest.url,
  };
}

/**
 * @param {import('../github/types.js').GitHubIssueReference[]} issues
 * @returns {string}
 */
function formatIssueList(issues) {
  return issues.map(issue => `#${issue.number}`).join(', ');
}

/**
 * @param {import('../github/types.js').GitHubIssueReference} issue
 * @returns {boolean}
 */
function isClosedIssue(issue) {
  return issue.state?.toUpperCase() === 'CLOSED';
}

/**
 * @param {{ directory: string }} runRecord
 * @param {string} fileName
 * @param {string} contents
 * @returns {Promise<void>}
 */
export async function writeLocalPullRequestRunArtifact(runRecord, fileName, contents) {
  await writeFile(join(runRecord.directory, fileName), contents);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function formatArtifactValue(value) {
  if (typeof value === 'string') {
    return value.endsWith('\n') ? value : `${value}\n`;
  }

  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * @param {OperationRunnerContext} context
 */
function assertPullRequestTarget(context) {
  if (context.target.type !== 'pr') {
    throw new Error(`Expected pull request target, received ${context.target.type}.`);
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
