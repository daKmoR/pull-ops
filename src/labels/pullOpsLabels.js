/**
 * @typedef {import('../github/types.js').PullOpsLabel} PullOpsLabel
 */

export const PULL_OPS_OPERATION_LABELS = Object.freeze({
  prdPrepare: 'pullops:prd:prepare',
  prdAutoAdvance: 'pullops:prd:auto-advance',
  prdAutoComplete: 'pullops:prd:auto-complete',
  issueImplement: 'pullops:issue:implement',
  prReview: 'pullops:pr:review',
  prAddressReview: 'pullops:pr:address-review',
  prFixCi: 'pullops:pr:fix-ci',
  prUpdateBranch: 'pullops:pr:update-branch',
  prResolveConflicts: 'pullops:pr:resolve-conflicts',
  prFinalize: 'pullops:pr:finalize',
});

export const PULL_OPS_STATUS_LABELS = Object.freeze({
  humanRequired: 'pullops:human-required',
});

export const PULL_OPS_PRD_OPERATION_LABELS = Object.freeze([
  PULL_OPS_OPERATION_LABELS.prdPrepare,
  PULL_OPS_OPERATION_LABELS.prdAutoAdvance,
  PULL_OPS_OPERATION_LABELS.prdAutoComplete,
]);

export const PULL_OPS_ISSUE_OPERATION_LABELS = Object.freeze([
  PULL_OPS_OPERATION_LABELS.issueImplement,
]);

export const PULL_OPS_PR_OPERATION_LABELS = Object.freeze([
  PULL_OPS_OPERATION_LABELS.prReview,
  PULL_OPS_OPERATION_LABELS.prAddressReview,
  PULL_OPS_OPERATION_LABELS.prFixCi,
  PULL_OPS_OPERATION_LABELS.prUpdateBranch,
  PULL_OPS_OPERATION_LABELS.prResolveConflicts,
  PULL_OPS_OPERATION_LABELS.prFinalize,
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
    name: PULL_OPS_OPERATION_LABELS.prdPrepare,
    color: '5319E7',
    description: 'Prepare an umbrella branch and draft PR for a PRD issue.',
  },
  {
    name: PULL_OPS_OPERATION_LABELS.prdAutoAdvance,
    color: '5319E7',
    description: 'Prepare a PRD and drain the current unblocked child frontier.',
  },
  {
    name: PULL_OPS_OPERATION_LABELS.prdAutoComplete,
    color: '5319E7',
    description:
      'Complete a PRD through child PRs, umbrella integration, and finalization; humans merge umbrella PR.',
  },
  {
    name: PULL_OPS_OPERATION_LABELS.issueImplement,
    color: '5319E7',
    description:
      'Implement one concrete issue through review and finalization. Does not coordinate child issues.',
  },
  {
    name: PULL_OPS_OPERATION_LABELS.prReview,
    color: '5319E7',
    description: 'Run PullOps automated PR review.',
  },
  {
    name: PULL_OPS_OPERATION_LABELS.prAddressReview,
    color: '5319E7',
    description: 'Address actionable PullOps PR review feedback.',
  },
  {
    name: PULL_OPS_OPERATION_LABELS.prFixCi,
    color: '5319E7',
    description: 'Classify and fix actionable CI failures.',
  },
  {
    name: PULL_OPS_OPERATION_LABELS.prUpdateBranch,
    color: '5319E7',
    description: 'Update a same-repository PR branch.',
  },
  {
    name: PULL_OPS_OPERATION_LABELS.prResolveConflicts,
    color: '5319E7',
    description: 'Resolve branch update conflicts with the PullOps runner.',
  },
  {
    name: PULL_OPS_OPERATION_LABELS.prFinalize,
    color: '5319E7',
    description: 'Finalize a PullOps-managed PR for human review and merge.',
  },
  {
    name: PULL_OPS_STATUS_LABELS.humanRequired,
    color: 'D93F0B',
    description: 'PullOps automation needs maintainer attention.',
  },
];
