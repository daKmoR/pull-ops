import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateIssueImplementOutput } from './output.js';

describe('validateIssueImplementOutput', () => {
  it('01: ignores empty changes entries on implemented output', () => {
    assert.deepEqual(
      validateIssueImplementOutput({
        status: 'implemented',
        summary: 'Implemented the issue.',
        changes: ['Changed code.', '', '  ', 'Updated tests.'],
        testPlan: ['npm test'],
        followUps: [],
      }),
      {
        valid: true,
        value: {
          status: 'implemented',
          summary: 'Implemented the issue.',
          changes: ['Changed code.', 'Updated tests.'],
          testPlan: ['npm test'],
          followUps: [],
        },
      },
    );
  });

  it('02: keeps other implemented output string arrays strict', () => {
    assert.deepEqual(
      validateIssueImplementOutput({
        status: 'implemented',
        summary: 'Implemented the issue.',
        changes: ['Changed code.'],
        testPlan: ['npm test', ''],
      }),
      {
        valid: false,
        reason: 'Operation Output.testPlan[1] must be a non-empty string.',
      },
    );
  });
});
