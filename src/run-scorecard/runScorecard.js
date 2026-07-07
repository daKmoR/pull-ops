import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { LOCAL_RUN_STATE_FILE_NAME, readLocalRunState } from '../local-run-state/localRunState.js';

/**
 * @typedef {import('./types.js').RunScorecard} RunScorecard
 * @typedef {import('./types.js').RunScorecardGroup} RunScorecardGroup
 * @typedef {import('./types.js').RunScorecardModelTierGroup} RunScorecardModelTierGroup
 * @typedef {import('./types.js').RunScorecardOperationGroup} RunScorecardOperationGroup
 * @typedef {import('./types.js').RunScorecardSkippedRunRecord} RunScorecardSkippedRunRecord
 * @typedef {import('./types.js').RunScorecardStatusCounts} RunScorecardStatusCounts
 * @typedef {import('../local-run-state/types.js').LocalRunState} LocalRunState
 */

const RUN_SCORECARD_SCHEMA_VERSION = 1;
const UNKNOWN_MODEL_TIER = 'unknown';
const RENDERED_SKIPPED_RUN_RECORDS = 5;

/**
 * Aggregate the Local Run Records under one runs directory into a Run
 * Scorecard. Records that cannot be read stay visible as skipped entries
 * instead of failing the whole scorecard, and unknown Run Duration or
 * Context Usage stays unknown rather than being estimated.
 *
 * @param {{ runsDirectory: string }} options
 * @returns {Promise<RunScorecard>}
 */
export async function readRunScorecard({ runsDirectory }) {
  /** @type {RunScorecardSkippedRunRecord[]} */
  const skippedRunRecords = [];
  /** @type {{ state: LocalRunState, modelTier: string }[]} */
  const runs = [];

  for (const runId of await readRunRecordIds(runsDirectory)) {
    const runRecordDirectory = join(runsDirectory, runId);
    try {
      const state = await readLocalRunState(join(runRecordDirectory, LOCAL_RUN_STATE_FILE_NAME));
      if (!isScorecardStatus(normalizeScorecardStatus(state.status))) {
        skippedRunRecords.push({
          runId,
          reason: `Unsupported run status "${state.status}".`,
        });
        continue;
      }

      runs.push({
        state,
        modelTier: await readRunRecordModelTier(runRecordDirectory),
      });
    } catch (error) {
      skippedRunRecords.push({ runId, reason: getErrorMessage(error) });
    }
  }

  return {
    schemaVersion: RUN_SCORECARD_SCHEMA_VERSION,
    runsDirectory,
    totals: createGroup(runs),
    operations: createOperationGroups(runs),
    skippedRunRecords,
  };
}

/**
 * Render a Run Scorecard as a human-readable summary.
 *
 * @param {RunScorecard} scorecard
 * @returns {string}
 */
export function renderRunScorecard(scorecard) {
  const lines = [`Run Scorecard for ${scorecard.runsDirectory}`];

  if (scorecard.totals.runs === 0) {
    lines.push('No readable Local Run Records found.');
  } else {
    lines.push(...renderGroupLines(scorecard.totals, ''));
    lines.push('', 'By operation:');
    for (const operation of scorecard.operations) {
      lines.push(`  ${operation.operationReference}`);
      lines.push(...renderGroupLines(operation, '    '));
      for (const tier of operation.modelTiers) {
        lines.push(`    model tier ${tier.modelTier}`);
        lines.push(...renderGroupLines(tier, '      '));
      }
    }
  }

  if (scorecard.skippedRunRecords.length > 0) {
    lines.push('', `Skipped run records: ${scorecard.skippedRunRecords.length}`);
    for (const skipped of scorecard.skippedRunRecords.slice(0, RENDERED_SKIPPED_RUN_RECORDS)) {
      lines.push(`  ${skipped.runId}: ${skipped.reason}`);
    }
    if (scorecard.skippedRunRecords.length > RENDERED_SKIPPED_RUN_RECORDS) {
      const remaining = scorecard.skippedRunRecords.length - RENDERED_SKIPPED_RUN_RECORDS;
      lines.push(`  … and ${remaining} more; use --json for the full list.`);
    }
  }

  return lines.join('\n');
}

/**
 * @param {string} runsDirectory
 * @returns {Promise<string[]>}
 */
async function readRunRecordIds(runsDirectory) {
  try {
    const entries = await readdir(runsDirectory, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort();
  } catch (error) {
    if (isMissingDirectoryError(error)) {
      return [];
    }

    throw error;
  }
}

/**
 * @param {string} runRecordDirectory
 * @returns {Promise<string>}
 */
async function readRunRecordModelTier(runRecordDirectory) {
  try {
    const rawMetadata = await readFile(join(runRecordDirectory, 'metadata.json'), 'utf8');
    const metadata = JSON.parse(rawMetadata);
    if (
      typeof metadata === 'object' &&
      metadata !== null &&
      typeof metadata.modelTier === 'string' &&
      metadata.modelTier.trim() !== ''
    ) {
      return metadata.modelTier;
    }
  } catch {
    // Metadata is optional; runs without it group under the unknown tier.
  }

  return UNKNOWN_MODEL_TIER;
}

/**
 * @param {{ state: LocalRunState, modelTier: string }[]} runs
 * @returns {RunScorecardOperationGroup[]}
 */
function createOperationGroups(runs) {
  /** @type {Map<string, { state: LocalRunState, modelTier: string }[]>} */
  const byOperation = new Map();
  for (const run of runs) {
    const operationRuns = byOperation.get(run.state.normalizedOperationReference) ?? [];
    operationRuns.push(run);
    byOperation.set(run.state.normalizedOperationReference, operationRuns);
  }

  return [...byOperation.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([operationReference, operationRuns]) => ({
      operationReference,
      ...createGroup(operationRuns),
      modelTiers: createModelTierGroups(operationRuns),
    }));
}

/**
 * @param {{ state: LocalRunState, modelTier: string }[]} runs
 * @returns {RunScorecardModelTierGroup[]}
 */
function createModelTierGroups(runs) {
  /** @type {Map<string, { state: LocalRunState, modelTier: string }[]>} */
  const byModelTier = new Map();
  for (const run of runs) {
    const tierRuns = byModelTier.get(run.modelTier) ?? [];
    tierRuns.push(run);
    byModelTier.set(run.modelTier, tierRuns);
  }

  return [...byModelTier.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([modelTier, tierRuns]) => ({
      modelTier,
      ...createGroup(tierRuns),
    }));
}

/**
 * @param {{ state: LocalRunState }[]} runs
 * @returns {RunScorecardGroup}
 */
function createGroup(runs) {
  /** @type {RunScorecardStatusCounts} */
  const statuses = {
    accepted: 0,
    blocked: 0,
    refused: 0,
    failed: 0,
    running: 0,
    waiting: 0,
  };
  let knownDurationRuns = 0;
  let totalDurationMs = 0;
  let knownContextUsageRuns = 0;
  let totalUsedTokens = 0;

  for (const { state } of runs) {
    const status = normalizeScorecardStatus(state.status);
    if (isScorecardStatus(status)) {
      statuses[status] += 1;
    }

    const durationMs = readKnownRunDurationMs(state);
    if (durationMs !== undefined) {
      knownDurationRuns += 1;
      totalDurationMs += durationMs;
    }

    if (state.contextUsage !== undefined) {
      knownContextUsageRuns += 1;
      totalUsedTokens += state.contextUsage.used;
    }
  }

  const terminalRuns = statuses.accepted + statuses.blocked + statuses.refused + statuses.failed;
  return {
    runs: runs.length,
    terminalRuns,
    statuses,
    ...(terminalRuns === 0 ? {} : { acceptedRate: statuses.accepted / terminalRuns }),
    ...(terminalRuns === 0 ? {} : { blockedRate: statuses.blocked / terminalRuns }),
    duration: {
      knownRuns: knownDurationRuns,
      totalMs: totalDurationMs,
      ...(knownDurationRuns === 0
        ? {}
        : { averageMs: Math.round(totalDurationMs / knownDurationRuns) }),
    },
    contextUsage: {
      knownRuns: knownContextUsageRuns,
      totalUsedTokens,
    },
  };
}

/**
 * Read a run's known Run Duration. Prefer the recorded durationMs and fall
 * back to the recorded start and finish timestamps; anything else stays
 * unknown.
 *
 * @param {LocalRunState} state
 * @returns {number | undefined}
 */
function readKnownRunDurationMs(state) {
  if (typeof state.durationMs === 'number') {
    return state.durationMs;
  }

  if (state.startedAt === undefined || state.finishedAt === undefined) {
    return undefined;
  }

  const startedMs = Date.parse(state.startedAt);
  const finishedMs = Date.parse(state.finishedAt);
  if (Number.isNaN(startedMs) || Number.isNaN(finishedMs) || finishedMs < startedMs) {
    return undefined;
  }

  return finishedMs - startedMs;
}

/**
 * Legacy Local Run Records may carry the retired skipped status, which maps
 * to accepted exactly like skipped operation results do.
 *
 * @param {string} status
 * @returns {string}
 */
function normalizeScorecardStatus(status) {
  return status === 'skipped' ? 'accepted' : status;
}

/**
 * @param {string} status
 * @returns {status is keyof RunScorecardStatusCounts}
 */
function isScorecardStatus(status) {
  return (
    status === 'accepted' ||
    status === 'blocked' ||
    status === 'refused' ||
    status === 'failed' ||
    status === 'running' ||
    status === 'waiting'
  );
}

/**
 * @param {RunScorecardGroup} group
 * @param {string} indent
 * @returns {string[]}
 */
function renderGroupLines(group, indent) {
  const { statuses } = group;
  const lines = [
    `${indent}Runs: ${group.runs} (terminal ${group.terminalRuns}, running ${statuses.running}, waiting ${statuses.waiting})`,
    `${indent}Accepted: ${statuses.accepted}${renderRate(group.acceptedRate)}, blocked (human required): ${statuses.blocked}${renderRate(group.blockedRate)}, refused: ${statuses.refused}, failed: ${statuses.failed}`,
  ];

  lines.push(
    group.duration.knownRuns === 0
      ? `${indent}Run Duration: unknown`
      : `${indent}Run Duration: known for ${group.duration.knownRuns} runs, total ${renderDuration(group.duration.totalMs)}, average ${renderDuration(group.duration.averageMs ?? 0)}`,
  );
  lines.push(
    group.contextUsage.knownRuns === 0
      ? `${indent}Context Usage: unknown`
      : `${indent}Context Usage: known for ${group.contextUsage.knownRuns} runs, ${group.contextUsage.totalUsedTokens} tokens used`,
  );

  return lines;
}

/**
 * @param {number | undefined} rate
 * @returns {string}
 */
function renderRate(rate) {
  return rate === undefined ? '' : ` (${Math.round(rate * 100)}%)`;
}

/**
 * @param {number} durationMs
 * @returns {string}
 */
function renderDuration(durationMs) {
  const totalSeconds = Math.round(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isMissingDirectoryError(error) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    /** @type {{ code?: unknown }} */ (error).code === 'ENOENT'
  );
}
