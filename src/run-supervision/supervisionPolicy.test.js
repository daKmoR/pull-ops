import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyRunStall,
  DEFAULT_LOCAL_RUN_HEARTBEAT_INTERVAL_MS,
  isHeartbeatDue,
  isRunLive,
  readHeartbeatIntervalMs,
} from './supervisionPolicy.js';

const NOW = new Date('2026-07-07T12:00:00.000Z');

describe('Test supervisionPolicy', () => {
  it('01: first heartbeat is always due', () => {
    const state = createRunState({ heartbeatCount: 0 });
    assert.equal(isHeartbeatDue(state, { now: NOW }), true);
  });

  it('02: heartbeat is due after the interval elapses, not before', () => {
    const recent = createRunState({
      heartbeatAt: new Date(NOW.getTime() - 60 * 1000).toISOString(),
    });
    assert.equal(isHeartbeatDue(recent, { now: NOW }), false);

    const overdue = createRunState({
      heartbeatAt: new Date(NOW.getTime() - DEFAULT_LOCAL_RUN_HEARTBEAT_INTERVAL_MS).toISOString(),
    });
    assert.equal(isHeartbeatDue(overdue, { now: NOW }), true);
  });

  it('03: heartbeat is due after enough completed non-heartbeat steps', () => {
    const state = createRunState({
      heartbeatAt: new Date(NOW.getTime() - 1000).toISOString(),
      completedNonHeartbeatStepsSinceHeartbeat: 3,
    });
    assert.equal(isHeartbeatDue(state, { now: NOW }), true);
  });

  it('04: force always makes a heartbeat due', () => {
    const state = createRunState({
      heartbeatAt: new Date(NOW.getTime() - 1000).toISOString(),
    });
    assert.equal(isHeartbeatDue(state, { force: true, now: NOW }), true);
  });

  it('05: a run is live only while its lease is active and status is not terminal', () => {
    const live = createRunState({
      leaseExpiresAt: new Date(NOW.getTime() + 1000).toISOString(),
    });
    assert.equal(isRunLive(live, { now: NOW }), true);

    const expired = createRunState({
      leaseExpiresAt: new Date(NOW.getTime() - 1000).toISOString(),
    });
    assert.equal(isRunLive(expired, { now: NOW }), false);

    const terminal = createRunState({
      status: 'accepted',
      leaseExpiresAt: new Date(NOW.getTime() + 1000).toISOString(),
    });
    assert.equal(isRunLive(terminal, { now: NOW }), false);
  });

  it('06: classifies terminal runs as not stalled', () => {
    const classification = classifyRunStall(createRunState({ status: 'blocked' }), { now: NOW });
    assert.equal(classification.stalled, false);
    assert.equal(classification.reason, 'terminal-status');
  });

  it('07: classifies active leases as not stalled', () => {
    const classification = classifyRunStall(
      createRunState({ leaseExpiresAt: new Date(NOW.getTime() + 1000).toISOString() }),
      { now: NOW },
    );
    assert.equal(classification.stalled, false);
    assert.equal(classification.reason, 'lease-active');
  });

  it('08: a fresh live signal prevents a stall after lease expiry', () => {
    const state = createRunState({
      leaseExpiresAt: new Date(NOW.getTime() - 1000).toISOString(),
      leaseDurationMs: 8 * 60 * 1000,
    });
    const classification = classifyRunStall(state, {
      now: NOW,
      liveSignalAt: new Date(NOW.getTime() - 60 * 1000),
    });
    assert.equal(classification.stalled, false);
    assert.equal(classification.reason, 'live-signal');
  });

  it('09: classifies a stall only after lease expiry without a live signal', () => {
    const state = createRunState({
      leaseExpiresAt: new Date(NOW.getTime() - 30 * 1000).toISOString(),
    });
    const classification = classifyRunStall(state, { now: NOW });
    assert.equal(classification.stalled, true);
    assert.equal(classification.reason, 'lease-expired');
    assert.equal(classification.expiredForMs, 30 * 1000);
    assert.equal(classification.leaseExpiresAt, state.leaseExpiresAt);
  });

  it('10: falls back to the default heartbeat interval for invalid state values', () => {
    assert.equal(
      readHeartbeatIntervalMs(createRunState({ heartbeatIntervalMs: 0 })),
      DEFAULT_LOCAL_RUN_HEARTBEAT_INTERVAL_MS,
    );
    assert.equal(readHeartbeatIntervalMs(createRunState({ heartbeatIntervalMs: 1000 })), 1000);
  });
});

/**
 * @param {Partial<import('../local-run-state/types.js').LocalRunState>} overrides
 * @returns {import('../local-run-state/types.js').LocalRunState}
 */
function createRunState(overrides = {}) {
  return /** @type {import('../local-run-state/types.js').LocalRunState} */ ({
    schemaVersion: 1,
    runId: '2026-07-07T110000000Z-issue-implement-7',
    operationReference: 'issue:implement',
    normalizedOperationReference: 'issue-implement',
    target: { type: 'issue', number: 7 },
    publicationMode: 'dry-run',
    runGoal: 'operation',
    status: 'running',
    phase: 'run',
    heartbeatToken: 'token',
    heartbeatIntervalMs: DEFAULT_LOCAL_RUN_HEARTBEAT_INTERVAL_MS,
    leaseDurationMs: DEFAULT_LOCAL_RUN_HEARTBEAT_INTERVAL_MS * 2,
    heartbeatAt: new Date(NOW.getTime() - 1000).toISOString(),
    heartbeatCount: 1,
    completedNonHeartbeatStepsSinceHeartbeat: 0,
    leaseExpiresAt: new Date(NOW.getTime() + DEFAULT_LOCAL_RUN_HEARTBEAT_INTERVAL_MS).toISOString(),
    lastEvent: { event: 'run.started' },
    childRuns: [],
    ...overrides,
  });
}
