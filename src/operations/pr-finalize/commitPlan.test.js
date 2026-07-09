import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validatePlannerCommitPlan } from './commitPlan.js';

describe('validatePlannerCommitPlan', () => {
  it('01: accepts ticket and parent Spec traceability', () => {
    const result = validatePlannerCommitPlan({
      plannedCommits: [
        createCommit({
          footers: ['Refs: #42', 'Spec: #7'],
          files: ['src/ticket.js'],
        }),
        createCommit({
          footers: ['Refs: #7'],
          files: ['docs/spec.md'],
        }),
      ],
      changedFiles: ['src/ticket.js', 'docs/spec.md'],
      parentIssueNumber: 7,
      ticketNumbers: [42],
    });

    assert.equal(result.valid, true);
    if (result.valid) {
      assert.deepEqual(
        result.commits.map(commit => commit.files),
        [['src/ticket.js'], ['docs/spec.md']],
      );
    }
  });

  it('02: rejects ticket work without the Spec footer', () => {
    const result = validatePlannerCommitPlan({
      plannedCommits: [createCommit({ footers: ['Refs: #42'] })],
      changedFiles: ['src/example.js'],
      parentIssueNumber: 7,
      ticketNumbers: [42],
    });

    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.match(result.reason, /Spec: #7/);
    }
  });

  it('03: rejects GitHub closing footers for parent Spec plans', () => {
    const result = validatePlannerCommitPlan({
      plannedCommits: [createCommit({ footers: ['Closes #42'] })],
      changedFiles: ['src/example.js'],
      parentIssueNumber: 7,
      ticketNumbers: [42],
    });

    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.match(result.reason, /must not use GitHub closing footer/);
    }
  });
});

/**
 * @param {{ footers: string[], files?: string[] }} options
 * @returns {import('./output.types.js').PlannedCommit}
 */
function createCommit({ footers, files = ['src/example.js'] }) {
  return {
    header: 'feat(issue): implement #42',
    body: ['Finalize the logical change.'],
    footers,
    files,
  };
}
