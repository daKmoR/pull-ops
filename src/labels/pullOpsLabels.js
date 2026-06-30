/**
 * @typedef {import('../github/types.js').PullOpsLabel} PullOpsLabel
 */

import { getOperationCatalogLabelDefinitions } from '../operations/operationCatalog.js';

export const PULL_OPS_STATUS_LABELS = Object.freeze({
  humanRequired: 'pullops:human-required',
});

export const PULL_OPS_STATUS_LABEL_NAMES = Object.freeze(Object.values(PULL_OPS_STATUS_LABELS));

/** @type {PullOpsLabel[]} */
export const PULL_OPS_LABELS = [
  ...getOperationCatalogLabelDefinitions(),
  {
    name: PULL_OPS_STATUS_LABELS.humanRequired,
    color: 'D93F0B',
    description: 'PullOps automation needs maintainer attention.',
  },
];
