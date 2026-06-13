import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createIssueBranchName, createParentBranchName } from '../branchNames.js';
import { getParentIssueNumber, isIssueDone, parseIssueDependencies } from '../issueDependencies.js';
import { validateImplementIssueOutput } from './output.js';
import { buildImplementIssuePrompt } from './prompt.js';
import { createImplementIssuePullRequestBody } from './prBody.js';

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('./output.js').ImplementedIssueOutput} ImplementedIssueOutput
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
  assertIssueTarget(context);

  const issue = await context.githubClient.getIssue(context.target.number);
  const parentIssueNumber = getParentIssueNumber(issue);

  if (issue.state !== 'OPEN') {
    return await blockIssue(context, issue, {
      reason: `Issue #${issue.number} is ${issue.state.toLowerCase()}. PullOps can only implement open issues.`,
    });
  }

  if (issue.subIssues.length > 0) {
    return await blockIssue(context, issue, {
      reason: [
        `Issue #${issue.number} is a Parent Issue with child issues.`,
        'Use pullops:prepare on the parent issue to create or update its umbrella branch and draft PR.',
        'PullOps will not implement child issues from pullops:implement.',
      ].join(' '),
    });
  }

  if (looksLikePrdIssue(issue)) {
    return await blockIssue(context, issue, {
      reason: [
        `Issue #${issue.number} looks like a Parent Issue or PRD.`,
        'Use pullops:prepare for parent setup, then label concrete child issues with pullops:implement.',
      ].join(' '),
    });
  }

  const blockingDependencies = await findBlockingDependencies(context, issue);
  if (blockingDependencies.length > 0) {
    return await blockIssue(context, issue, {
      reason: [
        `Issue #${issue.number} is blocked by unfinished dependencies:`,
        blockingDependencies.map(dependency => `#${dependency.number}`).join(', '),
      ].join(' '),
    });
  }

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

  const existingPullRequest = await context.githubClient.findOpenPullRequestByHead(branchName);
  if (existingPullRequest !== undefined) {
    await clearIssueTaskLabels(context, issue);
    return {
      status: 'accepted',
      summary: `An open PullOps implementation PR already exists for issue #${issue.number}: ${existingPullRequest.url}`,
      issue: issue.number,
      reason: `An open PullOps implementation PR already exists for issue #${issue.number}: ${existingPullRequest.url}`,
      existingPullRequest,
    };
  }

  let failureRecorded = false;

  try {
    await markIssueInProgress(context, issue);

    await context.gitClient.createBranch({
      branchName,
      baseBranch,
    });

    const rawOutput = await context.codexRunner.run({
      cwd: context.cwd,
      command: context.config.runner.command,
      model: context.model,
      prompt: buildImplementIssuePrompt({ issue, parentIssueNumber }),
    });
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
      labels: ['pullops:review'],
    });
    await context.githubClient.removeLabelsFromIssue({
      number: issue.number,
      labels: ['pullops:implement', 'pullops:in-progress', 'pullops:blocked', 'pullops:failed'],
    });
    await context.githubClient.addLabelsToIssue({
      number: issue.number,
      labels: ['pullops:done'],
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
    labels: ['pullops:blocked'],
  });
  await context.githubClient.removeLabelsFromIssue({
    number: issue.number,
    labels: ['pullops:implement', 'pullops:in-progress', 'pullops:failed', 'pullops:done'],
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
    labels: ['pullops:in-progress'],
  });
  await context.githubClient.removeLabelsFromIssue({
    number: issue.number,
    labels: ['pullops:blocked', 'pullops:failed', 'pullops:done'],
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
    labels: ['pullops:failed'],
  });
  await context.githubClient.removeLabelsFromIssue({
    number: issue.number,
    labels: ['pullops:implement', 'pullops:in-progress', 'pullops:blocked', 'pullops:done'],
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
    labels: ['pullops:implement', 'pullops:in-progress', 'pullops:blocked', 'pullops:failed'],
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
