import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { initializeLocalRunState } from '../local-run-state/localRunState.js';
import { createOperationProgressEventWriter } from './progressEvents.js';

describe('Operation progress event streams', () => {
  it('01: rejects details that contain reserved identity fields', async () => {
    const stdout = createWritableBuffer();
    const writer = createOperationProgressEventWriter({
      stdout,
      operation: 'spec-auto-complete',
      operationLabelReference: 'spec:auto-complete',
      runId: '2026-06-20T010203000Z-spec-auto-complete-123',
      target: {
        type: 'issue',
        number: 123,
      },
    });

    await assert.rejects(
      writer.emit('run.summary', {
        runId: 'wrong-run',
        status: 'accepted',
        summary: 'accepted',
      }),
      /reserved field "runId"/,
    );
    assert.equal(stdout.text, '');
  });

  it('02: rejects event names outside the PullOps progress event vocabulary', async () => {
    const stdout = createWritableBuffer();
    const writer = createOperationProgressEventWriter({
      stdout,
      operation: 'spec-auto-complete',
      operationLabelReference: 'spec:auto-complete',
      runId: '2026-06-20T010203000Z-spec-auto-complete-123',
      target: {
        type: 'issue',
        number: 123,
      },
    });
    const unsupportedEvent = /** @type {import('./types.js').OperationProgressEventName} */ (
      'ticket.custom-completed'
    );

    await assert.rejects(
      writer.emit(unsupportedEvent, {
        phase: 'ticket-coordination',
      }),
      /Unsupported PullOps progress event "ticket.custom-completed"/,
    );
    assert.equal(stdout.text, '');
  });

  it('03: mirrors semantic ticket progress into the bound Local Run State last event', async () => {
    const stdout = createWritableBuffer();
    const runRecordDirectory = await mkdtemp(join(tmpdir(), 'pullops-progress-events-'));
    const stateRecord = await initializeLocalRunState({
      runRecordDirectory,
      operationReference: 'spec:auto-complete',
      target: {
        type: 'issue',
        number: 123,
      },
      publicationMode: 'dry-run',
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
    });
    const writer = createOperationProgressEventWriter({
      stdout,
      operation: 'spec-auto-complete',
      operationLabelReference: 'spec:auto-complete',
      runId: stateRecord.state.runId,
      target: {
        type: 'issue',
        number: 123,
      },
    });

    await writer.bindLocalRunRecord(runRecordDirectory);
    await writer.emit('ticket.progress', {
      phase: 'ticket-coordination',
      ticket: {
        number: 34,
        url: 'https://github.test/issues/34',
      },
      message: 'Checking local worktree.',
      progressMessage: 'Checking local worktree.',
    });

    const state = JSON.parse(await readFile(stateRecord.statePath, 'utf8'));
    assert.equal(state.status, 'running');
    assert.equal(state.heartbeatAt, '2024-01-01T00:00:00.000Z');
    assert.equal(state.lastEvent.event, 'ticket.progress');
    assert.equal(state.lastEvent.operationReference, 'spec:auto-complete');
    assert.equal(state.lastEvent.normalizedOperationReference, 'spec-auto-complete');
    assert.deepEqual(state.lastEvent.target, { type: 'issue', number: 123 });
    assert.equal(state.lastEvent.phase, 'ticket-coordination');
    assert.deepEqual(state.lastEvent.ticket, {
      number: 34,
      url: 'https://github.test/issues/34',
    });
    assert.equal(state.lastEvent.progressMessage, 'Checking local worktree.');
    assert.equal(state.lastEvent.message, 'Checking local worktree.');
  });
});

/**
 * @returns {import('../cli/types.js').WritableLike & { text: string }}
 */
function createWritableBuffer() {
  return {
    text: '',
    /**
     * @param {string} chunk
     */
    write(chunk) {
      this.text += chunk;
    },
  };
}
