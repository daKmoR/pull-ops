/**
 * Pure supervision policy: the lease math, heartbeat cadence, and stall
 * classification rules that the active worker (reporter) and its supervisor
 * (observer) must agree on. Everything here is side-effect free; durable
 * state and live transport stay behind their adapters.
 *
 * @typedef {import('../local-run-state/types.js').LocalRunState} LocalRunState
 * @typedef {import('./types.js').RunStallClassification} RunStallClassification
 */

export const LOCAL_RUN_HEARTBEAT_COMMAND = 'npm exec -- pullops heartbeat';
export const DEFAULT_LOCAL_RUN_HEARTBEAT_INTERVAL_MS = 4 * 60 * 1000;
export const DEFAULT_LOCAL_RUN_LEASE_DURATION_MS = DEFAULT_LOCAL_RUN_HEARTBEAT_INTERVAL_MS * 2;
export const COMPLETED_NON_HEARTBEAT_STEPS_BEFORE_HEARTBEAT = 3;

const TERMINAL_RUN_STATUSES = new Set(['accepted', 'blocked', 'refused', 'failed', 'skipped']);

/**
 * @param {LocalRunState} state
 * @returns {number}
 */
export function readHeartbeatIntervalMs(state) {
  return state.heartbeatIntervalMs > 0
    ? state.heartbeatIntervalMs
    : DEFAULT_LOCAL_RUN_HEARTBEAT_INTERVAL_MS;
}

/**
 * @param {LocalRunState} state
 * @param {{ force?: boolean, now?: Date }} [options]
 * @returns {boolean}
 */
export function isHeartbeatDue(state, { force = false, now = new Date() } = {}) {
  if (force) {
    return true;
  }

  if ((state.heartbeatCount ?? 0) === 0) {
    return true;
  }

  const heartbeatAt = Date.parse(state.heartbeatAt);
  if (
    !Number.isFinite(heartbeatAt) ||
    now.getTime() - heartbeatAt >= readHeartbeatIntervalMs(state)
  ) {
    return true;
  }

  return (
    (state.completedNonHeartbeatStepsSinceHeartbeat ?? 0) >=
    COMPLETED_NON_HEARTBEAT_STEPS_BEFORE_HEARTBEAT
  );
}

/**
 * @param {LocalRunState} state
 * @param {{ now?: Date }} [options]
 * @returns {boolean}
 */
export function isRunLive(state, { now = new Date() } = {}) {
  if (isTerminalRunStatus(state.status)) {
    return false;
  }

  const leaseExpiresAt = Date.parse(state.leaseExpiresAt);
  return Number.isFinite(leaseExpiresAt) && now.getTime() < leaseExpiresAt;
}

/**
 * Classifies whether a running PullOps worker appears stalled. A stall is
 * only classified after lease expiry AND liveness reconciliation: pass the
 * freshest live observation (for nested runs, a Child Heartbeat Event) as
 * `liveSignalAt`, and re-read durable run state before calling.
 *
 * @param {LocalRunState} state
 * @param {{ now?: Date, liveSignalAt?: Date }} [options]
 * @returns {RunStallClassification}
 */
export function classifyRunStall(state, { now = new Date(), liveSignalAt } = {}) {
  const base = {
    status: state.status,
    leaseExpiresAt: state.leaseExpiresAt,
    lastHeartbeatAt: state.heartbeatAt,
    heartbeatCount: state.heartbeatCount ?? 0,
  };

  if (isTerminalRunStatus(state.status)) {
    return { stalled: false, reason: 'terminal-status', ...base };
  }

  const leaseExpiresAt = Date.parse(state.leaseExpiresAt);
  if (Number.isFinite(leaseExpiresAt) && now.getTime() < leaseExpiresAt) {
    return { stalled: false, reason: 'lease-active', ...base };
  }

  if (
    liveSignalAt !== undefined &&
    now.getTime() - liveSignalAt.getTime() < state.leaseDurationMs
  ) {
    return { stalled: false, reason: 'live-signal', ...base };
  }

  return {
    stalled: true,
    reason: 'lease-expired',
    ...base,
    expiredForMs: Number.isFinite(leaseExpiresAt) ? Math.max(0, now.getTime() - leaseExpiresAt) : 0,
  };
}

/**
 * @param {string} status
 * @returns {boolean}
 */
function isTerminalRunStatus(status) {
  return TERMINAL_RUN_STATUSES.has(status);
}
