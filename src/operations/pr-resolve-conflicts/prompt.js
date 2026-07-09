/**
 * @typedef {import('../../git/types.js').GitConflictContext} GitConflictContext
 * @typedef {import('../../git/types.js').GitConflictFile} GitConflictFile
 * @typedef {import('../../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('../../github/types.js').GitHubPullRequest} GitHubPullRequest
 */

/**
 * @param {object} options
 * @param {GitHubPullRequest} options.pullRequest
 * @param {GitHubIssue | undefined} options.issue
 * @param {GitConflictContext} options.conflictContext
 * @param {number} options.pass
 * @param {number} options.maxPasses
 * @returns {string}
 */
export function buildPrResolveConflictsPrompt({
  pullRequest,
  issue,
  conflictContext,
  pass,
  maxPasses,
}) {
  return [
    'Use the pullops-resolve-conflicts skill.',
    '',
    `Goal: resolve the rebase conflicts on PR #${pullRequest.number} so the branch preserves the linked issue intent and both sides of the rebase: ${pullRequest.title}`,
    '',
    'Linked issue or Spec context:',
    formatIssue(issue),
    '',
    'Pull request body:',
    pullRequest.body.trim() || '(empty)',
    '',
    'Rebase state:',
    `- Branch: ${conflictContext.branchName}`,
    `- Base branch: ${conflictContext.baseBranch}`,
    `- Conflict pass: ${pass} / ${maxPasses}`,
    ...formatOptionalMetadata(conflictContext),
    '',
    'Conflicted files:',
    formatConflictedFiles(conflictContext.conflictedFiles),
    '',
    'Boundaries:',
    '- Edit the real conflicted files in this checkout and remove every Git conflict marker; do not describe a patch without applying it.',
    '- Run focused verification when the repository state allows it.',
    '- Do not stage files, create commits, push, edit labels, update the PR body, or post GitHub comments; PullOps will continue the rebase and push after validating your output.',
    '',
    'Final response must be only JSON in this shape:',
    JSON.stringify(
      {
        status: 'resolved',
        summary: 'One sentence summary of the conflict resolution.',
        resolvedFiles: ['path/to/conflicted-file.js'],
        changes: ['Specific conflict resolution change made.'],
        testPlan: ['Command or manual check that was run.'],
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
        failureReason: 'Specific reason the conflicts could not be safely resolved.',
      },
      null,
      2,
    ),
  ].join('\n');
}

/**
 * @param {GitHubIssue | undefined} issue
 * @returns {string}
 */
function formatIssue(issue) {
  if (issue === undefined) {
    return '(none supplied; this is an explicit pr-resolve-conflicts request for a pull request)';
  }

  return [`Issue #${issue.number}: ${issue.title}`, issue.body.trim() || '(empty)'].join('\n');
}

/**
 * @param {GitConflictContext} context
 * @returns {string[]}
 */
function formatOptionalMetadata(context) {
  return [
    context.baseHeadSha === undefined ? undefined : `- Base head: ${context.baseHeadSha}`,
    context.originalHeadSha === undefined
      ? undefined
      : `- Original PR head: ${context.originalHeadSha}`,
    `- Current rebase head: ${context.currentHeadSha}`,
    context.rebaseHeadSha === undefined
      ? undefined
      : `- Commit being replayed: ${context.rebaseHeadSha}`,
  ].filter(line => line !== undefined);
}

/**
 * @param {GitConflictFile[]} files
 * @returns {string}
 */
function formatConflictedFiles(files) {
  if (files.length === 0) {
    return '(none)';
  }

  return files.map(formatConflictedFile).join('\n\n');
}

/**
 * @param {GitConflictFile} file
 * @returns {string}
 */
function formatConflictedFile(file) {
  return [
    `## ${file.path}`,
    '',
    'Working tree content:',
    fenced(file.content ?? '(file is deleted in the working tree)'),
    '',
    'Stage 1 base content:',
    fenced(file.baseContent ?? '(not available)'),
    '',
    'Stage 2 ours content:',
    fenced(file.oursContent ?? '(not available)'),
    '',
    'Stage 3 theirs content:',
    fenced(file.theirsContent ?? '(not available)'),
  ].join('\n');
}

/**
 * @param {string} value
 * @returns {string}
 */
function fenced(value) {
  return ['```', value.trimEnd(), '```'].join('\n');
}
