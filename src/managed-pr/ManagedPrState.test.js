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
  requestManagedPrReview,
  resumeManagedPrWorkflow,
  refusePrOperationTarget,
  updateManagedPrState,
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
    assert.deepEqual(state.escalationReviewCycles, { current: 0, max: 1 });
    assert.equal(state.humanFeedbackResponseStateMarkersPresent, true);
    assert.equal(state.humanFeedbackResponseCycles, 0);
    assert.deepEqual(state.processedHumanFeedbackReviewIds, []);
    assert.equal(state.pendingHumanFeedbackReviewId, undefined);
    assert.match(section, /^Managed: yes$/m);
    assert.doesNotMatch(section, /Managed PR: yes/);
    assert.match(section, /<summary>PullOps workflow state<\/summary>/);
    assert.match(section, /Escalation review cycles: 0 \/ 1/);
    assert.match(section, /Human feedback response cycles: 0/);
    assert.match(section, /Processed human feedback review ids: none/);
    assert.match(section, /Pending human feedback review id: none/);
    assert.doesNotMatch(section, /Triggered by:/);
    assert.doesNotMatch(section, /Model tier:/);
  });

  it('02: rejects old managed PR grammar and reads workflow markers only from the collapsed block', () => {
    const state = readManagedPrState(
      [
        '## PullOps',
        '',
        'Managed PR: yes',
        'Managed: yes',
        'Status: Draft automation',
        '',
        'Last operation: pullops:pr:review',
        '',
        '<details>',
        '<summary>PullOps workflow state</summary>',
        '',
        'Source: Issue #42',
        'Review cycles: 1 / 3',
        'CI fix cycles: 0 / 2',
        'Last operation: pullops:issue:implement',
        '',
        '</details>',
      ].join('\n'),
    );

    assert.equal(state.managed, true);
    assert.equal(state.lastOperation, PULL_OPS_OPERATION_LABELS.issueImplement);
    assert.equal(state.humanFeedbackResponseStateMarkersPresent, false);
    const oldGrammarState = readManagedPrState(
      '## PullOps\n\nManaged PR: yes\nStatus: Draft automation',
    );
    assert.equal(oldGrammarState.managed, false);
    assert.equal(oldGrammarState.status, 'Draft automation');
    assert.deepEqual(oldGrammarState.reviewCycles, { current: 0, max: 3 });
    assert.deepEqual(oldGrammarState.ciFixCycles, { current: 0, max: 2 });
    assert.equal(oldGrammarState.escalationReviewCycles, undefined);
    assert.equal(oldGrammarState.humanFeedbackResponseStateMarkersPresent, false);
    assert.equal(oldGrammarState.humanFeedbackResponseCycles, undefined);
    assert.equal(oldGrammarState.processedHumanFeedbackReviewIds, undefined);
    assert.equal(oldGrammarState.pendingHumanFeedbackReviewId, undefined);
  });

  it('15: parses and updates explicit special-review markers in the workflow state block', () => {
    const updatedBody = updateManagedPrState({
      body: createManagedBody({ lastOperation: PULL_OPS_OPERATION_LABELS.issueImplement }),
      status: 'Draft automation',
      reviewCycles: {
        current: 3,
        max: 3,
      },
      escalationReviewCycles: {
        current: 1,
        max: 1,
      },
      humanFeedbackResponseCycles: 2,
      processedHumanFeedbackReviewIds: ['review-1', 'review-2'],
      pendingHumanFeedbackReviewId: 'review-3',
      lastOperation: PULL_OPS_OPERATION_LABELS.prReview,
    });

    assert.match(updatedBody, /Escalation review cycles: 1 \/ 1/);
    assert.match(updatedBody, /Human feedback response cycles: 2/);
    assert.match(updatedBody, /Processed human feedback review ids: review-1, review-2/);
    assert.match(updatedBody, /Pending human feedback review id: review-3/);
    assert.match(updatedBody, /Review cycles: 3 \/ 3/);

    const state = readManagedPrState(updatedBody);
    assert.deepEqual(state.reviewCycles, { current: 3, max: 3 });
    assert.deepEqual(state.escalationReviewCycles, { current: 1, max: 1 });
    assert.equal(state.humanFeedbackResponseStateMarkersPresent, true);
    assert.equal(state.humanFeedbackResponseCycles, 2);
    assert.deepEqual(state.processedHumanFeedbackReviewIds, ['review-1', 'review-2']);
    assert.equal(state.pendingHumanFeedbackReviewId, 'review-3');
  });

  it('16: records review follow-up issue numbers in the workflow state block', () => {
    const updatedBody = updateManagedPrState({
      body: createManagedBody({ lastOperation: PULL_OPS_OPERATION_LABELS.issueImplement }),
      reviewFollowUpIssueNumbers: [501, 502],
    });

    assert.match(updatedBody, /Review follow-up issue numbers: #501, #502/);

    const state = readManagedPrState(updatedBody);
    assert.deepEqual(state.reviewFollowUpIssueNumbers, [501, 502]);
  });

  it('03: applies approved review transitions and routes to finalize', async () => {
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
    assert.match(
      github.updatedBodies[0].body,
      /<summary>PullOps workflow state<\/summary>[\s\S]*Reviewed tree: tree-reviewed/,
    );
    assert.deepEqual(github.pullRequestLabelsRemoved, [
      {
        number: 100,
        labels: [
          'pullops:pr:review',
          'pullops:pr:finalize',
          'pullops:human-required',
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

  it('04: leaves final review approvals ready for human merge without status labels', async () => {
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

    assert.match(github.updatedBodies[0].body, /Status: Ready for human merge/);
    assert.deepEqual(github.pullRequestLabelsAdded, []);
  });

  it('05: suppresses follow-up operation labels for local direct transitions', async () => {
    const github = createFakeGitHub();

    const result = await applyManagedPrTransition({
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
      suppressFollowUpOperationLabels: true,
    });

    assert.match(github.updatedBodies[0].body, /Status: Review approved/);
    assert.match(github.updatedBodies[0].body, /Reviewed tree: tree-reviewed/);
    assert.deepEqual(github.pullRequestLabelsAdded, []);
    assert.equal(result.nextOperationLabel, undefined);
  });

  it('06: clears stale merge preparation markers after address-review feedback', async () => {
    const github = createFakeGitHub();

    await applyManagedPrTransition({
      githubClient: github.client,
      pullRequest: createPullRequest({
        body: createManagedBody({
          status: 'Ready for human merge',
          lastOperation: PULL_OPS_OPERATION_LABELS.prFinalize,
          reviewedTreeHash: 'tree-reviewed',
          finalizedTreeHash: 'tree-finalized',
          finalizedHeadSha: 'head-finalized',
          mergeMethod: 'rebase',
        }),
      }),
      operation: PULL_OPS_OPERATION_LABELS.prAddressReview,
      outcome: {
        kind: 'addressed',
        reviewCycle: 2,
        maxReviewCycles: 3,
      },
    });

    assert.match(github.updatedBodies[0].body, /Status: Review feedback addressed/);
    assert.match(github.updatedBodies[0].body, /Review cycles: 2 \/ 3/);
    assert.match(github.updatedBodies[0].body, /Last operation: pullops:pr:address-review/);
    assert.doesNotMatch(github.updatedBodies[0].body, /Reviewed tree:/);
    assert.doesNotMatch(github.updatedBodies[0].body, /Finalized tree:/);
    assert.doesNotMatch(github.updatedBodies[0].body, /Finalized head:/);
    assert.doesNotMatch(github.updatedBodies[0].body, /Merge method:/);
    assert.deepEqual(github.pullRequestLabelsAdded, [
      {
        number: 100,
        labels: ['pullops:pr:review'],
      },
    ]);
  });

  it('07: refreshes stale PR operation labels before routing to the next operation', async () => {
    const github = createFakeGitHub();

    await applyManagedPrTransition({
      githubClient: github.client,
      pullRequest: createPullRequest({
        body: createManagedBody({
          status: 'Changes requested',
          lastOperation: PULL_OPS_OPERATION_LABELS.prReview,
        }),
        labels: [PULL_OPS_OPERATION_LABELS.prReview, PULL_OPS_OPERATION_LABELS.prAddressReview],
      }),
      operation: PULL_OPS_OPERATION_LABELS.prAddressReview,
      outcome: {
        kind: 'addressed',
        reviewCycle: 2,
        maxReviewCycles: 3,
      },
    });

    assert.deepEqual(github.pullRequestLabelsRemoved, [
      {
        number: 100,
        labels: [
          'pullops:pr:address-review',
          'pullops:pr:review',
          'pullops:human-required',
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
        labels: ['pullops:pr:review'],
      },
    ]);
  });

  it('08: refuses non-managed PR targets without writing a PR State Marker', async () => {
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
        labels: ['pullops:human-required'],
      },
    ]);
    assert.match(github.comments[0].body, /not a PullOps-managed PR/);
    assert.equal(
      await readFile(join(outputDirectory, 'failure_reason.txt'), 'utf8'),
      'PR #100 is not a PullOps-managed PR.\n',
    );
  });

  it('09: resumes a managed PR from approved review to finalize', async () => {
    const github = createFakeGitHub();

    const result = await resumeManagedPrWorkflow({
      githubClient: github.client,
      pullRequest: createPullRequest({
        body: createManagedBody({
          status: 'Review approved',
          reviewedTreeHash: 'tree-reviewed',
          lastOperation: PULL_OPS_OPERATION_LABELS.prReview,
        }),
      }),
    });

    assert.equal(result.status, 'resumed');
    assert.equal(result.nextOperation, PULL_OPS_OPERATION_LABELS.prFinalize);
    assert.deepEqual(github.pullRequestLabelsAdded, [
      {
        number: 100,
        labels: ['pullops:pr:finalize'],
      },
    ]);
  });

  it('10: leaves finalized managed PRs waiting for integration', async () => {
    const github = createFakeGitHub();

    const result = await resumeManagedPrWorkflow({
      githubClient: github.client,
      pullRequest: createPullRequest({
        body: createManagedBody({
          status: 'Ready for human merge',
          finalizedTreeHash: 'tree-finalized',
          finalizedHeadSha: 'head-finalized',
          mergeMethod: 'rebase',
          lastOperation: PULL_OPS_OPERATION_LABELS.prFinalize,
        }),
      }),
    });

    assert.equal(result.status, 'finalized');
    assert.deepEqual(github.pullRequestLabelsAdded, []);
  });

  it('11: requests managed PR review when no PR workflow is active', async () => {
    const github = createFakeGitHub();

    const result = await requestManagedPrReview({
      githubClient: github.client,
      pullRequest: createPullRequest({
        body: createManagedBody({
          status: 'Draft parent preparation',
          lastOperation: PULL_OPS_OPERATION_LABELS.prdPrepare,
        }),
      }),
    });

    assert.equal(result.status, 'review-requested');
    assert.deepEqual(github.pullRequestLabelsAdded, [
      {
        number: 100,
        labels: ['pullops:pr:review'],
      },
    ]);
  });

  it('12: does not route managed PRs that already have active workflow labels', async () => {
    const github = createFakeGitHub();

    const result = await requestManagedPrReview({
      githubClient: github.client,
      pullRequest: createPullRequest({
        labels: ['pullops:human-required'],
      }),
    });

    assert.equal(result.status, 'already-active');
    assert.deepEqual(github.pullRequestLabelsAdded, []);
  });

  it('13: applies clean branch update transitions without requesting review', async () => {
    const github = createFakeGitHub();

    await applyManagedPrTransition({
      githubClient: github.client,
      pullRequest: createPullRequest({
        body: createManagedBody({
          status: 'Ready for human merge',
          lastOperation: PULL_OPS_OPERATION_LABELS.prFinalize,
          reviewedTreeHash: 'tree-reviewed',
          finalizedTreeHash: 'tree-finalized',
          finalizedHeadSha: 'head-finalized',
          mergeMethod: 'rebase',
        }),
      }),
      operation: PULL_OPS_OPERATION_LABELS.prUpdateBranch,
      outcome: {
        kind: 'updated',
      },
    });

    assert.match(github.updatedBodies[0].body, /Status: Branch updated/);
    assert.match(github.updatedBodies[0].body, /Last operation: pullops:pr:update-branch/);
    assert.doesNotMatch(github.updatedBodies[0].body, /Reviewed tree:/);
    assert.doesNotMatch(github.updatedBodies[0].body, /Finalized tree:/);
    assert.doesNotMatch(github.updatedBodies[0].body, /Finalized head:/);
    assert.doesNotMatch(github.updatedBodies[0].body, /Merge method:/);
    assert.deepEqual(github.pullRequestLabelsAdded, []);
    assert.deepEqual(github.pullRequestLabelsRemoved, [
      {
        number: 100,
        labels: [
          'pullops:pr:update-branch',
          'pullops:human-required',
          'pullops:status:in-progress',
          'pullops:status:blocked',
          'pullops:status:prepared',
          'pullops:status:done',
          'pullops:status:failed',
        ],
      },
    ]);
  });

  it('14: clears stale finalization markers after a successful ci-fix on a ready finalized PR', async () => {
    const github = createFakeGitHub();

    await applyManagedPrTransition({
      githubClient: github.client,
      pullRequest: createPullRequest({
        body: createManagedBody({
          status: 'Ready for human merge',
          lastOperation: PULL_OPS_OPERATION_LABELS.prFinalize,
          reviewedTreeHash: 'tree-reviewed',
          finalizedTreeHash: 'tree-finalized',
          finalizedHeadSha: 'head-finalized',
          mergeMethod: 'rebase',
        }),
      }),
      operation: PULL_OPS_OPERATION_LABELS.prFixCi,
      outcome: {
        kind: 'fixed',
        ciFixCycle: 1,
        maxCiFixCycles: 2,
      },
    });

    assert.match(github.updatedBodies[0].body, /Status: CI fixed/);
    assert.match(github.updatedBodies[0].body, /CI fix cycles: 1 \/ 2/);
    assert.match(github.updatedBodies[0].body, /Last operation: pullops:pr:fix-ci/);
    assert.doesNotMatch(github.updatedBodies[0].body, /Reviewed tree:/);
    assert.doesNotMatch(github.updatedBodies[0].body, /Finalized tree:/);
    assert.doesNotMatch(github.updatedBodies[0].body, /Finalized head:/);
    assert.doesNotMatch(github.updatedBodies[0].body, /Merge method:/);
    assert.deepEqual(github.pullRequestLabelsAdded, [
      {
        number: 100,
        labels: ['pullops:pr:review'],
      },
    ]);
  });
});

/**
 * @param {{ body?: string, lastOperation?: string, labels?: string[] }} [options]
 * @returns {GitHubPullRequest}
 */
function createPullRequest({ body = createManagedBody(), lastOperation, labels = [] } = {}) {
  return {
    number: 100,
    title: 'Example PR',
    url: 'https://github.test/pull/100',
    headRefName: 'pullops/issue-42',
    body: lastOperation === undefined ? body : createManagedBody({ lastOperation }),
    isDraft: true,
    labels,
  };
}

/**
 * @param {{
 *   status?: string,
 *   lastOperation?: string,
 *   reviewedTreeHash?: string,
 *   finalizedTreeHash?: string,
 *   finalizedHeadSha?: string,
 *   mergeMethod?: string,
 * }} [options]
 * @returns {string}
 */
function createManagedBody({
  status = 'Draft automation',
  lastOperation = PULL_OPS_OPERATION_LABELS.issueImplement,
  reviewedTreeHash,
  finalizedTreeHash,
  finalizedHeadSha,
  mergeMethod,
} = {}) {
  return [
    '## Summary',
    '',
    'Implemented work.',
    '',
    '## PullOps',
    '',
    'Managed: yes',
    `Status: ${status}`,
    '',
    '<details>',
    '<summary>PullOps workflow state</summary>',
    '',
    'Review cycles: 1 / 3',
    'CI fix cycles: 0 / 2',
    'Source: Issue #42',
    ...(reviewedTreeHash === undefined ? [] : [`Reviewed tree: ${reviewedTreeHash}`]),
    ...(finalizedTreeHash === undefined ? [] : [`Finalized tree: ${finalizedTreeHash}`]),
    ...(finalizedHeadSha === undefined ? [] : [`Finalized head: ${finalizedHeadSha}`]),
    ...(mergeMethod === undefined ? [] : [`Merge method: ${mergeMethod}`]),
    `Last operation: ${lastOperation}`,
    '',
    '</details>',
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
