import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validatePlannerCommitPlan } from './commitPlan.js';

describe('validatePlannerCommitPlan', () => {
  it('01: accepts child issue and parent PRD traceability', () => {
    const result = validatePlannerCommitPlan({
      plannedCommits: [
        createCommit({
          footers: ['Refs: #42', 'PRD: #7'],
          files: ['src/child.js'],
        }),
        createCommit({
          footers: ['Refs: #7'],
          files: ['docs/prd.md'],
        }),
      ],
      changedFiles: ['src/child.js', 'docs/prd.md'],
      parentIssueNumber: 7,
      childIssueNumbers: [42],
    });

    assert.equal(result.valid, true);
    if (result.valid) {
      assert.deepEqual(
        result.commits.map(commit => commit.files),
        [['src/child.js'], ['docs/prd.md']],
      );
    }
  });

  it('02: rejects child issue work without the PRD footer', () => {
    const result = validatePlannerCommitPlan({
      plannedCommits: [createCommit({ footers: ['Refs: #42'] })],
      changedFiles: ['src/example.js'],
      parentIssueNumber: 7,
      childIssueNumbers: [42],
    });

    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.match(result.reason, /PRD: #7/);
    }
  });

  it('03: rejects GitHub closing footers for parent PRD plans', () => {
    const result = validatePlannerCommitPlan({
      plannedCommits: [createCommit({ footers: ['Closes #42'] })],
      changedFiles: ['src/example.js'],
      parentIssueNumber: 7,
      childIssueNumbers: [42],
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
