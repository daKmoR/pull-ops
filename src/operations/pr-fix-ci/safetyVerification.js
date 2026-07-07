/**
 * @typedef {import('./safetyVerification.types.js').PrFixCiSafetyVerification} PrFixCiSafetyVerification
 */

const CHECK_CONFIGURATION_PATH_PATTERN = /^\.github\//;
const TEST_FILE_PATH_PATTERN = /\.test\.|\.spec\.|(?:^|\/)__tests__\/|(?:^|\/)tests?\//;
const TEST_SKIP_PATTERN =
  /\b(?:it|test|describe)\s*\.\s*(?:skip|only|todo)\s*\(|\bx(?:it|describe|test)\s*\(/;
const TEST_CASE_PATTERN = /\b(?:it|test)\s*\(/;
const ASSERTION_PATTERN = /\b(?:assert|expect)\b/;

/**
 * Deterministically verify the working tree patch a CI repair produced.
 * The runner's self-reported safety flags are declarations; this inspection
 * is the verification, and it refuses repairs that delete or skip tests,
 * remove assertions, or alter check and workflow configuration.
 *
 * @param {string} patch
 * @returns {PrFixCiSafetyVerification}
 */
export function verifyPrFixCiWorkingTreeSafety(patch) {
  /** @type {string[]} */
  const violations = [];

  for (const file of parsePatchFiles(patch)) {
    if (CHECK_CONFIGURATION_PATH_PATTERN.test(file.path)) {
      violations.push(`"${file.path}" alters check or workflow configuration.`);
      continue;
    }

    if (!TEST_FILE_PATH_PATTERN.test(file.path)) {
      continue;
    }

    if (file.deleted) {
      violations.push(`Deletes test file "${file.path}".`);
      continue;
    }

    if (file.addedLines.some(line => TEST_SKIP_PATTERN.test(line))) {
      violations.push(`Skips or focuses tests in "${file.path}".`);
    }

    const removedTestCases = countMatches(file.removedLines, TEST_CASE_PATTERN);
    const addedTestCases = countMatches(file.addedLines, TEST_CASE_PATTERN);
    if (removedTestCases > addedTestCases) {
      violations.push(
        `Removes ${removedTestCases - addedTestCases} test case(s) from "${file.path}".`,
      );
    }

    const removedAssertions = countMatches(file.removedLines, ASSERTION_PATTERN);
    const addedAssertions = countMatches(file.addedLines, ASSERTION_PATTERN);
    if (removedAssertions > addedAssertions) {
      violations.push(
        `Removes ${removedAssertions - addedAssertions} assertion(s) from "${file.path}".`,
      );
    }
  }

  return violations.length === 0 ? { safe: true } : { safe: false, violations };
}

/**
 * @param {string} patch
 * @returns {{ path: string, deleted: boolean, addedLines: string[], removedLines: string[] }[]}
 */
function parsePatchFiles(patch) {
  /** @type {{ path: string, deleted: boolean, addedLines: string[], removedLines: string[] }[]} */
  const files = [];
  /** @type {{ path: string, deleted: boolean, addedLines: string[], removedLines: string[] } | undefined} */
  let currentFile;
  /** @type {string | undefined} */
  let removedPath;

  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      currentFile = undefined;
      removedPath = undefined;
      continue;
    }

    if (line.startsWith('--- ')) {
      removedPath = readPatchPath(line.slice('--- '.length));
      continue;
    }

    if (line.startsWith('+++ ')) {
      const addedPath = readPatchPath(line.slice('+++ '.length));
      const path = addedPath ?? removedPath;
      if (path !== undefined) {
        currentFile = {
          path,
          deleted: addedPath === undefined,
          addedLines: [],
          removedLines: [],
        };
        files.push(currentFile);
      }
      continue;
    }

    if (currentFile === undefined) {
      continue;
    }

    if (line.startsWith('+')) {
      currentFile.addedLines.push(line.slice(1));
    } else if (line.startsWith('-')) {
      currentFile.removedLines.push(line.slice(1));
    }
  }

  return files;
}

/**
 * @param {string} value
 * @returns {string | undefined}
 */
function readPatchPath(value) {
  const path = value.trim();
  if (path === '/dev/null') {
    return undefined;
  }

  return path.replace(/^[ab]\//, '');
}

/**
 * @param {string[]} lines
 * @param {RegExp} pattern
 * @returns {number}
 */
function countMatches(lines, pattern) {
  return lines.filter(line => pattern.test(line)).length;
}
