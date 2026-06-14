/**
 * @typedef {import('../../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('../../github/types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('../../github/types.js').GitHubPullRequestReviewContext} GitHubPullRequestReviewContext
 * @typedef {import('../../github/types.js').GitHubPullRequestDiff} GitHubPullRequestDiff
 * @typedef {import('./feedback.types.js').AddressReviewFeedbackItem} AddressReviewFeedbackItem
 */

/**
 * @param {object} options
 * @param {GitHubPullRequest} options.pullRequest
 * @param {GitHubIssue} options.issue
 * @param {GitHubPullRequestReviewContext} options.reviewContext
 * @param {GitHubPullRequestDiff} options.diff
 * @param {AddressReviewFeedbackItem[]} options.feedbackItems
 * @returns {string}
 */
export function buildAddressReviewPrompt({
  pullRequest,
  issue,
  reviewContext,
  diff,
  feedbackItems,
}) {
  return [
    'Use the pullops-address-review skill.',
    '',
    `Address Actionable PR Feedback on PullOps-managed PR #${pullRequest.number}: ${pullRequest.title}`,
    '',
    'Linked issue or PRD context:',
    `Issue #${issue.number}: ${issue.title}`,
    issue.body.trim() || '(empty)',
    '',
    'Pull request body:',
    pullRequest.body.trim() || '(empty)',
    '',
    'Changed files:',
    formatFiles(reviewContext),
    '',
    'Pull request diff:',
    diff.patch.trim() || '(empty)',
    '',
    'Actionable PR Feedback:',
    formatFeedbackItems(feedbackItems),
    '',
    'Constraints:',
    '- Classify every feedbackId exactly once as addressed, declined, or deferred.',
    '- Address feedback by default with code, test, documentation, or explanation changes as needed.',
    '- Decline feedback only when the requested change should not be made, and include a substantive reason.',
    '- Defer feedback only when it is stale, irrelevant, or outside this PR, and include a reason.',
    '- Keep the implementation focused on the linked issue and the supplied feedback.',
    '- Do not create commits, push, approve, request changes, edit labels, update the PR body, or post GitHub comments; PullOps will do those after validating your output.',
    '',
    'Final response must be only JSON in this shape:',
    JSON.stringify(
      {
        status: 'addressed',
        summary: 'One sentence summary of the addressed PR feedback.',
        addressed: [
          {
            feedbackId: 'thread:123456789',
            response: 'Implemented the requested change.',
          },
        ],
        declined: [
          {
            feedbackId: 'review:PRR_123',
            reason: 'This requested change would contradict the linked issue.',
          },
        ],
        deferred: [
          {
            feedbackId: 'comment:987654321',
            reason: 'This is stale after the latest diff.',
          },
        ],
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
        failureReason: 'Specific reason the feedback could not be addressed.',
      },
      null,
      2,
    ),
  ].join('\n');
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

/**
 * @param {AddressReviewFeedbackItem[]} feedbackItems
 * @returns {string}
 */
function formatFeedbackItems(feedbackItems) {
  if (feedbackItems.length === 0) {
    return '(none)';
  }

  return feedbackItems
    .map(item =>
      [
        `- feedbackId \`${item.id}\``,
        `  Surface: ${formatFeedbackSurface(item.surface)}`,
        `  Author: ${formatAuthor(item.authorLogin)}`,
        item.location === undefined ? undefined : `  Location: ${item.location}`,
        item.url === undefined ? undefined : `  URL: ${item.url}`,
        '  Body:',
        indent(item.body),
      ]
        .filter(line => line !== undefined)
        .join('\n'),
    )
    .join('\n');
}

/**
 * @param {import('./feedback.types.js').AddressReviewFeedbackSurface} surface
 * @returns {string}
 */
function formatFeedbackSurface(surface) {
  if (surface === 'unresolved_inline_thread') {
    return 'unresolved inline review thread';
  }

  if (surface === 'requested_change_summary') {
    return 'requested-change review summary';
  }

  if (surface === 'pullops_review_output') {
    return 'PullOps review output';
  }

  return 'top-level PR comment';
}

/**
 * @param {string | null} login
 * @returns {string}
 */
function formatAuthor(login) {
  return login === null || login.trim() === '' ? 'unknown' : `@${login}`;
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
