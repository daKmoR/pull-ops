import { PULL_OPS_STATUS_LABEL_NAMES } from '../../labels/pullOpsLabels.js';
import {
  applyManagedPrTransition,
  isFinalizedForRebase,
  readManagedPrState,
  readOperationBudgetUsage,
  readRunBudgetExhaustion,
  refusePrOperationTarget,
} from '../../managed-pr/ManagedPrState.js';
import { requireOperationCatalogOperationLabelName } from '../operationCatalog.js';
import { executeOperationPhase } from '../runnerLifecycle.js';
import { commentOnPullRequestWithOperationAudit } from '../auditComment.js';
import { hasPullOpsBranchPrefix } from '../branchNames.js';
import { collectFailedChecks } from './failedChecks.js';
import { ACTIONABLE_CHECK_FAILURE_CLASSIFICATIONS, validatePrFixCiOutput } from './output.js';
import { buildPrFixCiPrompt } from './prompt.js';
import { verifyPrFixCiWorkingTreeSafety } from './safetyVerification.js';
import { GITHUB_ACTIONS_BOT_AUTHOR } from '../githubActionsBot.js';

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('../../github/types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('../../github/types.js').GitHubPullRequestReviewContext} GitHubPullRequestReviewContext
 * @typedef {import('../../github/types.js').GitHubPullRequestDiff} GitHubPullRequestDiff
 * @typedef {import('./failedChecks.types.js').FailedCheck} FailedCheck
 * @typedef {import('./output.types.js').CompletedPrFixCiOutput} CompletedPrFixCiOutput
 * @typedef {import('./run.types.js').PrFixCiPreparation} PrFixCiPreparation
 */

/** @type {import('../runnerLifecycle.types.js').OperationDescriptor} */
export const prFixCiDescriptor = {
  operationReference: 'pr:fix-ci',
  createOperation: createPrFixCiRunnerOperation,
  finalize: {
    // Do not rerun preparePrFixCi before reading the runner output: its
    // not-ready branches transition PR state as if the runner outcome were
    // known, which would mask a runner failure.
    order: 'output-first',
    rejectSkippedPreparedRunner: true,
    onOutputError: async (outputErrorContext, error) => {
      assertPullRequestTarget(outputErrorContext);
      const pullRequest = await outputErrorContext.githubClient.getPullRequest(
        outputErrorContext.target.number,
      );
      const state = readManagedPrState(pullRequest.body);
      await recordPullRequestFailure(outputErrorContext, pullRequest, getErrorMessage(error), {
        updateBody: state.managed,
        ciFixCycle: state.ciFixCycles.current + 1,
        maxCiFixCycles: state.ciFixCycles.max,
      });
    },
  },
};

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runPrFixCi(context) {
  return await executeOperationPhase(prFixCiDescriptor, 'run', context);
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runPrFixCiExternalRunnerPrepare(context) {
  return await executeOperationPhase(prFixCiDescriptor, 'prepare', context);
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runPrFixCiExternalRunnerFinalize(context) {
  return await executeOperationPhase(prFixCiDescriptor, 'complete', context);
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<import('../runnerLifecycle.types.js').RunnerLifecycleOperation>}
 */
async function createPrFixCiRunnerOperation(context) {
  const preparation = await preparePrFixCi(context);
  if (!preparation.ready) {
    return { status: 'settled', output: preparation.output };
  }

  return {
    status: 'runner',
    prompt: buildPrFixCiPrompt({
      pullRequest: preparation.pullRequest,
      issue: preparation.issue,
      reviewContext: preparation.reviewContext,
      diff: preparation.diff,
      checkFailures: preparation.checkFailures,
    }),
    model: context.model,
    branch: preparation.pullRequest.headRefName,
    runOptions: { streamOutput: context.suppressRunnerOutput !== true },
    waiting: {
      summary: `Prepared external pr-fix-ci run for PR #${preparation.pullRequest.number}.`,
      details: {
        pullRequest: {
          number: preparation.pullRequest.number,
          url: preparation.pullRequest.url,
        },
        checks: {
          failed: preparation.checkFailures.length,
        },
      },
    },
    finalize: async rawOutput => await finalizePreparedPrFixCi(context, preparation, rawOutput),
    onRunnerFailure: async error => {
      await recordPullRequestFailure(context, preparation.pullRequest, getErrorMessage(error), {
        updateBody: preparation.managed,
        ciFixCycle: preparation.ciFixCycle,
        maxCiFixCycles: preparation.maxCiFixCycles,
      });
    },
  };
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<PrFixCiPreparation>}
 */
async function preparePrFixCi(context) {
  assertPullRequestTarget(context);

  const pullRequest = await context.githubClient.getPullRequest(context.target.number);
  const state = readManagedPrState(pullRequest.body);
  const manual =
    pullRequest.labels?.includes(requireOperationCatalogOperationLabelName('pr-fix-ci')) === true;

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
        `PR #${pullRequest.number} is not a PullOps-managed draft PR and does not have an explicit ${requireOperationCatalogOperationLabelName('pr-fix-ci')} label.`,
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

  if (state.managed) {
    const budgetExhaustion = readRunBudgetExhaustion(state, context.config.runBudget);
    if (budgetExhaustion.exhausted) {
      const reason = `${budgetExhaustion.reason} PR #${pullRequest.number} needs maintainer attention.`;
      await recordPullRequestFailure(context, pullRequest, reason, {
        updateBody: true,
        ciFixCycle: state.ciFixCycles.current,
        maxCiFixCycles: state.ciFixCycles.max,
      });
      return {
        ready: false,
        output: {
          status: 'blocked',
          summary: reason,
          blocker: { kind: 'budget-exhausted' },
          pullRequest: {
            number: pullRequest.number,
            url: pullRequest.url,
          },
        },
      };
    }
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
  const checkFailures = collectFailedChecks(checks);

  if (checkFailures.length === 0) {
    return {
      ready: false,
      output: await completeNoFailedChecks(context, pullRequest, {
        managed: state.managed,
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
      operation: requireOperationCatalogOperationLabelName('pr-fix-ci'),
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

    const nonActionableClassifications = validatedOutput.value.classifications.filter(
      classification =>
        !ACTIONABLE_CHECK_FAILURE_CLASSIFICATIONS.includes(classification.classification),
    );
    if (nonActionableClassifications.length > 0) {
      const reason = [
        `CI failures are not safely actionable for PullOps on PR #${pullRequest.number}:`,
        nonActionableClassifications
          .map(
            classification =>
              `${classification.checkId} is classified as ${classification.classification}: ${classification.rationale}`,
          )
          .join('; '),
      ].join(' ');
      failureRecorded = true;
      await recordPullRequestFailure(context, pullRequest, reason, {
        updateBody: managed,
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
        blocker: { kind: 'safety-refusal' },
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

    if (context.gitClient.readWorkingTreePatch !== undefined) {
      const verification = verifyPrFixCiWorkingTreeSafety(
        await context.gitClient.readWorkingTreePatch(),
      );
      if (!verification.safe) {
        const reason = [
          `Deterministic safety verification refused the CI repair for PR #${pullRequest.number}:`,
          verification.violations.join(' '),
          'PullOps will not commit unsafe CI repairs.',
        ].join(' ');
        failureRecorded = true;
        await recordPullRequestFailure(context, pullRequest, reason, {
          updateBody: managed,
          ciFixCycle,
          maxCiFixCycles,
        });
        return {
          status: 'blocked',
          summary: reason,
          blocker: { kind: 'safety-refusal' },
          pullRequest: {
            number: pullRequest.number,
            url: pullRequest.url,
          },
        };
      }
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
        operation: requireOperationCatalogOperationLabelName('pr-fix-ci'),
        suppressFollowUpOperationLabels: context.suppressFollowUpOperationLabels,
        outcome: {
          kind: 'fixed',
          ciFixCycle,
          maxCiFixCycles,
        },
        usage: readOperationBudgetUsage(context),
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
          classifications: summarizeClassifications(validatedOutput.value.classifications),
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
 * Require the runner to classify every failed check exactly once. The
 * runner owns the classification judgment; PullOps only verifies coverage
 * and the schema-level taxonomy.
 *
 * @param {CompletedPrFixCiOutput} output
 * @param {FailedCheck[]} checkFailures
 * @returns {{ valid: true } | { valid: false, reason: string }}
 */
function validateClassificationCoverage(output, checkFailures) {
  const expected = new Set(checkFailures.map(failure => failure.id));
  const seen = new Set();

  for (const classification of output.classifications) {
    if (!expected.has(classification.checkId)) {
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

    seen.add(classification.checkId);
  }

  for (const checkId of expected) {
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
    labels: [
      requireOperationCatalogOperationLabelName('pr-fix-ci'),
      ...PULL_OPS_STATUS_LABEL_NAMES,
    ],
  });

  if (managed) {
    await context.githubClient.addLabelsToPullRequest({
      number: pullRequest.number,
      labels: [requireOperationCatalogOperationLabelName('pr-review')],
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
      operation: requireOperationCatalogOperationLabelName('pr-fix-ci'),
      suppressFollowUpOperationLabels: context.suppressFollowUpOperationLabels,
      outcome: {
        kind: 'no-failed-checks',
      },
      usage: readOperationBudgetUsage(context),
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
    operation: requireOperationCatalogOperationLabelName('pr-fix-ci'),
    suppressFollowUpOperationLabels: context.suppressFollowUpOperationLabels,
    outcome: {
      kind: 'blocked',
      reason,
      ciFixCycle,
      maxCiFixCycles,
    },
    usage: readOperationBudgetUsage(context),
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
 * @param {{ reason: string }} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function refusePullRequest(context, pullRequest, { reason }) {
  await refusePrOperationTarget({
    githubClient: context.githubClient,
    outputDirectory: context.outputDirectory,
    pullRequest,
    operation: requireOperationCatalogOperationLabelName('pr-fix-ci'),
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
      operation: requireOperationCatalogOperationLabelName('pr-fix-ci'),
      reason,
    });
    return;
  }

  await applyManagedPrTransition({
    githubClient: context.githubClient,
    outputDirectory: context.outputDirectory,
    pullRequest,
    operation: requireOperationCatalogOperationLabelName('pr-fix-ci'),
    suppressFollowUpOperationLabels: context.suppressFollowUpOperationLabels,
    outcome: {
      kind: 'blocked',
      reason,
      ciFixCycle,
      maxCiFixCycles,
    },
    usage: readOperationBudgetUsage(context),
  });
}

/**
 * @param {{ classification: string }[]} classifiedFailures
 * @returns {Record<string, number>}
 */
function summarizeClassifications(classifiedFailures) {
  /** @type {Record<string, number>} */
  const classifications = {};
  for (const failure of classifiedFailures) {
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
