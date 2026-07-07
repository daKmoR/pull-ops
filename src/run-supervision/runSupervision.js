import { dirname } from 'node:path';

import {
  readLocalRunState,
  recordLocalRunCompletedNonHeartbeatStep,
  recordLocalRunHeartbeat,
} from '../local-run-state/localRunState.js';
import { publishHeartbeatToParentEventSink } from '../parent-event-sink/parentEventSink.js';
import { isHeartbeatDue, readHeartbeatIntervalMs } from './supervisionPolicy.js';

/**
 * PullOps Run Supervision: the module that carries run liveness and progress
 * signals between an active worker and its supervisor. The reporter facet
 * (heartbeats, progress events, summaries) is used by the active worker; the
 * observer facet (isRunLive, classifyRunStall) is used by the supervisor.
 * PullOps Run State is the durable adapter and the PullOps Parent Event Sink
 * is the live-transport adapter behind this seam. The module classifies
 * stalls but never intervenes.
 *
 * @typedef {import('./types.js').HeartbeatDelivery} HeartbeatDelivery
 * @typedef {import('./types.js').HeartbeatIfDueResult} HeartbeatIfDueResult
 */

export {
  COMPLETED_NON_HEARTBEAT_STEPS_BEFORE_HEARTBEAT,
  DEFAULT_LOCAL_RUN_HEARTBEAT_INTERVAL_MS,
  DEFAULT_LOCAL_RUN_LEASE_DURATION_MS,
  LOCAL_RUN_HEARTBEAT_COMMAND,
  classifyRunStall,
  isHeartbeatDue,
  isRunLive,
  readHeartbeatIntervalMs,
} from './supervisionPolicy.js';
export { createOperationProgressEventWriter, isSemanticProgressEvent } from './progressEvents.js';

/**
 * Records a PullOps Heartbeat durably and, when a PullOps Parent Event Sink
 * is configured in the environment, publishes it as a live Child Heartbeat
 * Event. Sink delivery failures degrade to a warning; the durable record is
 * the source of truth.
 *
 * @param {{
 *   statePath: string,
 *   token: string,
 *   summary?: string,
 *   at?: Date,
 *   env: NodeJS.ProcessEnv,
 * }} options
 * @returns {Promise<HeartbeatDelivery>}
 */
export async function recordHeartbeatAndPublish({ statePath, token, summary, at, env }) {
  const runState = await recordLocalRunHeartbeat({ statePath, token, summary, at });
  const sinkDelivery = await publishHeartbeatToParentEventSink({
    env,
    localRunRecord: dirname(statePath),
    runState,
  });
  return {
    runState,
    ...(sinkDelivery.warning === undefined ? {} : { warning: sinkDelivery.warning }),
  };
}

/**
 * Records a heartbeat only when the supervision policy says one is due.
 *
 * @param {{
 *   statePath: string,
 *   token: string,
 *   summary: string,
 *   force?: boolean,
 *   now?: () => Date,
 *   env: NodeJS.ProcessEnv,
 * }} options
 * @returns {Promise<HeartbeatIfDueResult>}
 */
export async function recordHeartbeatIfDue({
  statePath,
  token,
  summary,
  force = false,
  now = () => new Date(),
  env,
}) {
  const state = await readLocalRunState(statePath);
  const heartbeatIntervalMs = readHeartbeatIntervalMs(state);
  if (!isHeartbeatDue(state, { force, now: now() })) {
    return { emitted: false, heartbeatIntervalMs };
  }

  const delivery = await recordHeartbeatAndPublish({
    statePath,
    token,
    summary,
    at: now(),
    env,
  });
  return {
    emitted: true,
    heartbeatIntervalMs: readHeartbeatIntervalMs(delivery.runState),
    ...(delivery.warning === undefined ? {} : { warning: delivery.warning }),
  };
}

/**
 * Starts the periodic heartbeat loop for a long-running worker step.
 * Failures never interrupt the wrapped work: sink warnings and heartbeat
 * errors are reported through the callbacks.
 *
 * @param {{
 *   statePath: string,
 *   token: string,
 *   summary: string,
 *   intervalMs: number,
 *   now?: () => Date,
 *   env: NodeJS.ProcessEnv,
 *   onWarning?: (warning: string) => void,
 *   onError?: (error: unknown) => void,
 * }} options
 * @returns {{ stop: () => Promise<void> }}
 */
export function startPeriodicHeartbeats({
  statePath,
  token,
  summary,
  intervalMs,
  now = () => new Date(),
  env,
  onWarning,
  onError,
}) {
  /** @type {Promise<void>} */
  let heartbeatWrite = Promise.resolve();
  const timer = setInterval(() => {
    heartbeatWrite = heartbeatWrite
      .catch(() => undefined)
      .then(async () => {
        const delivery = await recordHeartbeatAndPublish({
          statePath,
          token,
          summary,
          at: now(),
          env,
        });
        if (delivery.warning !== undefined) {
          onWarning?.(delivery.warning);
        }
      })
      .catch(error => {
        onError?.(error);
      });
  }, intervalMs);

  return {
    stop: async () => {
      clearInterval(timer);
      await heartbeatWrite.catch(() => undefined);
    },
  };
}

/**
 * Records that the worker completed a non-heartbeat step. The supervision
 * policy counts these toward the next due heartbeat.
 *
 * @param {{ statePath: string }} options
 * @returns {Promise<void>}
 */
export async function recordCompletedStep({ statePath }) {
  await recordLocalRunCompletedNonHeartbeatStep({ statePath });
}
