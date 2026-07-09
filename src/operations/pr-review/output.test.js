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
  it('03: accepts a managed-pr nextOperation proposal with changes_requested only', () => {
    const accepted = validatePrReviewOutput({
      status: 'changes_requested',
      summary: 'CI is failing.',
      nextOperation: 'pr-fix-ci',
    });
    assert.ok(accepted.valid);
    const completed = /** @type {import('./output.types.js').CompletedPrReviewOutput} */ (
      accepted.valid ? accepted.value : {}
    );
    assert.equal(completed.nextOperation, 'pr-fix-ci');

    const withApproved = validatePrReviewOutput({
      status: 'approved',
      summary: 'Looks good.',
      nextOperation: 'pr-fix-ci',
    });
    assert.equal(withApproved.valid, false);
    assert.match(
      withApproved.valid ? '' : withApproved.reason,
      /only accepted with status "changes_requested"/,
    );
  });

  it('04: rejects a nextOperation outside the managed PR workflow vocabulary', () => {
    const result = validatePrReviewOutput({
      status: 'changes_requested',
      summary: 'Needs work.',
      nextOperation: 'issue-implement',
    });
    assert.equal(result.valid, false);
    assert.match(result.valid ? '' : result.reason, /must be one of/);
  });
});
