/**
 * @typedef {import('../github/types.js').PullOpsLabel} PullOpsLabel
 */

export const PULL_OPS_OPERATION_LABELS = Object.freeze({
  preparePrd: 'pullops:prd:prepare',
  coordinatePrd: 'pullops:prd:coordinate',
  implementIssue: 'pullops:issue:implement',
  reviewPr: 'pullops:pr:review',
  addressReview: 'pullops:pr:address-review',
  fixCi: 'pullops:pr:fix-ci',
  updateBranch: 'pullops:pr:update-branch',
  resolveConflicts: 'pullops:pr:resolve-conflicts',
  prepareMerge: 'pullops:pr:prepare-merge',
});

export const PULL_OPS_STATUS_LABELS = Object.freeze({
  inProgress: 'pullops:status:in-progress',
  blocked: 'pullops:status:blocked',
  done: 'pullops:status:done',
  failed: 'pullops:status:failed',
});

export const PULL_OPS_PRD_OPERATION_LABELS = Object.freeze([
  PULL_OPS_OPERATION_LABELS.preparePrd,
  PULL_OPS_OPERATION_LABELS.coordinatePrd,
]);

export const PULL_OPS_ISSUE_OPERATION_LABELS = Object.freeze([
  PULL_OPS_OPERATION_LABELS.implementIssue,
]);

export const PULL_OPS_PR_OPERATION_LABELS = Object.freeze([
  PULL_OPS_OPERATION_LABELS.reviewPr,
  PULL_OPS_OPERATION_LABELS.addressReview,
  PULL_OPS_OPERATION_LABELS.fixCi,
  PULL_OPS_OPERATION_LABELS.updateBranch,
  PULL_OPS_OPERATION_LABELS.resolveConflicts,
  PULL_OPS_OPERATION_LABELS.prepareMerge,
]);

export const PULL_OPS_OPERATION_LABEL_NAMES = Object.freeze([
  ...PULL_OPS_PRD_OPERATION_LABELS,
  ...PULL_OPS_ISSUE_OPERATION_LABELS,
  ...PULL_OPS_PR_OPERATION_LABELS,
]);

export const PULL_OPS_STATUS_LABEL_NAMES = Object.freeze(Object.values(PULL_OPS_STATUS_LABELS));

/** @type {PullOpsLabel[]} */
export const PULL_OPS_LABELS = [
  {
    name: PULL_OPS_OPERATION_LABELS.preparePrd,
    color: '5319E7',
    description: 'Prepare an umbrella branch and draft PR for a PRD issue.',
  },
  {
    name: PULL_OPS_OPERATION_LABELS.coordinatePrd,
    color: '5319E7',
    description: 'Reserved for future automatic PRD child issue orchestration.',
  },
  {
    name: PULL_OPS_OPERATION_LABELS.implementIssue,
    color: '5319E7',
    description: 'Implement one concrete issue. Does not coordinate child issues.',
  },
  {
    name: PULL_OPS_OPERATION_LABELS.reviewPr,
    color: '5319E7',
    description: 'Run PullOps automated PR review.',
  },
  {
    name: PULL_OPS_OPERATION_LABELS.addressReview,
    color: '5319E7',
    description: 'Address actionable PullOps PR review feedback.',
  },
  {
    name: PULL_OPS_OPERATION_LABELS.fixCi,
    color: '5319E7',
    description: 'Classify and fix actionable CI failures.',
  },
  {
    name: PULL_OPS_OPERATION_LABELS.updateBranch,
    color: '5319E7',
    description: 'Update a same-repository PR branch.',
  },
  {
    name: PULL_OPS_OPERATION_LABELS.resolveConflicts,
    color: '5319E7',
    description: 'Resolve branch update conflicts with the PullOps runner.',
  },
  {
    name: PULL_OPS_OPERATION_LABELS.prepareMerge,
    color: '5319E7',
    description: 'Prepare a PullOps-managed PR for human review and merge.',
  },
  {
    name: PULL_OPS_STATUS_LABELS.inProgress,
    color: 'FBCA04',
    description: 'PullOps automation is currently working.',
  },
  {
    name: PULL_OPS_STATUS_LABELS.blocked,
    color: 'D93F0B',
    description: 'PullOps automation is blocked and needs human attention.',
  },
  {
    name: PULL_OPS_STATUS_LABELS.done,
    color: '0E8A16',
    description: 'PullOps automation completed successfully.',
  },
  {
    name: PULL_OPS_STATUS_LABELS.failed,
    color: 'B60205',
    description: 'PullOps automation failed and needs investigation.',
  },
];
