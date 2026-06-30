import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getOperationCatalogLabelDefinition } from '../operations/operationCatalog.js';
import { PULL_OPS_LABELS } from './pullOpsLabels.js';

describe('PULL_OPS_LABELS', () => {
  it('01: keeps label descriptions within GitHub limits', () => {
    for (const label of PULL_OPS_LABELS) {
      assert.ok(
        label.description.length <= 100,
        `${label.name} description must be 100 characters or fewer.`,
      );
    }
  });

  it('02: keeps PRD, review loop, and maintenance labels sourced from the operation catalog', () => {
    for (const operationName of [
      'prd-auto-advance',
      'prd-auto-complete',
      'pr-review',
      'pr-address-review',
      'pr-fix-ci',
      'pr-update-branch',
      'pr-resolve-conflicts',
    ]) {
      const catalogLabelDefinition = requireCatalogLabelDefinition(operationName);
      assert.deepEqual(
        PULL_OPS_LABELS.find(label => label.name === catalogLabelDefinition.name),
        catalogLabelDefinition,
      );
    }
  });
});

/**
 * @param {string} operationName
 * @returns {import('../github/types.js').PullOpsLabel}
 */
function requireCatalogLabelDefinition(operationName) {
  const catalogLabelDefinition = getOperationCatalogLabelDefinition(operationName);
  if (catalogLabelDefinition === undefined) {
    throw new Error(`${operationName} label definition is missing from the operation catalog.`);
  }

  return catalogLabelDefinition;
}
