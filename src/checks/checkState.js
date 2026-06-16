/**
 * @typedef {import('../github/types.js').GitHubCheckRun} GitHubCheckRun
 */

/**
 * @param {GitHubCheckRun[]} checks
 * @returns {'absent' | 'pending' | 'failed' | 'passed'}
 */
export function classifyCheckState(checks) {
  if (checks.length === 0) {
    return 'absent';
  }

  if (checks.some(isFailedCheck)) {
    return 'failed';
  }

  if (checks.some(isPendingCheck)) {
    return 'pending';
  }

  return 'passed';
}

/**
 * @param {GitHubCheckRun} check
 * @returns {boolean}
 */
function isFailedCheck(check) {
  const bucket = normalize(check.bucket);
  const conclusion = normalize(check.conclusion);
  const state = normalize(check.state);
  return (
    bucket === 'fail' ||
    ['failure', 'timed_out', 'action_required', 'startup_failure', 'cancelled'].includes(
      conclusion,
    ) ||
    ['failure', 'failed', 'error', 'timed_out', 'cancelled'].includes(state)
  );
}

/**
 * @param {GitHubCheckRun} check
 * @returns {boolean}
 */
function isPendingCheck(check) {
  const bucket = normalize(check.bucket);
  const state = normalize(check.state);
  return (
    bucket === 'pending' ||
    ['pending', 'queued', 'requested', 'waiting', 'in_progress'].includes(state) ||
    (!isPassingCheck(check) && !isFailedCheck(check))
  );
}

/**
 * @param {GitHubCheckRun} check
 * @returns {boolean}
 */
function isPassingCheck(check) {
  const bucket = normalize(check.bucket);
  const conclusion = normalize(check.conclusion);
  const state = normalize(check.state);
  return (
    bucket === 'pass' ||
    ['success', 'neutral', 'skipped'].includes(conclusion) ||
    state === 'success'
  );
}

/**
 * @param {string | undefined} value
 * @returns {string}
 */
function normalize(value) {
  return value === undefined ? '' : value.toLowerCase();
}
