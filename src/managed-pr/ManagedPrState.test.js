import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { PULL_OPS_OPERATION_LABELS } from '../labels/pullOpsLabels.js';
import {
  applyManagedPrTransition,
  createManagedPrStateSection,
  readManagedPrState,
  refusePrOperationTarget,
} from './ManagedPrState.js';

/**
 * @typedef {import('../github/types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('../github/types.js').UpdatePullRequestBodyOptions} UpdatePullRequestBodyOptions
 * @typedef {import('../github/types.js').EditLabelsOptions} EditLabelsOptions
 * @typedef {import('../github/types.js').CommentOnPullRequestOptions} CommentOnPullRequestOptions
 */

describe('ManagedPrState', () => {
  it('01: creates and reads the PullOps-managed PR State Marker', () => {
    const section = createManagedPrStateSection({
      status: 'Draft automation',
      source: {
        kind: 'issue',
        number: 42,
      },
      branchName: 'pullops/issue-42',
      triggerActor: 'octocat',
      runnerTask: 'pullops-issue-implement',
      modelTier: 'high',
      model: 'gpt-test',
      lastOperation: PULL_OPS_OPERATION_LABELS.issueImplement,
      reviewCycles: {
        current: 0,
        max: 3,
      },
      ciFixCycles: {
        current: 0,
        max: 2,
      },
    });

    const state = readManagedPrState(
      ['## Summary', '', 'Implemented work.', '', section].join('\n'),
    );

    assert.equal(state.managed, true);
    assert.equal(state.sourceIssueNumber, 42);
    assert.equal(state.sourceKind, 'issue');
    assert.equal(state.lastOperation, PULL_OPS_OPERATION_LABELS.issueImplement);
    assert.deepEqual(state.reviewCycles, { current: 0, max: 3 });
    assert.deepEqual(state.ciFixCycles, { current: 0, max: 2 });
    assert.match(section, /Triggered by: @octocat/);
  });

  it('02: applies approved review transitions and routes to finalize', async () => {
    const github = createFakeGitHub();

    await applyManagedPrTransition({
      githubClient: github.client,
      pullRequest: createPullRequest({
        body: createManagedBody({ lastOperation: PULL_OPS_OPERATION_LABELS.issueImplement }),
      }),
      operation: PULL_OPS_OPERATION_LABELS.prReview,
      outcome: {
        kind: 'approved',
        reviewCycle: 2,
        maxReviewCycles: 3,
        reviewedTreeHash: 'tree-reviewed',
      },
    });

    assert.match(github.updatedBodies[0].body, /Status: Review approved/);
    assert.match(github.updatedBodies[0].body, /Review cycles: 2 \/ 3/);
    assert.match(github.updatedBodies[0].body, /Reviewed tree: tree-reviewed/);
    assert.deepEqual(github.pullRequestLabelsRemoved, [
      {
        number: 100,
        labels: [
          'pullops:pr:review',
          'pullops:status:in-progress',
          'pullops:status:blocked',
          'pullops:status:prepared',
          'pullops:status:done',
          'pullops:status:failed',
        ],
      },
    ]);
    assert.deepEqual(github.pullRequestLabelsAdded, [
      {
        number: 100,
        labels: ['pullops:pr:finalize'],
      },
    ]);
  });

  it('03: preserves finalize review-approval status-label behavior', async () => {
    const github = createFakeGitHub();

    await applyManagedPrTransition({
      githubClient: github.client,
      pullRequest: createPullRequest({
        body: createManagedBody({ lastOperation: PULL_OPS_OPERATION_LABELS.prFinalize }),
      }),
      operation: PULL_OPS_OPERATION_LABELS.prReview,
      outcome: {
        kind: 'approved',
        reviewCycle: 3,
        maxReviewCycles: 3,
        reviewedTreeHash: 'tree-reviewed',
      },
    });

    assert.deepEqual(github.pullRequestLabelsAdded, [
      {
        number: 100,
        labels: ['pullops:status:done'],
      },
    ]);
  });

  it('04: refuses non-managed PR targets without writing a PR State Marker', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'managed-pr-'));
    const github = createFakeGitHub();

    await refusePrOperationTarget({
      githubClient: github.client,
      outputDirectory,
      pullRequest: createPullRequest({
        body: '## Summary\n\nHuman-authored PR.',
      }),
      operation: PULL_OPS_OPERATION_LABELS.prReview,
      reason: 'PR #100 is not a PullOps-managed PR.',
    });

    assert.equal(github.updatedBodies.length, 0);
    assert.deepEqual(github.pullRequestLabelsAdded, [
      {
        number: 100,
        labels: ['pullops:status:blocked'],
      },
    ]);
    assert.match(github.comments[0].body, /not a PullOps-managed PR/);
    assert.equal(
      await readFile(join(outputDirectory, 'failure_reason.txt'), 'utf8'),
      'PR #100 is not a PullOps-managed PR.\n',
    );
  });
});

/**
 * @param {{ body?: string, lastOperation?: string }} [options]
 * @returns {GitHubPullRequest}
 */
function createPullRequest({ body = createManagedBody(), lastOperation } = {}) {
  return {
    number: 100,
    title: 'Example PR',
    url: 'https://github.test/pull/100',
    headRefName: 'pullops/issue-42',
    body: lastOperation === undefined ? body : createManagedBody({ lastOperation }),
    isDraft: true,
  };
}

/**
 * @param {{ lastOperation?: string }} [options]
 * @returns {string}
 */
function createManagedBody({ lastOperation = PULL_OPS_OPERATION_LABELS.issueImplement } = {}) {
  return [
    '## Summary',
    '',
    'Implemented work.',
    '',
    '## PullOps',
    '',
    'Managed PR: yes',
    'Status: Draft automation',
    'Review cycles: 1 / 3',
    'CI fix cycles: 0 / 2',
    'Source: Issue #42',
    'Branch: pullops/issue-42',
    'Triggered by: @octocat',
    'Runner task: pullops-issue-implement',
    'Model tier: high',
    'Model: gpt-test',
    `Last operation: ${lastOperation}`,
  ].join('\n');
}

/**
 * @returns {{
 *   client: import('../github/types.js').GitHubClient;
 *   updatedBodies: UpdatePullRequestBodyOptions[];
 *   pullRequestLabelsAdded: EditLabelsOptions[];
 *   pullRequestLabelsRemoved: EditLabelsOptions[];
 *   comments: CommentOnPullRequestOptions[];
 * }}
 */
function createFakeGitHub() {
  /** @type {UpdatePullRequestBodyOptions[]} */
  const updatedBodies = [];
  /** @type {EditLabelsOptions[]} */
  const pullRequestLabelsAdded = [];
  /** @type {EditLabelsOptions[]} */
  const pullRequestLabelsRemoved = [];
  /** @type {CommentOnPullRequestOptions[]} */
  const comments = [];

  return {
    updatedBodies,
    pullRequestLabelsAdded,
    pullRequestLabelsRemoved,
    comments,
    client: {
      async ensureLabels() {
        throw new Error('ensureLabels was not expected in this test.');
      },
      async getIssue() {
        throw new Error('getIssue was not expected in this test.');
      },
      async getPullRequest() {
        throw new Error('getPullRequest was not expected in this test.');
      },
      async getPullRequestChecks() {
        throw new Error('getPullRequestChecks was not expected in this test.');
      },
      async getPullRequestChecksForRef() {
        throw new Error('getPullRequestChecksForRef was not expected in this test.');
      },
      async getPullRequestReviewContext() {
        throw new Error('getPullRequestReviewContext was not expected in this test.');
      },
      async getPullRequestDiff() {
        throw new Error('getPullRequestDiff was not expected in this test.');
      },
      async findOpenPullRequestByHead() {
        throw new Error('findOpenPullRequestByHead was not expected in this test.');
      },
      async createDraftPullRequest() {
        throw new Error('createDraftPullRequest was not expected in this test.');
      },
      async addLabelsToIssue() {
        throw new Error('addLabelsToIssue was not expected in this test.');
      },
      async removeLabelsFromIssue() {
        throw new Error('removeLabelsFromIssue was not expected in this test.');
      },
      async updatePullRequestBody(options) {
        updatedBodies.push(options);
      },
      async addLabelsToPullRequest(options) {
        pullRequestLabelsAdded.push(options);
      },
      async removeLabelsFromPullRequest(options) {
        pullRequestLabelsRemoved.push(options);
      },
      async commentOnPullRequest(options) {
        comments.push(options);
      },
      async commentOnIssue() {
        throw new Error('commentOnIssue was not expected in this test.');
      },
      async closeIssue() {
        throw new Error('closeIssue was not expected in this test.');
      },
      async markPullRequestReadyForReview() {
        throw new Error('markPullRequestReadyForReview was not expected in this test.');
      },
      async publishPullRequestReview() {
        throw new Error('publishPullRequestReview was not expected in this test.');
      },
      async replyToPullRequestReviewComment() {
        throw new Error('replyToPullRequestReviewComment was not expected in this test.');
      },
      async resolvePullRequestReviewThread() {
        throw new Error('resolvePullRequestReviewThread was not expected in this test.');
      },
    },
  };
}
