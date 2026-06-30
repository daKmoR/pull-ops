import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

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
});
