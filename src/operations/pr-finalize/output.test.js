import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validatePrFinalizeOutput } from './output.js';

describe('validatePrFinalizeOutput', () => {
  it('01: treats blank optional commit plan justification as omitted', () => {
    const result = validatePrFinalizeOutput({
      status: 'planned',
      summary: 'Plan one ticket commit.',
      commitPlan: {
        justification: '',
        commits: [createCommit()],
      },
      followUps: [],
    });

    assert.deepEqual(result, {
      valid: true,
      value: {
        status: 'planned',
        summary: 'Plan one ticket commit.',
        commitPlan: {
          commits: [createCommit()],
        },
        followUps: [],
      },
    });
  });
});

/**
 * @returns {import('./output.types.js').PlannedCommit}
 */
function createCommit() {
  return {
    header: 'feat(issue): implement #42',
    body: ['Finalize the logical change.'],
    footers: ['Refs: #42', 'Spec: #7'],
    files: ['src/example.js'],
  };
}
