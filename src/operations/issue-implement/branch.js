import { createIssueBranchName } from '../branchNames.js';

/**
 * @param {{ branchPrefix: string, issueNumber: number, parentNumber?: number }} options
 * @returns {string}
 */
export function createIssueImplementBranchName({ branchPrefix, issueNumber, parentNumber }) {
  return createIssueBranchName({ branchPrefix, issueNumber, parentNumber });
}
