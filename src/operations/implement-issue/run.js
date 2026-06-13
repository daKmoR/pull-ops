import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createImplementIssueBranchName } from './branch.js';
import { validateImplementIssueOutput } from './output.js';
import { buildImplementIssuePrompt } from './prompt.js';
import { createImplementIssuePullRequestBody } from './prBody.js';

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('../../github/types.js').GitHubPullRequest} GitHubPullRequest
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

  if (issue.state !== 'OPEN') {
    return await refuseIssue(context, issue, {
      reason: `Issue #${issue.number} is ${issue.state.toLowerCase()}. PullOps can only implement open issues.`,
    });
  }

  if (issue.subIssues.length > 0) {
    return await refuseIssue(context, issue, {
      reason: [
        `Issue #${issue.number} is a PRD Issue with native GitHub sub-issues.`,
        'Native PRD implementation is not wired yet, so PullOps will not treat it as a Leaf Issue.',
      ].join(' '),
    });
  }

  if (looksLikePrdIssue(issue)) {
    return await refuseIssue(context, issue, {
      reason: [
        `Issue #${issue.number} looks like a PRD Issue but has no native GitHub sub-issues.`,
        'Add native GitHub sub-issues before labeling the PRD with pullops:implement, or label an open Leaf Issue directly.',
      ].join(' '),
    });
  }

  const branchName = createImplementIssueBranchName({
    branchPrefix: context.config.branchPrefix,
    issueNumber: issue.number,
  });

  const existingPullRequest = await context.githubClient.findOpenPullRequestByHead(branchName);
  if (existingPullRequest !== undefined) {
    return await refuseIssue(context, issue, {
      reason: `An open PullOps implementation PR already exists for issue #${issue.number}: ${existingPullRequest.url}`,
      existingPullRequest,
    });
  }

  let failureRecorded = false;

  try {
    await context.gitClient.createBranch({
      branchName,
      baseBranch: context.config.baseBranch,
    });

    const rawOutput = await context.codexRunner.run({
      cwd: context.cwd,
      command: context.config.runner.command,
      model: context.model,
      prompt: buildImplementIssuePrompt({ issue }),
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
      await recordIssueFailure(context, issue, validatedOutput.value.failureReason);
      return {
        status: 'blocked',
        summary: validatedOutput.value.summary,
        issue: issue.number,
      };
    }

    await markIssueInProgress(context, issue);

    if (!(await context.gitClient.hasChanges())) {
      const reason = 'Codex runner completed but did not leave any working tree changes to commit.';
      failureRecorded = true;
      await recordIssueFailure(context, issue, reason);
      throw new Error(reason);
    }

    await context.gitClient.commitAll({
      message: createImplementIssueCommitMessage(issue),
      author: GITHUB_ACTIONS_BOT_AUTHOR,
    });
    await context.gitClient.pushBranch({ branchName });

    const pullRequestBody = createImplementIssuePullRequestBody({
      issue,
      output: validatedOutput.value,
      branchName,
      triggerActor: context.triggerActor,
      modelTier: context.modelTier,
      model: context.model,
    });
    const pullRequest = await context.githubClient.createDraftPullRequest({
      title: `Implement #${issue.number}: ${issue.title}`,
      body: pullRequestBody,
      baseBranch: context.config.baseBranch,
      headBranch: branchName,
    });

    await context.githubClient.addLabelsToPullRequest({
      number: pullRequest.number,
      labels: ['pullops:review'],
    });
    await context.githubClient.removeLabelsFromIssue({
      number: issue.number,
      labels: ['pullops:implement', 'pullops:in-progress', 'pullops:blocked'],
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
 * @returns {string}
 */
export function createImplementIssueCommitMessage(issue) {
  const footers = [`Refs: #${issue.number}`];
  if (issue.parent !== null) {
    footers.push(`PRD: #${issue.parent.number}`);
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
 * @param {{ reason: string, existingPullRequest?: GitHubPullRequest }} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function refuseIssue(context, issue, { reason, existingPullRequest }) {
  await recordIssueFailure(context, issue, reason);

  return {
    status: 'refused',
    summary: reason,
    issue: issue.number,
    existingPullRequest:
      existingPullRequest === undefined
        ? undefined
        : {
            number: existingPullRequest.number,
            url: existingPullRequest.url,
          },
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
    labels: ['pullops:blocked'],
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
    labels: ['pullops:blocked'],
  });
  await context.githubClient.removeLabelsFromIssue({
    number: issue.number,
    labels: ['pullops:implement', 'pullops:in-progress'],
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
