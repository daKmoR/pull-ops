import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PULL_OPS_OPERATION_LABELS, PULL_OPS_STATUS_LABELS } from '../../labels/pullOpsLabels.js';
import {
  readBlockingDependencies,
  readIssueWorkTarget,
} from '../../prd-automation/childCoordination.js';
import { createOperationAuditComment } from '../auditComment.js';
import {
  createSkippedCodexActionOutput,
  getCodexActionFiles,
  readCodexActionOutput,
  writeCodexActionPrompt,
} from '../codexAction.js';
import { GITHUB_ACTIONS_BOT_AUTHOR } from '../githubActionsBot.js';
import { getParentIssueNumber } from '../issueDependencies.js';
import { validateIssueImplementOutput } from './output.js';
import { buildIssueImplementPrompt } from './prompt.js';
import { createIssueImplementPullRequestBody } from './prBody.js';

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('./output.types.js').ImplementedIssueOutput} ImplementedIssueOutput
 * @typedef {import('./run.types.js').IssueImplementPreparation} IssueImplementPreparation
 */

export { GITHUB_ACTIONS_BOT_AUTHOR } from '../githubActionsBot.js';

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runIssueImplement(context) {
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
    await context.githubClient.commentOnPullRequest({
      number: pullRequest.number,
      body: createOperationAuditComment(context, {
        operation: PULL_OPS_OPERATION_LABELS.issueImplement,
      }),
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
 * @param {unknown} error
 * @returns {string}
 */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
