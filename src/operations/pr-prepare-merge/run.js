import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  PULL_OPS_OPERATION_LABELS,
  PULL_OPS_STATUS_LABEL_NAMES,
  PULL_OPS_STATUS_LABELS,
} from '../../labels/pullOpsLabels.js';
import {
  createSkippedCodexActionOutput,
  getCodexActionFiles,
  readCodexActionOutput,
  writeCodexActionPrompt,
} from '../codexAction.js';
import { readPullOpsPullRequestState } from '../pr-review/prBody.js';
import { validatePrPrepareMergeOutput } from './output.js';
import { buildPrPrepareMergePrompt } from './prompt.js';
import {
  updatePullRequestBodyForPrPrepareMerge,
  updatePullRequestBodyForPrPrepareMergeFailure,
} from './prBody.js';

/**
 * @typedef {import('../../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('../../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('../../github/types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('../../github/types.js').GitHubPullRequestReviewContext} GitHubPullRequestReviewContext
 * @typedef {import('../../github/types.js').GitHubPullRequestDiff} GitHubPullRequestDiff
 * @typedef {import('./output.types.js').PlannedPrPrepareMergeOutput} PlannedPrPrepareMergeOutput
 * @typedef {import('./output.types.js').PlannedCommit} PlannedCommit
 * @typedef {import('./run.types.js').PrPrepareMergePreparation} PrPrepareMergePreparation
 */

export const GITHUB_ACTIONS_BOT_AUTHOR = {
  name: 'github-actions[bot]',
  email: '41898282+github-actions[bot]@users.noreply.github.com',
};

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runPrPrepareMerge(context) {
  const preparation = await preparePrPrepareMerge(context);
  if (!preparation.ready) {
    return preparation.output;
  }

  let rawOutput;

  try {
    rawOutput = await context.codexRunner.run({
      cwd: context.cwd,
      command: context.config.runner.command,
      model: context.model,
      prompt: buildPrPrepareMergePrompt({
        pullRequest: preparation.pullRequest,
        issue: preparation.issue,
        sourceKind: preparation.sourceKind,
        reviewContext: preparation.reviewContext,
        diff: preparation.diff,
        changedFiles: preparation.changedFiles,
      }),
    });
  } catch (error) {
    await recordPullRequestFailure(context, preparation.pullRequest, getErrorMessage(error));
    throw error;
  }

  return await finalizePreparedPrPrepareMerge(context, preparation, rawOutput);
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runPrPrepareMergeCodexActionPrepare(context) {
  const preparation = await preparePrPrepareMerge(context);
  if (!preparation.ready) {
    return preparation.output;
  }

  try {
    await writeCodexActionPrompt(
      context,
      buildPrPrepareMergePrompt({
        pullRequest: preparation.pullRequest,
        issue: preparation.issue,
        sourceKind: preparation.sourceKind,
        reviewContext: preparation.reviewContext,
        diff: preparation.diff,
        changedFiles: preparation.changedFiles,
      }),
    );
  } catch (error) {
    await recordPullRequestFailure(context, preparation.pullRequest, getErrorMessage(error));
    throw error;
  }

  const files = getCodexActionFiles(context);
  return {
    status: 'accepted',
    summary: `Prepared Codex Action pr-prepare-merge run for PR #${preparation.pullRequest.number}.`,
    pullRequest: {
      number: preparation.pullRequest.number,
      url: preparation.pullRequest.url,
    },
    changedFiles: preparation.changedFiles.length,
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
export async function runPrPrepareMergeCodexActionFinalize(context) {
  if (context.runnerRan === false) {
    return createSkippedCodexActionOutput(context);
  }

  const preparation = await preparePrPrepareMerge(context);
  if (!preparation.ready) {
    return preparation.output;
  }

  let rawOutput;

  try {
    rawOutput = await readCodexActionOutput(context);
  } catch (error) {
    await recordPullRequestFailure(context, preparation.pullRequest, getErrorMessage(error));
    throw error;
  }

  return await finalizePreparedPrPrepareMerge(context, preparation, rawOutput);
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<PrPrepareMergePreparation>}
 */
async function preparePrPrepareMerge(context) {
  assertPullRequestTarget(context);

  const pullRequest = await context.githubClient.getPullRequest(context.target.number);
  const state = readPullOpsPullRequestState(pullRequest.body);

  if (pullRequest.isCrossRepository === true) {
    return {
      ready: false,
      output: await refusePullRequest(
        context,
        pullRequest,
        `PullOps v1 only prepares same-repository PRs for merge. PR #${pullRequest.number} comes from a fork.`,
        { updateBody: state.managed },
      ),
    };
  }

  if (!state.managed) {
    return {
      ready: false,
      output: await refusePullRequest(
        context,
        pullRequest,
        `PR #${pullRequest.number} is not a PullOps-managed PR.`,
        { updateBody: false },
      ),
    };
  }

  if (!hasPullOpsBranchPrefix(pullRequest.headRefName, context.config.branchPrefix)) {
    return {
      ready: false,
      output: await refusePullRequest(
        context,
        pullRequest,
        `PR #${pullRequest.number} head branch "${pullRequest.headRefName}" does not use the configured PullOps branch prefix.`,
        { updateBody: true },
      ),
    };
  }

  if (state.sourceIssueNumber === undefined || state.sourceKind === undefined) {
    return {
      ready: false,
      output: await refusePullRequest(
        context,
        pullRequest,
        `PR #${pullRequest.number} does not include a structured Source: Issue #<number> or Source: Parent Issue #<number> line.`,
        { updateBody: true },
      ),
    };
  }

  const baseBranch = pullRequest.baseRefName ?? context.config.baseBranch;
  let changedFiles;

  try {
    changedFiles = await context.gitClient.getChangedFilesSinceBase({ baseBranch });
  } catch (error) {
    await recordPullRequestFailure(context, pullRequest, getErrorMessage(error));
    throw error;
  }

  if (changedFiles.length === 0) {
    return {
      ready: false,
      output: await refusePullRequest(
        context,
        pullRequest,
        `PR #${pullRequest.number} has no changed files to include in a Commit Plan.`,
        { updateBody: true },
      ),
    };
  }

  const issue = await context.githubClient.getIssue(state.sourceIssueNumber);
  const reviewContext = await context.githubClient.getPullRequestReviewContext(pullRequest.number);
  const diff = await context.githubClient.getPullRequestDiff(pullRequest.number);

  return {
    ready: true,
    pullRequest,
    issue,
    sourceKind: state.sourceKind,
    sourceIssueNumber: state.sourceIssueNumber,
    baseBranch,
    reviewContext,
    diff,
    changedFiles,
  };
}

/**
 * @param {OperationRunnerContext} context
 * @param {PrPrepareMergePreparation & { ready: true }} preparation
 * @param {unknown} rawOutput
 * @returns {Promise<Record<string, unknown>>}
 */
async function finalizePreparedPrPrepareMerge(context, preparation, rawOutput) {
  const { pullRequest, changedFiles, sourceKind, sourceIssueNumber, baseBranch } = preparation;
  let failureRecorded = false;

  try {
    const validatedOutput = validatePrPrepareMergeOutput(rawOutput);

    if (!validatedOutput.valid) {
      const reason = `Invalid Prepare Merge Output: ${validatedOutput.reason}`;
      failureRecorded = true;
      await recordPullRequestFailure(context, pullRequest, reason);
      throw new Error(reason);
    }

    if (validatedOutput.value.status === 'blocked') {
      failureRecorded = true;
      await recordPullRequestFailure(context, pullRequest, validatedOutput.value.failureReason);
      return {
        status: 'blocked',
        summary: validatedOutput.value.summary,
        pullRequest: {
          number: pullRequest.number,
          url: pullRequest.url,
        },
      };
    }

    const planValidation = validateCommitPlan({
      output: validatedOutput.value,
      changedFiles,
      sourceKind,
      sourceIssueNumber,
    });
    if (!planValidation.valid) {
      const reason = `Invalid Commit Plan: ${planValidation.reason}`;
      failureRecorded = true;
      await recordPullRequestFailure(context, pullRequest, reason);
      throw new Error(reason);
    }

    const commits = validatedOutput.value.commitPlan.commits.map(commit => ({
      message: createPrPrepareMergeCommitMessage(commit),
      files: commit.files,
    }));

    await context.gitClient.rewriteBranchWithCommitPlan({
      baseBranch,
      branchName: pullRequest.headRefName,
      commits,
      author: GITHUB_ACTIONS_BOT_AUTHOR,
    });
    await context.githubClient.updatePullRequestBody({
      number: pullRequest.number,
      body: updatePullRequestBodyForPrPrepareMerge({
        body: pullRequest.body,
        pullRequest: validatedOutput.value.pullRequest,
      }),
    });
    await transitionPullRequestLabelsToReview(context, pullRequest);

    return {
      status: 'accepted',
      summary: `Prepared PullOps-managed PR #${pullRequest.number} for final review.`,
      pullRequest: {
        number: pullRequest.number,
        url: pullRequest.url,
      },
      prPrepareMerge: {
        commits: commits.length,
        changedFiles: changedFiles.length,
      },
    };
  } catch (error) {
    if (!failureRecorded) {
      await recordPullRequestFailure(context, pullRequest, getErrorMessage(error));
    }

    throw error;
  }
}

/**
 * @param {PlannedCommit} commit
 * @returns {string}
 */
export function createPrPrepareMergeCommitMessage(commit) {
  return [
    commit.header,
    ...(commit.body.length === 0 ? [] : ['', ...commit.body]),
    '',
    ...commit.footers,
  ].join('\n');
}

/**
 * @param {object} options
 * @param {PlannedPrPrepareMergeOutput} options.output
 * @param {string[]} options.changedFiles
 * @param {'issue' | 'parentIssue'} options.sourceKind
 * @param {number} options.sourceIssueNumber
 * @returns {{ valid: true } | { valid: false, reason: string }}
 */
function validateCommitPlan({ output, changedFiles, sourceKind, sourceIssueNumber }) {
  if (
    sourceKind === 'issue' &&
    output.commitPlan.commits.length > 1 &&
    output.commitPlan.justification === undefined
  ) {
    return {
      valid: false,
      reason: 'Concrete Issue PRs with multiple commits must include commitPlan.justification.',
    };
  }

  for (const [index, commit] of output.commitPlan.commits.entries()) {
    const commitPath = `commitPlan.commits[${index}]`;
    if (!isConventionalCommitHeader(commit.header)) {
      return {
        valid: false,
        reason: `${commitPath}.header must be a conventional commit header.`,
      };
    }

    const traceability = validateCommitTraceability(commit, {
      sourceKind,
      sourceIssueNumber,
      commitPath,
    });
    if (!traceability.valid) {
      return traceability;
    }
  }

  const coverage = validateChangedFileCoverage(output.commitPlan.commits, changedFiles);
  if (!coverage.valid) {
    return coverage;
  }

  const pullRequestTraceability = validatePullRequestTraceability(output, {
    sourceIssueNumber,
  });
  if (!pullRequestTraceability.valid) {
    return pullRequestTraceability;
  }

  return { valid: true };
}

/**
 * @param {PlannedCommit} commit
 * @param {{ sourceKind: 'issue' | 'parentIssue', sourceIssueNumber: number, commitPath: string }} options
 * @returns {{ valid: true } | { valid: false, reason: string }}
 */
function validateCommitTraceability(commit, { sourceKind, sourceIssueNumber, commitPath }) {
  if (sourceKind === 'parentIssue') {
    if (!commit.footers.some(footer => footer === `PRD: #${sourceIssueNumber}`)) {
      return {
        valid: false,
        reason: `${commitPath}.footers must include PRD: #${sourceIssueNumber}.`,
      };
    }

    if (!commit.footers.some(footer => /^Refs: #\d+$/.test(footer))) {
      return {
        valid: false,
        reason: `${commitPath}.footers must include a Refs: #<child-issue> footer.`,
      };
    }

    return { valid: true };
  }

  if (!commit.footers.some(footer => footer === `Refs: #${sourceIssueNumber}`)) {
    return {
      valid: false,
      reason: `${commitPath}.footers must include Refs: #${sourceIssueNumber}.`,
    };
  }

  return { valid: true };
}

/**
 * @param {PlannedCommit[]} commits
 * @param {string[]} changedFiles
 * @returns {{ valid: true } | { valid: false, reason: string }}
 */
function validateChangedFileCoverage(commits, changedFiles) {
  const changed = new Set(changedFiles);
  const planned = new Set();

  for (const commit of commits) {
    for (const file of commit.files) {
      if (planned.has(file)) {
        return {
          valid: false,
          reason: `Changed file "${file}" is assigned to more than one planned commit.`,
        };
      }

      planned.add(file);
    }
  }

  const unknown = [...planned].filter(file => !changed.has(file));
  if (unknown.length > 0) {
    return {
      valid: false,
      reason: `Commit Plan references files that are not changed in the PR: ${unknown.join(', ')}.`,
    };
  }

  const missing = changedFiles.filter(file => !planned.has(file));
  if (missing.length > 0) {
    return {
      valid: false,
      reason: `Commit Plan does not assign every changed file: ${missing.join(', ')}.`,
    };
  }

  return { valid: true };
}

/**
 * @param {PlannedPrPrepareMergeOutput} output
 * @param {{ sourceIssueNumber: number }} options
 * @returns {{ valid: true } | { valid: false, reason: string }}
 */
function validatePullRequestTraceability(output, { sourceIssueNumber }) {
  const expected = `Closes #${sourceIssueNumber}`;

  if (!output.pullRequest.traceability.includes(expected)) {
    return {
      valid: false,
      reason: `pullRequest.traceability must include ${expected}.`,
    };
  }

  return { valid: true };
}

/**
 * @param {string} header
 * @returns {boolean}
 */
function isConventionalCommitHeader(header) {
  return /^(build|chore|ci|docs|feat|fix|perf|refactor|style|test)(\([a-z0-9._-]+\))?!?: .+/.test(
    header,
  );
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @returns {Promise<void>}
 */
async function transitionPullRequestLabelsToReview(context, pullRequest) {
  await context.githubClient.removeLabelsFromPullRequest({
    number: pullRequest.number,
    labels: [PULL_OPS_OPERATION_LABELS.prPrepareMerge, ...PULL_OPS_STATUS_LABEL_NAMES],
  });

  await context.githubClient.addLabelsToPullRequest({
    number: pullRequest.number,
    labels: [PULL_OPS_OPERATION_LABELS.prReview],
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {GitHubPullRequest} pullRequest
 * @param {string} reason
 * @param {{ updateBody: boolean }} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function refusePullRequest(context, pullRequest, reason, { updateBody }) {
  await recordPullRequestFailure(context, pullRequest, reason, { updateBody });

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
 * @param {{ updateBody?: boolean }} [options]
 * @returns {Promise<void>}
 */
async function recordPullRequestFailure(context, pullRequest, reason, { updateBody = true } = {}) {
  await writeFailureReason(context, reason);

  if (updateBody) {
    await context.githubClient.updatePullRequestBody({
      number: pullRequest.number,
      body: updatePullRequestBodyForPrPrepareMergeFailure({
        body: pullRequest.body,
      }),
    });
  }

  await context.githubClient.addLabelsToPullRequest({
    number: pullRequest.number,
    labels: [PULL_OPS_STATUS_LABELS.blocked],
  });
  await context.githubClient.removeLabelsFromPullRequest({
    number: pullRequest.number,
    labels: [
      PULL_OPS_OPERATION_LABELS.prPrepareMerge,
      PULL_OPS_STATUS_LABELS.inProgress,
      PULL_OPS_STATUS_LABELS.failed,
      PULL_OPS_STATUS_LABELS.prepared,
      PULL_OPS_STATUS_LABELS.done,
    ],
  });
  await context.githubClient.commentOnPullRequest({
    number: pullRequest.number,
    body: [
      'PullOps could not complete `pullops run pr-prepare-merge`.',
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
 * @param {string} branchName
 * @param {string} branchPrefix
 * @returns {boolean}
 */
function hasPullOpsBranchPrefix(branchName, branchPrefix) {
  const normalizedPrefix =
    branchPrefix
      .split('/')
      .map(part => part.trim())
      .filter(Boolean)
      .join('/') || 'pullops';
  return branchName === normalizedPrefix || branchName.startsWith(`${normalizedPrefix}/`);
}

/**
 * @param {OperationRunnerContext} context
 * @returns {asserts context is OperationRunnerContext & { target: { type: 'pr', number: number } }}
 */
function assertPullRequestTarget(context) {
  if (context.target.type !== 'pr') {
    throw new Error('pr-prepare-merge requires a pull request target.');
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
