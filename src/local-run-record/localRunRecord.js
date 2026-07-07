import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * @param {{
 *   cwd: string,
 *   operationReference: string,
 *   targetReference: string | number,
 *   createdAt?: Date,
 * }} options
 * @returns {{
 *   directory: string,
 *   normalizedOperationReference: string,
 *   runId: string,
 * }}
 */
export function createRunRecordLocation({
  cwd,
  operationReference,
  targetReference,
  createdAt = new Date(),
}) {
  const normalizedOperationReference = normalizeOperationReferenceForPath(operationReference);
  const normalizedTargetReference = normalizeRunRecordTargetReference(targetReference);
  const timestamp = createdAt.toISOString().replaceAll(':', '').replaceAll('.', '');
  const runId = `${timestamp}-${normalizedOperationReference}-${normalizedTargetReference}`;
  return {
    directory: join(cwd, '.pullops', 'runs', runId),
    normalizedOperationReference,
    runId,
  };
}

/**
 * @param {{ directory: string }} runRecord
 * @param {string} fileName
 * @param {string} contents
 * @returns {Promise<void>}
 */
export async function writeRunArtifact(runRecord, fileName, contents) {
  await mkdir(runRecord.directory, { recursive: true });
  await writeFile(join(runRecord.directory, fileName), contents);
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

/**
 * @param {string | number} targetReference
 * @returns {string}
 */
function normalizeRunRecordTargetReference(targetReference) {
  const normalized = String(targetReference)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized === '' ? 'new' : normalized;
}
