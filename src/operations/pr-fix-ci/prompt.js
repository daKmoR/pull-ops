/**
 * @typedef {import('../../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('../../github/types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('../../github/types.js').GitHubPullRequestReviewContext} GitHubPullRequestReviewContext
 * @typedef {import('../../github/types.js').GitHubPullRequestDiff} GitHubPullRequestDiff
 * @typedef {import('./classification.types.js').ClassifiedCheckFailure} ClassifiedCheckFailure
 */

/**
 * @param {object} options
 * @param {GitHubPullRequest} options.pullRequest
 * @param {GitHubIssue | undefined} options.issue
 * @param {GitHubPullRequestReviewContext} options.reviewContext
 * @param {GitHubPullRequestDiff} options.diff
 * @param {ClassifiedCheckFailure[]} options.checkFailures
 * @returns {string}
 */
export function buildPrFixCiPrompt({ pullRequest, issue, reviewContext, diff, checkFailures }) {
  return [
    'Use the pullops-pr-fix-ci skill.',
    '',
    `Fix actionable CI failures on PR #${pullRequest.number}: ${pullRequest.title}`,
    '',
    'Linked issue or PRD context:',
    formatIssue(issue),
    '',
    'Pull request body:',
    pullRequest.body.trim() || '(empty)',
    '',
    'Check Failure Classification:',
    formatCheckFailures(checkFailures),
    '',
    'Changed files:',
    formatFiles(reviewContext),
    '',
    'Pull request diff:',
    diff.patch.trim() || '(empty)',
    '',
    'Constraints:',
    '- Review the Check Failure Classification before making code changes.',
    '- Echo every supplied checkId exactly once with its supplied classification and a rationale.',
    '- Only repair checks classified as formatting, lint, type, test, or build.',
    '- If a repair would require weakening tests, deleting assertions, bypassing checks, or working around missing secrets or infrastructure failures, return blocked instead of changing code.',
    '- Keep changes focused on the failed checks and the pull request diff.',
    '- Do not create commits, push, edit labels, update the PR body, or post GitHub comments; PullOps will do those after validating your output.',
    '',
    'Final response must be only JSON in this shape:',
    JSON.stringify(
      {
        status: 'fixed',
        summary: 'One sentence summary of the CI repairs.',
        classifications: [
          {
            checkId: 'check-1',
            classification: 'lint',
            rationale: 'ESLint reported an unused variable.',
          },
        ],
        safetyChecks: {
          weakenedTests: false,
          deletedAssertions: false,
          bypassedChecks: false,
          secretOrInfrastructureWorkaround: false,
        },
        changes: ['Specific code, test, or documentation change made.'],
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
        failureReason: 'Specific reason the CI failure could not be safely fixed.',
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
    return '(none supplied; this is an explicit manual pr-fix-ci request for a pull request)';
  }

  return [`Issue #${issue.number}: ${issue.title}`, issue.body.trim() || '(empty)'].join('\n');
}

/**
 * @param {ClassifiedCheckFailure[]} checkFailures
 * @returns {string}
 */
function formatCheckFailures(checkFailures) {
  if (checkFailures.length === 0) {
    return '(none)';
  }

  return checkFailures
    .map(failure =>
      [
        `- checkId \`${failure.id}\``,
        `  Check: ${failure.checkName}`,
        failure.workflowName === undefined ? undefined : `  Workflow: ${failure.workflowName}`,
        failure.state === undefined ? undefined : `  State: ${failure.state}`,
        failure.conclusion === undefined ? undefined : `  Conclusion: ${failure.conclusion}`,
        failure.bucket === undefined ? undefined : `  Bucket: ${failure.bucket}`,
        failure.detailsUrl === undefined ? undefined : `  Details: ${failure.detailsUrl}`,
        `  Classification: ${failure.classification}`,
        `  Actionable: ${failure.actionable ? 'yes' : 'no'}`,
        `  Reason: ${failure.reason}`,
      ]
        .filter(line => line !== undefined)
        .join('\n'),
    )
    .join('\n');
}

/**
 * @param {GitHubPullRequestReviewContext} context
 * @returns {string}
 */
function formatFiles(context) {
  if (context.files.length === 0) {
    return '(none)';
  }

  return context.files
    .map(file => `- ${file.path} (+${file.additions} / -${file.deletions})`)
    .join('\n');
}
