import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getOperationCatalogLabelDefinitions } from '../operations/operationCatalog.js';
import { PULL_OPS_LABELS, PULL_OPS_STATUS_LABELS } from './pullOpsLabels.js';

describe('PULL_OPS_LABELS', () => {
  it('01: keeps label descriptions within GitHub limits', () => {
    for (const label of PULL_OPS_LABELS) {
      assert.ok(
        label.description.length <= 100,
        `${label.name} description must be 100 characters or fewer.`,
      );
    }
  });

  it('02: derives operation labels from the catalog and keeps status labels separate', () => {
    const operationLabelDefinitions = getOperationCatalogLabelDefinitions();

    assert.deepEqual(
      PULL_OPS_LABELS.slice(0, operationLabelDefinitions.length),
      operationLabelDefinitions,
    );
    assert.deepEqual(PULL_OPS_LABELS.at(-1), {
      name: PULL_OPS_STATUS_LABELS.humanRequired,
      color: 'D93F0B',
      description: 'PullOps automation needs maintainer attention.',
    });
  });
});
