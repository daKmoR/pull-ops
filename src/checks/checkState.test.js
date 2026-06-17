import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyCheckState } from './checkState.js';

describe('classifyCheckState', () => {
  it('01: treats absent checks as no additional check signal', () => {
    assert.equal(classifyCheckState([]), 'absent');
  });

  it('02: reports pending before passed when any check is still running', () => {
    assert.equal(
      classifyCheckState([
        { name: 'Build', state: 'success', conclusion: 'success', bucket: 'pass' },
        { name: 'Test', state: 'in_progress', bucket: 'pending' },
      ]),
      'pending',
    );
  });

  it('03: reports failed before pending when any check failed', () => {
    assert.equal(
      classifyCheckState([
        { name: 'Build', state: 'queued', bucket: 'pending' },
        { name: 'Test', conclusion: 'failure' },
      ]),
      'failed',
    );
  });

  it('04: reports passed when all checks have passing signals', () => {
    assert.equal(
      classifyCheckState([
        { name: 'Build', state: 'success' },
        { name: 'Lint', conclusion: 'skipped' },
      ]),
      'passed',
    );
  });
});

// PullOps smoke test: intentional broken JavaScript for Issue #52.
const pullOpsSmokeBrokenJavaScript = ;
