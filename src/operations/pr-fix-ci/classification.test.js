import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyCheckFailures } from './classification.js';

describe('classifyCheckFailures', () => {
  it('01: classifies formatting, lint, type, test, build, environment, flaky, and secret failures', () => {
    const classifications = classifyCheckFailures([
      createFailedCheck({ name: 'Prettier formatting' }),
      createFailedCheck({ name: 'ESLint lint' }),
      createFailedCheck({ name: 'TypeScript type check' }),
      createFailedCheck({ name: 'Unit tests' }),
      createFailedCheck({ name: 'Production build' }),
      createFailedCheck({ name: 'Install dependencies', workflowName: 'CI environment setup' }),
      createFailedCheck({ name: 'E2E tests timed out after retry' }),
      createFailedCheck({ name: 'Deploy with missing secret token' }),
      {
        name: 'Already passing',
        workflowName: 'CI',
        bucket: 'pass',
        conclusion: 'success',
      },
    ]);

    assert.deepEqual(
      classifications.map(failure => [
        failure.checkName,
        failure.classification,
        failure.actionable,
      ]),
      [
        ['Prettier formatting', 'formatting', true],
        ['ESLint lint', 'lint', true],
        ['TypeScript type check', 'type', true],
        ['Unit tests', 'test', true],
        ['Production build', 'build', true],
        ['Install dependencies', 'environment', false],
        ['E2E tests timed out after retry', 'flaky', false],
        ['Deploy with missing secret token', 'secret', false],
      ],
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
