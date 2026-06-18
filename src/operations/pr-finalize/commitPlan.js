/**
 * @typedef {import('../../git/types.js').PlannedRewriteCommit} PlannedRewriteCommit
 * @typedef {import('./output.types.js').PlannedCommit} PlannedCommit
 */

/**
 * @param {object} options
 * @param {PlannedCommit[]} options.plannedCommits
 * @param {string[]} options.changedFiles
 * @returns {{ valid: true, commits: PlannedRewriteCommit[] } | { valid: false, reason: string }}
 */
export function validatePlannerCommitPlan({ plannedCommits, changedFiles }) {
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
 * @param {string} reason
 * @returns {{ valid: false, reason: string }}
 */
function invalidPlannerCommitPlan(reason) {
  return { valid: false, reason };
}
