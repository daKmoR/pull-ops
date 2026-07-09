import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  createRunRecordLocation,
  normalizeOperationReferenceForPath,
  writeRunArtifact,
} from './localRunRecord.js';

describe('Test localRunRecord', () => {
  it('01: creates a run record location from a numeric target', () => {
    const location = createRunRecordLocation({
      cwd: '/repo',
      operationReference: 'issue:implement',
      targetReference: 42,
      createdAt: new Date('2026-07-07T10:20:30.400Z'),
    });

    assert.equal(location.runId, '2026-07-07T102030400Z-issue-implement-42');
    assert.equal(location.directory, join('/repo', '.pullops', 'runs', location.runId));
    assert.equal(location.normalizedOperationReference, 'issue-implement');
  });

  it('02: slugifies string targets for path safety', () => {
    const location = createRunRecordLocation({
      cwd: '/repo',
      operationReference: 'issues:publish-spec',
      targetReference: 'My Spec Title!',
      createdAt: new Date('2026-07-07T10:20:30.400Z'),
    });

    assert.equal(location.runId, '2026-07-07T102030400Z-issues-publish-spec-my-spec-title');
  });

  it('03: falls back to "new" for targets without path-safe characters', () => {
    const location = createRunRecordLocation({
      cwd: '/repo',
      operationReference: 'issues:publish-spec',
      targetReference: '???',
      createdAt: new Date('2026-07-07T10:20:30.400Z'),
    });

    assert.equal(location.runId, '2026-07-07T102030400Z-issues-publish-spec-new');
  });

  it('04: normalizes operation references for paths', () => {
    assert.equal(normalizeOperationReferenceForPath('spec:auto-complete'), 'spec-auto-complete');
    assert.equal(normalizeOperationReferenceForPath('  Issue:Implement  '), 'issue-implement');
  });

  it('05: writes run artifacts into the run record directory', async () => {
    const location = createRunRecordLocation({
      cwd: join(tmpdir(), `pullops-run-record-test-${process.pid}`),
      operationReference: 'issue:implement',
      targetReference: 7,
    });

    await writeRunArtifact(location, 'request.json', '{"ok":true}\n');

    const contents = await readFile(join(location.directory, 'request.json'), 'utf8');
    assert.equal(contents, '{"ok":true}\n');
  });
});
