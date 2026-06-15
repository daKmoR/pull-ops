import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createIssueBranchName,
  createParentBranchName,
  parseChildIssueBranchName,
  parseParentBranchName,
} from './branchNames.js';

describe('branchNames', () => {
  it('01: creates parent, child, and standalone issue branch names', () => {
    assert.equal(
      createParentBranchName({
        branchPrefix: 'pullops',
        parentNumber: 12,
      }),
      'pullops/prd-12',
    );
    assert.equal(
      createIssueBranchName({
        branchPrefix: 'pullops',
        parentNumber: 12,
        issueNumber: 34,
      }),
      'pullops/prd-12-issue-34',
    );
    assert.equal(
      createIssueBranchName({
        branchPrefix: 'pullops',
        issueNumber: 34,
      }),
      'pullops/issue-34',
    );
  });

  it('02: normalizes configured branch prefixes', () => {
    assert.equal(
      createIssueBranchName({
        branchPrefix: ' automation/pullops/ ',
        parentNumber: 1,
        issueNumber: 2,
      }),
      'automation/pullops/prd-1-issue-2',
    );
  });

  it('03: parses only configured child issue branch names', () => {
    assert.deepEqual(
      parseParentBranchName({
        branchPrefix: 'pullops',
        branchName: 'pullops/prd-12',
      }),
      {
        parentNumber: 12,
      },
    );
    assert.equal(
      parseParentBranchName({
        branchPrefix: 'pullops',
        branchName: 'pullops/issue-34',
      }),
      undefined,
    );
    assert.deepEqual(
      parseChildIssueBranchName({
        branchPrefix: 'pullops',
        branchName: 'pullops/prd-12-issue-34',
      }),
      {
        parentNumber: 12,
        issueNumber: 34,
      },
    );
    assert.deepEqual(
      parseChildIssueBranchName({
        branchPrefix: ' automation/pullops/ ',
        branchName: 'automation/pullops/prd-1-issue-2',
      }),
      {
        parentNumber: 1,
        issueNumber: 2,
      },
    );
    assert.equal(
      parseChildIssueBranchName({
        branchPrefix: 'pullops',
        branchName: 'pullops/issue-34',
      }),
      undefined,
    );
  });
});
