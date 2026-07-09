import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createIssueBranchName,
  createParentBranchName,
  hasPullOpsBranchPrefix,
  parseTicketBranchName,
  parseParentBranchName,
} from './branchNames.js';

describe('branchNames', () => {
  it('01: creates parent, ticket, and standalone issue branch names', () => {
    assert.equal(
      createParentBranchName({
        branchPrefix: 'pullops',
        parentNumber: 12,
      }),
      'pullops/spec-12',
    );
    assert.equal(
      createIssueBranchName({
        branchPrefix: 'pullops',
        parentNumber: 12,
        issueNumber: 34,
      }),
      'pullops/spec-12-issue-34',
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
      'automation/pullops/spec-1-issue-2',
    );
  });

  it('03: parses only configured ticket branch names', () => {
    assert.deepEqual(
      parseParentBranchName({
        branchPrefix: 'pullops',
        branchName: 'pullops/spec-12',
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
      parseTicketBranchName({
        branchPrefix: 'pullops',
        branchName: 'pullops/spec-12-issue-34',
      }),
      {
        parentNumber: 12,
        issueNumber: 34,
      },
    );
    assert.deepEqual(
      parseTicketBranchName({
        branchPrefix: ' automation/pullops/ ',
        branchName: 'automation/pullops/spec-1-issue-2',
      }),
      {
        parentNumber: 1,
        issueNumber: 2,
      },
    );
    assert.equal(
      parseTicketBranchName({
        branchPrefix: 'pullops',
        branchName: 'pullops/issue-34',
      }),
      undefined,
    );
  });

  it('04: detects branches under the normalized PullOps branch prefix', () => {
    assert.equal(
      hasPullOpsBranchPrefix({
        branchPrefix: ' automation/pullops/ ',
        branchName: 'automation/pullops/issue-34',
      }),
      true,
    );
    assert.equal(
      hasPullOpsBranchPrefix({
        branchPrefix: ' automation/pullops/ ',
        branchName: 'automation/pullops-other/issue-34',
      }),
      false,
    );
  });
});
