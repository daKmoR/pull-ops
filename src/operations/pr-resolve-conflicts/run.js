import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PULL_OPS_STATUS_LABEL_NAMES } from '../../labels/pullOpsLabels.js';
import {
  applyManagedPrTransition,
  readManagedPrState,
  refusePrOperationTarget,
} from '../../managed-pr/ManagedPrState.js';
import { requireOperationCatalogOperationLabelName } from '../operationCatalog.js';
import {
  createExternalRunnerJob,
  createSkippedExternalRunnerOutput,
  getExternalRunnerFiles,
  isSkippedExternalRunnerResult,
  readExternalRunnerOutput,
  writeExternalRunnerPrompt,
} from '../externalRunner.js';
import { runLocalPullRequestOperation } from '../runLocalPullRequestOperation.js';
import { commentOnPullRequestWithOperationAudit } from '../auditComment.js';
import { validatePrResolveConflictsOutput } from './output.js';
import { buildPrResolveConflictsPrompt } from './prompt.js';
import { GITHUB_ACTIONS_BOT_COMMITTER } from '../githubActionsBot.js';

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../../git/types.js').GitConflictContext} GitConflictContext
 * @typedef {import('../../git/types.js').GitRebaseStepResult} GitRebaseStepResult
 * @typedef {import('../../git/types.js').GitPushWithLeaseResult} GitPushWithLeaseResult
 * @typedef {import('../../github/types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('./output.types.js').ResolvedConflictOutput} ResolvedConflictOutput
 * @typedef {import('./run.types.js').ConflictResolutionPassState} ConflictResolutionPassState
 * @typedef {import('./run.types.js').PrResolveConflictsPreparation} PrResolveConflictsPreparation
 * @typedef {import('./run.types.js').PrResolveConflictsReadyPreparation} PrResolveConflictsReadyPreparation
 */

const CONFLICT_PASS_STATE_FILE = 'pr_resolve_conflicts_state.json';
/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runPrResolveConflicts(context) {
  if (context.executionBackend === 'local' && context.publicationMode !== 'publish') {
    return await runLocalPullRequestOperation(context);
  }

  const preparation = await preparePrResolveConflicts(context);
  if (!preparation.ready) {
    return preparation.output;
  }

  let step = await startOrReadRebaseStep(context, preparation);
  if (step.status === 'complete') {
    return await completeResolvedRebase(context, preparation, step, { conflictPasses: 0 });
  }

  let auditCommentPosted = false;

  for (let pass = 1; pass <= preparation.maxConflictResolutionPasses; pass += 1) {
    let rawOutput;

    try {
      rawOutput = await context.runner.run({
        cwd: context.cwd,
        command: context.config.runner.command,
        model: context.model,
        prompt: buildPrResolveConflictsPrompt({
          pullRequest: preparation.pullRequest,
          issue: preparation.issue,
          conflictContext: step.conflictContext,
          pass,
          maxPasses: preparation.maxConflictResolutionPasses,
        }),
        streamOutput: context.suppressRunnerOutput !== true,
      });
      if (!auditCommentPosted) {
        await commentOnPullRequestWithOperationAudit(context, {
          pullRequestNumber: preparation.pullRequest.number,
          operation: requireOperationCatalogOperationLabelName('pr-resolve-conflicts'),
        });
        auditCommentPosted = true;
      }
    } catch (error) {
      await recordPullRequestFailure(context, preparation.pullRequest, getErrorMessage(error), {
        updateBody: preparation.managed,
      });
      throw error;
    }

    const resolved = await validateOutputAndContinueRebase(
      context,
      preparation,
      step.conflictContext,
      rawOutput,
    );
    if (resolved.status === 'blocked') {
      return resolved.output;
    }

    step = resolved.step;
    if (step.status === 'complete') {
      return await completeResolvedRebase(context, preparation, step, { conflictPasses: pass });
    }
  }

  return await blockConflictResolutionBudget(context, preparation, step.conflictContext);
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runPrResolveConflictsExternalRunnerPrepare(context) {
  const preparation = await preparePrResolveConflicts(context);
  if (!preparation.ready) {
    return preparation.output;
  }

  const step = await startOrReadRebaseStep(context, preparation);
  if (step.status === 'complete') {
    await removeExternalRunnerConflictState(context);
    return await completeResolvedRebase(context, preparation, step, { conflictPasses: 0 });
  }

  const handoff = await writeExternalRunnerConflictPrompt(
    context,
    preparation,
    step.conflictContext,
    {
      pass: 1,
    },
  );

  return {
    status: 'waiting',
    summary: `Prepared external conflict resolution for PR #${preparation.pullRequest.number}.`,
    pullRequest: {
      number: preparation.pullRequest.number,
      url: preparation.pullRequest.url,
    },
    prResolveConflicts: {
      baseBranch: preparation.baseBranch,
      branchName: preparation.pullRequest.headRefName,
      conflictPass: 1,
      maxConflictResolutionPasses: preparation.maxConflictResolutionPasses,
      conflictedFiles: step.conflictContext.conflictedFiles.map(file => file.path),
    },
    runnerJob: createExternalRunnerJob(context, handoff, {
      model: context.model,
      branch: preparation.pullRequest.headRefName,
    }),
  };
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runPrResolveConflictsExternalRunnerFinalize(context) {
  let rawOutput;

  try {
    rawOutput = await readExternalRunnerOutput(context, { rejectSkippedPreparedRunner: true });
  } catch (error) {
    if (isSkippedExternalRunnerResult(error)) {
      return createSkippedExternalRunnerOutput(context);
    }

    const preparation = await preparePrResolveConflicts(context);
    if (!preparation.ready) {
      throw error;
    }

    await removeExternalRunnerPrompt(context);
    await recordPullRequestFailure(context, preparation.pullRequest, getErrorMessage(error), {
      updateBody: preparation.managed,
    });
    throw error;
  }

  const preparation = await preparePrResolveConflicts(context);
  if (!preparation.ready) {
    return preparation.output;
  }

  const passState = await readExternalRunnerConflictPassState(context);
  const conflictContext = await readRequiredConflictContext(context, preparation);
  await commentOnPullRequestWithOperationAudit(context, {
    pullRequestNumber: preparation.pullRequest.number,
    operation: requireOperationCatalogOperationLabelName('pr-resolve-conflicts'),
  });

  const resolved = await validateOutputAndContinueRebase(
    context,
    preparation,
    conflictContext,
    rawOutput,
  );
  if (resolved.status === 'blocked') {
    await removeExternalRunnerConflictState(context);
    return resolved.output;
  }

  if (resolved.step.status === 'complete') {
    await removeExternalRunnerConflictState(context);
    return await completeResolvedRebase(context, preparation, resolved.step, {
      conflictPasses: passState.pass,
    });
  }

  const nextPass = passState.pass + 1;
  if (nextPass > preparation.maxConflictResolutionPasses) {
    await removeExternalRunnerConflictState(context);
    return await blockConflictResolutionBudget(context, preparation, resolved.step.conflictContext);
  }

  const handoff = await writeExternalRunnerConflictPrompt(
    context,
    preparation,
    resolved.step.conflictContext,
    {
      pass: nextPass,
    },
  );

  return {
    status: 'waiting',
    summary: `Prepared external conflict resolution pass ${nextPass} for PR #${preparation.pullRequest.number}.`,
    pullRequest: {
      number: preparation.pullRequest.number,
      url: preparation.pullRequest.url,
    },
    prResolveConflicts: {
      baseBranch: preparation.baseBranch,
      branchName: preparation.pullRequest.headRefName,
      conflictPass: nextPass,
      maxConflictResolutionPasses: preparation.maxConflictResolutionPasses,
      conflictedFiles: resolved.step.conflictContext.conflictedFiles.map(file => file.path),
    },
    runnerJob: createExternalRunnerJob(context, handoff, {
      model: context.model,
      branch: preparation.pullRequest.headRefName,
    }),
  };
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<PrResolveConflictsPreparation>}
 */
async function preparePrResolveConflicts(context) {
  assertPullRequestTarget(context);

  const pullRequest = await context.githubClient.getPullRequest(context.target.number);
  const state = readManagedPrState(pullRequest.body);

  if (pullRequest.isCrossRepository === true) {
    return {
      ready: false,
      output: await refusePullRequest(
        context,
        pullRequest,
        `PullOps v1 only resolves conflicts on same-repository PRs. PR #${pullRequest.number} comes from a fork.`,
        { updateBody: state.managed },
      ),
    };
  }

  const issue =
    state.sourceIssueNumber === undefined
      ? undefined
      : await context.githubClient.getIssue(state.sourceIssueNumber);

  return {
    ready: true,
    pullRequest,
    ...(issue === undefined ? {} : { issue }),
    baseBranch: pullRequest.baseRefName ?? context.config.baseBranch,
    managed: state.managed,
    maxConflictResolutionPasses:
      context.config.operations.prResolveConflicts.maxConflictResolutionPasses,
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {PrResolveConflictsReadyPreparation} preparation
 * @returns {Promise<GitRebaseStepResult>}
 */
async function startOrReadRebaseStep(context, preparation) {
  const conflictContext = await readOptionalConflictContext(context, preparation);
  if (conflictContext !== undefined) {
    return {
      status: 'conflicts',
      conflictContext,
    };
  }

  return await requireGitMethod(
    context.gitClient.startRebaseBranchOntoBase,
    'startRebaseBranchOntoBase',
  )({
    branchName: preparation.pullRequest.headRefName,
    baseBranch: preparation.baseBranch,
    committer: GITHUB_ACTIONS_BOT_COMMITTER,
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {PrResolveConflictsReadyPreparation} preparation
 * @param {GitConflictContext} conflictContext
 * @param {unknown} rawOutput
 * @returns {Promise<
 *   | { status: 'continued', step: GitRebaseStepResult }
 *   | { status: 'blocked', output: Record<string, unknown> }
 * >}
 */
async function validateOutputAndContinueRebase(context, preparation, conflictContext, rawOutput) {
  let failureRecorded = false;

  try {
    const validatedOutput = validatePrResolveConflictsOutput(rawOutput);
    if (!validatedOutput.valid) {
      const reason = `Invalid Resolve Conflicts Output: ${validatedOutput.reason}`;
      failureRecorded = true;
      await recordPullRequestFailure(context, preparation.pullRequest, reason, {
        updateBody: preparation.managed,
      });
      throw new Error(reason);
    }

    if (validatedOutput.value.status === 'blocked') {
      failureRecorded = true;
      await recordPullRequestFailure(
        context,
        preparation.pullRequest,
        validatedOutput.value.failureReason,
        { updateBody: preparation.managed },
      );
      return {
        status: 'blocked',
        output: {
          status: 'blocked',
          summary: validatedOutput.value.summary,
          pullRequest: {
            number: preparation.pullRequest.number,
            url: preparation.pullRequest.url,
          },
        },
      };
    }

    const coverage = validateResolvedFileCoverage(validatedOutput.value, conflictContext);
    if (!coverage.valid) {
      const reason = `Invalid Resolve Conflicts Output: ${coverage.reason}`;
      failureRecorded = true;
      await recordPullRequestFailure(context, preparation.pullRequest, reason, {
        updateBody: preparation.managed,
      });
      throw new Error(reason);
    }

    const currentConflictContext = await readRequiredConflictContext(context, preparation);
    const markerFiles = findConflictMarkerFiles(currentConflictContext);
    if (markerFiles.length > 0) {
      const reason = `Conflict markers remain in resolved files: ${markerFiles.join(', ')}.`;
      failureRecorded = true;
      await recordPullRequestFailure(context, preparation.pullRequest, reason, {
        updateBody: preparation.managed,
      });
      return {
        status: 'blocked',
        output: {
          status: 'blocked',
          summary: reason,
          pullRequest: {
            number: preparation.pullRequest.number,
            url: preparation.pullRequest.url,
          },
        },
      };
    }

    const step = await requireGitMethod(
      context.gitClient.continueRebase,
      'continueRebase',
    )({
      branchName: preparation.pullRequest.headRefName,
      baseBranch: preparation.baseBranch,
      committer: GITHUB_ACTIONS_BOT_COMMITTER,
    });

    return {
      status: 'continued',
      step,
    };
  } catch (error) {
    if (!failureRecorded) {
      await recordPullRequestFailure(context, preparation.pullRequest, getErrorMessage(error), {
        updateBody: preparation.managed,
      });
    }

    throw error;
  }
}

/**
 * @param {ResolvedConflictOutput} output
 * @param {GitConflictContext} conflictContext
 * @returns {{ valid: true } | { valid: false, reason: string }}
 */
function validateResolvedFileCoverage(output, conflictContext) {
  const expected = new Set(conflictContext.conflictedFiles.map(file => file.path));
  const seen = new Set();

  for (const resolvedFile of output.resolvedFiles) {
    if (!expected.has(resolvedFile)) {
      return {
        valid: false,
        reason: `Operation Output.resolvedFiles references unknown conflicted file "${resolvedFile}".`,
      };
    }

    if (seen.has(resolvedFile)) {
      return {
        valid: false,
        reason: `Conflicted file "${resolvedFile}" must be listed exactly once.`,
      };
    }

    seen.add(resolvedFile);
  }

  for (const path of expected) {
    if (!seen.has(path)) {
      return {
        valid: false,
        reason: `Conflicted file "${path}" must be included in Operation Output.resolvedFiles.`,
      };
    }
  }

  return { valid: true };
}

/**
 * @param {GitConflictContext} conflictContext
 * @returns {string[]}
 */
function findConflictMarkerFiles(conflictContext) {
  return conflictContext.conflictedFiles
    .filter(file => file.content !== undefined && hasConflictMarkers(file.content))
    .map(file => file.path);
}

/**
 * @param {string} content
 * @returns {boolean}
 */
function hasConflictMarkers(content) {
  return /^(<<<<<<<|=======|>>>>>>>)(?:$|[ \t].*$)/m.test(content);
}

/**
 * @param {OperationRunnerContext} context
 * @param {PrResolveConflictsReadyPreparation} preparation
 * @returns {Promise<GitConflictContext | undefined>}
 */
async function readOptionalConflictContext(context, preparation) {
  return await requireGitMethod(
    context.gitClient.readRebaseConflictContext,
    'readRebaseConflictContext',
  )({
    branchName: preparation.pullRequest.headRefName,
    baseBranch: preparation.baseBranch,
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {PrResolveConflictsReadyPreparation} preparation
 * @returns {Promise<GitConflictContext>}
 */
async function readRequiredConflictContext(context, preparation) {
  const conflictContext = await readOptionalConflictContext(context, preparation);
  if (conflictContext === undefined) {
    throw new Error('No active conflicted rebase state was found.');
  }

  return conflictContext;
}

/**
 * @template {Function} T
 * @param {T | undefined} method
 * @param {string} name
 * @returns {T}
 */
function requireGitMethod(method, name) {
  if (method === undefined) {
    throw new Error(`Git client does not implement ${name}.`);
  }

  return method;
}

/**
 * @param {OperationRunnerContext} context
 * @param {PrResolveConflictsReadyPreparation} preparation
 * @param {GitRebaseStepResult & { status: 'complete' }} rebaseResult
 * @param {{ conflictPasses: number }} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function completeResolvedRebase(context, preparation, rebaseResult, { conflictPasses }) {
  const pushResult = await context.gitClient.pushBranchWithLease({
    branchName: preparation.pullRequest.headRefName,
  });

  if (pushResult.status === 'stale-lease') {
    return await blockStaleLease(context, preparation);
  }

  if (preparation.managed) {
    await applyManagedPrTransition({
      githubClient: context.githubClient,
      outputDirectory: context.outputDirectory,
      pullRequest: preparation.pullRequest,
      operation: requireOperationCatalogOperationLabelName('pr-resolve-conflicts'),
      suppressFollowUpOperationLabels: context.suppressFollowUpOperationLabels,
      outcome: {
        kind: 'resolved',
      },
    });
  } else {
    await transitionNonManagedPullRequestToReview(context, preparation.pullRequest);
  }

  return {
    status: 'accepted',
    summary: `Resolved rebase conflicts on PR #${preparation.pullRequest.number}.`,
    pullRequest: {
      number: preparation.pullRequest.number,
      url: preparation.pullRequest.url,
    },
    prResolveConflicts: {
      baseBranch: preparation.baseBranch,
      branchName: preparation.pullRequest.headRefName,
      conflictPasses,
      headSha: pushResult.headSha,
      treeHash: pushResult.treeHash,
      rebasedHeadSha: rebaseResult.headSha,
      rebasedTreeHash: rebaseResult.treeHash,
    },
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {PrResolveConflictsReadyPreparation} preparation
 * @returns {Promise<Record<string, unknown>>}
 */
async function blockStaleLease(context, preparation) {
  const reason = [
    `Concurrent branch advancement was detected for PR #${preparation.pullRequest.number}.`,
    'The force-with-lease push was rejected, so PullOps did not overwrite the remote branch.',
  ].join(' ');

  await recordPullRequestFailure(context, preparation.pullRequest, reason, {
    updateBody: preparation.managed,
  });

  return {
    status: 'blocked',
    summary: reason,
    pullRequest: {
      number: preparation.pullRequest.number,
      url: preparation.pullRequest.url,
    },
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {PrResolveConflictsReadyPreparation} preparation
 * @param {GitConflictContext} conflictContext
 * @returns {Promise<Record<string, unknown>>}
 */
async function blockConflictResolutionBudget(context, preparation, conflictContext) {
  const reason = [
    `Conflict resolution budget exhausted for PR #${preparation.pullRequest.number}:`,
    `${preparation.maxConflictResolutionPasses} conflict resolution passes were allowed.`,
    `Remaining conflicted files: ${formatList(conflictContext.conflictedFiles.map(file => file.path))}.`,
  ].join(' ');

  await recordPullRequestFailure(context, preparation.pullRequest, reason, {
    updateBody: preparation.managed,
  });

  return {
    status: 'blocked',
    summary: reason,
    pullRequest: {
      number: preparation.pullRequest.number,
      url: preparation.pullRequest.url,
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
      operation: requireOperationCatalogOperationLabelName('pr-resolve-conflicts'),
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
 * @param {{ updateBody: boolean }} options
 * @returns {Promise<void>}
 */
async function recordPullRequestFailure(context, pullRequest, reason, { updateBody }) {
  if (updateBody) {
    await applyManagedPrTransition({
      githubClient: context.githubClient,
      outputDirectory: context.outputDirectory,
      pullRequest,
      operation: requireOperationCatalogOperationLabelName('pr-resolve-conflicts'),
      suppressFollowUpOperationLabels: context.suppressFollowUpOperationLabels,
      outcome: {
        kind: 'blocked',
        reason,
      },
    });
    return;
  }

  await refusePrOperationTarget({
    githubClient: context.githubClient,
    outputDirectory: context.outputDirectory,
    pullRequest,
    operation: requireOperationCatalogOperationLabelName('pr-resolve-conflicts'),
    reason,
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @returns {Promise<void>}
 */
async function transitionNonManagedPullRequestToReview(context, pullRequest) {
  await context.githubClient.removeLabelsFromPullRequest({
    number: pullRequest.number,
    labels: [
      requireOperationCatalogOperationLabelName('pr-resolve-conflicts'),
      ...PULL_OPS_STATUS_LABEL_NAMES,
    ],
  });
  await context.githubClient.addLabelsToPullRequest({
    number: pullRequest.number,
    labels: [requireOperationCatalogOperationLabelName('pr-review')],
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {PrResolveConflictsReadyPreparation} preparation
 * @param {GitConflictContext} conflictContext
 * @param {{ pass: number }} options
 * @returns {Promise<{ promptFile: string, outputFile: string, resultFile: string, workerPrompt: string }>}
 */
async function writeExternalRunnerConflictPrompt(context, preparation, conflictContext, { pass }) {
  const files = getExternalRunnerFiles(context);
  await mkdir(requireOutputDirectory(context), { recursive: true });
  await rm(files.outputFile, { force: true });
  await writeConflictPassState(context, { pass });
  return await writeExternalRunnerPrompt(
    context,
    buildPrResolveConflictsPrompt({
      pullRequest: preparation.pullRequest,
      issue: preparation.issue,
      conflictContext,
      pass,
      maxPasses: preparation.maxConflictResolutionPasses,
    }),
    { branch: preparation.pullRequest.headRefName },
  );
}

/**
 * @param {OperationRunnerContext} context
 * @param {ConflictResolutionPassState} state
 * @returns {Promise<void>}
 */
async function writeConflictPassState(context, state) {
  await mkdir(requireOutputDirectory(context), { recursive: true });
  await writeFile(
    join(requireOutputDirectory(context), CONFLICT_PASS_STATE_FILE),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<ConflictResolutionPassState>}
 */
async function readExternalRunnerConflictPassState(context) {
  try {
    const raw = await readFile(join(requireOutputDirectory(context), CONFLICT_PASS_STATE_FILE), {
      encoding: 'utf8',
    });
    const parsed = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      Number.isInteger(parsed.pass) &&
      parsed.pass > 0
    ) {
      return {
        pass: parsed.pass,
      };
    }
  } catch {
    return { pass: 1 };
  }

  return { pass: 1 };
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<void>}
 */
async function removeExternalRunnerConflictState(context) {
  await removeExternalRunnerPrompt(context);
  if (context.outputDirectory === undefined || context.outputDirectory.trim() === '') {
    return;
  }

  await rm(join(context.outputDirectory, CONFLICT_PASS_STATE_FILE), { force: true });
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<void>}
 */
async function removeExternalRunnerPrompt(context) {
  if (context.outputDirectory === undefined || context.outputDirectory.trim() === '') {
    return;
  }

  const files = getExternalRunnerFiles(context);
  await rm(files.promptFile, { force: true });
}

/**
 * @param {OperationRunnerContext} context
 * @returns {string}
 */
function requireOutputDirectory(context) {
  if (context.outputDirectory === undefined || context.outputDirectory.trim() === '') {
    throw new Error('External runner phases require OUTPUT_DIR.');
  }

  return context.outputDirectory;
}

/**
 * @param {string[]} values
 * @returns {string}
 */
function formatList(values) {
  return values.length === 0 ? 'none reported' : values.join(', ');
}

/**
 * @param {OperationRunnerContext} context
 * @returns {asserts context is OperationRunnerContext & { target: { type: 'pr', number: number } }}
 */
function assertPullRequestTarget(context) {
  if (context.target.type !== 'pr') {
    throw new Error('pr-resolve-conflicts requires a pull request target.');
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
