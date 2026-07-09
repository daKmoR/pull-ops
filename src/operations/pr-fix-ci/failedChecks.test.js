import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { collectFailedChecks } from './failedChecks.js';

describe('collectFailedChecks', () => {
  it('01: keeps failed checks with stable checkIds and drops passing checks', () => {
    const failedChecks = collectFailedChecks([
      createFailedCheck({ name: 'Unit tests' }),
      {
        name: 'Already passing',
        workflowName: 'CI',
        bucket: 'pass',
        conclusion: 'success',
      },
      createFailedCheck({ name: 'Production build', detailsUrl: 'https://ci.test/build' }),
    ]);

    assert.deepEqual(failedChecks, [
      {
        id: 'check-1',
        checkName: 'Unit tests',
        workflowName: 'CI',
        bucket: 'fail',
        conclusion: 'failure',
      },
      {
        id: 'check-2',
        checkName: 'Production build',
        workflowName: 'CI',
        bucket: 'fail',
        conclusion: 'failure',
        detailsUrl: 'https://ci.test/build',
      },
    ]);
  });

  it('02: detects failures from bucket, conclusion, and state independently', () => {
    const failedChecks = collectFailedChecks([
      { name: 'Bucket failure', bucket: 'fail' },
      { name: 'Conclusion timeout', conclusion: 'timed_out' },
      { name: 'State error', state: 'error' },
      { name: 'Pending check', state: 'pending' },
    ]);

    assert.deepEqual(
      failedChecks.map(check => check.checkName),
      ['Bucket failure', 'Conclusion timeout', 'State error'],
    );
  });
});

/**
 * @param {Partial<import('../../github/types.js').GitHubCheckRun>} overrides
 * @returns {import('../../github/types.js').GitHubCheckRun}
 */
function createFailedCheck(overrides = {}) {
  return {
    name: 'Check',
    workflowName: 'CI',
    bucket: 'fail',
    conclusion: 'failure',
    ...overrides,
  };
}
