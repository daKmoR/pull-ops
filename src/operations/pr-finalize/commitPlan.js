/**
 * @typedef {import('../../git/types.js').PlannedRewriteCommit} PlannedRewriteCommit
 * @typedef {import('./output.types.js').PlannedCommit} PlannedCommit
 */

const GITHUB_CLOSING_FOOTER_PATTERN = /^(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#\d+\s*$/i;
const REFS_FOOTER_PATTERN = /^Refs:\s+#(\d+)\s*$/i;
const SPEC_FOOTER_PATTERN = /^Spec:\s+#(\d+)\s*$/i;

/**
 * @param {object} options
 * @param {PlannedCommit[]} options.plannedCommits
 * @param {string[]} options.changedFiles
 * @param {number} [options.parentIssueNumber]
 * @param {number[]} [options.ticketNumbers]
 * @returns {{ valid: true, commits: PlannedRewriteCommit[] } | { valid: false, reason: string }}
 */
export function validatePlannerCommitPlan({
  plannedCommits,
  changedFiles,
  parentIssueNumber,
  ticketNumbers = [],
}) {
  const expectedFiles = new Set(changedFiles);
  const assignedFiles = new Set();
  /** @type {PlannedRewriteCommit[]} */
  const commits = [];

  for (const [commitIndex, plannedCommit] of plannedCommits.entries()) {
    for (const file of plannedCommit.files) {
      if (!expectedFiles.has(file)) {
        return invalidPlannerCommitPlan(
          `commitPlan.commits[${commitIndex}].files contains unchanged file "${file}".`,
        );
      }

      if (assignedFiles.has(file)) {
        return invalidPlannerCommitPlan(
          `commitPlan.commits[${commitIndex}].files assigns "${file}" more than once.`,
        );
      }

      assignedFiles.add(file);
    }

    if (parentIssueNumber !== undefined) {
      const traceability = validatePlannerCommitTraceability({
        plannedCommit,
        commitIndex,
        parentIssueNumber,
        ticketNumbers,
      });
      if (!traceability.valid) {
        return traceability;
      }
    }

    commits.push({
      message: createPlannerCommitMessage(plannedCommit),
      files: plannedCommit.files,
    });
  }

  const missingFiles = changedFiles.filter(file => !assignedFiles.has(file));
  if (missingFiles.length > 0) {
    return invalidPlannerCommitPlan(
      `commitPlan.commits must assign every changed file exactly once; missing ${missingFiles.join(
        ', ',
      )}.`,
    );
  }

  return { valid: true, commits };
}

/**
 * @param {PlannedCommit} commit
 * @returns {string}
 */
function createPlannerCommitMessage(commit) {
  const parts = [commit.header];

  if (commit.body.length > 0) {
    parts.push('', ...commit.body);
  }

  parts.push('', ...commit.footers);
  return parts.join('\n');
}

/**
 * @param {object} options
 * @param {PlannedCommit} options.plannedCommit
 * @param {number} options.commitIndex
 * @param {number} options.parentIssueNumber
 * @param {number[]} options.ticketNumbers
 * @returns {{ valid: true } | { valid: false, reason: string }}
 */
function validatePlannerCommitTraceability({
  plannedCommit,
  commitIndex,
  parentIssueNumber,
  ticketNumbers,
}) {
  const closingFooter = plannedCommit.footers.find(isGitHubClosingFooter);
  if (closingFooter !== undefined) {
    return invalidPlannerCommitPlan(
      `commitPlan.commits[${commitIndex}].footers must not use GitHub closing footer "${closingFooter}".`,
    );
  }

  const refs = readFooterNumbers(plannedCommit.footers, REFS_FOOTER_PATTERN);
  const specs = readFooterNumbers(plannedCommit.footers, SPEC_FOOTER_PATTERN);
  const ticketNumberSet = new Set(ticketNumbers);
  const ticketRefs = refs.filter(issueNumber => ticketNumberSet.has(issueNumber));
  const unknownRefs = refs.filter(
    issueNumber => issueNumber !== parentIssueNumber && !ticketNumberSet.has(issueNumber),
  );

  if (unknownRefs.length > 0) {
    return invalidPlannerCommitPlan(
      `commitPlan.commits[${commitIndex}].footers references issue #${unknownRefs[0]}, which is neither Spec #${parentIssueNumber} nor a closed native Ticket.`,
    );
  }

  if (ticketRefs.length > 0) {
    if (!specs.includes(parentIssueNumber)) {
      return invalidPlannerCommitPlan(
        `commitPlan.commits[${commitIndex}].footers must include Spec: #${parentIssueNumber} for Ticket work.`,
      );
    }

    return { valid: true };
  }

  if (!refs.includes(parentIssueNumber)) {
    return invalidPlannerCommitPlan(
      `commitPlan.commits[${commitIndex}].footers must include Refs: #${parentIssueNumber} for Spec-level work or Refs: #<ticket> plus Spec: #${parentIssueNumber} for Ticket work.`,
    );
  }

  return { valid: true };
}

/**
 * @param {string} footer
 * @returns {boolean}
 */
function isGitHubClosingFooter(footer) {
  return GITHUB_CLOSING_FOOTER_PATTERN.test(footer);
}

/**
 * @param {string[]} footers
 * @param {RegExp} pattern
 * @returns {number[]}
 */
function readFooterNumbers(footers, pattern) {
  return footers.flatMap(footer => {
    const match = pattern.exec(footer);
    return match === null ? [] : [Number(match[1])];
  });
}

/**
 * @param {string} reason
 * @returns {{ valid: false, reason: string }}
 */
function invalidPlannerCommitPlan(reason) {
  return { valid: false, reason };
}
