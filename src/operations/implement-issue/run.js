import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PULL_OPS_OPERATION_LABELS, PULL_OPS_STATUS_LABELS } from '../../labels/pullOpsLabels.js';
import {
  createSkippedCodexActionOutput,
  getCodexActionFiles,
  readCodexActionOutput,
  writeCodexActionPrompt,
} from '../codexAction.js';
import { createIssueBranchName, createParentBranchName } from '../branchNames.js';
import { getParentIssueNumber, isIssueDone, parseIssueDependencies } from '../issueDependencies.js';
import { validateImplementIssueOutput } from './output.js';
import { buildImplementIssuePrompt } from './prompt.js';
import { createImplementIssuePullRequestBody } from './prBody.js';

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('./output.js').ImplementedIssueOutput} ImplementedIssueOutput
 * @typedef {{ ready: false, output: Record<string, unknown> } | {
 *   ready: true;
 *   issue: GitHubIssue;
 *   parentIssueNumber?: number;
 *   branchName: string;
 *   baseBranch: string;
 * }} ImplementIssuePreparation
 */

export const GITHUB_ACTIONS_BOT_AUTHOR = {
  name: 'github-actions[bot]',
  email: '41898282+github-actions[bot]@users.noreply.github.com',
};

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runImplementIssue(context) {
  const preparation = await prepareImplementIssue(context);
  if (!preparation.ready) {
    return preparation.output;
  }

  let rawOutput;

  try {
    rawOutput = await context.codexRunner.run({
      cwd: context.cwd,
      command: context.config.runner.command,
      model: context.model,
      prompt: buildImplementIssuePrompt({
        issue: preparation.issue,
        parentIssueNumber: preparation.parentIssueNumber,
      }),
    });
  } catch (error) {
    await recordIssueFailure(context, preparation.issue, getErrorMessage(error));
    throw error;
  }

  return await finalizePreparedImplementIssue(context, preparation, rawOutput);
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runImplementIssueCodexActionPrepare(context) {
  const preparation = await prepareImplementIssue(context);
  if (!preparation.ready) {
    return preparation.output;
  }

  try {
    await writeCodexActionPrompt(
      context,
      buildImplementIssuePrompt({
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
export async function runImplementIssueCodexActionFinalize(context) {
  if (context.runnerRan === false) {
    return createSkippedCodexActionOutput(context);
  }

  const preparation = await readPreparedImplementIssue(context);
  let rawOutput;

  try {
    rawOutput = await readCodexActionOutput(context);
  } catch (error) {
    await recordIssueFailure(context, preparation.issue, getErrorMessage(error));
    throw error;
  }

  return await finalizePreparedImplementIssue(context, preparation, rawOutput);
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<ImplementIssuePreparation>}
 */
async function prepareImplementIssue(context) {
  assertIssueTarget(context);

  const issue = await context.githubClient.getIssue(context.target.number);

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
            `Use ${PULL_OPS_OPERATION_LABELS.preparePrd} on the parent issue`,
            'to create or update its umbrella branch and draft PR.',
          ].join(' '),
          `PullOps will not implement child issues from ${PULL_OPS_OPERATION_LABELS.implementIssue}.`,
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
            `Use ${PULL_OPS_OPERATION_LABELS.preparePrd} for parent setup,`,
            `then label concrete child issues with ${PULL_OPS_OPERATION_LABELS.implementIssue}.`,
          ].join(' '),
        ].join(' '),
      }),
    };
  }

  const blockingDependencies = await findBlockingDependencies(context, issue);
  if (blockingDependencies.length > 0) {
    return {
      ready: false,
      output: await blockIssue(context, issue, {
        reason: [
          `Issue #${issue.number} is blocked by unfinished dependencies:`,
          blockingDependencies.map(dependency => `#${dependency.number}`).join(', '),
        ].join(' '),
      }),
    };
  }

  const prepared = buildPreparedImplementIssue(context, issue);

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
 * @returns {Promise<ImplementIssuePreparation & { ready: true }>}
 */
async function readPreparedImplementIssue(context) {
  assertIssueTarget(context);
  const issue = await context.githubClient.getIssue(context.target.number);
  return buildPreparedImplementIssue(context, issue);
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubIssue} issue
 * @returns {ImplementIssuePreparation & { ready: true }}
 */
function buildPreparedImplementIssue(context, issue) {
  const parentIssueNumber = getParentIssueNumber(issue);
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
    ready: true,
    issue,
    parentIssueNumber,
    branchName,
    baseBranch,
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {ImplementIssuePreparation & { ready: true }} preparation
 * @param {unknown} rawOutput
 * @returns {Promise<Record<string, unknown>>}
 */
async function finalizePreparedImplementIssue(context, preparation, rawOutput) {
  const { issue, parentIssueNumber, branchName, baseBranch } = preparation;
  let failureRecorded = false;

  try {
    const validatedOutput = validateImplementIssueOutput(rawOutput);

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
      message: createImplementIssueCommitMessage(issue, parentIssueNumber),
      author: GITHUB_ACTIONS_BOT_AUTHOR,
    });
    await context.gitClient.pushBranch({ branchName });

    const pullRequestBody = createImplementIssuePullRequestBody({
      issue,
      output: validatedOutput.value,
      branchName,
      parentIssueNumber,
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
      labels: [PULL_OPS_OPERATION_LABELS.reviewPr],
    });
    await context.githubClient.removeLabelsFromIssue({
      number: issue.number,
      labels: [
        PULL_OPS_OPERATION_LABELS.implementIssue,
        PULL_OPS_STATUS_LABELS.inProgress,
        PULL_OPS_STATUS_LABELS.blocked,
        PULL_OPS_STATUS_LABELS.prepared,
        PULL_OPS_STATUS_LABELS.failed,
      ],
    });
    await context.githubClient.addLabelsToIssue({
      number: issue.number,
      labels: [PULL_OPS_STATUS_LABELS.done],
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
 * @param {GitHubIssue} issue
 * @param {number | undefined} [parentIssueNumber]
 * @returns {string}
 */
export function createImplementIssueCommitMessage(
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
 * @param {GitHubIssue} issue
 * @returns {Promise<GitHubIssue[]>}
 */
async function findBlockingDependencies(context, issue) {
  const dependencyNumbers = parseIssueDependencies(issue.body).blockedBy;
  /** @type {GitHubIssue[]} */
  const blockingDependencies = [];

  for (const dependencyNumber of dependencyNumbers) {
    const dependency = await context.githubClient.getIssue(dependencyNumber);
    if (!isIssueDone(dependency)) {
      blockingDependencies.push(dependency);
    }
  }

  return blockingDependencies;
}

/**
 * @param {OperationRunnerContext} context
 * @returns {asserts context is OperationRunnerContext & { target: { type: 'issue', number: number } }}
 */
function assertIssueTarget(context) {
  if (context.target.type !== 'issue') {
    throw new Error('implement-issue requires an issue target.');
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
 * @param {{ reason: string, summary?: string }} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function blockIssue(context, issue, { reason, summary = reason }) {
  await writeFailureReason(context, reason);
  await context.githubClient.addLabelsToIssue({
    number: issue.number,
    labels: [PULL_OPS_STATUS_LABELS.blocked],
  });
  await context.githubClient.removeLabelsFromIssue({
    number: issue.number,
    labels: [
      PULL_OPS_OPERATION_LABELS.implementIssue,
      PULL_OPS_STATUS_LABELS.inProgress,
      PULL_OPS_STATUS_LABELS.failed,
      PULL_OPS_STATUS_LABELS.prepared,
      PULL_OPS_STATUS_LABELS.done,
    ],
  });
  await context.githubClient.commentOnIssue({
    number: issue.number,
    body: [
      'PullOps could not complete `pullops run implement-issue`.',
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
  await context.githubClient.addLabelsToIssue({
    number: issue.number,
    labels: [PULL_OPS_STATUS_LABELS.inProgress],
  });
  await context.githubClient.removeLabelsFromIssue({
    number: issue.number,
    labels: [
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
    labels: [PULL_OPS_STATUS_LABELS.failed],
  });
  await context.githubClient.removeLabelsFromIssue({
    number: issue.number,
    labels: [
      PULL_OPS_OPERATION_LABELS.implementIssue,
      PULL_OPS_STATUS_LABELS.inProgress,
      PULL_OPS_STATUS_LABELS.blocked,
      PULL_OPS_STATUS_LABELS.prepared,
      PULL_OPS_STATUS_LABELS.done,
    ],
  });
  await context.githubClient.commentOnIssue({
    number: issue.number,
    body: [
      'PullOps could not complete `pullops run implement-issue`.',
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
      PULL_OPS_OPERATION_LABELS.implementIssue,
      PULL_OPS_STATUS_LABELS.inProgress,
      PULL_OPS_STATUS_LABELS.blocked,
      PULL_OPS_STATUS_LABELS.prepared,
      PULL_OPS_STATUS_LABELS.failed,
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
