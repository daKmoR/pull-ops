/**
 * @typedef {'formatting' | 'lint' | 'type' | 'test' | 'build' | 'environment' | 'flaky' | 'secret'} CheckFailureClassification
 * @typedef {{
 *   id: string;
 *   checkName: string;
 *   workflowName?: string;
 *   state?: string;
 *   conclusion?: string;
 *   bucket?: string;
 *   detailsUrl?: string;
 *   classification: CheckFailureClassification;
 *   actionable: boolean;
 *   reason: string;
 * }} ClassifiedCheckFailure
 * @typedef {import('../../github/types.js').GitHubCheckRun} GitHubCheckRun
 */

/** @type {CheckFailureClassification[]} */
export const ACTIONABLE_CHECK_FAILURE_CLASSIFICATIONS = [
  'formatting',
  'lint',
  'type',
  'test',
  'build',
];

/**
 * @param {GitHubCheckRun[]} checks
 * @returns {ClassifiedCheckFailure[]}
 */
export function classifyCheckFailures(checks) {
  return checks.filter(isFailedCheck).map((check, index) => {
    const result = classifyCheckFailure(check);

    return {
      id: `check-${index + 1}`,
      checkName: check.name,
      ...(check.workflowName === undefined ? {} : { workflowName: check.workflowName }),
      ...(check.state === undefined ? {} : { state: check.state }),
      ...(check.conclusion === undefined ? {} : { conclusion: check.conclusion }),
      ...(check.bucket === undefined ? {} : { bucket: check.bucket }),
      ...(check.detailsUrl === undefined ? {} : { detailsUrl: check.detailsUrl }),
      classification: result.classification,
      actionable: ACTIONABLE_CHECK_FAILURE_CLASSIFICATIONS.includes(result.classification),
      reason: result.reason,
    };
  });
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
 * @param {GitHubCheckRun} check
 * @returns {{ classification: CheckFailureClassification, reason: string }}
 */
function classifyCheckFailure(check) {
  const text = normalize(
    [
      check.name,
      check.workflowName,
      check.state,
      check.conclusion,
      check.bucket,
      check.detailsUrl,
      check.summary,
    ]
      .filter(value => value !== undefined)
      .join(' '),
  );

  if (matches(text, [/secret/, /credential/, /token/, /auth/, /permission/, /forbidden/])) {
    return {
      classification: 'secret',
      reason:
        'The failed check references secrets, credentials, authentication, or repository permissions.',
    };
  }

  if (matches(text, [/flaky/, /flake/, /intermittent/, /race/, /random/, /retry/, /timed? out/])) {
    return {
      classification: 'flaky',
      reason: 'The failed check looks intermittent or timeout-driven rather than code-actionable.',
    };
  }

  if (
    matches(text, [
      /environment/,
      /infra/,
      /network/,
      /dns/,
      /registry/,
      /npm ci/,
      /install/,
      /setup/,
      /cache/,
      /outage/,
      /rate limit/,
      /runner/,
      /pullops/,
      /openai/,
      /codex/,
      /disk/,
      /quota/,
      /service unavailable/,
    ])
  ) {
    return {
      classification: 'environment',
      reason: 'The failed check points at the runner, setup, dependency, or external environment.',
    };
  }

  if (matches(text, [/format/, /prettier/, /style/])) {
    return {
      classification: 'formatting',
      reason: 'The failed check is formatting or code style related.',
    };
  }

  if (matches(text, [/lint/, /eslint/])) {
    return {
      classification: 'lint',
      reason: 'The failed check is lint related.',
    };
  }

  if (matches(text, [/typecheck/, /type check/, /typescript/, /\btsc\b/, /\btypes?\b/])) {
    return {
      classification: 'type',
      reason: 'The failed check is type-checking related.',
    };
  }

  if (matches(text, [/\btest\b/, /\btests\b/, /unit/, /integration/, /e2e/, /spec/])) {
    return {
      classification: 'test',
      reason: 'The failed check is test related.',
    };
  }

  if (matches(text, [/build/, /bundle/, /compile/, /pack/, /dist/])) {
    return {
      classification: 'build',
      reason: 'The failed check is build or packaging related.',
    };
  }

  return {
    classification: 'build',
    reason:
      'No more specific signal matched, so PullOps treats this as a build failure requiring careful repair.',
  };
}

/**
 * @param {string | undefined} value
 * @returns {string}
 */
function normalize(value) {
  return value === undefined ? '' : value.toLowerCase();
}

/**
 * @param {string} value
 * @param {RegExp[]} patterns
 * @returns {boolean}
 */
function matches(value, patterns) {
  return patterns.some(pattern => pattern.test(value));
}
