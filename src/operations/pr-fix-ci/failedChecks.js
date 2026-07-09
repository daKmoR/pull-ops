/**
 * @typedef {import('./failedChecks.types.js').FailedCheck} FailedCheck
 * @typedef {import('../../github/types.js').GitHubCheckRun} GitHubCheckRun
 */

/**
 * Detect failed checks and give each one a stable checkId. PullOps records
 * check facts only; the runner owns the Check Failure Classification
 * judgment, and PullOps verifies coverage and actionability afterwards.
 *
 * @param {GitHubCheckRun[]} checks
 * @returns {FailedCheck[]}
 */
export function collectFailedChecks(checks) {
  return checks.filter(isFailedCheck).map((check, index) => ({
    id: `check-${index + 1}`,
    checkName: check.name,
    ...(check.workflowName === undefined ? {} : { workflowName: check.workflowName }),
    ...(check.state === undefined ? {} : { state: check.state }),
    ...(check.conclusion === undefined ? {} : { conclusion: check.conclusion }),
    ...(check.bucket === undefined ? {} : { bucket: check.bucket }),
    ...(check.detailsUrl === undefined ? {} : { detailsUrl: check.detailsUrl }),
  }));
}

/**
 * @param {GitHubCheckRun} check
 * @returns {boolean}
 */
function isFailedCheck(check) {
  const bucket = normalize(check.bucket);
  if (bucket === 'fail') {
    return true;
  }

  const conclusion = normalize(check.conclusion);
  if (
    ['failure', 'timed_out', 'action_required', 'startup_failure', 'cancelled'].includes(conclusion)
  ) {
    return true;
  }

  const state = normalize(check.state);
  return ['failure', 'failed', 'error', 'timed_out', 'cancelled'].includes(state);
}

/**
 * @param {string | undefined} value
 * @returns {string}
 */
function normalize(value) {
  return value === undefined ? '' : value.toLowerCase();
}
