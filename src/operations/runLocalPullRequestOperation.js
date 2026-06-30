import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { readManagedPrState } from '../managed-pr/ManagedPrState.js';
import { hasPullOpsBranchPrefix } from './branchNames.js';
import { GITHUB_ACTIONS_BOT_AUTHOR } from './githubActionsBot.js';
import { collectPrAddressReviewFeedback } from './pr-address-review/feedback.js';
import { validateAddressReviewFeedbackCoverage } from './pr-address-review/feedbackCoverage.js';
import { validatePrAddressReviewOutput } from './pr-address-review/output.js';
import { buildAddressPrReviewompt } from './pr-address-review/prompt.js';
import { createPrAddressReviewCommitMessage } from './pr-address-review/run.js';
import { validatePlannerCommitPlan } from './pr-finalize/commitPlan.js';
import { validatePrFinalizeOutput } from './pr-finalize/output.js';
import { filterCommentsToDiffAnchors } from './pr-review/anchors.js';
import { validatePrReviewOutput } from './pr-review/output.js';
import { buildPrReviewPrompt } from './pr-review/prompt.js';
import { createPrReviewCommitMessage } from './pr-review/run.js';
import {
  DEFAULT_LOCAL_RUN_HEARTBEAT_INTERVAL_MS,
  DEFAULT_LOCAL_RUN_LEASE_DURATION_MS,
  LOCAL_RUN_HEARTBEAT_COMMAND,
  initializeLocalRunState,
  mapLocalRunResultStatusToTerminalStatus,
  recordLocalRunTerminalStatus,
} from '../local-run-state/localRunState.js';
import { getOperationCatalogOperationLabelReference } from './operationCatalog.js';

/**
 * @typedef {import('../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../git/types.js').GitCommit} GitCommit
 * @typedef {import('../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('../github/types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('../github/types.js').GitHubPullRequestReviewContext} GitHubPullRequestReviewContext
 * @typedef {import('../github/types.js').GitHubPullRequestDiff} GitHubPullRequestDiff
 * @typedef {import('../local-run-state/types.js').LocalRunRecord} LocalRunRecord
 */

const OPERATION_REFERENCES = new Map([
  ['pr-review', requireOperationCatalogLabelReference('pr:review')],
  ['pr-address-review', requireOperationCatalogLabelReference('pr:address-review')],
  ['pr-fix-ci', 'pr:fix-ci'],
  ['pr-update-branch', 'pr:update-branch'],
  ['pr-resolve-conflicts', 'pr:resolve-conflicts'],
  ['pr-finalize', 'pr:finalize'],
]);

/**
 * @param {string} reference
 * @returns {string}
 */
function requireOperationCatalogLabelReference(reference) {
  const catalogReference = getOperationCatalogOperationLabelReference(reference);
  if (catalogReference === undefined) {
    throw new Error(`${reference} label reference is missing from the operation catalog.`);
  }

  return catalogReference.reference;
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runLocalPullRequestOperation(context) {
  assertPullRequestTarget(context);

  const operationReference = OPERATION_REFERENCES.get(context.operation);
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

    if (operationReference === 'pr:review') {
      return await runLocalPrReview(context, runRecord, preparation);
    }

    if (operationReference === 'pr:address-review') {
      return await runLocalPrAddressReview(context, runRecord, preparation);
    }

    if (operationReference === 'pr:finalize') {
      return await runLocalPrFinalize(context, runRecord, preparation);
    }

    return await blockLocalPullRequestOperation(context, runRecord, {
      pullRequest: preparation.pullRequest,
      reason: `Local dry-run execution is not implemented yet for ${operationReference}.`,
    });
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
 * @param {OperationRunnerContext} context
 * @param {LocalRunRecord} runRecord
 * @param {{
 *   pullRequest: GitHubPullRequest,
 *   issue: GitHubIssue,
 *   reviewContext: GitHubPullRequestReviewContext,
 *   diff: GitHubPullRequestDiff,
 * }} preparation
 * @returns {Promise<Record<string, unknown>>}
 */
async function runLocalPrReview(context, runRecord, preparation) {
  const prompt = buildPrReviewPrompt(preparation);
  const validation = await runLocalCodexOperation(context, runRecord, {
    operationReference: 'pr:review',
    prompt,
    validate: validatePrReviewOutput,
  });

  if (!validation.valid) {
    return await blockLocalPullRequestOperation(context, runRecord, {
      pullRequest: preparation.pullRequest,
      reason: `Invalid Review Result: ${validation.reason}`,
    });
  }

  if (validation.value.status === 'blocked') {
    return await completeLocalPullRequestRunRecord(runRecord, {
      status: 'blocked',
      summary: validation.value.summary,
      operation: 'pr:review',
      pullRequest: formatPullRequest(preparation.pullRequest),
      failureReason: validation.value.failureReason,
    });
  }

  const comments = filterCommentsToDiffAnchors({
    comments: validation.value.comments,
    patch: preparation.diff.patch,
  });
  const directChangesCommitted = await commitLocalChangesIfPresent(context, {
    message: createPrReviewCommitMessage(preparation.pullRequest, validation.value),
  });

  return await completeLocalPullRequestRunRecord(runRecord, {
    status: 'accepted',
    summary: `Completed local dry-run pr:review for PR #${preparation.pullRequest.number}.`,
    operation: 'pr:review',
    reviewResult: validation.value.status,
    pullRequest: formatPullRequest(preparation.pullRequest),
    review: {
      comments: {
        publishable: comments.publishable.length,
        dropped: comments.dropped.length,
      },
      directChangesCommitted,
    },
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {LocalRunRecord} runRecord
 * @param {{
 *   pullRequest: GitHubPullRequest,
 *   issue: GitHubIssue,
 *   reviewContext: GitHubPullRequestReviewContext,
 *   diff: GitHubPullRequestDiff,
 * }} preparation
 * @returns {Promise<Record<string, unknown>>}
 */
async function runLocalPrAddressReview(context, runRecord, preparation) {
  const feedbackItems = collectPrAddressReviewFeedback(preparation.reviewContext);
  const prompt = buildAddressPrReviewompt({
    ...preparation,
    feedbackItems,
  });
  const validation = await runLocalCodexOperation(context, runRecord, {
    operationReference: 'pr:address-review',
    prompt,
    validate: validatePrAddressReviewOutput,
  });

  if (!validation.valid) {
    return await blockLocalPullRequestOperation(context, runRecord, {
      pullRequest: preparation.pullRequest,
      reason: `Invalid Address Review Output: ${validation.reason}`,
    });
  }

  if (validation.value.status === 'blocked') {
    return await completeLocalPullRequestRunRecord(runRecord, {
      status: 'blocked',
      summary: validation.value.summary,
      operation: 'pr:address-review',
      pullRequest: formatPullRequest(preparation.pullRequest),
      failureReason: validation.value.failureReason,
    });
  }

  const coverage = validateAddressReviewFeedbackCoverage(
    validation.value,
    feedbackItems.map(item => item.id),
  );
  if (!coverage.valid) {
    return await blockLocalPullRequestOperation(context, runRecord, {
      pullRequest: preparation.pullRequest,
      reason: `Invalid Address Review Output: ${coverage.reason}`,
    });
  }

  const changesCommitted = await commitLocalChangesIfPresent(context, {
    message: createPrAddressReviewCommitMessage(preparation.pullRequest, validation.value),
  });

  return await completeLocalPullRequestRunRecord(runRecord, {
    status: 'accepted',
    summary: `Completed local dry-run pr:address-review for PR #${preparation.pullRequest.number}.`,
    operation: 'pr:address-review',
    pullRequest: formatPullRequest(preparation.pullRequest),
    prAddressReview: {
      feedback: {
        addressed: validation.value.addressed.length,
        declined: validation.value.declined.length,
        deferred: validation.value.deferred.length,
      },
      changesCommitted,
    },
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {LocalRunRecord} runRecord
 * @param {{
 *   pullRequest: GitHubPullRequest,
 *   issue: GitHubIssue,
 *   reviewContext: GitHubPullRequestReviewContext,
 * }} preparation
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
  const validation = await runLocalCodexOperation(context, runRecord, {
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
async function runLocalCodexOperation(
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
 *   | {
 *       ready: true,
 *       pullRequest: GitHubPullRequest,
 *       issue: GitHubIssue,
 *       reviewContext: GitHubPullRequestReviewContext,
 *       diff: GitHubPullRequestDiff,
 *     }
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
async function commitLocalChangesIfPresent(context, { message }) {
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
async function blockLocalPullRequestOperation(context, runRecord, { reason, pullRequest }) {
  await writeLocalPullRequestRunArtifact(runRecord, 'failure-reason.txt', `${reason}\n`);
  return await completeLocalPullRequestRunRecord(runRecord, {
    status: 'blocked',
    summary: reason,
    operation: OPERATION_REFERENCES.get(context.operation) ?? context.operation,
    target: context.target,
    ...(pullRequest === undefined ? {} : { pullRequest: formatPullRequest(pullRequest) }),
  });
}

/**
 * @param {LocalRunRecord} runRecord
 * @param {Record<string, unknown>} result
 * @returns {Promise<Record<string, unknown>>}
 */
async function completeLocalPullRequestRunRecord(runRecord, result) {
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
    `Plan local dry-run PR Finalize history grouping for PR #${pullRequest.number}: ${pullRequest.title}`,
    '',
    'Planner scope:',
    '- Propose commit grouping and commit messages only.',
    '- Do not edit files, run commands, create commits, reset, stage, push, edit labels, update PR bodies, change review state, change checks, change draft state, post GitHub comments, or merge the pull request.',
    '- PullOps will validate the output and keep the result in the Local Run Record.',
    '',
    'Linked issue or PRD context:',
    [`Issue #${issue.number}: ${issue.title}`, issue.body.trim() || '(empty)'].join('\n'),
    '',
    'Pull request body:',
    pullRequest.body.trim() || '(empty)',
    '',
    'Changed files that must be assigned exactly once:',
    formatStringList(changedFiles),
    '',
    'Changed file summary:',
    formatReviewFiles(reviewContext),
    '',
    'Current commits since base:',
    formatCommits(commits),
    '',
    'Planner constraints:',
    '- Each changed file must appear in exactly one commit files array, and no unchanged files may appear.',
    '- Include commitPlan.justification only when grouping is not obvious, and make it a non-empty explanation when included.',
    '- Commit headers must be conventional commit headers.',
    `- Commit footers must include a relevant Refs: #<issue> footer, usually Refs: #${issue.number}.`,
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
 * @param {GitHubPullRequest} pullRequest
 * @returns {{ number: number, url: string }}
 */
function formatPullRequest(pullRequest) {
  return {
    number: pullRequest.number,
    url: pullRequest.url,
  };
}

/**
 * @param {string[]} items
 * @returns {string}
 */
function formatStringList(items) {
  if (items.length === 0) {
    return '(none)';
  }

  return items.map(item => `- ${item}`).join('\n');
}

/**
 * @param {GitCommit[]} commits
 * @returns {string}
 */
function formatCommits(commits) {
  if (commits.length === 0) {
    return '(none)';
  }

  return commits
    .map(commit =>
      [
        `- ${commit.sha} ${commit.subject}`,
        `  Files: ${commit.files.length === 0 ? '(none)' : commit.files.join(', ')}`,
        '  Message:',
        indent(commit.body),
      ].join('\n'),
    )
    .join('\n');
}

/**
 * @param {GitHubPullRequestReviewContext} reviewContext
 * @returns {string}
 */
function formatReviewFiles(reviewContext) {
  if (reviewContext.files.length === 0) {
    return '(none)';
  }

  return reviewContext.files
    .map(file => `- ${file.path} (+${file.additions} / -${file.deletions})`)
    .join('\n');
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
async function writeLocalPullRequestRunArtifact(runRecord, fileName, contents) {
  await writeFile(join(runRecord.directory, fileName), contents);
}

/**
 * @param {string} reference
 * @returns {string}
 */
function normalizeOperationReferenceForPath(reference) {
  return reference
    .trim()
    .toLowerCase()
    .replaceAll(':', '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
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
 * @param {string} value
 * @returns {string}
 */
function indent(value) {
  return value
    .split('\n')
    .map(line => `    ${line}`)
    .join('\n');
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
