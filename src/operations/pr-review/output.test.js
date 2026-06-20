import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validatePrReviewOutput } from './output.js';

describe('validatePrReviewOutput', () => {
  it('01: accepts structured review follow-up issue proposals and audit-only followUps', () => {
    const result = validatePrReviewOutput(
      JSON.stringify({
        status: 'approved',
        summary: 'The PR satisfies the review.',
        comments: [],
        replies: [],
        directChanges: [],
        reviewFollowUpIssues: [
          {
            title: 'Capture a later cleanup task.',
            body: 'Standalone follow-up issue body.',
          },
        ],
        followUps: ['Audit-only note.'],
      }),
    );

    assert.deepEqual(result, {
      valid: true,
      value: {
        status: 'approved',
        summary: 'The PR satisfies the review.',
        comments: [],
        replies: [],
        directChanges: [],
        reviewFollowUpIssues: [
          {
            title: 'Capture a later cleanup task.',
            body: 'Standalone follow-up issue body.',
          },
        ],
        followUps: ['Audit-only note.'],
      },
    });
  });

  it('02: rejects malformed review follow-up issue proposals with a clear path', () => {
    const result = validatePrReviewOutput(
      JSON.stringify({
        status: 'approved',
        summary: 'The PR satisfies the review.',
        comments: [],
        replies: [],
        directChanges: [],
        reviewFollowUpIssues: [
          {
            title: 'Capture a later cleanup task.',
          },
        ],
      }),
    );

    assert.equal(result.valid, false);
    if (result.valid) {
      throw new Error('Expected malformed review follow-up issue proposals to fail validation.');
    }

    assert.equal(
      result.reason,
      'Operation Output.reviewFollowUpIssues[0].body must be a non-empty string.',
    );
  });
});
