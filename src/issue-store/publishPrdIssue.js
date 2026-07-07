import { createPrdIssueBody, readPrdIssuePublicationMarker } from './prdIssueBody.js';
import { createRunRecordLocation, writeRunArtifact } from '../local-run-record/localRunRecord.js';

/**
 * @typedef {Pick<import('../config/types.js').PullOpsConfig, 'issueStore'>} IssueStoreConfig
 * @typedef {import('../github/types.js').GitHubClient} GitHubClient
 * @typedef {import('../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('./types.js').NormalizedPrdIssueRequest} NormalizedPrdIssueRequest
 * @typedef {import('./types.js').PrdIssuePublishFailureOutput} PrdIssuePublishFailureOutput
 * @typedef {import('./types.js').PrdIssuePublishOutput} PrdIssuePublishOutput
 * @typedef {import('./types.js').PrdIssuePublishSuccessOutput} PrdIssuePublishSuccessOutput
 * @typedef {import('./types.js').TriageRole} TriageRole
 */

const TRIAGE_ROLES = /** @type {const} */ ([
  'needs-triage',
  'needs-info',
  'ready-for-agent',
  'ready-for-human',
  'wontfix',
]);

/**
 * @param {object} options
 * @param {string} options.cwd
 * @param {IssueStoreConfig} options.config
 * @param {GitHubClient} options.githubClient
 * @param {unknown} options.rawRequest
 * @param {Date} [options.createdAt]
 * @returns {Promise<PrdIssuePublishOutput>}
 */
export async function publishPrdIssue({
  cwd,
  config,
  githubClient,
  rawRequest,
  createdAt = new Date(),
}) {
  const rawRequestText = serializeRawRequest(rawRequest);

  try {
    const normalizedRequest = normalizePrdIssuePublicationRequest(rawRequest);
    const runRecord = createRunRecordLocation({
      cwd,
      operationReference: 'issues:publish-prd',
      targetReference: normalizedRequest.issueNumber ?? 'new',
      createdAt,
    });

    await writeRunArtifact(runRecord, 'request.raw.txt', `${rawRequestText}\n`);
    await writeRunArtifact(
      runRecord,
      'request.json',
      `${JSON.stringify(normalizedRequest, null, 2)}\n`,
    );

    const provider = config.issueStore.provider;
    if (provider !== 'github') {
      return await writeFailureResult(runRecord, {
        summary: 'Publish PRD request failed.',
        failureReason: `Issue Store provider "${provider}" is not supported by publish-prd.`,
      });
    }

    if (normalizedRequest.issueNumber === undefined) {
      return await createPrdIssue({
        githubClient,
        normalizedRequest,
        runRecord,
      });
    }

    return await updatePrdIssue({
      githubClient,
      normalizedRequest,
      runRecord,
    });
  } catch (error) {
    const runRecord = createRunRecordLocation({
      cwd,
      operationReference: 'issues:publish-prd',
      targetReference: 'invalid',
      createdAt,
    });
    await writeRunArtifact(runRecord, 'request.raw.txt', `${rawRequestText}\n`);
    return await writeFailureResult(runRecord, {
      summary: 'Publish PRD request failed.',
      failureReason: getErrorMessage(error),
    });
  }
}

/**
 * @param {{
 *   githubClient: GitHubClient,
 *   normalizedRequest: NormalizedPrdIssueRequest,
 *   runRecord: { directory: string },
 * }} options
 * @returns {Promise<PrdIssuePublishOutput>}
 */
async function createPrdIssue({ githubClient, normalizedRequest, runRecord }) {
  /** @type {GitHubIssue | undefined} */
  let createdIssue;
  try {
    const createIssue = githubClient.createIssue;
    if (typeof createIssue !== 'function') {
      throw new Error('GitHub client does not support issue creation.');
    }

    createdIssue = await createIssue.call(githubClient, {
      title: normalizedRequest.title,
      body: createPrdIssueBody(normalizedRequest),
    });

    const triageRole = normalizedRequest.triageRole;
    /** @type {string[]} */
    const warnings = [];
    if (triageRole !== undefined) {
      await syncTriageRoleLabels({
        githubClient,
        issueNumber: createdIssue.number,
        currentLabels: createdIssue.labels,
        triageRole,
      });
    }

    const output = createSuccessOutput({
      action: 'created',
      issue: createdIssue,
      normalizedRequest,
      localRunRecord: runRecord.directory,
      warnings,
    });
    await writeRunArtifact(runRecord, 'response.json', `${JSON.stringify(output, null, 2)}\n`);
    if (warnings.length > 0) {
      await writeRunArtifact(runRecord, 'warnings.json', `${JSON.stringify(warnings, null, 2)}\n`);
    }
    return output;
  } catch (error) {
    return await writePartialFailure(runRecord, {
      normalizedRequest,
      issue: createdIssue,
      action: createdIssue === undefined ? undefined : 'created',
      localRunRecord: runRecord.directory,
      failureReason: getErrorMessage(error),
      summary:
        createdIssue === undefined
          ? 'Publish PRD request failed.'
          : `Created PullOps-published PRD Issue #${createdIssue.number}, but publication failed.`,
      warnings: [],
    });
  }
}

/**
 * @param {{
 *   githubClient: GitHubClient,
 *   normalizedRequest: NormalizedPrdIssueRequest,
 *   runRecord: { directory: string },
 * }} options
 * @returns {Promise<PrdIssuePublishOutput>}
 */
async function updatePrdIssue({ githubClient, normalizedRequest, runRecord }) {
  /** @type {GitHubIssue | undefined} */
  let existingIssue;
  /** @type {GitHubIssue | undefined} */
  let updatedIssue;
  try {
    const issueNumber = normalizedRequest.issueNumber;
    if (issueNumber === undefined) {
      throw new Error('Issue number is required to update a PRD issue.');
    }

    existingIssue = await githubClient.getIssue(issueNumber);
    if (readPrdIssuePublicationMarker(existingIssue.body) === undefined) {
      return await writeFailureResult(runRecord, {
        summary: `Refused to update PRD issue #${issueNumber}.`,
        failureReason: `Issue #${issueNumber} is not marked as a PullOps-published issue.`,
      });
    }

    const updateIssue = githubClient.updateIssue;
    if (typeof updateIssue !== 'function') {
      throw new Error('GitHub client does not support issue updates.');
    }

    updatedIssue = await updateIssue.call(githubClient, {
      number: issueNumber,
      title: normalizedRequest.title,
      body: createPrdIssueBody(normalizedRequest),
    });

    const triageRole = normalizedRequest.triageRole;
    /** @type {string[]} */
    const warnings = [];
    if (triageRole !== undefined) {
      await syncTriageRoleLabels({
        githubClient,
        issueNumber: updatedIssue.number,
        currentLabels: existingIssue.labels,
        triageRole,
      });
    }

    const output = createSuccessOutput({
      action: 'updated',
      issue: updatedIssue,
      normalizedRequest,
      localRunRecord: runRecord.directory,
      warnings,
    });
    await writeRunArtifact(runRecord, 'response.json', `${JSON.stringify(output, null, 2)}\n`);
    if (warnings.length > 0) {
      await writeRunArtifact(runRecord, 'warnings.json', `${JSON.stringify(warnings, null, 2)}\n`);
    }
    return output;
  } catch (error) {
    return await writePartialFailure(runRecord, {
      normalizedRequest,
      issue: updatedIssue ?? existingIssue,
      action: updatedIssue !== undefined ? 'updated' : undefined,
      localRunRecord: runRecord.directory,
      failureReason: getErrorMessage(error),
      summary:
        updatedIssue === undefined
          ? `Refused to update PRD issue #${normalizedRequest.issueNumber}.`
          : `Updated PullOps-published PRD Issue #${updatedIssue.number}, but publication failed.`,
      warnings: [],
    });
  }
}

/**
 * @param {{
 *   action: 'created' | 'updated',
 *   issue: GitHubIssue,
 *   normalizedRequest: NormalizedPrdIssueRequest,
 *   localRunRecord: string,
 *   warnings: string[],
 * }} options
 * @returns {PrdIssuePublishSuccessOutput}
 */
function createSuccessOutput({ action, issue, normalizedRequest, localRunRecord, warnings }) {
  /** @type {PrdIssuePublishSuccessOutput} */
  const output = {
    status: 'accepted',
    summary:
      action === 'created'
        ? `Created PullOps-published PRD Issue #${issue.number}.`
        : `Updated PullOps-published PRD Issue #${issue.number}.`,
    action,
    issue: {
      number: issue.number,
      url: issue.url,
    },
    warnings,
    localRunRecord,
    ...(normalizedRequest.triageRole === undefined
      ? {}
      : { triageRole: normalizedRequest.triageRole }),
  };
  return output;
}

/**
 * @param {{ directory: string }} runRecord
 * @param {{
 *   summary: string,
 *   failureReason: string,
 * }} options
 * @returns {Promise<PrdIssuePublishFailureOutput>}
 */
async function writeFailureResult(runRecord, options) {
  const { summary, failureReason } = options;
  /** @type {PrdIssuePublishFailureOutput} */
  const output = {
    status: 'failed',
    summary,
    failureReason,
    warnings: [],
    localRunRecord: runRecord.directory,
  };
  await writeRunArtifact(runRecord, 'response.json', `${JSON.stringify(output, null, 2)}\n`);
  await writeRunArtifact(runRecord, 'failure-reason.txt', `${failureReason}\n`);
  return output;
}

/**
 * @param {{ directory: string }} runRecord
 * @param {{
 *   normalizedRequest: NormalizedPrdIssueRequest,
 *   issue: GitHubIssue | undefined,
 *   action: 'created' | 'updated' | undefined,
 *   localRunRecord: string,
 *   failureReason: string,
 *   summary: string,
 *   warnings: string[],
 * }} options
 * @returns {Promise<PrdIssuePublishFailureOutput>}
 */
async function writePartialFailure(runRecord, options) {
  const { normalizedRequest, issue, action, localRunRecord, failureReason, summary, warnings } =
    options;
  /** @type {PrdIssuePublishFailureOutput} */
  const output = {
    status: 'failed',
    summary,
    failureReason,
    warnings,
    localRunRecord,
    ...(issue === undefined
      ? {}
      : {
          issue: {
            number: issue.number,
            url: issue.url,
          },
        }),
    ...(action === undefined ? {} : { action }),
    ...(normalizedRequest.triageRole === undefined
      ? {}
      : { triageRole: normalizedRequest.triageRole }),
  };
  await writeRunArtifact(runRecord, 'response.json', `${JSON.stringify(output, null, 2)}\n`);
  await writeRunArtifact(runRecord, 'failure-reason.txt', `${failureReason}\n`);
  return output;
}

/**
 * @param {{
 *   githubClient: GitHubClient,
 *   issueNumber: number,
 *   currentLabels: string[],
 *   triageRole: TriageRole,
 * }} options
 * @returns {Promise<void>}
 */
async function syncTriageRoleLabels({ githubClient, issueNumber, currentLabels, triageRole }) {
  const labelsToRemove = currentLabels.filter(
    label => TRIAGE_ROLES.includes(/** @type {TriageRole} */ (label)) && label !== triageRole,
  );
  if (labelsToRemove.length > 0) {
    await githubClient.removeLabelsFromIssue({
      number: issueNumber,
      labels: labelsToRemove,
    });
  }

  if (!currentLabels.includes(triageRole)) {
    await githubClient.addLabelsToIssue({
      number: issueNumber,
      labels: [triageRole],
    });
  }
}

/**
 * @param {unknown} rawRequest
 * @returns {NormalizedPrdIssueRequest}
 */
function normalizePrdIssuePublicationRequest(rawRequest) {
  if (typeof rawRequest === 'string') {
    try {
      rawRequest = JSON.parse(rawRequest);
    } catch (error) {
      throw new Error(`Publish request must be valid JSON: ${getErrorMessage(error)}`, {
        cause: error,
      });
    }
  }

  if (!isPlainObject(rawRequest)) {
    throw new Error('Publish request must be a JSON object.');
  }

  const candidates = collectRequestCandidates(rawRequest);
  const kind = readOptionalConflictingString(
    candidates,
    candidate => candidate.kind ?? candidate.type,
    'Request.kind',
  );
  if (kind !== undefined && kind !== 'prd' && kind !== 'prd-issue') {
    throw new Error(
      `Publish request kind must be "prd" or "prd-issue". Received ${JSON.stringify(kind)}.`,
    );
  }

  const issueNumber = readOptionalConflictingPositiveInteger(
    candidates,
    candidate => candidate.issueNumber ?? candidate.number,
    'Request.issueNumber',
  );
  const title = readRequiredConflictingString(
    candidates,
    candidate => candidate.title,
    'Request.title',
  );
  const problemStatement = readRequiredConflictingString(
    candidates,
    candidate => candidate.problemStatement,
    'Request.problemStatement',
  );
  const solution = readRequiredConflictingString(
    candidates,
    candidate => candidate.solution,
    'Request.solution',
  );
  const userStories = readRequiredConflictingUserStories(
    candidates,
    candidate => candidate.userStories,
    'Request.userStories',
  );
  const implementationDecisions = readRequiredConflictingStringArray(
    candidates,
    candidate => candidate.implementationDecisions,
    'Request.implementationDecisions',
  );
  const testingDecisions = readRequiredConflictingStringArray(
    candidates,
    candidate => candidate.testingDecisions,
    'Request.testingDecisions',
  );
  const outOfScope = readRequiredConflictingStringArray(
    candidates,
    candidate => candidate.outOfScope,
    'Request.outOfScope',
  );
  const furtherNotes = readOptionalConflictingStringArray(
    candidates,
    candidate => candidate.furtherNotes,
    'Request.furtherNotes',
  );
  const auditDetails = readOptionalConflictingStringArray(
    candidates,
    candidate => candidate.auditDetails,
    'Request.auditDetails',
  );
  const triageRoleValue = readOptionalConflictingString(
    candidates,
    candidate => candidate.triageRole,
    'Request.triageRole',
  );
  const triageRole =
    triageRoleValue === undefined
      ? undefined
      : readTriageRole(triageRoleValue, 'Request.triageRole');

  return {
    ...(issueNumber === undefined ? {} : { issueNumber }),
    title,
    problemStatement,
    solution,
    userStories,
    implementationDecisions,
    testingDecisions,
    outOfScope,
    furtherNotes,
    auditDetails,
    ...(triageRole === undefined ? {} : { triageRole }),
  };
}

/**
 * @param {Record<string, unknown>} value
 * @returns {Record<string, unknown>[]}
 */
function collectRequestCandidates(value) {
  const candidates = [value];
  for (const key of ['request', 'prd', 'issue']) {
    const candidate = value[key];
    if (isPlainObject(candidate)) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

/**
 * @template TValue
 * @param {Record<string, unknown>[]} candidates
 * @param {(candidate: Record<string, unknown>) => unknown} readValue
 * @param {string} path
 * @param {(value: unknown, path: string) => TValue} normalize
 * @returns {TValue | undefined}
 */
function readOptionalConflictingValue(candidates, readValue, path, normalize) {
  /** @type {TValue | undefined} */
  let normalizedValue;
  let hasValue = false;
  let serializedValue;

  for (const candidate of candidates) {
    const value = readValue(candidate);
    if (value === undefined) {
      continue;
    }

    const nextValue = normalize(value, path);
    if (nextValue === undefined) {
      continue;
    }

    const nextSerializedValue = JSON.stringify(nextValue);

    if (!hasValue) {
      normalizedValue = nextValue;
      serializedValue = nextSerializedValue;
      hasValue = true;
      continue;
    }

    if (serializedValue !== nextSerializedValue) {
      throw new Error(`${path} values conflict.`);
    }
  }

  return hasValue ? normalizedValue : undefined;
}

/**
 * @param {Record<string, unknown>[]} candidates
 * @param {(candidate: Record<string, unknown>) => unknown} readValue
 * @param {string} path
 * @returns {string}
 */
function readRequiredConflictingString(candidates, readValue, path) {
  const value = readOptionalConflictingValue(candidates, readValue, path, readNonEmptyString);
  if (value === undefined) {
    throw new Error(`${path} must be a non-empty string.`);
  }

  return value;
}

/**
 * @param {Record<string, unknown>[]} candidates
 * @param {(candidate: Record<string, unknown>) => unknown} readValue
 * @param {string} path
 * @returns {string | undefined}
 */
function readOptionalConflictingString(candidates, readValue, path) {
  return readOptionalConflictingValue(candidates, readValue, path, readOptionalString);
}

/**
 * @param {Record<string, unknown>[]} candidates
 * @param {(candidate: Record<string, unknown>) => unknown} readValue
 * @param {string} path
 * @returns {number | undefined}
 */
function readOptionalConflictingPositiveInteger(candidates, readValue, path) {
  return readOptionalConflictingValue(candidates, readValue, path, readOptionalPositiveInteger);
}

/**
 * @param {Record<string, unknown>[]} candidates
 * @param {(candidate: Record<string, unknown>) => unknown} readValue
 * @param {string} path
 * @returns {string[]}
 */
function readRequiredConflictingStringArray(candidates, readValue, path) {
  const value = readOptionalConflictingValue(candidates, readValue, path, readRequiredStringArray);
  if (value === undefined) {
    throw new Error(`${path} must contain at least one item.`);
  }

  if (value.length === 0) {
    throw new Error(`${path} must contain at least one item.`);
  }

  return value;
}

/**
 * @param {Record<string, unknown>[]} candidates
 * @param {(candidate: Record<string, unknown>) => unknown} readValue
 * @param {string} path
 * @returns {string[]}
 */
function readOptionalConflictingStringArray(candidates, readValue, path) {
  return readOptionalConflictingValue(candidates, readValue, path, readOptionalStringArray) ?? [];
}

/**
 * @param {Record<string, unknown>[]} candidates
 * @param {(candidate: Record<string, unknown>) => unknown} readValue
 * @param {string} path
 * @returns {{ number: number, story: string }[]}
 */
function readRequiredConflictingUserStories(candidates, readValue, path) {
  const value = readOptionalConflictingValue(candidates, readValue, path, readPrdUserStories);
  if (value === undefined || value.length === 0) {
    throw new Error(`${path} must contain at least one item.`);
  }

  return value;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {string}
 */
function readNonEmptyString(value, path) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${path} must be a non-empty string.`);
  }

  return value.trim();
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {string | undefined}
 */
function readOptionalString(value, path = 'value') {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new Error(`${path} must be a string.`);
  }

  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {number | undefined}
 */
function readOptionalPositiveInteger(value, path) {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${path} must be a positive integer.`);
  }

  return value;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {string[]}
 */
function readRequiredStringArray(value, path) {
  if (value === undefined) {
    throw new Error(`${path} must contain at least one item.`);
  }

  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array.`);
  }

  const items = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new Error(`${path}[${index}] must be a non-empty string.`);
    }

    items.push(item.trim());
  }

  if (items.length === 0) {
    throw new Error(`${path} must contain at least one item.`);
  }

  return items;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {string[]}
 */
function readOptionalStringArray(value, path) {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array.`);
  }

  const items = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new Error(`${path}[${index}] must be a non-empty string.`);
    }

    items.push(item.trim());
  }

  return items;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {{ number: number, story: string }[]}
 */
function readPrdUserStories(value, path) {
  if (value === undefined) {
    throw new Error(`${path} must contain at least one item.`);
  }

  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array.`);
  }

  /** @type {{ number: number, story: string }[]} */
  const stories = [];
  const seenNumbers = new Set();

  for (const [index, item] of value.entries()) {
    if (!isPlainObject(item)) {
      throw new Error(`${path}[${index}] must be an object.`);
    }

    const number = readOptionalPositiveInteger(item.number, `${path}[${index}].number`);
    if (number === undefined) {
      throw new Error(`${path}[${index}].number must be a positive integer.`);
    }

    if (seenNumbers.has(number)) {
      throw new Error(`${path}[${index}].number must be unique. Duplicate ${number} detected.`);
    }
    seenNumbers.add(number);

    const story = readNonEmptyString(item.story, `${path}[${index}].story`);
    stories.push({ number, story });
  }

  stories.sort((left, right) => left.number - right.number);
  return stories;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {TriageRole}
 */
function readTriageRole(value, path) {
  const role = readOptionalString(value, path);
  if (role === undefined || !TRIAGE_ROLES.includes(/** @type {TriageRole} */ (role))) {
    throw new Error(
      `${path} must be one of: ${TRIAGE_ROLES.join(', ')}. Received ${JSON.stringify(value)}.`,
    );
  }

  return /** @type {TriageRole} */ (role);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function serializeRawRequest(value) {
  if (typeof value === 'string') {
    return value.trimEnd();
  }

  return JSON.stringify(value, null, 2);
}
