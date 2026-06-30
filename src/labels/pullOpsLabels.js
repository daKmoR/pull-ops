/**
 * @typedef {import('../github/types.js').PullOpsLabel} PullOpsLabel
 */

import { getOperationCatalogLabelDefinition } from '../operations/operationCatalog.js';

const PRD_PREPARE_LABEL_DEFINITION = getOperationCatalogLabelDefinition('prd-prepare');

if (PRD_PREPARE_LABEL_DEFINITION === undefined) {
  throw new Error('prd-prepare label definition is missing from the operation catalog.');
}

const PRD_AUTO_ADVANCE_LABEL_DEFINITION = getOperationCatalogLabelDefinition('prd-auto-advance');

if (PRD_AUTO_ADVANCE_LABEL_DEFINITION === undefined) {
  throw new Error('prd-auto-advance label definition is missing from the operation catalog.');
}

const PRD_AUTO_COMPLETE_LABEL_DEFINITION = getOperationCatalogLabelDefinition('prd-auto-complete');

if (PRD_AUTO_COMPLETE_LABEL_DEFINITION === undefined) {
  throw new Error('prd-auto-complete label definition is missing from the operation catalog.');
}

const ISSUE_IMPLEMENT_LABEL_DEFINITION = getOperationCatalogLabelDefinition('issue-implement');

if (ISSUE_IMPLEMENT_LABEL_DEFINITION === undefined) {
  throw new Error('issue-implement label definition is missing from the operation catalog.');
}

const PR_REVIEW_LABEL_DEFINITION = getOperationCatalogLabelDefinition('pr-review');

if (PR_REVIEW_LABEL_DEFINITION === undefined) {
  throw new Error('pr-review label definition is missing from the operation catalog.');
}

const PR_ADDRESS_REVIEW_LABEL_DEFINITION = getOperationCatalogLabelDefinition('pr-address-review');

if (PR_ADDRESS_REVIEW_LABEL_DEFINITION === undefined) {
  throw new Error('pr-address-review label definition is missing from the operation catalog.');
}

const PR_FIX_CI_LABEL_DEFINITION = getOperationCatalogLabelDefinition('pr-fix-ci');

if (PR_FIX_CI_LABEL_DEFINITION === undefined) {
  throw new Error('pr-fix-ci label definition is missing from the operation catalog.');
}

const PR_UPDATE_BRANCH_LABEL_DEFINITION = getOperationCatalogLabelDefinition('pr-update-branch');

if (PR_UPDATE_BRANCH_LABEL_DEFINITION === undefined) {
  throw new Error('pr-update-branch label definition is missing from the operation catalog.');
}

const PR_RESOLVE_CONFLICTS_LABEL_DEFINITION =
  getOperationCatalogLabelDefinition('pr-resolve-conflicts');

if (PR_RESOLVE_CONFLICTS_LABEL_DEFINITION === undefined) {
  throw new Error('pr-resolve-conflicts label definition is missing from the operation catalog.');
}

const PR_FINALIZE_LABEL_DEFINITION = getOperationCatalogLabelDefinition('pr-finalize');

if (PR_FINALIZE_LABEL_DEFINITION === undefined) {
  throw new Error('pr-finalize label definition is missing from the operation catalog.');
}

export const PULL_OPS_OPERATION_LABELS = Object.freeze({
  prdPrepare: PRD_PREPARE_LABEL_DEFINITION.name,
  prdAutoAdvance: PRD_AUTO_ADVANCE_LABEL_DEFINITION.name,
  prdAutoComplete: PRD_AUTO_COMPLETE_LABEL_DEFINITION.name,
  issueImplement: ISSUE_IMPLEMENT_LABEL_DEFINITION.name,
  prReview: PR_REVIEW_LABEL_DEFINITION.name,
  prAddressReview: PR_ADDRESS_REVIEW_LABEL_DEFINITION.name,
  prFixCi: PR_FIX_CI_LABEL_DEFINITION.name,
  prUpdateBranch: PR_UPDATE_BRANCH_LABEL_DEFINITION.name,
  prResolveConflicts: PR_RESOLVE_CONFLICTS_LABEL_DEFINITION.name,
  prFinalize: PR_FINALIZE_LABEL_DEFINITION.name,
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
  PRD_PREPARE_LABEL_DEFINITION,
  PRD_AUTO_ADVANCE_LABEL_DEFINITION,
  PRD_AUTO_COMPLETE_LABEL_DEFINITION,
  ISSUE_IMPLEMENT_LABEL_DEFINITION,
  PR_REVIEW_LABEL_DEFINITION,
  PR_ADDRESS_REVIEW_LABEL_DEFINITION,
  PR_FIX_CI_LABEL_DEFINITION,
  PR_UPDATE_BRANCH_LABEL_DEFINITION,
  PR_RESOLVE_CONFLICTS_LABEL_DEFINITION,
  PR_FINALIZE_LABEL_DEFINITION,
  {
    name: PULL_OPS_STATUS_LABELS.humanRequired,
    color: 'D93F0B',
    description: 'PullOps automation needs maintainer attention.',
  },
];
