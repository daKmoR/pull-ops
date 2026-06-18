/**
 * @typedef {import('./output.types.js').CompletedPrAddressReviewOutput} CompletedPrAddressReviewOutput
 */

/**
 * @param {CompletedPrAddressReviewOutput} output
 * @param {string[]} expectedFeedbackIds
 * @returns {{ valid: true } | { valid: false, reason: string }}
 */
export function validateAddressReviewFeedbackCoverage(output, expectedFeedbackIds) {
  const expected = new Set(expectedFeedbackIds);
  const seen = new Set();

  for (const feedback of [
    ...output.addressed.map(item => ({ feedbackId: item.feedbackId, path: 'addressed' })),
    ...output.declined.map(item => ({ feedbackId: item.feedbackId, path: 'declined' })),
    ...output.deferred.map(item => ({ feedbackId: item.feedbackId, path: 'deferred' })),
  ]) {
    if (!expected.has(feedback.feedbackId)) {
      return {
        valid: false,
        reason: `Operation Output.${feedback.path} references unknown feedbackId "${feedback.feedbackId}".`,
      };
    }

    if (seen.has(feedback.feedbackId)) {
      return {
        valid: false,
        reason: `Feedback item "${feedback.feedbackId}" must be classified exactly once.`,
      };
    }

    seen.add(feedback.feedbackId);
  }

  for (const feedbackId of expected) {
    if (!seen.has(feedbackId)) {
      return {
        valid: false,
        reason: `Feedback item "${feedbackId}" must be classified as addressed, declined, or deferred.`,
      };
    }
  }

  return { valid: true };
}
