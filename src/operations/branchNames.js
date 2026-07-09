/**
 * @param {{ branchPrefix: string, parentNumber: number }} options
 * @returns {string}
 */
export function createParentBranchName({ branchPrefix, parentNumber }) {
  return `${normalizeBranchPrefix(branchPrefix)}/spec-${parentNumber}`;
}

/**
 * @param {{ branchPrefix: string, issueNumber: number, parentNumber?: number }} options
 * @returns {string}
 */
export function createIssueBranchName({ branchPrefix, issueNumber, parentNumber }) {
  const prefix = normalizeBranchPrefix(branchPrefix);

  if (parentNumber !== undefined) {
    return `${prefix}/spec-${parentNumber}-issue-${issueNumber}`;
  }

  return `${prefix}/issue-${issueNumber}`;
}

/**
 * @param {{ branchPrefix: string, branchName: string }} options
 * @returns {{ parentNumber: number } | undefined}
 */
export function parseParentBranchName({ branchPrefix, branchName }) {
  const prefix = normalizeBranchPrefix(branchPrefix);
  const pattern = new RegExp(`^${escapeRegExp(prefix)}/spec-(\\d+)$`);
  const match = pattern.exec(branchName);

  if (match === null) {
    return undefined;
  }

  return {
    parentNumber: Number(match[1]),
  };
}

/**
 * @param {{ branchPrefix: string, branchName: string }} options
 * @returns {{ parentNumber: number, issueNumber: number } | undefined}
 */
export function parseTicketBranchName({ branchPrefix, branchName }) {
  const prefix = normalizeBranchPrefix(branchPrefix);
  const pattern = new RegExp(`^${escapeRegExp(prefix)}/spec-(\\d+)-issue-(\\d+)$`);
  const match = pattern.exec(branchName);

  if (match === null) {
    return undefined;
  }

  return {
    parentNumber: Number(match[1]),
    issueNumber: Number(match[2]),
  };
}

/**
 * @param {{ branchPrefix: string, branchName: string }} options
 * @returns {boolean}
 */
export function hasPullOpsBranchPrefix({ branchPrefix, branchName }) {
  const prefix = normalizeBranchPrefix(branchPrefix);
  return branchName === prefix || branchName.startsWith(`${prefix}/`);
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

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
