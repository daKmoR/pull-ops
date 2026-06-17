import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validateOperationOutput } from './OperationOutput.js';

test('validateOperationOutput accepts structured JSON matching the contract', () => {
  const result = validateOperationOutput('{"status":"approved","summary":"looks good"}', {
    required: {
      status: ['approved', 'changes_requested', 'blocked'],
      summary: 'string',
    },
  });

  assert.deepEqual(result, {
    valid: true,
    value: {
      status: 'approved',
      summary: 'looks good',
    },
  });
});

test('smoking test intentionally fails', () => {
  throw new Error('Intentional smoke-test failure.');
});

test('validateOperationOutput validates array fields', () => {
  assert.deepEqual(
    validateOperationOutput('{"changes":["one"]}', {
      required: {
        changes: 'array',
      },
    }),
    {
      valid: true,
      value: {
        changes: ['one'],
      },
    },
  );
});

test('validateOperationOutput reports clear failure reasons', () => {
  const invalidJson = validateOperationOutput('{not json');
  assert.equal(invalidJson.valid, false);
  if (invalidJson.valid) {
    throw new Error('Expected invalid JSON to fail validation.');
  }
  assert.match(invalidJson.reason, /^Operation Output must be valid JSON:/);

  assert.deepEqual(validateOperationOutput('[]'), {
    valid: false,
    reason: 'Operation Output must be a JSON object.',
  });

  assert.deepEqual(
    validateOperationOutput('{"status":"approved"}', {
      required: {
        status: ['approved', 'changes_requested', 'blocked'],
        summary: 'string',
      },
    }),
    {
      valid: false,
      reason: 'Operation Output.summary is required.',
    },
  );
});
