/**
 * @param {{ branchPrefix: string, issueNumber: number }} options
 * @returns {string}
 */
export function createImplementIssueBranchName({ branchPrefix, issueNumber }) {
  const normalizedPrefix = branchPrefix
    .split('/')
    .map(part => part.trim())
    .filter(Boolean)
    .join('/');

  return `${normalizedPrefix || 'pullops'}/issue-${issueNumber}`;
}
