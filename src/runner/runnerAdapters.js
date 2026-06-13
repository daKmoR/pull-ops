export const DEFAULT_RUNNER_ADAPTER = 'codex-cli';

/** @type {import('./types.js').RunnerAdapter[]} */
export const RUNNER_ADAPTERS = ['codex-cli', 'codex-action'];

/**
 * @param {unknown} value
 * @returns {value is import('./types.js').RunnerAdapter}
 */
export function isRunnerAdapter(value) {
  return typeof value === 'string' && RUNNER_ADAPTERS.includes(/** @type {never} */ (value));
}
