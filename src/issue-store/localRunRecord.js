import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { normalizeOperationReferenceForPath } from '../prd-automation/localRunRecord.js';

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
export function createIssueStoreRunRecordLocation({
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
export async function writeIssueStoreRunArtifact(runRecord, fileName, contents) {
  await mkdir(runRecord.directory, { recursive: true });
  await writeFile(join(runRecord.directory, fileName), contents);
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
