import { join } from 'node:path';

/**
 * @param {{
 *   cwd: string,
 *   operationReference: string,
 *   targetNumber: number,
 *   createdAt?: Date,
 * }} options
 * @returns {{
 *   directory: string,
 *   normalizedOperationReference: string,
 *   runId: string,
 * }}
 */
export function createLocalPrdRunRecordLocation({
  cwd,
  operationReference,
  targetNumber,
  createdAt = new Date(),
}) {
  const normalizedOperationReference = normalizeOperationReferenceForPath(operationReference);
  const timestamp = createdAt.toISOString().replaceAll(':', '').replaceAll('.', '');
  const runId = `${timestamp}-${normalizedOperationReference}-${targetNumber}`;
  return {
    directory: join(cwd, '.pullops', 'runs', runId),
    normalizedOperationReference,
    runId,
  };
}

/**
 * @param {string} reference
 * @returns {string}
 */
export function normalizeOperationReferenceForPath(reference) {
  return reference
    .trim()
    .toLowerCase()
    .replaceAll(':', '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
