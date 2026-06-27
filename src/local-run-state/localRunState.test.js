import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  initializeLocalRunState,
  mapLocalRunResultStatusToTerminalStatus,
  readLocalRunState,
  readLocalRunStateRecordFromDirectory,
  recordLocalRunHeartbeat,
  recordLocalRunTerminalStatus,
} from './localRunState.js';

describe('localRunState', () => {
  it('01: initializes a machine-readable run state and heartbeat environment', async () => {
    const runRecordDirectory = await mkdtemp(join(tmpdir(), 'pullops-local-run-state-'));
    const createdAt = new Date('2024-01-01T00:00:00.000Z');

    const record = await initializeLocalRunState({
      runRecordDirectory,
      operationReference: 'issue:implement',
      target: {
        type: 'issue',
        number: 42,
      },
      publicationMode: 'dry-run',
      runGoal: 'operation',
      createdAt,
      heartbeatIntervalMs: 120000,
      leaseDurationMs: 240000,
    });

    assert.equal(record.statePath, join(runRecordDirectory, 'state.json'));
    assert.deepEqual(record.heartbeatEnvironment, {
      PULLOPS_HEARTBEAT_COMMAND: 'npm exec pullops -- heartbeat',
      PULLOPS_RUN_STATE_PATH: join(runRecordDirectory, 'state.json'),
      PULLOPS_HEARTBEAT_TOKEN: record.state.heartbeatToken,
      PULLOPS_HEARTBEAT_INTERVAL_MS: '120000',
    });

    const state = JSON.parse(await readFile(record.statePath, 'utf8'));
    assert.equal(state.schemaVersion, 1);
    assert.equal(state.status, 'running');
    assert.equal(state.phase, 'run');
    assert.equal(state.heartbeatAt, createdAt.toISOString());
    assert.equal(state.leaseExpiresAt, new Date(createdAt.getTime() + 240000).toISOString());
    assert.equal(state.heartbeatIntervalMs, 120000);
    assert.equal(state.leaseDurationMs, 240000);
    assert.deepEqual(state.childRuns, []);
    assert.equal(state.lastEvent.event, 'run.started');
    assert.equal(state.lastEvent.status, 'running');

    const reread = await readLocalRunStateRecordFromDirectory(runRecordDirectory);
    assert.equal(reread.statePath, record.statePath);
    assert.equal(reread.state.heartbeatToken, record.state.heartbeatToken);
    assert.equal(reread.heartbeatEnvironment.PULLOPS_RUN_STATE_PATH, record.statePath);
  });

  it('01b: preserves the original parse error when state.json is invalid JSON', async () => {
    const runRecordDirectory = await mkdtemp(join(tmpdir(), 'pullops-local-run-state-invalid-'));
    const statePath = join(runRecordDirectory, 'state.json');
    await writeFile(statePath, '{"schemaVersion":');

    await assert.rejects(
      async () => await readLocalRunState(statePath),
      error => {
        const readError = /** @type {Error & { cause?: unknown }} */ (error);
        assert.match(readError.message, /must be valid JSON/);
        assert.ok(readError.cause instanceof SyntaxError);
        return true;
      },
    );
  });

  it('02: records heartbeats atomically and rejects mismatched tokens', async () => {
    const runRecordDirectory = await mkdtemp(join(tmpdir(), 'pullops-local-run-heartbeat-'));
    const initial = await initializeLocalRunState({
      runRecordDirectory,
      operationReference: 'issue:implement',
      target: {
        type: 'issue',
        number: 42,
      },
      publicationMode: 'dry-run',
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      heartbeatIntervalMs: 60000,
      leaseDurationMs: 120000,
    });

    const heartbeatAt = new Date('2024-01-01T00:05:00.000Z');
    const updated = await recordLocalRunHeartbeat({
      statePath: initial.statePath,
      token: initial.state.heartbeatToken,
      at: heartbeatAt,
    });

    assert.equal(updated.heartbeatAt, heartbeatAt.toISOString());
    assert.equal(
      updated.leaseExpiresAt,
      new Date(heartbeatAt.getTime() + updated.leaseDurationMs).toISOString(),
    );
    assert.equal(updated.lastEvent.event, 'run.started');

    const stored = JSON.parse(await readFile(initial.statePath, 'utf8'));
    assert.equal(stored.heartbeatAt, heartbeatAt.toISOString());
    assert.equal(stored.leaseExpiresAt, updated.leaseExpiresAt);

    await assert.rejects(
      async () =>
        await recordLocalRunHeartbeat({
          statePath: initial.statePath,
          token: 'wrong-token',
          at: new Date('2024-01-01T00:06:00.000Z'),
        }),
      /Heartbeat token mismatch/,
    );

    const afterRejection = JSON.parse(await readFile(initial.statePath, 'utf8'));
    assert.equal(afterRejection.heartbeatAt, heartbeatAt.toISOString());
    assert.equal(afterRejection.leaseExpiresAt, updated.leaseExpiresAt);
  });

  it('03: records terminal status without clearing the existing run history', async () => {
    const runRecordDirectory = await mkdtemp(join(tmpdir(), 'pullops-local-run-terminal-'));
    const initial = await initializeLocalRunState({
      runRecordDirectory,
      operationReference: 'issue:implement',
      target: {
        type: 'issue',
        number: 42,
      },
      publicationMode: 'dry-run',
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
    });

    const finished = await recordLocalRunTerminalStatus({
      statePath: initial.statePath,
      status: 'accepted',
      summary: 'Completed local run.',
      phase: 'run',
      at: new Date('2024-01-01T00:10:00.000Z'),
    });

    assert.equal(finished.status, 'accepted');
    assert.equal(finished.phase, 'run');
    assert.equal(finished.lastEvent.event, 'run.summary');
    assert.equal(finished.lastEvent.status, 'accepted');
    assert.equal(finished.lastEvent.summary, 'Completed local run.');

    const stored = JSON.parse(await readFile(initial.statePath, 'utf8'));
    assert.equal(stored.status, 'accepted');
    assert.equal(stored.phase, 'run');
    assert.equal(stored.lastEvent.status, 'accepted');
    assert.equal(stored.lastEvent.summary, 'Completed local run.');
    assert.equal(stored.heartbeatAt, initial.state.heartbeatAt);
  });

  it('04: rejects non-terminal terminal writes without mutating the stored state', async () => {
    const runRecordDirectory = await mkdtemp(join(tmpdir(), 'pullops-local-run-terminal-'));
    const initial = await initializeLocalRunState({
      runRecordDirectory,
      operationReference: 'pr:finalize',
      target: {
        type: 'pr',
        number: 7,
      },
      publicationMode: 'dry-run',
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
    });

    await assert.rejects(
      async () =>
        await recordLocalRunTerminalStatus({
          statePath: initial.statePath,
          status: /** @type {import('./types.js').LocalRunTerminalStatus} */ ('planned'),
          summary: 'Planned local finalize run.',
          phase: 'run',
          at: new Date('2024-01-01T00:10:00.000Z'),
        }),
      /must use a terminal status/,
    );

    const stored = JSON.parse(await readFile(initial.statePath, 'utf8'));
    assert.equal(stored.status, 'running');
    assert.equal(stored.lastEvent.event, 'run.started');
    assert.equal(stored.lastEvent.status, 'running');
  });

  it('05: maps operation-specific run results to terminal run statuses', () => {
    assert.equal(mapLocalRunResultStatusToTerminalStatus('planned'), 'accepted');
    assert.equal(mapLocalRunResultStatusToTerminalStatus('skipped'), 'accepted');
    assert.equal(mapLocalRunResultStatusToTerminalStatus('accepted'), 'accepted');
    assert.equal(mapLocalRunResultStatusToTerminalStatus('blocked'), 'blocked');
    assert.equal(mapLocalRunResultStatusToTerminalStatus('refused'), 'refused');
    assert.equal(mapLocalRunResultStatusToTerminalStatus('failed'), 'failed');
    assert.throws(
      () =>
        mapLocalRunResultStatusToTerminalStatus(
          /** @type {import('./types.js').LocalRunResultStatus} */ ('running'),
        ),
      /Unsupported local run result status "running"/,
    );
  });
});
