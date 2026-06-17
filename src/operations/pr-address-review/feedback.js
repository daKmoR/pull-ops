/**
 * @typedef {import('./feedback.types.js').PrAddressReviewFeedbackSurface} PrAddressReviewFeedbackSurface
 * @typedef {import('./feedback.types.js').PrAddressReviewFeedbackItem} PrAddressReviewFeedbackItem
 */

const GITHUB_ACTIONS_BOT_LOGIN = 'github-actions[bot]';

/**
 * @param {import('../../github/types.js').GitHubPullRequestReviewContext} reviewContext
 * @returns {PrAddressReviewFeedbackItem[]}
 */
export function collectPrAddressReviewFeedback(reviewContext) {
  return [
    ...collectUnresolvedThreadFeedback(reviewContext),
    ...collectReviewSummaryFeedback(reviewContext),
    ...collectTopLevelCommentFeedback(reviewContext),
  ];
}

/**
 * @param {import('../../github/types.js').GitHubPullRequestReviewContext} reviewContext
 * @returns {PrAddressReviewFeedbackItem[]}
 */
function collectUnresolvedThreadFeedback(reviewContext) {
  /** @type {PrAddressReviewFeedbackItem[]} */
  const items = [];

  for (const [threadIndex, thread] of reviewContext.unresolvedThreads.entries()) {
    for (const [commentIndex, comment] of thread.comments.entries()) {
      const body = comment.body.trim();
      if (body === '') {
        continue;
      }

      const fallbackId = `${threadIndex + 1}.${commentIndex + 1}`;
      const id = `thread:${comment.databaseId ?? comment.id ?? fallbackId}`;
      const location =
        comment.path === undefined || comment.line === undefined
          ? undefined
          : `${comment.path}:${comment.line}`;

      items.push({
        id,
        surface: 'unresolved_inline_thread',
        body,
        authorLogin: comment.authorLogin,
        ...(comment.databaseId === undefined ? {} : { replyCommentId: comment.databaseId }),
        ...(thread.id === undefined ? {} : { reviewThreadId: thread.id }),
        ...(location === undefined ? {} : { location }),
        ...(comment.url === undefined ? {} : { url: comment.url }),
      });
    }
  }

  return items;
}

/**
 * @param {import('../../github/types.js').GitHubPullRequestReviewContext} reviewContext
 * @returns {PrAddressReviewFeedbackItem[]}
 */
function collectReviewSummaryFeedback(reviewContext) {
  /** @type {PrAddressReviewFeedbackItem[]} */
  const items = [];

  for (const [index, review] of reviewContext.reviews.entries()) {
    const body = review.body.trim();
    if (body === '') {
      continue;
    }

    if (review.authorLogin === GITHUB_ACTIONS_BOT_LOGIN) {
      items.push({
        id: `pullops-pr-review:${review.id ?? index + 1}`,
        surface: 'pullops_review_output',
        body,
        authorLogin: review.authorLogin,
        ...(review.url === undefined ? {} : { url: review.url }),
      });
      continue;
    }

    if (review.state === 'CHANGES_REQUESTED') {
      items.push({
        id: `review:${review.id ?? index + 1}`,
        surface: 'requested_change_summary',
        body,
        authorLogin: review.authorLogin,
        ...(review.url === undefined ? {} : { url: review.url }),
      });
    }
  }

  return items;
}

/**
 * @param {import('../../github/types.js').GitHubPullRequestReviewContext} reviewContext
 * @returns {PrAddressReviewFeedbackItem[]}
 */
function collectTopLevelCommentFeedback(reviewContext) {
  /** @type {PrAddressReviewFeedbackItem[]} */
  const items = [];

  for (const [index, comment] of reviewContext.comments.entries()) {
    const body = comment.body.trim();
    if (body === '') {
      continue;
    }

    if (isPullOpsOperationAuditComment(body)) {
      continue;
    }

    items.push({
      id: `comment:${comment.databaseId ?? comment.id ?? index + 1}`,
      surface: 'top_level_comment',
      body,
      authorLogin: comment.authorLogin,
      ...(comment.url === undefined ? {} : { url: comment.url }),
    });
  }

  return items;
}

/**
 * @param {string} body
 * @returns {boolean}
 */
function isPullOpsOperationAuditComment(body) {
  return /<summary>\s*PullOps operation audit\s*<\/summary>/i.test(body);
}
