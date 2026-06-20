import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createOperationProgressEventWriter } from './eventStream.js';

describe('Operation progress event streams', () => {
  it('01: rejects details that contain reserved identity fields', async () => {
    const stdout = createWritableBuffer();
    const writer = createOperationProgressEventWriter({
      stdout,
      operation: 'prd-auto-complete',
      operationLabelReference: 'prd:auto-complete',
      runId: '2026-06-20T010203000Z-prd-auto-complete-123',
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
      operation: 'prd-auto-complete',
      operationLabelReference: 'prd:auto-complete',
      runId: '2026-06-20T010203000Z-prd-auto-complete-123',
      target: {
        type: 'issue',
        number: 123,
      },
    });
    const unsupportedEvent =
      /** @type {import('../../cli/types.js').OperationProgressEventName} */ (
        'child.custom-completed'
      );

    await assert.rejects(
      writer.emit(unsupportedEvent, {
        phase: 'child-coordination',
      }),
      /Unsupported PullOps progress event "child.custom-completed"/,
    );
    assert.equal(stdout.text, '');
  });
});

/**
 * @returns {import('../../cli/types.js').WritableLike & { text: string }}
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
