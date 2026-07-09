/**
 * @typedef {import('../../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('../../github/types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('../../github/types.js').GitHubPullRequestReviewContext} GitHubPullRequestReviewContext
 * @typedef {import('../../github/types.js').GitHubPullRequestDiff} GitHubPullRequestDiff
 */

/**
 * @param {object} options
 * @param {GitHubPullRequest} options.pullRequest
 * @param {GitHubIssue} options.issue
 * @param {GitHubPullRequestReviewContext} options.reviewContext
 * @param {GitHubPullRequestDiff} options.diff
 * @returns {string}
 */
export function buildPrReviewPrompt({ pullRequest, issue, reviewContext, diff }) {
  return [
    'Use the pullops-pr-review skill.',
    '',
    `Goal: review PullOps-managed PR #${pullRequest.number} against the linked issue and this repository's coding standards (the Coding Standards Pass), and decide whether it is ready for the next PullOps automation step: ${pullRequest.title}`,
    '',
    'Linked issue or Spec context:',
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
    'Pull request comments:',
    formatComments(reviewContext),
    '',
    'Review summaries:',
    formatReviews(reviewContext),
    '',
    'Unresolved review threads:',
    formatThreads(reviewContext),
    '',
    'Boundaries:',
    '- Inline comments belong only on changed lines from the diff, and replies to existing feedback use commentId values from the unresolved review threads.',
    '- Small direct improvements in the working tree are allowed when they are clearly review-owned and do not change PR scope.',
    '- Do not create commits, push, approve, request changes, or edit GitHub labels; PullOps will do that after validating your output.',
    '',
    'Final response must be only JSON in this shape:',
    JSON.stringify(
      {
        status: 'changes_requested',
        summary: 'One sentence review summary.',
        comments: [
          {
            path: 'src/example.js',
            line: 42,
            body: 'Actionable inline review comment.',
          },
        ],
        replies: [
          {
            commentId: 123456789,
            body: 'Reply to an unresolved review comment.',
          },
        ],
        directChanges: ['Small direct improvement made during review.'],
        reviewFollowUpIssues: [
          {
            title: 'Follow up on a non-blocking concern.',
            body: 'Standalone Review Follow-up Issue body that links back to the PR and source issue.',
          },
        ],
        followUps: ['Optional follow-up that should not block this PR.'],
      },
      null,
      2,
    ),
    '',
    'Use "approved" when the PR is ready for the next PullOps automation step, "changes_requested" when pr-address-review should run, or "blocked" when review cannot complete.',
    '',
    'If you are approving the final Escalation Review Cycle, use reviewFollowUpIssues for standalone needs-triage issue proposals. Keep plain followUps as audit-only notes that must not create issues.',
    '',
    'If blocked, return only JSON in this shape:',
    JSON.stringify(
      {
        status: 'blocked',
        summary: 'Short blocked summary.',
        failureReason: 'Specific reason the review could not be completed.',
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
 * @param {GitHubPullRequestReviewContext} context
 * @returns {string}
 */
function formatComments(context) {
  if (context.comments.length === 0) {
    return '(none)';
  }

  return context.comments
    .map(comment => `- ${formatAuthor(comment.authorLogin)}: ${comment.body}`)
    .join('\n');
}

/**
 * @param {GitHubPullRequestReviewContext} context
 * @returns {string}
 */
function formatReviews(context) {
  if (context.reviews.length === 0) {
    return '(none)';
  }

  return context.reviews
    .map(review => `- ${review.state} by ${formatAuthor(review.authorLogin)}: ${review.body}`)
    .join('\n');
}

/**
 * @param {GitHubPullRequestReviewContext} context
 * @returns {string}
 */
function formatThreads(context) {
  if (context.unresolvedThreads.length === 0) {
    return '(none)';
  }

  return context.unresolvedThreads
    .map((thread, index) => {
      const comments = thread.comments
        .map(comment => {
          const id = comment.databaseId === undefined ? 'unknown' : String(comment.databaseId);
          const location =
            comment.path === undefined || comment.line === undefined
              ? 'unknown location'
              : `${comment.path}:${comment.line}`;
          return `  - commentId ${id} at ${location} by ${formatAuthor(
            comment.authorLogin,
          )}: ${comment.body}`;
        })
        .join('\n');
      return `Thread ${index + 1}:\n${comments}`;
    })
    .join('\n');
}

/**
 * @param {string | null} login
 * @returns {string}
 */
function formatAuthor(login) {
  return login === null || login.trim() === '' ? 'unknown' : `@${login}`;
}
