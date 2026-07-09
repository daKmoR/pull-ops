import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { updatePullRequestBodyForPrFinalize } from './prBody.js';

describe('updatePullRequestBodyForPrFinalize', () => {
  it('01: replaces the full traceability section instead of inserting duplicate parent links', () => {
    const body = [
      '## Summary',
      '',
      'Implemented ticket work.',
      '',
      '## Traceability',
      '',
      'Refs #32',
      'Part of #31',
      '',
      '## PullOps',
      '',
      'Managed: yes',
      'Status: Review approved',
      '',
      '<details>',
      '<summary>PullOps workflow state</summary>',
      '',
      'Source: Issue #32',
      'Last operation: pullops:pr:review',
      '',
      '</details>',
    ].join('\n');

    const finalizedOnce = updatePullRequestBodyForPrFinalize({
      body,
      sourceIssueNumber: 32,
      parentIssueNumber: 31,
      finalizedTreeHash: 'reviewed-tree',
      finalizedHeadSha: 'finalized-head',
    });

    const finalizedTwice = updatePullRequestBodyForPrFinalize({
      body: finalizedOnce,
      sourceIssueNumber: 32,
      parentIssueNumber: 31,
      finalizedTreeHash: 'reviewed-tree',
      finalizedHeadSha: 'finalized-head',
    });

    assert.equal(countMatches(finalizedTwice, /^Refs #32$/gm), 1);
    assert.equal(countMatches(finalizedTwice, /^Part of #31$/gm), 1);
    assert.match(finalizedTwice, /## Traceability\n\nRefs #32\nPart of #31\n\n## PullOps/);
  });
});

/**
 * @param {string} value
 * @param {RegExp} pattern
 * @returns {number}
 */
function countMatches(value, pattern) {
  return [...value.matchAll(pattern)].length;
}
