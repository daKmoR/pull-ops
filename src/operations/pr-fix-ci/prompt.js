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
    `Goal: make the failed checks on PR #${pullRequest.number} pass with the smallest correct repair, or return blocked when no safe code repair exists: ${pullRequest.title}`,
    '',
    'Linked issue or PRD context:',
    formatIssue(issue),
    '',
    'Pull request body:',
    pullRequest.body.trim() || '(empty)',
    '',
    'Failed checks:',
    formatCheckFailures(checkFailures),
    '',
    'Changed files:',
    formatFiles(reviewContext),
    '',
    'Pull request diff:',
    diff.patch.trim() || '(empty)',
    '',
    'Boundaries:',
    '- Classify every failed checkId yourself as formatting, lint, type, test, build, environment, flaky, or secret, based on the check evidence. The keyword prior shown with each check is a non-binding hint you may overrule.',
    '- Only formatting, lint, type, test, and build failures are yours to repair. Return blocked when the failures are environment, flaky, or secret, or when no safe repair exists.',
    '- Never weaken tests, delete assertions, skip checks, or work around missing secrets or infrastructure. PullOps verifies the resulting diff and will not commit unsafe repairs.',
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
        classifications: [
          {
            checkId: 'check-1',
            classification: 'environment',
            rationale: 'The runner lost network access while installing dependencies.',
          },
        ],
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
        `  Keyword prior (non-binding): ${failure.classification} — ${failure.reason}`,
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
