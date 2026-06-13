/**
 * @param {{ branchPrefix: string, parentNumber: number }} options
 * @returns {string}
 */
export function createParentBranchName({ branchPrefix, parentNumber }) {
  return `${normalizeBranchPrefix(branchPrefix)}/prd-${parentNumber}`;
}

/**
 * @param {{ branchPrefix: string, issueNumber: number, parentNumber?: number }} options
 * @returns {string}
 */
export function createIssueBranchName({ branchPrefix, issueNumber, parentNumber }) {
  const prefix = normalizeBranchPrefix(branchPrefix);

  if (parentNumber !== undefined) {
    return `${prefix}/prd-${parentNumber}/issue-${issueNumber}`;
  }

  return `${prefix}/issue-${issueNumber}`;
}

/**
 * @param {string} branchPrefix
 * @returns {string}
 */
function normalizeBranchPrefix(branchPrefix) {
  const normalizedPrefix = branchPrefix
    .split('/')
    .map(part => part.trim())
    .filter(Boolean)
    .join('/');

  return normalizedPrefix || 'pullops';
}
