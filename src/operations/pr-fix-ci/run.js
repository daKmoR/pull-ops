import {
  PULL_OPS_OPERATION_LABELS,
  PULL_OPS_STATUS_LABEL_NAMES,
} from '../../labels/pullOpsLabels.js';
import {
  applyManagedPrTransition,
  isFinalizedForRebase,
  readManagedPrState,
  refusePrOperationTarget,
} from '../../managed-pr/ManagedPrState.js';
import {
  createSkippedCodexActionOutput,
  getCodexActionFiles,
  readCodexActionOutput,
  writeCodexActionPrompt,
} from '../codexAction.js';
import { commentOnPullRequestWithOperationAudit } from '../auditComment.js';
import { hasPullOpsBranchPrefix } from '../branchNames.js';
import { classifyCheckFailures } from './classification.js';
import { validatePrFixCiOutput } from './output.js';
import { buildPrFixCiPrompt } from './prompt.js';

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('../../github/types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('../../github/types.js').GitHubPullRequestReviewContext} GitHubPullRequestReviewContext
 * @typedef {import('../../github/types.js').GitHubPullRequestDiff} GitHubPullRequestDiff
 * @typedef {import('./classification.types.js').ClassifiedCheckFailure} ClassifiedCheckFailure
 * @typedef {import('./output.types.js').CompletedPrFixCiOutput} CompletedPrFixCiOutput
 * @typedef {import('./run.types.js').PrFixCiPreparation} PrFixCiPreparation
 */

export const GITHUB_ACTIONS_BOT_AUTHOR = {
  name: 'github-actions[bot]',
  email: '41898282+github-actions[bot]@users.noreply.github.com',
};

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runPrFixCi(context) {
  const preparation = await preparePrFixCi(context);
  if (!preparation.ready) {
    return preparation.output;
  }

  let rawOutput;

  try {
    rawOutput = await context.codexRunner.run({
      cwd: context.cwd,
      command: context.config.runner.command,
      model: context.model,
      prompt: buildPrFixCiPrompt({
        pullRequest: preparation.pullRequest,
        issue: preparation.issue,
        reviewContext: preparation.reviewContext,
        diff: preparation.diff,
        checkFailures: preparation.checkFailures,
      }),
      streamOutput: context.suppressRunnerOutput !== true,
    });
  } catch (error) {
    await recordPullRequestFailure(context, preparation.pullRequest, getErrorMessage(error), {
      updateBody: preparation.managed,
      ciFixCycle: preparation.ciFixCycle,
      maxCiFixCycles: preparation.maxCiFixCycles,
    });
    throw error;
  }

  return await finalizePreparedPrFixCi(context, preparation, rawOutput);
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runPrFixCiCodexActionPrepare(context) {
  const preparation = await preparePrFixCi(context);
  if (!preparation.ready) {
    return preparation.output;
  }

  try {
    await writeCodexActionPrompt(
      context,
      buildPrFixCiPrompt({
        pullRequest: preparation.pullRequest,
        issue: preparation.issue,
        reviewContext: preparation.reviewContext,
        diff: preparation.diff,
        checkFailures: preparation.checkFailures,
      }),
    );
  } catch (error) {
    await recordPullRequestFailure(context, preparation.pullRequest, getErrorMessage(error), {
      updateBody: preparation.managed,
      ciFixCycle: preparation.ciFixCycle,
      maxCiFixCycles: preparation.maxCiFixCycles,
    });
    throw error;
  }

  const files = getCodexActionFiles(context);
  return {
    status: 'accepted',
    summary: `Prepared Codex Action pr-fix-ci run for PR #${preparation.pullRequest.number}.`,
    pullRequest: {
      number: preparation.pullRequest.number,
      url: preparation.pullRequest.url,
    },
    checks: {
      failed: preparation.checkFailures.length,
      classifications: summarizeClassifications(preparation.checkFailures),
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
export async function runPrFixCiCodexActionFinalize(context) {
  if (context.runnerRan === false) {
    return createSkippedCodexActionOutput(context);
  }

  const preparation = await preparePrFixCi(context);
  if (!preparation.ready) {
    return preparation.output;
  }

  let rawOutput;

  try {
    rawOutput = await readCodexActionOutput(context);
  } catch (error) {
    await recordPullRequestFailure(context, preparation.pullRequest, getErrorMessage(error), {
      updateBody: preparation.managed,
      ciFixCycle: preparation.ciFixCycle,
      maxCiFixCycles: preparation.maxCiFixCycles,
    });
    throw error;
  }

  return await finalizePreparedPrFixCi(context, preparation, rawOutput);
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<PrFixCiPreparation>}
 */
async function preparePrFixCi(context) {
  assertPullRequestTarget(context);

  const pullRequest = await context.githubClient.getPullRequest(context.target.number);
  const state = readManagedPrState(pullRequest.body);
  const manual = pullRequest.labels?.includes(PULL_OPS_OPERATION_LABELS.prFixCi) === true;

  if (pullRequest.isCrossRepository === true) {
    return {
      ready: false,
      output: await refusePullRequest(context, pullRequest, {
        reason: `PullOps v1 only fixes CI on same-repository PRs. PR #${pullRequest.number} comes from a fork.`,
      }),
    };
  }

  if (!manual && !state.managed) {
    return {
      ready: false,
      output: skipAutomaticPrFixCi(
        pullRequest,
        `PR #${pullRequest.number} is not a PullOps-managed draft PR and does not have an explicit ${PULL_OPS_OPERATION_LABELS.prFixCi} label.`,
      ),
    };
  }

  if (
    !manual &&
    state.managed &&
    !pullRequest.isDraft &&
    !canAutomaticallyFixReadyFinalizedPr(state)
  ) {
    return {
      ready: false,
      output: skipAutomaticPrFixCi(
        pullRequest,
        `Automatic pr-fix-ci only runs for PullOps-managed draft PRs. PR #${pullRequest.number} is not a draft.`,
      ),
    };
  }

  if (
    state.managed &&
    !hasPullOpsBranchPrefix({
      branchName: pullRequest.headRefName,
      branchPrefix: context.config.branchPrefix,
    })
  ) {
    return {
      ready: false,
      output: await refusePullRequest(context, pullRequest, {
        reason: `PR #${pullRequest.number} head branch "${pullRequest.headRefName}" does not use the configured PullOps branch prefix.`,
      }),
    };
  }

  if (state.managed && state.sourceIssueNumber === undefined) {
    return {
      ready: false,
      output: await refusePullRequest(context, pullRequest, {
        reason: `PR #${pullRequest.number} does not include a structured Source: Issue #<number> line.`,
      }),
    };
  }

  if (state.managed && state.ciFixCycles.current >= state.ciFixCycles.max) {
    return {
      ready: false,
      output: await blockCiFixCycleBudget(context, pullRequest, {
        ciFixCycle: state.ciFixCycles.current,
        maxCiFixCycles: state.ciFixCycles.max,
      }),
    };
  }

  const checks = await context.githubClient.getPullRequestChecks(pullRequest.number);
  const checkFailures = classifyCheckFailures(checks);

  if (checkFailures.length === 0) {
    return {
      ready: false,
      output: await completeNoFailedChecks(context, pullRequest, {
        managed: state.managed,
      }),
    };
  }

  const nonActionableFailures = checkFailures.filter(failure => !failure.actionable);
  if (nonActionableFailures.length > 0) {
    return {
      ready: false,
      output: await blockNonActionableFailures(context, pullRequest, nonActionableFailures, {
        updateBody: state.managed,
        ciFixCycle: state.ciFixCycles.current,
        maxCiFixCycles: state.ciFixCycles.max,
      }),
    };
  }

  const issue =
    state.sourceIssueNumber === undefined
      ? undefined
      : await context.githubClient.getIssue(state.sourceIssueNumber);
  const reviewContext = await context.githubClient.getPullRequestReviewContext(pullRequest.number);
  const diff = await context.githubClient.getPullRequestDiff(pullRequest.number);

  return {
    ready: true,
    pullRequest,
    ...(issue === undefined ? {} : { issue }),
    reviewContext,
    diff,
    checkFailures,
    managed: state.managed,
    ciFixCycle: state.ciFixCycles.current + 1,
    maxCiFixCycles: state.ciFixCycles.max,
  };
}

/**
 * @param {import('../../managed-pr/ManagedPrState.types.js').ManagedPrState} state
 * @returns {boolean}
 */
function canAutomaticallyFixReadyFinalizedPr(state) {
  return state.status === 'Ready for human merge' && isFinalizedForRebase(state);
}

/**
 * @param {OperationRunnerContext} context
 * @param {PrFixCiPreparation & { ready: true }} preparation
 * @param {unknown} rawOutput
 * @returns {Promise<Record<string, unknown>>}
 */
async function finalizePreparedPrFixCi(context, preparation, rawOutput) {
  const { pullRequest, checkFailures, managed, ciFixCycle, maxCiFixCycles } = preparation;
  let failureRecorded = false;

  try {
    await commentOnPullRequestWithOperationAudit(context, {
      pullRequestNumber: pullRequest.number,
      operation: PULL_OPS_OPERATION_LABELS.prFixCi,
    });

    const validatedOutput = validatePrFixCiOutput(rawOutput);

    if (!validatedOutput.valid) {
      const reason = `Invalid Fix CI Output: ${validatedOutput.reason}`;
      failureRecorded = true;
      await recordPullRequestFailure(context, pullRequest, reason, {
        updateBody: managed,
        ciFixCycle,
        maxCiFixCycles,
      });
      throw new Error(reason);
    }

    if (validatedOutput.value.status === 'blocked') {
      failureRecorded = true;
      await recordPullRequestFailure(context, pullRequest, validatedOutput.value.failureReason, {
        updateBody: managed,
        ciFixCycle,
        maxCiFixCycles,
      });
      return {
        status: 'blocked',
        summary: validatedOutput.value.summary,
        pullRequest: {
          number: pullRequest.number,
          url: pullRequest.url,
        },
      };
    }

    const coverage = validateClassificationCoverage(validatedOutput.value, checkFailures);
    if (!coverage.valid) {
      const reason = `Invalid Fix CI Output: ${coverage.reason}`;
      failureRecorded = true;
      await recordPullRequestFailure(context, pullRequest, reason, {
        updateBody: managed,
        ciFixCycle,
        maxCiFixCycles,
      });
      throw new Error(reason);
    }

    const unsafeReason = summarizeUnsafeSafetyChecks(pullRequest, validatedOutput.value);
    if (unsafeReason !== undefined) {
      failureRecorded = true;
      await recordPullRequestFailure(context, pullRequest, unsafeReason, {
        updateBody: managed,
        ciFixCycle,
        maxCiFixCycles,
      });
      return {
        status: 'blocked',
        summary: unsafeReason,
        pullRequest: {
          number: pullRequest.number,
          url: pullRequest.url,
        },
      };
    }

    if (!(await context.gitClient.hasChanges())) {
      const reason =
        'Fix-ci runner completed but did not leave any working tree changes to commit.';
      failureRecorded = true;
      await recordPullRequestFailure(context, pullRequest, reason, {
        updateBody: managed,
        ciFixCycle,
        maxCiFixCycles,
      });
      throw new Error(reason);
    }

    await context.gitClient.commitAll({
      message: createPrFixCiCommitMessage(pullRequest, validatedOutput.value),
      author: GITHUB_ACTIONS_BOT_AUTHOR,
    });
    await context.gitClient.pushBranch({
      branchName: pullRequest.headRefName,
    });

    if (managed) {
      await applyManagedPrTransition({
        githubClient: context.githubClient,
        outputDirectory: context.outputDirectory,
        pullRequest,
        operation: PULL_OPS_OPERATION_LABELS.prFixCi,
        suppressFollowUpOperationLabels: context.suppressFollowUpOperationLabels,
        outcome: {
          kind: 'fixed',
          ciFixCycle,
          maxCiFixCycles,
        },
      });
    } else {
      await transitionPullRequestLabelsAfterFix(context, pullRequest, { managed });
    }

    return {
      status: 'accepted',
      summary: `Fixed actionable CI failures on PR #${pullRequest.number}.`,
      pullRequest: {
        number: pullRequest.number,
        url: pullRequest.url,
      },
      prFixCi: {
        checks: {
          failed: checkFailures.length,
          classifications: summarizeClassifications(checkFailures),
        },
        changesCommitted: true,
      },
    };
  } catch (error) {
    if (!failureRecorded) {
      await recordPullRequestFailure(context, pullRequest, getErrorMessage(error), {
        updateBody: managed,
        ciFixCycle,
        maxCiFixCycles,
      });
    }

    throw error;
  }
}

/**
 * @param {GitHubPullRequest} pullRequest
 * @param {CompletedPrFixCiOutput} output
 * @returns {string}
 */
export function createPrFixCiCommitMessage(pullRequest, output) {
  return [
    `fix(ci): repair failures for PR #${pullRequest.number}`,
    '',
    output.changes.length === 0
      ? output.summary
      : output.changes.map(change => `- ${change}`).join('\n'),
    '',
    `Refs: #${pullRequest.number}`,
  ].join('\n');
}

/**
 * @param {CompletedPrFixCiOutput} output
 * @param {ClassifiedCheckFailure[]} checkFailures
 * @returns {{ valid: true } | { valid: false, reason: string }}
 */
function validateClassificationCoverage(output, checkFailures) {
  const expected = new Map(checkFailures.map(failure => [failure.id, failure.classification]));
  const seen = new Set();

  for (const classification of output.classifications) {
    const expectedClassification = expected.get(classification.checkId);
    if (expectedClassification === undefined) {
      return {
        valid: false,
        reason: `Operation Output.classifications references unknown checkId "${classification.checkId}".`,
      };
    }

    if (seen.has(classification.checkId)) {
      return {
        valid: false,
        reason: `Check failure "${classification.checkId}" must be classified exactly once.`,
      };
    }

    if (classification.classification !== expectedClassification) {
      return {
        valid: false,
        reason: `Check failure "${classification.checkId}" was preclassified as ${expectedClassification}, but output reported ${classification.classification}.`,
      };
    }

    seen.add(classification.checkId);
  }

  for (const checkId of expected.keys()) {
    if (!seen.has(checkId)) {
      return {
        valid: false,
        reason: `Check failure "${checkId}" must be included in Operation Output.classifications.`,
      };
    }
  }

  return { valid: true };
}

/**
 * @param {GitHubPullRequest} pullRequest
 * @param {CompletedPrFixCiOutput} output
 * @returns {string | undefined}
 */
function summarizeUnsafeSafetyChecks(pullRequest, output) {
  const unsafeActions = [];
  if (output.safetyChecks.weakenedTests) {
    unsafeActions.push('weakened tests');
  }
  if (output.safetyChecks.deletedAssertions) {
    unsafeActions.push('deleted assertions');
  }
  if (output.safetyChecks.bypassedChecks) {
    unsafeActions.push('bypassed checks');
  }
  if (output.safetyChecks.secretOrInfrastructureWorkaround) {
    unsafeActions.push('worked around secrets or infrastructure');
  }

  if (unsafeActions.length === 0) {
    return undefined;
  }

  return [
    `Fix-ci runner reported unsafe repair actions for PR #${pullRequest.number}:`,
    `${unsafeActions.join(', ')}.`,
    'PullOps will not commit unsafe CI repairs.',
  ].join(' ');
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @param {{ managed: boolean }} options
 * @returns {Promise<void>}
 */
async function transitionPullRequestLabelsAfterFix(context, pullRequest, { managed }) {
  await context.githubClient.removeLabelsFromPullRequest({
    number: pullRequest.number,
    labels: [PULL_OPS_OPERATION_LABELS.prFixCi, ...PULL_OPS_STATUS_LABEL_NAMES],
  });

  if (managed) {
    await context.githubClient.addLabelsToPullRequest({
      number: pullRequest.number,
      labels: [PULL_OPS_OPERATION_LABELS.prReview],
    });
  }
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @param {{ managed: boolean }} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function completeNoFailedChecks(context, pullRequest, { managed }) {
  if (managed) {
    await applyManagedPrTransition({
      githubClient: context.githubClient,
      outputDirectory: context.outputDirectory,
      pullRequest,
      operation: PULL_OPS_OPERATION_LABELS.prFixCi,
      suppressFollowUpOperationLabels: context.suppressFollowUpOperationLabels,
      outcome: {
        kind: 'no-failed-checks',
      },
    });
  } else {
    await transitionPullRequestLabelsAfterFix(context, pullRequest, { managed });
  }

  return {
    status: 'accepted',
    summary: `No failed checks were found for PR #${pullRequest.number}.`,
    pullRequest: {
      number: pullRequest.number,
      url: pullRequest.url,
    },
    prFixCi: {
      checks: {
        failed: 0,
        classifications: {},
      },
      changesCommitted: false,
    },
  };
}

/**
 * @param {GitHubPullRequest} pullRequest
 * @param {string} reason
 * @returns {Record<string, unknown>}
 */
function skipAutomaticPrFixCi(pullRequest, reason) {
  return {
    status: 'accepted',
    summary: reason,
    pullRequest: {
      number: pullRequest.number,
      url: pullRequest.url,
    },
    prFixCi: {
      skipped: true,
      reason,
    },
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @param {{ ciFixCycle: number, maxCiFixCycles: number }} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function blockCiFixCycleBudget(context, pullRequest, { ciFixCycle, maxCiFixCycles }) {
  const reason = [
    `CI fix cycle budget exhausted for PR #${pullRequest.number}:`,
    `${ciFixCycle} / ${maxCiFixCycles} CI Fix Cycles have already run.`,
  ].join(' ');

  await applyManagedPrTransition({
    githubClient: context.githubClient,
    outputDirectory: context.outputDirectory,
    pullRequest,
    operation: PULL_OPS_OPERATION_LABELS.prFixCi,
    suppressFollowUpOperationLabels: context.suppressFollowUpOperationLabels,
    outcome: {
      kind: 'blocked',
      reason,
      ciFixCycle,
      maxCiFixCycles,
    },
  });

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
 * @param {ClassifiedCheckFailure[]} nonActionableFailures
 * @param {{ updateBody: boolean, ciFixCycle: number, maxCiFixCycles: number }} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function blockNonActionableFailures(
  context,
  pullRequest,
  nonActionableFailures,
  { updateBody, ciFixCycle, maxCiFixCycles },
) {
  const reason = [
    `CI failures are not safely actionable for PullOps on PR #${pullRequest.number}:`,
    nonActionableFailures.map(formatNonActionableFailure).join('; '),
  ].join(' ');

  await recordPullRequestFailure(context, pullRequest, reason, {
    updateBody,
    ciFixCycle,
    maxCiFixCycles,
  });

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
 * @param {ClassifiedCheckFailure} failure
 * @returns {string}
 */
function formatNonActionableFailure(failure) {
  return `${failure.id} "${failure.checkName}" is classified as ${failure.classification}: ${failure.reason}`;
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @param {{ reason: string }} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function refusePullRequest(context, pullRequest, { reason }) {
  await refusePrOperationTarget({
    githubClient: context.githubClient,
    outputDirectory: context.outputDirectory,
    pullRequest,
    operation: PULL_OPS_OPERATION_LABELS.prFixCi,
    reason,
  });

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
 * @param {{ updateBody: boolean, ciFixCycle: number, maxCiFixCycles: number }} options
 * @returns {Promise<void>}
 */
async function recordPullRequestFailure(
  context,
  pullRequest,
  reason,
  { updateBody, ciFixCycle, maxCiFixCycles },
) {
  if (!updateBody) {
    await refusePrOperationTarget({
      githubClient: context.githubClient,
      outputDirectory: context.outputDirectory,
      pullRequest,
      operation: PULL_OPS_OPERATION_LABELS.prFixCi,
      reason,
    });
    return;
  }

  await applyManagedPrTransition({
    githubClient: context.githubClient,
    outputDirectory: context.outputDirectory,
    pullRequest,
    operation: PULL_OPS_OPERATION_LABELS.prFixCi,
    suppressFollowUpOperationLabels: context.suppressFollowUpOperationLabels,
    outcome: {
      kind: 'blocked',
      reason,
      ciFixCycle,
      maxCiFixCycles,
    },
  });
}

/**
 * @param {ClassifiedCheckFailure[]} checkFailures
 * @returns {Record<string, number>}
 */
function summarizeClassifications(checkFailures) {
  /** @type {Record<string, number>} */
  const classifications = {};
  for (const failure of checkFailures) {
    classifications[failure.classification] = (classifications[failure.classification] ?? 0) + 1;
  }
  return classifications;
}

/**
 * @param {OperationRunnerContext} context
 * @returns {asserts context is OperationRunnerContext & { target: { type: 'pr', number: number } }}
 */
function assertPullRequestTarget(context) {
  if (context.target.type !== 'pr') {
    throw new Error('pr-fix-ci requires a pull request target.');
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
