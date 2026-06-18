import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PULL_OPS_OPERATION_LABELS, PULL_OPS_STATUS_LABELS } from '../../labels/pullOpsLabels.js';
import {
  readBlockingDependencies,
  readIssueWorkTarget,
} from '../../prd-automation/childCoordination.js';
import { commentOnPullRequestWithOperationAudit } from '../auditComment.js';
import {
  createSkippedCodexActionOutput,
  getCodexActionFiles,
  readCodexActionOutput,
  writeCodexActionPrompt,
} from '../codexAction.js';
import { GITHUB_ACTIONS_BOT_AUTHOR } from '../githubActionsBot.js';
import { getParentIssueNumber } from '../issueDependencies.js';
import { getWorkflowOperation } from '../operations.js';
import { validateAddressReviewFeedbackCoverage } from '../pr-address-review/feedbackCoverage.js';
import { validatePrAddressReviewOutput } from '../pr-address-review/output.js';
import { validatePlannerCommitPlan } from '../pr-finalize/commitPlan.js';
import { updatePullRequestBodyForPrFinalize } from '../pr-finalize/prBody.js';
import { validatePrFinalizeOutput } from '../pr-finalize/output.js';
import { validatePrReviewOutput } from '../pr-review/output.js';
import { validateIssueImplementOutput } from './output.js';
import { buildIssueImplementPrompt } from './prompt.js';
import { createIssueImplementPullRequestBody } from './prBody.js';

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../../git/types.js').GitCommit} GitCommit
 * @typedef {import('../../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('./output.types.js').ImplementedIssueOutput} ImplementedIssueOutput
 * @typedef {import('../pr-review/output.types.js').CompletedPrReviewOutput} CompletedPrReviewOutput
 * @typedef {import('./run.types.js').IssueImplementPreparation} IssueImplementPreparation
 * @typedef {import('./run.types.js').BlockIssueDryRunOptions} BlockIssueDryRunOptions
 */

export { GITHUB_ACTIONS_BOT_AUTHOR } from '../githubActionsBot.js';

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runIssueImplement(context) {
  if (context.publicationMode === 'dry-run') {
    return await runIssueImplementDryRun(context);
  }

  if (context.executionBackend === 'local' && context.publicationMode === 'publish') {
    return await runIssueImplementLocalPublish(context);
  }

  const preparation = await prepareIssueImplement(context);
  if (!preparation.ready) {
    return preparation.output;
  }

  let rawOutput;

  try {
    rawOutput = await context.codexRunner.run({
      cwd: context.cwd,
      command: context.config.runner.command,
      model: context.model,
      prompt: buildIssueImplementPrompt({
        issue: preparation.issue,
        parentIssueNumber: preparation.parentIssueNumber,
      }),
    });
  } catch (error) {
    await recordIssueFailure(context, preparation.issue, getErrorMessage(error));
    throw error;
  }

  return await finalizePreparedIssueImplement(context, preparation, rawOutput);
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
async function runIssueImplementLocalPublish(context) {
  assertIssueTarget(context);

  const runRecord = await createLocalRunRecord(context, {
    operationReference: 'issue:implement',
    targetNumber: context.target.number,
    publicationMode: 'publish',
  });
  context.progress?.(`Local Run Record: ${runRecord.directory}`);

  try {
    context.progress?.('Checking local worktree.');
    if (await context.gitClient.hasChanges()) {
      const reason = [
        'Local issue implementation PR publication requires a clean worktree before pushing or mutating GitHub.',
        'Commit, stash, or discard existing changes and run PullOps again.',
      ].join(' ');
      await writeLocalRunArtifact(runRecord, 'failure-reason.txt', `${reason}\n`);
      throw new Error(`${reason} Local Run Record: ${runRecord.directory}`);
    }

    const preparation = await prepareIssueImplementLocalPublish(context, runRecord);
    if (!preparation.ready) {
      return preparation.output;
    }

    if (preparation.preparedBranch) {
      return await publishPreparedIssueImplementBranch(context, preparation, runRecord);
    }

    const prompt = buildIssueImplementPrompt({
      issue: preparation.issue,
      parentIssueNumber: preparation.parentIssueNumber,
    });
    await writeLocalRunArtifact(runRecord, 'prompt.md', prompt);
    context.progress?.('Starting Codex runner.');

    let rawOutput;
    try {
      rawOutput = await context.codexRunner.run({
        cwd: context.cwd,
        command: context.config.runner.command,
        model: context.model,
        prompt,
      });
    } catch (error) {
      const reason = getErrorMessage(error);
      await writeLocalRunArtifact(runRecord, 'failure-reason.txt', `${reason}\n`);
      throw error;
    }
    context.progress?.('Codex runner finished.');

    await writeLocalRunArtifact(runRecord, 'raw-runner-output.txt', formatArtifactValue(rawOutput));
    return await finalizePreparedIssueImplementLocalPublish(
      context,
      preparation,
      rawOutput,
      runRecord,
    );
  } catch (error) {
    await writeLocalRunArtifact(runRecord, 'error.txt', `${getErrorMessage(error)}\n`);
    throw error;
  }
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
async function runIssueImplementDryRun(context) {
  assertIssueTarget(context);

  const runRecord = await createLocalRunRecord(context, {
    operationReference: 'issue:implement',
    targetNumber: context.target.number,
  });
  context.progress?.(`Local Run Record: ${runRecord.directory}`);

  try {
    context.progress?.('Checking local worktree.');
    if (await context.gitClient.hasChanges()) {
      const reason = [
        'Local dry-run issue implementation requires a clean worktree before the runner starts.',
        'Commit, stash, or discard existing changes and run PullOps again.',
      ].join(' ');
      await writeLocalRunArtifact(runRecord, 'failure-reason.txt', `${reason}\n`);
      throw new Error(`${reason} Local Run Record: ${runRecord.directory}`);
    }

    const preparation = await prepareIssueImplementDryRun(context, runRecord);
    if (!preparation.ready) {
      return preparation.output;
    }

    if (preparation.preparedBranch) {
      return await dryRunPreparedIssueImplementBranch(context, preparation, runRecord);
    }

    const prompt = buildIssueImplementPrompt({
      issue: preparation.issue,
      parentIssueNumber: preparation.parentIssueNumber,
    });
    await writeLocalRunArtifact(runRecord, 'prompt.md', prompt);
    context.progress?.('Starting Codex runner.');

    let rawOutput;
    try {
      rawOutput = await context.codexRunner.run({
        cwd: context.cwd,
        command: context.config.runner.command,
        model: context.model,
        prompt,
      });
    } catch (error) {
      const reason = getErrorMessage(error);
      await writeLocalRunArtifact(runRecord, 'failure-reason.txt', `${reason}\n`);
      throw error;
    }
    context.progress?.('Codex runner finished.');

    await writeLocalRunArtifact(runRecord, 'raw-runner-output.txt', formatArtifactValue(rawOutput));
    return await finalizePreparedIssueImplementDryRun(context, preparation, rawOutput, runRecord);
  } catch (error) {
    await writeLocalRunArtifact(runRecord, 'error.txt', `${getErrorMessage(error)}\n`);
    throw error;
  }
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runIssueImplementCodexActionPrepare(context) {
  const preparation = await prepareIssueImplement(context);
  if (!preparation.ready) {
    return preparation.output;
  }

  try {
    await writeCodexActionPrompt(
      context,
      buildIssueImplementPrompt({
        issue: preparation.issue,
        parentIssueNumber: preparation.parentIssueNumber,
      }),
    );
  } catch (error) {
    await recordIssueFailure(context, preparation.issue, getErrorMessage(error));
    throw error;
  }

  const files = getCodexActionFiles(context);
  return {
    status: 'accepted',
    summary: `Prepared Codex Action implement run for issue #${preparation.issue.number}.`,
    issue: {
      number: preparation.issue.number,
      url: preparation.issue.url,
    },
    codexAction: {
      promptFile: files.promptFile,
      outputFile: files.outputFile,
      model: context.model,
      branch: preparation.branchName,
    },
  };
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runIssueImplementCodexActionFinalize(context) {
  if (context.runnerRan === false) {
    return createSkippedCodexActionOutput(context);
  }

  const preparation = await readPreparedIssueImplement(context);
  let rawOutput;

  try {
    rawOutput = await readCodexActionOutput(context);
  } catch (error) {
    await recordIssueFailure(context, preparation.issue, getErrorMessage(error));
    throw error;
  }

  return await finalizePreparedIssueImplement(context, preparation, rawOutput);
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<IssueImplementPreparation>}
 */
async function prepareIssueImplement(context) {
  assertIssueTarget(context);

  const workTarget = await readIssueWorkTarget(context, {
    issueNumber: context.target.number,
  });
  const { issue } = workTarget;

  if (issue.state !== 'OPEN') {
    return {
      ready: false,
      output: await blockIssue(context, issue, {
        reason: `Issue #${issue.number} is ${issue.state.toLowerCase()}. PullOps can only implement open issues.`,
      }),
    };
  }

  if (issue.subIssues.length > 0) {
    return {
      ready: false,
      output: await blockIssue(context, issue, {
        reason: [
          `Issue #${issue.number} is a Parent Issue with child issues.`,
          [
            `Use ${PULL_OPS_OPERATION_LABELS.prdPrepare} on the parent issue`,
            'to create or update its umbrella branch and draft PR.',
          ].join(' '),
          `PullOps will not implement child issues from ${PULL_OPS_OPERATION_LABELS.issueImplement}.`,
        ].join(' '),
      }),
    };
  }

  if (looksLikePrdIssue(issue)) {
    return {
      ready: false,
      output: await blockIssue(context, issue, {
        reason: [
          `Issue #${issue.number} looks like a Parent Issue or PRD.`,
          [
            `Use ${PULL_OPS_OPERATION_LABELS.prdPrepare} for parent setup,`,
            `then label concrete child issues with ${PULL_OPS_OPERATION_LABELS.issueImplement}.`,
          ].join(' '),
        ].join(' '),
      }),
    };
  }

  const blockingDependencies = await readBlockingDependencies(context, { issue });
  if (blockingDependencies.length > 0) {
    return {
      ready: false,
      output: await blockIssue(context, issue, {
        reason: [
          `Issue #${issue.number} is blocked by unfinished dependencies:`,
          blockingDependencies.map(dependency => `#${dependency.number}`).join(', '),
        ].join(' '),
        humanRequired: false,
      }),
    };
  }

  const prepared = buildPreparedIssueImplement(workTarget);

  const existingPullRequest = await context.githubClient.findOpenPullRequestByHead(
    prepared.branchName,
  );
  if (existingPullRequest !== undefined) {
    await clearIssueTaskLabels(context, issue);
    return {
      ready: false,
      output: {
        status: 'accepted',
        summary: `An open PullOps implementation PR already exists for issue #${issue.number}: ${existingPullRequest.url}`,
        issue: issue.number,
        reason: `An open PullOps implementation PR already exists for issue #${issue.number}: ${existingPullRequest.url}`,
        existingPullRequest,
      },
    };
  }

  try {
    await markIssueInProgress(context, issue);

    await context.gitClient.createBranch({
      branchName: prepared.branchName,
      baseBranch: prepared.baseBranch,
    });

    return prepared;
  } catch (error) {
    await recordIssueFailure(context, issue, getErrorMessage(error));
    throw error;
  }
}

/**
 * @param {OperationRunnerContext} context
 * @param {{ directory: string }} runRecord
 * @returns {Promise<(IssueImplementPreparation & { preparedBranch?: boolean, commits?: import('../../git/types.js').GitCommit[] })>}
 */
async function prepareIssueImplementDryRun(context, runRecord) {
  assertIssueTarget(context);

  const workTarget = await readIssueWorkTarget(context, {
    issueNumber: context.target.number,
  });
  const { issue } = workTarget;
  const prepared = buildPreparedIssueImplement(workTarget);

  await fetchRemoteRefsForDryRun(context, prepared);
  const currentBranch = await readCurrentBranch(context);
  await checkoutPullOpsBranchForDryRun(context, prepared);
  await writeLocalRunArtifact(
    runRecord,
    'metadata.json',
    `${JSON.stringify(
      {
        operation: PULL_OPS_OPERATION_LABELS.issueImplement,
        operationReference: 'issue:implement',
        target: {
          type: 'issue',
          number: issue.number,
        },
        branch: prepared.branchName,
        baseBranch: prepared.baseBranch,
        publicationMode: 'dry-run',
        runGoal: context.runGoal ?? 'operation',
        modelTier: context.modelTier,
        model: context.model,
      },
      null,
      2,
    )}\n`,
  );

  if (issue.state !== 'OPEN') {
    return await blockIssueDryRun(runRecord, issue, {
      reason: `Issue #${issue.number} is ${issue.state.toLowerCase()}. PullOps can only implement open issues.`,
      branchName: prepared.branchName,
      baseBranch: prepared.baseBranch,
    });
  }

  if (issue.subIssues.length > 0) {
    return await blockIssueDryRun(runRecord, issue, {
      reason: [
        `Issue #${issue.number} is a Parent Issue with child issues.`,
        [
          `Use ${PULL_OPS_OPERATION_LABELS.prdPrepare} on the parent issue`,
          'to create or update its umbrella branch and draft PR.',
        ].join(' '),
        `PullOps will not implement child issues from ${PULL_OPS_OPERATION_LABELS.issueImplement}.`,
      ].join(' '),
      branchName: prepared.branchName,
      baseBranch: prepared.baseBranch,
    });
  }

  if (looksLikePrdIssue(issue)) {
    return await blockIssueDryRun(runRecord, issue, {
      reason: [
        `Issue #${issue.number} looks like a Parent Issue or PRD.`,
        [
          `Use ${PULL_OPS_OPERATION_LABELS.prdPrepare} for parent setup,`,
          `then label concrete child issues with ${PULL_OPS_OPERATION_LABELS.issueImplement}.`,
        ].join(' '),
      ].join(' '),
      branchName: prepared.branchName,
      baseBranch: prepared.baseBranch,
    });
  }

  const blockingDependencies = await readBlockingDependencies(context, { issue });
  if (blockingDependencies.length > 0) {
    return await blockIssueDryRun(runRecord, issue, {
      reason: [
        `Issue #${issue.number} is blocked by unfinished dependencies:`,
        blockingDependencies.map(dependency => `#${dependency.number}`).join(', '),
      ].join(' '),
      branchName: prepared.branchName,
      baseBranch: prepared.baseBranch,
    });
  }

  if (currentBranch === prepared.branchName) {
    const commits = await readLocalCommitsSinceBase(context, prepared);
    if (commits.length > 0) {
      return {
        ...prepared,
        preparedBranch: true,
        commits,
      };
    }
  }

  return prepared;
}

/**
 * @param {OperationRunnerContext} context
 * @param {{ directory: string }} runRecord
 * @returns {Promise<(IssueImplementPreparation & { preparedBranch?: boolean, commits?: import('../../git/types.js').GitCommit[] })>}
 */
async function prepareIssueImplementLocalPublish(context, runRecord) {
  assertIssueTarget(context);

  const workTarget = await readIssueWorkTarget(context, {
    issueNumber: context.target.number,
  });
  const { issue } = workTarget;
  const prepared = buildPreparedIssueImplement(workTarget);

  await fetchRemoteRefsForDryRun(context, prepared);
  const currentBranch = await readCurrentBranch(context);
  await writeIssueImplementLocalMetadata(context, runRecord, {
    issue,
    prepared,
    publicationMode: 'publish',
  });
  await checkoutPullOpsBranchForDryRun(context, prepared);

  const blocked = await readIssueImplementLocalBlock(context, prepared, issue, runRecord);
  if (blocked !== undefined) {
    return blocked;
  }

  if (currentBranch === prepared.branchName) {
    const commits = await readLocalCommitsSinceBase(context, prepared);
    if (commits.length > 0) {
      return {
        ...prepared,
        preparedBranch: true,
        commits,
      };
    }
  }

  return prepared;
}

/**
 * @param {OperationRunnerContext} context
 * @param {IssueImplementPreparation & { ready: true }} prepared
 * @param {GitHubIssue} issue
 * @param {{ directory: string }} runRecord
 * @returns {Promise<IssueImplementPreparation | undefined>}
 */
async function readIssueImplementLocalBlock(context, prepared, issue, runRecord) {
  if (issue.state !== 'OPEN') {
    return await blockIssueDryRun(runRecord, issue, {
      reason: `Issue #${issue.number} is ${issue.state.toLowerCase()}. PullOps can only implement open issues.`,
      branchName: prepared.branchName,
      baseBranch: prepared.baseBranch,
      publicationMode: 'publish',
    });
  }

  if (issue.subIssues.length > 0) {
    return await blockIssueDryRun(runRecord, issue, {
      reason: [
        `Issue #${issue.number} is a Parent Issue with child issues.`,
        [
          `Use ${PULL_OPS_OPERATION_LABELS.prdPrepare} on the parent issue`,
          'to create or update its umbrella branch and draft PR.',
        ].join(' '),
        `PullOps will not implement child issues from ${PULL_OPS_OPERATION_LABELS.issueImplement}.`,
      ].join(' '),
      branchName: prepared.branchName,
      baseBranch: prepared.baseBranch,
      publicationMode: 'publish',
    });
  }

  if (looksLikePrdIssue(issue)) {
    return await blockIssueDryRun(runRecord, issue, {
      reason: [
        `Issue #${issue.number} looks like a Parent Issue or PRD.`,
        [
          `Use ${PULL_OPS_OPERATION_LABELS.prdPrepare} for parent setup,`,
          `then label concrete child issues with ${PULL_OPS_OPERATION_LABELS.issueImplement}.`,
        ].join(' '),
      ].join(' '),
      branchName: prepared.branchName,
      baseBranch: prepared.baseBranch,
      publicationMode: 'publish',
    });
  }

  const blockingDependencies = await readBlockingDependencies(context, { issue });
  if (blockingDependencies.length > 0) {
    return await blockIssueDryRun(runRecord, issue, {
      reason: [
        `Issue #${issue.number} is blocked by unfinished dependencies:`,
        blockingDependencies.map(dependency => `#${dependency.number}`).join(', '),
      ].join(' '),
      branchName: prepared.branchName,
      baseBranch: prepared.baseBranch,
      publicationMode: 'publish',
    });
  }

  return undefined;
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<IssueImplementPreparation & { ready: true }>}
 */
async function readPreparedIssueImplement(context) {
  assertIssueTarget(context);
  return buildPreparedIssueImplement(
    await readIssueWorkTarget(context, {
      issueNumber: context.target.number,
    }),
  );
}

/**
 * @param {import('../../prd-automation/childCoordination.types.js').IssueWorkTarget} workTarget
 * @returns {IssueImplementPreparation & { ready: true }}
 */
function buildPreparedIssueImplement(workTarget) {
  return {
    ready: true,
    issue: workTarget.issue,
    parentIssueNumber: workTarget.parentIssueNumber,
    branchName: workTarget.branchName,
    baseBranch: workTarget.baseBranch,
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {IssueImplementPreparation & { ready: true }} preparation
 * @param {unknown} rawOutput
 * @returns {Promise<Record<string, unknown>>}
 */
async function finalizePreparedIssueImplement(context, preparation, rawOutput) {
  const { issue, parentIssueNumber, branchName, baseBranch } = preparation;
  let failureRecorded = false;

  try {
    const validatedOutput = validateIssueImplementOutput(rawOutput);

    if (!validatedOutput.valid) {
      const reason = `Invalid Operation Output: ${validatedOutput.reason}`;
      failureRecorded = true;
      await recordIssueFailure(context, issue, reason);
      throw new Error(reason);
    }

    if (validatedOutput.value.status === 'blocked') {
      failureRecorded = true;
      await blockIssue(context, issue, {
        reason: validatedOutput.value.failureReason,
        summary: validatedOutput.value.summary,
      });
      return {
        status: 'blocked',
        summary: validatedOutput.value.summary,
        issue: issue.number,
      };
    }

    if (!(await context.gitClient.hasChanges())) {
      const reason = 'Codex runner completed but did not leave any working tree changes to commit.';
      failureRecorded = true;
      await recordIssueFailure(context, issue, reason);
      throw new Error(reason);
    }

    await context.gitClient.commitAll({
      message: createIssueImplementCommitMessage(issue, parentIssueNumber),
      author: GITHUB_ACTIONS_BOT_AUTHOR,
    });
    await context.gitClient.pushBranch({ branchName });

    const umbrellaPullRequestNumber = await readUmbrellaPullRequestNumber(context, {
      parentIssueNumber,
      baseBranch,
    });
    const pullRequestBody = createIssueImplementPullRequestBody({
      issue,
      output: validatedOutput.value,
      branchName,
      parentIssueNumber,
      umbrellaPullRequestNumber,
      triggerActor: context.triggerActor,
      modelTier: context.modelTier,
      model: context.model,
    });
    const pullRequest = await context.githubClient.createDraftPullRequest({
      title: `Implement #${issue.number}: ${issue.title}`,
      body: pullRequestBody,
      baseBranch,
      headBranch: branchName,
    });

    await context.githubClient.addLabelsToPullRequest({
      number: pullRequest.number,
      labels: [PULL_OPS_OPERATION_LABELS.prReview],
    });
    await commentOnPullRequestWithOperationAudit(context, {
      pullRequestNumber: pullRequest.number,
      operation: PULL_OPS_OPERATION_LABELS.issueImplement,
      summary: validatedOutput.value.summary,
    });
    await context.githubClient.removeLabelsFromIssue({
      number: issue.number,
      labels: [
        PULL_OPS_OPERATION_LABELS.issueImplement,
        PULL_OPS_STATUS_LABELS.humanRequired,
        PULL_OPS_STATUS_LABELS.inProgress,
        PULL_OPS_STATUS_LABELS.blocked,
        PULL_OPS_STATUS_LABELS.prepared,
        PULL_OPS_STATUS_LABELS.failed,
      ],
    });

    return {
      status: 'accepted',
      summary: `Opened draft PullOps-managed PR #${pullRequest.number} for issue #${issue.number}.`,
      issue: {
        number: issue.number,
        url: issue.url,
      },
      pullRequest: {
        number: pullRequest.number,
        url: pullRequest.url,
        branch: branchName,
        draft: pullRequest.isDraft,
      },
    };
  } catch (error) {
    if (!failureRecorded) {
      await recordIssueFailure(context, issue, getErrorMessage(error));
    }

    throw error;
  }
}

/**
 * @param {OperationRunnerContext} context
 * @param {IssueImplementPreparation & { ready: true }} preparation
 * @param {unknown} rawOutput
 * @param {{ directory: string }} runRecord
 * @returns {Promise<Record<string, unknown>>}
 */
async function finalizePreparedIssueImplementLocalPublish(
  context,
  preparation,
  rawOutput,
  runRecord,
) {
  const { issue, parentIssueNumber, branchName } = preparation;
  const validatedOutput = validateIssueImplementOutput(rawOutput);

  if (!validatedOutput.valid) {
    const reason = `Invalid Operation Output: ${validatedOutput.reason}`;
    await writeLocalRunArtifact(runRecord, 'failure-reason.txt', `${reason}\n`);
    throw new Error(`${reason} Local Run Record: ${runRecord.directory}`);
  }

  await writeLocalRunArtifact(
    runRecord,
    'validated-output.json',
    `${JSON.stringify(validatedOutput.value, null, 2)}\n`,
  );

  if (validatedOutput.value.status === 'blocked') {
    await writeLocalRunArtifact(
      runRecord,
      'failure-reason.txt',
      `${validatedOutput.value.failureReason}\n`,
    );
    await writePatchArtifactIfAvailable(context, runRecord);
    return {
      status: 'blocked',
      summary: validatedOutput.value.summary,
      issue: issue.number,
      branch: branchName,
      baseBranch: preparation.baseBranch,
      publicationMode: 'publish',
      localRunRecord: runRecord.directory,
    };
  }

  if (!(await context.gitClient.hasChanges())) {
    const reason = 'Codex runner completed but did not leave any working tree changes to commit.';
    await writeLocalRunArtifact(runRecord, 'failure-reason.txt', `${reason}\n`);
    throw new Error(`${reason} Local Run Record: ${runRecord.directory}`);
  }

  await writePatchArtifactIfAvailable(context, runRecord);
  await context.gitClient.commitAll({
    message: createIssueImplementCommitMessage(issue, parentIssueNumber),
    author: GITHUB_ACTIONS_BOT_AUTHOR,
  });

  if (context.runGoal === 'finalized') {
    const finalized = await runLocalFinalizedIssuePipeline(
      context,
      preparation,
      validatedOutput.value,
      runRecord,
    );
    if (finalized.status === 'blocked') {
      return finalized.output;
    }

    return await publishIssueImplementPullRequest(context, preparation, validatedOutput.value, {
      localRunRecord: runRecord.directory,
      finalizedBody: finalized.body,
      readyForReview: true,
      finalizedBranch: true,
      summary: `Finalized and published PullOps-managed PR for issue #${issue.number}.`,
    });
  }

  return await publishIssueImplementPullRequest(context, preparation, validatedOutput.value, {
    localRunRecord: runRecord.directory,
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {IssueImplementPreparation & { ready: true, commits?: import('../../git/types.js').GitCommit[] }} preparation
 * @param {{ directory: string }} runRecord
 * @returns {Promise<Record<string, unknown>>}
 */
async function publishPreparedIssueImplementBranch(context, preparation, runRecord) {
  const output = createPreparedBranchIssueImplementOutput(preparation);
  await writeLocalRunArtifact(
    runRecord,
    'validated-output.json',
    `${JSON.stringify(output, null, 2)}\n`,
  );

  if (context.runGoal === 'finalized') {
    const finalized = await runLocalFinalizedIssuePipeline(context, preparation, output, runRecord);
    if (finalized.status === 'blocked') {
      return finalized.output;
    }

    return await publishIssueImplementPullRequest(context, preparation, output, {
      localRunRecord: runRecord.directory,
      preparedBranch: true,
      finalizedBody: finalized.body,
      readyForReview: true,
      finalizedBranch: true,
      summary: `Finalized and published prepared PullOps-managed PR for issue #${preparation.issue.number}.`,
    });
  }

  return await publishIssueImplementPullRequest(context, preparation, output, {
    localRunRecord: runRecord.directory,
    preparedBranch: true,
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {IssueImplementPreparation & { ready: true }} preparation
 * @param {ImplementedIssueOutput} output
 * @param {{
 *   localRunRecord: string,
 *   preparedBranch?: boolean,
 *   finalizedBody?: string,
 *   readyForReview?: boolean,
 *   finalizedBranch?: boolean,
 *   summary?: string,
 * }} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function publishIssueImplementPullRequest(
  context,
  preparation,
  output,
  {
    localRunRecord,
    preparedBranch = false,
    finalizedBody,
    readyForReview = false,
    finalizedBranch = false,
    summary,
  },
) {
  const { issue, parentIssueNumber, branchName, baseBranch } = preparation;

  if (await context.gitClient.hasChanges()) {
    const reason = [
      'Local issue implementation PR publication requires a clean worktree before pushing or mutating GitHub.',
      'Commit, stash, or discard existing changes and run PullOps again.',
    ].join(' ');
    throw new Error(`${reason} Local Run Record: ${localRunRecord}`);
  }

  if (finalizedBranch) {
    const pushResult = await context.gitClient.pushBranchWithLease({ branchName });
    if (pushResult.status === 'stale-lease') {
      throw new Error(
        `Remote branch ${branchName} changed during finalized publication. Local Run Record: ${localRunRecord}`,
      );
    }
  } else {
    await context.gitClient.pushBranch({ branchName });
  }

  const umbrellaPullRequestNumber = await readUmbrellaPullRequestNumber(context, {
    parentIssueNumber,
    baseBranch,
  });
  const pullRequestBody =
    finalizedBody ??
    createIssueImplementPullRequestBody({
      issue,
      output,
      branchName,
      parentIssueNumber,
      umbrellaPullRequestNumber,
      triggerActor: context.triggerActor,
      modelTier: context.modelTier,
      model: context.model,
    });

  const existingPullRequest = await context.githubClient.findOpenPullRequestByHead(branchName);
  const pullRequest =
    existingPullRequest === undefined
      ? await context.githubClient.createDraftPullRequest({
          title: `Implement #${issue.number}: ${issue.title}`,
          body: pullRequestBody,
          baseBranch,
          headBranch: branchName,
        })
      : existingPullRequest;

  if (existingPullRequest !== undefined) {
    await context.githubClient.updatePullRequestBody({
      number: existingPullRequest.number,
      body: pullRequestBody,
    });
  }

  if (readyForReview && pullRequest.isDraft) {
    await context.githubClient.markPullRequestReadyForReview(pullRequest.number);
  }

  await commentOnPullRequestWithOperationAudit(context, {
    pullRequestNumber: pullRequest.number,
    operation: PULL_OPS_OPERATION_LABELS.issueImplement,
    summary: output.summary,
  });
  await clearIssueTaskLabels(context, issue);

  const action = existingPullRequest === undefined ? 'Opened' : 'Updated';
  return {
    status: 'accepted',
    summary:
      summary ??
      `${action} draft PullOps-managed PR #${pullRequest.number} for issue #${issue.number}.`,
    issue: {
      number: issue.number,
      url: issue.url,
    },
    pullRequest: {
      number: pullRequest.number,
      url: pullRequest.url,
      branch: branchName,
      draft: readyForReview ? false : pullRequest.isDraft,
    },
    publicationMode: 'publish',
    localRunRecord,
    ...(preparedBranch ? { preparedBranch: true } : {}),
  };
}

/**
 * @param {IssueImplementPreparation & { ready: true, commits?: import('../../git/types.js').GitCommit[] }} preparation
 * @returns {ImplementedIssueOutput}
 */
function createPreparedBranchIssueImplementOutput(preparation) {
  const subjects = (preparation.commits ?? []).map(commit => commit.subject);
  return {
    status: 'implemented',
    summary: `Published prepared local issue implementation branch for issue #${preparation.issue.number}.`,
    changes:
      subjects.length === 0
        ? ['Published existing local commits on the prepared PullOps branch.']
        : subjects.map(subject => `Published local commit: ${subject}`),
    testPlan: ['Not run during publish-only; see the prepared local branch history.'],
    followUps: [],
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {IssueImplementPreparation & { ready: true, commits?: import('../../git/types.js').GitCommit[] }} preparation
 * @param {{ directory: string }} runRecord
 * @returns {Promise<Record<string, unknown>>}
 */
async function dryRunPreparedIssueImplementBranch(context, preparation, runRecord) {
  const { issue, branchName, baseBranch } = preparation;
  const output = createPreparedBranchIssueImplementOutput(preparation);
  await writeLocalRunArtifact(
    runRecord,
    'validated-output.json',
    `${JSON.stringify(output, null, 2)}\n`,
  );

  if (context.runGoal === 'finalized') {
    const finalized = await runLocalFinalizedIssuePipeline(context, preparation, output, runRecord);
    if (finalized.status === 'blocked') {
      return finalized.output;
    }

    await writeLocalRunArtifact(runRecord, 'finalized-pr-body.md', finalized.body);
    return {
      status: 'accepted',
      summary: `Completed local finalized dry-run prepared issue implementation for issue #${issue.number} on ${branchName}.`,
      issue: {
        number: issue.number,
        url: issue.url,
      },
      branch: branchName,
      baseBranch,
      publicationMode: 'dry-run',
      runGoal: 'finalized',
      localRunRecord: runRecord.directory,
      preparedBranch: true,
      prFinalize: finalized.prFinalize,
    };
  }

  return {
    status: 'accepted',
    summary: `Completed local dry-run prepared issue implementation for issue #${issue.number} on ${branchName}.`,
    issue: {
      number: issue.number,
      url: issue.url,
    },
    branch: branchName,
    baseBranch,
    publicationMode: 'dry-run',
    localRunRecord: runRecord.directory,
    preparedBranch: true,
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {IssueImplementPreparation & { ready: true }} preparation
 * @param {unknown} rawOutput
 * @param {{ directory: string }} runRecord
 * @returns {Promise<Record<string, unknown>>}
 */
async function finalizePreparedIssueImplementDryRun(context, preparation, rawOutput, runRecord) {
  const { issue, parentIssueNumber, branchName, baseBranch } = preparation;
  const validatedOutput = validateIssueImplementOutput(rawOutput);

  if (!validatedOutput.valid) {
    const reason = `Invalid Operation Output: ${validatedOutput.reason}`;
    await writeLocalRunArtifact(runRecord, 'failure-reason.txt', `${reason}\n`);
    throw new Error(`${reason} Local Run Record: ${runRecord.directory}`);
  }

  await writeLocalRunArtifact(
    runRecord,
    'validated-output.json',
    `${JSON.stringify(validatedOutput.value, null, 2)}\n`,
  );

  if (validatedOutput.value.status === 'blocked') {
    await writeLocalRunArtifact(
      runRecord,
      'failure-reason.txt',
      `${validatedOutput.value.failureReason}\n`,
    );
    await writePatchArtifactIfAvailable(context, runRecord);
    return {
      status: 'blocked',
      summary: validatedOutput.value.summary,
      issue: issue.number,
      branch: branchName,
      baseBranch,
      publicationMode: 'dry-run',
      localRunRecord: runRecord.directory,
    };
  }

  if (!(await context.gitClient.hasChanges())) {
    const reason = 'Codex runner completed but did not leave any working tree changes to commit.';
    await writeLocalRunArtifact(runRecord, 'failure-reason.txt', `${reason}\n`);
    throw new Error(`${reason} Local Run Record: ${runRecord.directory}`);
  }

  await writePatchArtifactIfAvailable(context, runRecord);
  await context.gitClient.commitAll({
    message: createIssueImplementCommitMessage(issue, parentIssueNumber),
    author: GITHUB_ACTIONS_BOT_AUTHOR,
  });

  if (context.runGoal === 'finalized') {
    const finalized = await runLocalFinalizedIssuePipeline(
      context,
      preparation,
      validatedOutput.value,
      runRecord,
    );
    if (finalized.status === 'blocked') {
      return finalized.output;
    }

    await writeLocalRunArtifact(runRecord, 'finalized-pr-body.md', finalized.body);
    return {
      status: 'accepted',
      summary: `Completed local finalized dry-run issue implementation for issue #${issue.number} on ${branchName}.`,
      issue: {
        number: issue.number,
        url: issue.url,
      },
      branch: branchName,
      baseBranch,
      publicationMode: 'dry-run',
      runGoal: 'finalized',
      localRunRecord: runRecord.directory,
      prFinalize: finalized.prFinalize,
    };
  }

  return {
    status: 'accepted',
    summary: `Completed local dry-run issue implementation for issue #${issue.number} on ${branchName}.`,
    issue: {
      number: issue.number,
      url: issue.url,
    },
    branch: branchName,
    baseBranch,
    publicationMode: 'dry-run',
    localRunRecord: runRecord.directory,
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {IssueImplementPreparation & { ready: true }} preparation
 * @param {ImplementedIssueOutput} implementationOutput
 * @param {{ directory: string }} runRecord
 * @returns {Promise<
 *   | { status: 'finalized', body: string, prFinalize: Record<string, unknown> }
 *   | { status: 'blocked', output: Record<string, unknown> }
 * >}
 */
async function runLocalFinalizedIssuePipeline(
  context,
  preparation,
  implementationOutput,
  runRecord,
) {
  const maxReviewCycles = 3;
  let reviewCycle = 0;
  /** @type {unknown[]} */
  const reviewComments = [];
  /** @type {string[]} */
  const operations = [];
  /** @type {{ operationReference: string, fileName: string, output: unknown }[]} */
  const followUpEvidence = [];

  while (true) {
    const reviewPrompt = await buildLocalFollowUpPrompt(context, {
      skillName: 'pullops-pr-review',
      operationReference: 'pr:review',
      preparation,
      implementationOutput,
      runRecord,
      followUpEvidence,
      reviewComments,
    });
    const reviewOutput = await runLocalFollowUpOperation(context, runRecord, {
      operationName: 'pr-review',
      operationReference: 'pr:review',
      prompt: reviewPrompt,
      validate: validatePrReviewOutput,
    });
    if (!reviewOutput.valid) {
      return await blockLocalFinalizedRun(context, runRecord, preparation, reviewOutput.reason);
    }

    operations.push('pr:review');
    const reviewEvidenceFile = await writeLocalFollowUpEvidence(
      runRecord,
      'pr:review',
      operations.length,
      reviewOutput.value,
    );
    followUpEvidence.push({
      operationReference: 'pr:review',
      fileName: reviewEvidenceFile,
      output: reviewOutput.value,
    });

    if (reviewOutput.value.status === 'blocked') {
      return await blockLocalFinalizedRun(
        context,
        runRecord,
        preparation,
        reviewOutput.value.failureReason,
        reviewOutput.value.summary,
      );
    }

    await commitLocalReviewChangesIfPresent(
      context,
      runRecord,
      preparation.issue,
      reviewOutput.value,
    );
    reviewCycle += 1;
    reviewComments.push(...reviewOutput.value.comments);

    if (reviewOutput.value.status === 'approved') {
      break;
    }

    if (reviewCycle >= maxReviewCycles) {
      return await blockLocalFinalizedRun(
        context,
        runRecord,
        preparation,
        `Review Cycles are exhausted (${reviewCycle} / ${maxReviewCycles}).`,
      );
    }

    const addressPrompt = await buildLocalFollowUpPrompt(context, {
      skillName: 'pullops-pr-address-review',
      operationReference: 'pr:address-review',
      preparation,
      implementationOutput,
      runRecord,
      followUpEvidence,
      reviewComments,
      latestReviewOutput: reviewOutput.value,
    });
    const addressOutput = await runLocalFollowUpOperation(context, runRecord, {
      operationName: 'pr-address-review',
      operationReference: 'pr:address-review',
      prompt: addressPrompt,
      validate: validatePrAddressReviewOutput,
    });
    if (!addressOutput.valid) {
      return await blockLocalFinalizedRun(context, runRecord, preparation, addressOutput.reason);
    }

    operations.push('pr:address-review');
    const addressEvidenceFile = await writeLocalFollowUpEvidence(
      runRecord,
      'pr:address-review',
      operations.length,
      addressOutput.value,
    );
    followUpEvidence.push({
      operationReference: 'pr:address-review',
      fileName: addressEvidenceFile,
      output: addressOutput.value,
    });

    if (addressOutput.value.status === 'blocked') {
      return await blockLocalFinalizedRun(
        context,
        runRecord,
        preparation,
        addressOutput.value.failureReason,
        addressOutput.value.summary,
      );
    }

    const addressCoverage = validateAddressReviewFeedbackCoverage(
      addressOutput.value,
      createLocalReviewFeedbackIds(reviewOutput.value),
    );
    if (!addressCoverage.valid) {
      return await blockLocalFinalizedRun(
        context,
        runRecord,
        preparation,
        `Invalid Address Review Output: ${addressCoverage.reason}`,
      );
    }

    if (await context.gitClient.hasChanges()) {
      await writePatchArtifactIfAvailable(context, runRecord);
      await context.gitClient.commitAll({
        message: createIssueImplementReviewAddressCommitMessage(preparation.issue),
        author: GITHUB_ACTIONS_BOT_AUTHOR,
      });
    }
  }

  const finalizePrompt = await buildLocalFollowUpPrompt(context, {
    skillName: 'pullops-pr-finalize',
    operationReference: 'pr:finalize',
    preparation,
    implementationOutput,
    runRecord,
    followUpEvidence,
    reviewComments,
  });
  const finalizeOutput = await runLocalFollowUpOperation(context, runRecord, {
    operationName: 'pr-finalize',
    operationReference: 'pr:finalize',
    prompt: finalizePrompt,
    validate: validatePrFinalizeOutput,
  });
  if (!finalizeOutput.valid) {
    return await blockLocalFinalizedRun(context, runRecord, preparation, finalizeOutput.reason);
  }

  operations.push('pr:finalize');
  const finalizeEvidenceFile = await writeLocalFollowUpEvidence(
    runRecord,
    'pr:finalize',
    operations.length,
    finalizeOutput.value,
  );
  followUpEvidence.push({
    operationReference: 'pr:finalize',
    fileName: finalizeEvidenceFile,
    output: finalizeOutput.value,
  });

  if (finalizeOutput.value.status === 'blocked') {
    return await blockLocalFinalizedRun(
      context,
      runRecord,
      preparation,
      finalizeOutput.value.failureReason,
      finalizeOutput.value.summary,
    );
  }

  const changedFiles = await context.gitClient.getChangedFilesSinceBase({
    baseBranch: preparation.baseBranch,
  });
  const commitPlan = validatePlannerCommitPlan({
    plannedCommits: finalizeOutput.value.commitPlan.commits,
    changedFiles,
  });
  if (!commitPlan.valid) {
    return await blockLocalFinalizedRun(
      context,
      runRecord,
      preparation,
      `Invalid PR Finalize Planner Output: ${commitPlan.reason}`,
    );
  }

  const reviewedHeadSha = await readLocalFinalizedHeadSha(context);
  const reviewedTreeHash = await readLocalFinalizedTreeHash(context);
  let rewriteResult;
  try {
    rewriteResult = await context.gitClient.rewriteBranchWithCommitPlan({
      baseBranch: preparation.baseBranch,
      branchName: preparation.branchName,
      commits: commitPlan.commits,
      author: GITHUB_ACTIONS_BOT_AUTHOR,
      push: false,
    });
  } catch (error) {
    return await blockLocalFinalizedRewriteFailure(
      context,
      runRecord,
      preparation,
      reviewedHeadSha,
      `Failed to rewrite the finalized branch: ${getErrorMessage(error)}`,
    );
  }

  if (rewriteResult.treeHash !== reviewedTreeHash) {
    return await blockLocalFinalizedRewriteFailure(
      context,
      runRecord,
      preparation,
      reviewedHeadSha,
      [
        `Finalized tree ${rewriteResult.treeHash} did not match reviewed tree`,
        `${reviewedTreeHash} for issue #${preparation.issue.number}.`,
      ].join(' '),
    );
  }

  const umbrellaPullRequestNumber = await readUmbrellaPullRequestNumber(context, {
    parentIssueNumber: preparation.parentIssueNumber,
    baseBranch: preparation.baseBranch,
  });
  const body = updatePullRequestBodyForPrFinalize({
    body: createIssueImplementPullRequestBody({
      issue: preparation.issue,
      output: implementationOutput,
      branchName: preparation.branchName,
      parentIssueNumber: preparation.parentIssueNumber,
      umbrellaPullRequestNumber,
      triggerActor: context.triggerActor,
      modelTier: context.modelTier,
      model: context.model,
    }),
    sourceIssueNumber: preparation.issue.number,
    parentIssueNumber: preparation.parentIssueNumber,
    finalizedTreeHash: rewriteResult.treeHash,
    finalizedHeadSha: rewriteResult.headSha,
    status: 'ready',
  });
  const ciFollowUp = createLocalFinalizedCiFollowUp({
    context,
    preparation,
    rewriteResult,
  });

  await writeLocalRunArtifact(
    runRecord,
    'review-comments.json',
    `${JSON.stringify(reviewComments, null, 2)}\n`,
  );
  await writeLocalRunArtifact(
    runRecord,
    'local-next-steps.md',
    ['# Local finalized run next steps', '', ...ciFollowUp.nextSteps, ''].join('\n'),
  );
  await writeLocalRunArtifact(
    runRecord,
    'ci-follow-up.json',
    `${JSON.stringify(ciFollowUp.record, null, 2)}\n`,
  );
  await writeLocalRunArtifact(
    runRecord,
    'follow-up-operations.json',
    `${JSON.stringify(operations, null, 2)}\n`,
  );

  return {
    status: 'finalized',
    body,
    prFinalize: {
      finalizedTree: rewriteResult.treeHash,
      finalizedHead: rewriteResult.headSha,
      mergeMethod: 'rebase',
      readyForReview: true,
      reviewCycles: reviewCycle,
      ciFollowUp: ciFollowUp.record,
    },
  };
}

/**
 * @template T
 * @param {OperationRunnerContext} context
 * @param {{ directory: string }} runRecord
 * @param {{
 *   operationName: string,
 *   operationReference: string,
 *   prompt: string,
 *   validate: (value: unknown) => { valid: true, value: T } | { valid: false, reason: string },
 * }} options
 * @returns {Promise<{ valid: true, value: T } | { valid: false, reason: string }>}
 */
async function runLocalFollowUpOperation(
  context,
  runRecord,
  { operationName, operationReference, prompt, validate },
) {
  const modelSelection = resolveOperationModelSelection(context, operationName);
  const rawOutput = await context.codexRunner.run({
    cwd: context.cwd,
    command: context.config.runner.command,
    model: modelSelection.model,
    prompt,
  });
  await writeLocalRunArtifact(
    runRecord,
    `${normalizeOperationReferenceForPath(operationReference)}-raw-output.txt`,
    formatArtifactValue(rawOutput),
  );

  return validate(rawOutput);
}

/**
 * @param {OperationRunnerContext} context
 * @param {string} operationName
 * @returns {{ modelTier: string, model: string }}
 */
function resolveOperationModelSelection(context, operationName) {
  const operation = getWorkflowOperation(operationName);
  if (operation === undefined) {
    throw new Error(`Workflow operation "${operationName}" is not registered.`);
  }

  const operationConfig = context.config.operations[operation.configKey];
  return {
    modelTier: operationConfig.modelTier,
    model: context.config.runner.models[operationConfig.modelTier],
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {{
 *   skillName: string,
 *   operationReference: string,
 *   preparation: IssueImplementPreparation & { ready: true },
 *   implementationOutput: ImplementedIssueOutput,
 *   runRecord: { directory: string },
 *   followUpEvidence: { operationReference: string, fileName: string, output: unknown }[],
 *   reviewComments: unknown[],
 *   latestReviewOutput?: CompletedPrReviewOutput,
 * }} options
 * @returns {Promise<string>}
 */
async function buildLocalFollowUpPrompt(
  context,
  {
    skillName,
    operationReference,
    preparation,
    implementationOutput,
    runRecord,
    followUpEvidence,
    reviewComments,
    latestReviewOutput,
  },
) {
  const umbrellaPullRequestNumber = await readUmbrellaPullRequestNumber(context, {
    parentIssueNumber: preparation.parentIssueNumber,
    baseBranch: preparation.baseBranch,
  });
  const pullRequestBody = createIssueImplementPullRequestBody({
    issue: preparation.issue,
    output: implementationOutput,
    branchName: preparation.branchName,
    parentIssueNumber: preparation.parentIssueNumber,
    umbrellaPullRequestNumber,
    triggerActor: context.triggerActor,
    modelTier: context.modelTier,
    model: context.model,
  });
  const changedFiles = await context.gitClient.getChangedFilesSinceBase({
    baseBranch: preparation.baseBranch,
  });
  const commits = await readLocalCommitsSinceBaseIfAvailable(context, preparation);
  const patch = await readWorkingTreePatchIfAvailable(context);

  const sections = [
    `Use the ${skillName} skill.`,
    '',
    `Run this PullOps follow-up locally for issue implementation PR branch for issue #${preparation.issue.number}.`,
    '',
    'Linked issue or PRD context:',
    formatLocalIssueContext(preparation.issue),
    '',
    'Local PR context:',
    [
      `Branch: ${preparation.branchName}`,
      `Base branch: ${preparation.baseBranch}`,
      `Operation: ${operationReference}`,
      `Local Run Record: ${runRecord.directory}`,
    ].join('\n'),
    '',
    'Pull request body:',
    pullRequestBody.trim() || '(empty)',
    '',
    formatLocalOperationSpecificContext({
      operationReference,
      latestReviewOutput,
      reviewComments,
    }),
    '',
    'Changed files since base:',
    formatStringList(changedFiles),
    '',
    'Current commits since base:',
    formatLocalCommits(commits),
    '',
    'Current working tree patch:',
    patch,
    '',
    'Prior local follow-up evidence:',
    formatLocalFollowUpEvidence(runRecord, followUpEvidence),
    '',
    'Constraints:',
    '- Treat the local run record as the authoritative substitute for hosted PR comments, review summaries, threads, and audit evidence while the PR does not yet exist.',
    '- Use the linked issue body, synthesized PR body, changed files, local commit history, and prior local evidence when making decisions.',
    '- Read or update workspace files as needed, but do not create commits, push, or mutate GitHub; PullOps will do that after validating your output.',
    '',
    'Return only the operation output JSON.',
  ];

  return sections.join('\n');
}

/**
 * @param {{ directory: string }} runRecord
 * @param {string} operationReference
 * @param {number} index
 * @param {unknown} output
 * @returns {Promise<string>}
 */
async function writeLocalFollowUpEvidence(runRecord, operationReference, index, output) {
  const fileName = `${String(index).padStart(2, '0')}-${normalizeOperationReferenceForPath(
    operationReference,
  )}-evidence.json`;
  await writeLocalRunArtifact(
    runRecord,
    fileName,
    `${JSON.stringify({ operation: operationReference, output }, null, 2)}\n`,
  );
  return fileName;
}

/**
 * @param {OperationRunnerContext} context
 * @param {{ directory: string }} runRecord
 * @param {IssueImplementPreparation & { ready: true }} preparation
 * @param {string} reason
 * @param {string} [summary]
 * @returns {Promise<{ status: 'blocked', output: Record<string, unknown> }>}
 */
async function blockLocalFinalizedRun(context, runRecord, preparation, reason, summary = reason) {
  await writeLocalRunArtifact(runRecord, 'failure-reason.txt', `${reason}\n`);
  return {
    status: 'blocked',
    output: {
      status: 'blocked',
      summary,
      issue: preparation.issue.number,
      branch: preparation.branchName,
      baseBranch: preparation.baseBranch,
      publicationMode: context.publicationMode ?? 'dry-run',
      runGoal: 'finalized',
      localRunRecord: runRecord.directory,
    },
  };
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<string>}
 */
async function readLocalFinalizedTreeHash(context) {
  if (context.gitClient.getCurrentTreeHash === undefined) {
    throw new Error('Git client does not support reading the finalized tree hash.');
  }

  return await context.gitClient.getCurrentTreeHash();
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<string>}
 */
async function readLocalFinalizedHeadSha(context) {
  if (context.gitClient.getCurrentHeadSha === undefined) {
    throw new Error('Git client does not support reading the finalized branch head.');
  }

  return await context.gitClient.getCurrentHeadSha();
}

/**
 * @param {OperationRunnerContext} context
 * @param {string} reviewedHeadSha
 * @returns {Promise<void>}
 */
async function restoreLocalFinalizedReviewedHead(context, reviewedHeadSha) {
  if (context.gitClient.resetHardToRevision === undefined) {
    throw new Error('Git client does not support restoring the reviewed branch head.');
  }

  await context.gitClient.resetHardToRevision({ revision: reviewedHeadSha });
}

/**
 * @param {OperationRunnerContext} context
 * @param {{ directory: string }} runRecord
 * @param {IssueImplementPreparation & { ready: true }} preparation
 * @param {string} reviewedHeadSha
 * @param {string} reason
 * @returns {Promise<{ status: 'blocked', output: Record<string, unknown> }>}
 */
async function blockLocalFinalizedRewriteFailure(
  context,
  runRecord,
  preparation,
  reviewedHeadSha,
  reason,
) {
  let blockReason = reason;

  try {
    await restoreLocalFinalizedReviewedHead(context, reviewedHeadSha);
  } catch (restoreError) {
    blockReason = [
      reason,
      `PullOps also failed to restore reviewed head ${reviewedHeadSha}: ${getErrorMessage(
        restoreError,
      )}`,
    ].join(' ');
  }

  return await blockLocalFinalizedRun(context, runRecord, preparation, blockReason);
}

/**
 * @param {OperationRunnerContext} context
 * @param {{ directory: string }} runRecord
 * @param {GitHubIssue} issue
 * @param {CompletedPrReviewOutput} reviewOutput
 * @returns {Promise<void>}
 */
async function commitLocalReviewChangesIfPresent(context, runRecord, issue, reviewOutput) {
  if (!(await context.gitClient.hasChanges())) {
    return;
  }

  await writePatchArtifactIfAvailable(context, runRecord);
  await context.gitClient.commitAll({
    message: createIssueImplementReviewCommitMessage(issue, reviewOutput),
    author: GITHUB_ACTIONS_BOT_AUTHOR,
  });
}

/**
 * @param {GitHubIssue} issue
 * @param {CompletedPrReviewOutput} reviewOutput
 * @returns {string}
 */
function createIssueImplementReviewCommitMessage(issue, reviewOutput) {
  return [
    `chore(review): apply local review improvements for #${issue.number}`,
    '',
    reviewOutput.directChanges.length === 0
      ? reviewOutput.summary
      : reviewOutput.directChanges.map(change => `- ${change}`).join('\n'),
    '',
    `Refs: #${issue.number}`,
  ].join('\n');
}

/**
 * @param {GitHubIssue} issue
 * @returns {string}
 */
function createIssueImplementReviewAddressCommitMessage(issue) {
  return [`fix(issue): address review for #${issue.number}`, '', `Refs: #${issue.number}`].join(
    '\n',
  );
}

/**
 * @param {OperationRunnerContext} context
 * @param {{ parentIssueNumber: number | undefined, baseBranch: string }} options
 * @returns {Promise<number | undefined>}
 */
async function readUmbrellaPullRequestNumber(context, { parentIssueNumber, baseBranch }) {
  if (parentIssueNumber === undefined) {
    return undefined;
  }

  return (await context.githubClient.findOpenPullRequestByHead(baseBranch))?.number;
}

/**
 * @param {GitHubIssue} issue
 * @param {number | undefined} [parentIssueNumber]
 * @returns {string}
 */
export function createIssueImplementCommitMessage(
  issue,
  parentIssueNumber = getParentIssueNumber(issue),
) {
  const footers = [`Refs: #${issue.number}`];
  if (parentIssueNumber !== undefined) {
    footers.push(`PRD: #${parentIssueNumber}`);
  }

  return [
    `feat(issue): implement #${issue.number}`,
    '',
    `Implement ${issue.title}.`,
    '',
    ...footers,
  ].join('\n');
}

/**
 * @param {OperationRunnerContext} context
 * @returns {asserts context is OperationRunnerContext & { target: { type: 'issue', number: number } }}
 */
function assertIssueTarget(context) {
  if (context.target.type !== 'issue') {
    throw new Error('issue-implement requires an issue target.');
  }
}

/**
 * @param {GitHubIssue} issue
 * @returns {boolean}
 */
function looksLikePrdIssue(issue) {
  return (
    issue.title.trim().toLowerCase().startsWith('prd:') ||
    (/^##\s+Problem Statement\s*$/im.test(issue.body) && /^##\s+Solution\s*$/im.test(issue.body))
  );
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubIssue} issue
 * @param {{ reason: string, summary?: string, humanRequired?: boolean }} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function blockIssue(context, issue, { reason, summary = reason, humanRequired = true }) {
  await writeFailureReason(context, reason);
  if (humanRequired) {
    await context.githubClient.addLabelsToIssue({
      number: issue.number,
      labels: [PULL_OPS_STATUS_LABELS.humanRequired],
    });
  }
  await context.githubClient.removeLabelsFromIssue({
    number: issue.number,
    labels: [
      PULL_OPS_OPERATION_LABELS.issueImplement,
      ...(humanRequired ? [] : [PULL_OPS_STATUS_LABELS.humanRequired]),
      PULL_OPS_STATUS_LABELS.inProgress,
      PULL_OPS_STATUS_LABELS.failed,
      PULL_OPS_STATUS_LABELS.prepared,
      PULL_OPS_STATUS_LABELS.done,
    ],
  });
  await context.githubClient.commentOnIssue({
    number: issue.number,
    body: [
      'PullOps could not complete `pullops run issue-implement`.',
      '',
      `Reason: ${reason}`,
    ].join('\n'),
  });

  return {
    status: 'blocked',
    summary,
    issue: issue.number,
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubIssue} issue
 * @returns {Promise<void>}
 */
async function markIssueInProgress(context, issue) {
  await context.githubClient.removeLabelsFromIssue({
    number: issue.number,
    labels: [
      PULL_OPS_STATUS_LABELS.humanRequired,
      PULL_OPS_STATUS_LABELS.blocked,
      PULL_OPS_STATUS_LABELS.failed,
      PULL_OPS_STATUS_LABELS.prepared,
      PULL_OPS_STATUS_LABELS.done,
    ],
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubIssue} issue
 * @param {string} reason
 * @returns {Promise<void>}
 */
async function recordIssueFailure(context, issue, reason) {
  await writeFailureReason(context, reason);
  await context.githubClient.addLabelsToIssue({
    number: issue.number,
    labels: [PULL_OPS_STATUS_LABELS.humanRequired],
  });
  await context.githubClient.removeLabelsFromIssue({
    number: issue.number,
    labels: [
      PULL_OPS_OPERATION_LABELS.issueImplement,
      PULL_OPS_STATUS_LABELS.inProgress,
      PULL_OPS_STATUS_LABELS.blocked,
      PULL_OPS_STATUS_LABELS.prepared,
      PULL_OPS_STATUS_LABELS.done,
    ],
  });
  await context.githubClient.commentOnIssue({
    number: issue.number,
    body: [
      'PullOps could not complete `pullops run issue-implement`.',
      '',
      `Reason: ${reason}`,
    ].join('\n'),
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubIssue} issue
 * @returns {Promise<void>}
 */
async function clearIssueTaskLabels(context, issue) {
  await context.githubClient.removeLabelsFromIssue({
    number: issue.number,
    labels: [
      PULL_OPS_OPERATION_LABELS.issueImplement,
      PULL_OPS_STATUS_LABELS.humanRequired,
      PULL_OPS_STATUS_LABELS.inProgress,
      PULL_OPS_STATUS_LABELS.blocked,
      PULL_OPS_STATUS_LABELS.prepared,
      PULL_OPS_STATUS_LABELS.failed,
      PULL_OPS_STATUS_LABELS.done,
    ],
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
 * @param {OperationRunnerContext} context
 * @param {{ operationReference: string, targetNumber: number, publicationMode?: 'dry-run' | 'publish' }} options
 * @returns {Promise<{ directory: string }>}
 */
async function createLocalRunRecord(
  context,
  { operationReference, targetNumber, publicationMode = 'dry-run' },
) {
  const normalizedReference = normalizeOperationReferenceForPath(operationReference);
  const timestamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', '');
  const directory = join(
    context.cwd,
    '.pullops',
    'runs',
    `${timestamp}-${normalizedReference}-${targetNumber}`,
  );

  await mkdir(directory, { recursive: true });
  await writeLocalRunArtifact(
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
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );

  return { directory };
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
 * @param {{ directory: string }} runRecord
 * @param {string} fileName
 * @param {string} contents
 * @returns {Promise<void>}
 */
async function writeLocalRunArtifact(runRecord, fileName, contents) {
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
 * @param {IssueImplementPreparation & { ready: true }} preparation
 * @returns {Promise<void>}
 */
async function fetchRemoteRefsForDryRun(context, preparation) {
  if (context.gitClient.fetchRemoteRefs === undefined) {
    throw new Error('Git client does not support local remote ref fetching.');
  }

  const requiredBranchNames =
    preparation.baseBranch === context.config.baseBranch
      ? [preparation.baseBranch]
      : [context.config.baseBranch];
  const optionalBranchNames =
    preparation.baseBranch === context.config.baseBranch
      ? [preparation.branchName]
      : [preparation.baseBranch, preparation.branchName];

  await context.gitClient.fetchRemoteRefs({
    requiredBranchNames,
    optionalBranchNames,
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {IssueImplementPreparation & { ready: true }} preparation
 * @returns {Promise<void>}
 */
async function checkoutPullOpsBranchForDryRun(context, preparation) {
  if (context.gitClient.checkoutPullOpsBranch === undefined) {
    throw new Error('Git client does not support local PullOps branch checkout.');
  }

  await context.gitClient.checkoutPullOpsBranch({
    branchName: preparation.branchName,
    baseBranch: preparation.baseBranch,
  });
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<string>}
 */
async function readCurrentBranch(context) {
  if (context.gitClient.getCurrentBranch === undefined) {
    throw new Error('Git client does not support reading the current local branch.');
  }

  return await context.gitClient.getCurrentBranch();
}

/**
 * @param {OperationRunnerContext} context
 * @param {IssueImplementPreparation & { ready: true }} preparation
 * @returns {Promise<import('../../git/types.js').GitCommit[]>}
 */
async function readLocalCommitsSinceBase(context, preparation) {
  if (context.gitClient.getCommitsSinceBase === undefined) {
    throw new Error('Git client does not support reading local commits since the base branch.');
  }

  return await context.gitClient.getCommitsSinceBase({
    baseBranch: preparation.baseBranch,
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {IssueImplementPreparation & { ready: true }} preparation
 * @returns {Promise<GitCommit[] | undefined>}
 */
async function readLocalCommitsSinceBaseIfAvailable(context, preparation) {
  if (context.gitClient.getCommitsSinceBase === undefined) {
    return undefined;
  }

  return await context.gitClient.getCommitsSinceBase({
    baseBranch: preparation.baseBranch,
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {{ directory: string }} runRecord
 * @param {{
 *   issue: GitHubIssue,
 *   prepared: IssueImplementPreparation & { ready: true },
 *   publicationMode: 'dry-run' | 'publish',
 * }} options
 * @returns {Promise<void>}
 */
async function writeIssueImplementLocalMetadata(
  context,
  runRecord,
  { issue, prepared, publicationMode },
) {
  await writeLocalRunArtifact(
    runRecord,
    'metadata.json',
    `${JSON.stringify(
      {
        operation: PULL_OPS_OPERATION_LABELS.issueImplement,
        operationReference: 'issue:implement',
        target: {
          type: 'issue',
          number: issue.number,
        },
        branch: prepared.branchName,
        baseBranch: prepared.baseBranch,
        publicationMode,
        runGoal: context.runGoal ?? 'operation',
        modelTier: context.modelTier,
        model: context.model,
      },
      null,
      2,
    )}\n`,
  );
}

/**
 * @param {OperationRunnerContext} context
 * @param {{ directory: string }} runRecord
 * @returns {Promise<void>}
 */
async function writePatchArtifactIfAvailable(context, runRecord) {
  if (context.gitClient.readWorkingTreePatch === undefined) {
    return;
  }

  const patch = await context.gitClient.readWorkingTreePatch();
  if (patch.trim() === '') {
    return;
  }

  await writeLocalRunArtifact(runRecord, 'working-tree.patch', patch);
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<string>}
 */
async function readWorkingTreePatchIfAvailable(context) {
  if (context.gitClient.readWorkingTreePatch === undefined) {
    return '(unavailable)';
  }

  const patch = await context.gitClient.readWorkingTreePatch();
  return patch.trim() === '' ? '(clean)' : patch.trimEnd();
}

/**
 * @param {GitHubIssue} issue
 * @returns {string}
 */
function formatLocalIssueContext(issue) {
  return [`Issue #${issue.number}: ${issue.title}`, issue.body.trim() || '(empty)'].join('\n');
}

/**
 * @param {{ operationReference: string, latestReviewOutput?: CompletedPrReviewOutput, reviewComments: unknown[] }} options
 * @returns {string}
 */
function formatLocalOperationSpecificContext({
  operationReference,
  latestReviewOutput,
  reviewComments,
}) {
  if (operationReference === 'pr:address-review') {
    return [
      'Actionable PR Feedback:',
      formatLocalAddressReviewFeedback(latestReviewOutput),
      '',
      'Review summaries:',
      formatLocalReviewSummaries(latestReviewOutput),
      '',
      'Unresolved review threads:',
      '(none; use the local feedback above and the local run record evidence files)',
    ].join('\n');
  }

  if (operationReference === 'pr:finalize') {
    return [
      'Pull request comments:',
      formatLocalReviewComments(reviewComments),
      '',
      'Review summaries:',
      '(see prior local follow-up evidence below for the full review/address-review cycle history)',
      '',
      'Unresolved review threads:',
      '(none; local finalized runs store follow-up evidence in the local run record)',
    ].join('\n');
  }

  return [
    'Pull request comments:',
    formatLocalReviewComments(reviewComments),
    '',
    'Review summaries:',
    '(none yet; use prior local evidence if this is a later review cycle)',
    '',
    'Unresolved review threads:',
    '(none; local finalized runs use the local run record instead of hosted review threads)',
  ].join('\n');
}

/**
 * @param {CompletedPrReviewOutput | undefined} reviewOutput
 * @returns {string}
 */
function formatLocalAddressReviewFeedback(reviewOutput) {
  if (reviewOutput === undefined) {
    return '(none)';
  }

  return createLocalReviewFeedbackItems(reviewOutput)
    .map(item =>
      [
        `- feedbackId \`${item.id}\``,
        `  Surface: ${item.surface}`,
        '  Author: PullOps local review',
        ...(item.location === undefined ? [] : [`  Location: ${item.location}`]),
        '  Body:',
        indent(item.body),
      ].join('\n'),
    )
    .join('\n');
}

/**
 * @param {CompletedPrReviewOutput | undefined} reviewOutput
 * @returns {string}
 */
function formatLocalReviewSummaries(reviewOutput) {
  if (reviewOutput === undefined) {
    return '(none)';
  }

  return `- ${reviewOutput.status}: ${reviewOutput.summary}`;
}

/**
 * @param {unknown[]} comments
 * @returns {string}
 */
function formatLocalReviewComments(comments) {
  if (comments.length === 0) {
    return '(none)';
  }

  return comments
    .map(comment => {
      if (
        comment !== null &&
        typeof comment === 'object' &&
        'path' in comment &&
        'line' in comment &&
        'body' in comment
      ) {
        return `- ${String(comment.path)}:${String(comment.line)} ${String(comment.body)}`;
      }

      return `- ${JSON.stringify(comment)}`;
    })
    .join('\n');
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
 * @param {GitCommit[] | undefined} commits
 * @returns {string}
 */
function formatLocalCommits(commits) {
  if (commits === undefined) {
    return '(unavailable)';
  }

  if (commits.length === 0) {
    return '(none)';
  }

  return commits
    .map(commit =>
      [
        `- ${commit.sha} ${commit.subject}`,
        `  Files: ${commit.files.length === 0 ? '(none)' : commit.files.join(', ')}`,
        '  Message:',
        indent(commit.body.trim() === '' ? '(empty)' : commit.body),
      ].join('\n'),
    )
    .join('\n');
}

/**
 * @param {{ directory: string }} runRecord
 * @param {{ operationReference: string, fileName: string, output: unknown }[]} evidence
 * @returns {string}
 */
function formatLocalFollowUpEvidence(runRecord, evidence) {
  if (evidence.length === 0) {
    return '(none yet)';
  }

  return evidence
    .map(entry =>
      [
        `- ${entry.operationReference}`,
        `  Evidence file: ${join(runRecord.directory, entry.fileName)}`,
        '  Output JSON:',
        indent(JSON.stringify(entry.output, null, 2)),
      ].join('\n'),
    )
    .join('\n');
}

/**
 * @param {CompletedPrReviewOutput} reviewOutput
 * @returns {{ id: string, surface: string, body: string, location?: string }[]}
 */
function createLocalReviewFeedbackItems(reviewOutput) {
  return [
    {
      id: 'local-review-summary:1',
      surface: 'local review summary',
      body: reviewOutput.summary,
    },
    ...reviewOutput.comments.map((comment, index) => ({
      id: `local-review-comment:${index + 1}`,
      surface: 'local inline review comment',
      location: `${comment.path}:${comment.line}`,
      body: comment.body,
    })),
  ];
}

/**
 * @param {CompletedPrReviewOutput} reviewOutput
 * @returns {string[]}
 */
function createLocalReviewFeedbackIds(reviewOutput) {
  return createLocalReviewFeedbackItems(reviewOutput).map(item => item.id);
}

/**
 * @param {{
 *   context: OperationRunnerContext,
 *   preparation: IssueImplementPreparation & { ready: true },
 *   rewriteResult: { headSha: string, treeHash: string },
 * }} options
 * @returns {{
 *   nextSteps: string[],
 *   record: {
 *     mode: 'await-hosted-checks',
 *     status: 'pending-publication' | 'pending-hosted-checks',
 *     operation: 'pr:fix-ci',
 *     finalizedHeadSha: string,
 *     finalizedTreeHash: string,
 *     branch: string,
 *     publicationMode: string,
 *     reason: string,
 *   },
 * }}
 */
function createLocalFinalizedCiFollowUp({ context, preparation, rewriteResult }) {
  const reason =
    'Local finalized runs cannot observe hosted checks for the finalized head before publication.';
  const status =
    context.publicationMode === 'publish' ? 'pending-hosted-checks' : 'pending-publication';

  return {
    nextSteps: [
      context.publicationMode === 'dry-run'
        ? '- Publish the finalized branch and ready PR when requested.'
        : '- PullOps published the finalized branch and ready PR.',
      '- Hosted CI must run after publication because the finalized head does not have a GitHub PR ref during local execution.',
      '- Failed hosted checks on the ready finalized PR should continue through `pr:fix-ci` automatically.',
    ],
    record: {
      mode: 'await-hosted-checks',
      status,
      operation: 'pr:fix-ci',
      finalizedHeadSha: rewriteResult.headSha,
      finalizedTreeHash: rewriteResult.treeHash,
      branch: preparation.branchName,
      publicationMode: context.publicationMode ?? 'dry-run',
      reason,
    },
  };
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
 * @param {{ directory: string }} runRecord
 * @param {GitHubIssue} issue
 * @param {BlockIssueDryRunOptions} options
 * @returns {Promise<IssueImplementPreparation>}
 */
async function blockIssueDryRun(
  runRecord,
  issue,
  { reason, summary = reason, branchName, baseBranch, publicationMode = 'dry-run' },
) {
  await writeLocalRunArtifact(runRecord, 'failure-reason.txt', `${reason}\n`);
  return {
    ready: false,
    output: {
      status: 'blocked',
      summary,
      issue: issue.number,
      branch: branchName,
      baseBranch,
      publicationMode,
      localRunRecord: runRecord.directory,
    },
  };
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
