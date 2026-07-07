import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  initializeLocalRunState,
  recordLocalRunTerminalStatus,
} from '../local-run-state/localRunState.js';
import { readRunScorecard, renderRunScorecard } from './runScorecard.js';

/**
 * @param {{
 *   runsDirectory: string,
 *   runId: string,
 *   operationReference: string,
 *   modelTier?: string,
 *   terminal?: {
 *     status: import('../local-run-state/types.js').LocalRunTerminalStatus,
 *     atMs: number,
 *     contextUsage?: import('../local-run-state/types.js').LocalRunContextUsage,
 *   },
 * }} options
 */
async function writeRunRecordFixture({
  runsDirectory,
  runId,
  operationReference,
  modelTier,
  terminal,
}) {
  const runRecordDirectory = join(runsDirectory, runId);
  const createdAt = new Date('2026-07-01T00:00:00.000Z');
  const stateRecord = await initializeLocalRunState({
    runRecordDirectory,
    operationReference,
    target: { type: 'issue', number: 7 },
    publicationMode: 'dry-run',
    createdAt,
  });

  if (modelTier !== undefined) {
    await writeFile(
      join(runRecordDirectory, 'metadata.json'),
      `${JSON.stringify({ operationReference, modelTier }, null, 2)}\n`,
    );
  }

  if (terminal !== undefined) {
    await recordLocalRunTerminalStatus({
      statePath: stateRecord.statePath,
      status: terminal.status,
      summary: `Fixture run finished as ${terminal.status}.`,
      at: new Date(createdAt.getTime() + terminal.atMs),
      contextUsage: terminal.contextUsage,
    });
  }
}

describe('runScorecard', () => {
  it('01: aggregates Local Run Records by operation and model tier', async () => {
    const runsDirectory = await mkdtemp(join(tmpdir(), 'pullops-run-scorecard-'));

    await writeRunRecordFixture({
      runsDirectory,
      runId: 'run-a-issue-implement',
      operationReference: 'issue:implement',
      modelTier: 'high',
      terminal: {
        status: 'accepted',
        atMs: 600000,
        contextUsage: { used: 120000, limit: 272000 },
      },
    });
    await writeRunRecordFixture({
      runsDirectory,
      runId: 'run-b-issue-implement',
      operationReference: 'issue:implement',
      modelTier: 'high',
      terminal: { status: 'blocked', atMs: 300000 },
    });
    await writeRunRecordFixture({
      runsDirectory,
      runId: 'run-c-pr-review',
      operationReference: 'pr:review',
      terminal: {
        status: 'accepted',
        atMs: 120000,
        contextUsage: { used: 80000 },
      },
    });
    await writeRunRecordFixture({
      runsDirectory,
      runId: 'run-d-pr-review-active',
      operationReference: 'pr:review',
      modelTier: 'mid',
    });

    const scorecard = await readRunScorecard({ runsDirectory });

    assert.equal(scorecard.schemaVersion, 1);
    assert.equal(scorecard.runsDirectory, runsDirectory);
    assert.deepEqual(scorecard.skippedRunRecords, []);

    assert.equal(scorecard.totals.runs, 4);
    assert.equal(scorecard.totals.terminalRuns, 3);
    assert.deepEqual(scorecard.totals.statuses, {
      accepted: 2,
      blocked: 1,
      refused: 0,
      failed: 0,
      running: 1,
      waiting: 0,
    });
    assert.equal(scorecard.totals.acceptedRate, 2 / 3);
    assert.equal(scorecard.totals.blockedRate, 1 / 3);
    assert.deepEqual(scorecard.totals.duration, {
      knownRuns: 3,
      totalMs: 1020000,
      averageMs: 340000,
    });
    assert.deepEqual(scorecard.totals.contextUsage, {
      knownRuns: 2,
      totalUsedTokens: 200000,
    });

    assert.deepEqual(
      scorecard.operations.map(operation => operation.operationReference),
      ['issue-implement', 'pr-review'],
    );

    const issueImplement = scorecard.operations[0];
    assert.equal(issueImplement.runs, 2);
    assert.equal(issueImplement.terminalRuns, 2);
    assert.equal(issueImplement.acceptedRate, 0.5);
    assert.equal(issueImplement.duration.totalMs, 900000);
    assert.deepEqual(
      issueImplement.modelTiers.map(tier => tier.modelTier),
      ['high'],
    );
    assert.equal(issueImplement.modelTiers[0].runs, 2);

    const prReview = scorecard.operations[1];
    assert.equal(prReview.runs, 2);
    assert.equal(prReview.terminalRuns, 1);
    assert.deepEqual(
      prReview.modelTiers.map(tier => tier.modelTier),
      ['mid', 'unknown'],
    );
    assert.equal(prReview.contextUsage.totalUsedTokens, 80000);
  });

  it('02: returns an empty scorecard when the runs directory is missing', async () => {
    const missingDirectory = join(
      await mkdtemp(join(tmpdir(), 'pullops-run-scorecard-missing-')),
      'does-not-exist',
    );

    const scorecard = await readRunScorecard({ runsDirectory: missingDirectory });

    assert.equal(scorecard.totals.runs, 0);
    assert.deepEqual(scorecard.operations, []);
    assert.deepEqual(scorecard.skippedRunRecords, []);
  });

  it('03: keeps unreadable run records visible as skipped entries', async () => {
    const runsDirectory = await mkdtemp(join(tmpdir(), 'pullops-run-scorecard-skip-'));

    await writeRunRecordFixture({
      runsDirectory,
      runId: 'run-a-usable',
      operationReference: 'issue:implement',
      terminal: { status: 'accepted', atMs: 60000 },
    });

    const brokenDirectory = join(runsDirectory, 'run-b-broken');
    await mkdir(brokenDirectory, { recursive: true });
    await writeFile(join(brokenDirectory, 'state.json'), '{"schemaVersion":');

    await mkdir(join(runsDirectory, 'run-c-missing-state'), { recursive: true });

    const scorecard = await readRunScorecard({ runsDirectory });

    assert.equal(scorecard.totals.runs, 1);
    assert.equal(scorecard.skippedRunRecords.length, 2);
    assert.deepEqual(
      scorecard.skippedRunRecords.map(skipped => skipped.runId),
      ['run-b-broken', 'run-c-missing-state'],
    );
    assert.match(scorecard.skippedRunRecords[0].reason, /must be valid JSON/);
  });

  it('04: renders a human-readable summary with rates, durations, and usage', async () => {
    const runsDirectory = await mkdtemp(join(tmpdir(), 'pullops-run-scorecard-render-'));

    await writeRunRecordFixture({
      runsDirectory,
      runId: 'run-a-issue-implement',
      operationReference: 'issue:implement',
      modelTier: 'high',
      terminal: {
        status: 'accepted',
        atMs: 90000,
        contextUsage: { used: 50000 },
      },
    });
    await writeRunRecordFixture({
      runsDirectory,
      runId: 'run-b-issue-implement',
      operationReference: 'issue:implement',
      modelTier: 'high',
      terminal: { status: 'blocked', atMs: 30000 },
    });

    const rendered = renderRunScorecard(await readRunScorecard({ runsDirectory }));

    assert.match(rendered, /Run Scorecard for /);
    assert.match(rendered, /Runs: 2 \(terminal 2, running 0, waiting 0\)/);
    assert.match(rendered, /Accepted: 1 \(50%\), blocked \(human required\): 1 \(50%\)/);
    assert.match(rendered, /Run Duration: known for 2 runs, total 2m 0s, average 1m 0s/);
    assert.match(rendered, /Context Usage: known for 1 runs, 50000 tokens used/);
    assert.match(rendered, /By operation:/);
    assert.match(rendered, / {2}issue-implement/);
    assert.match(rendered, / {4}model tier high/);
  });

  it('05: renders an empty scorecard without failing', async () => {
    const runsDirectory = join(
      await mkdtemp(join(tmpdir(), 'pullops-run-scorecard-empty-')),
      'does-not-exist',
    );

    const rendered = renderRunScorecard(await readRunScorecard({ runsDirectory }));

    assert.match(rendered, /No readable Local Run Records found\./);
  });
});
