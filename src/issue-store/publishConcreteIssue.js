import {
  createConcreteIssueBody,
  readConcreteIssuePublicationMarker,
} from './concreteIssueBody.js';
import { createRunRecordLocation, writeRunArtifact } from '../local-run-record/localRunRecord.js';

/**
 * @typedef {Pick<import('../config/types.js').PullOpsConfig, 'issueStore'>} IssueStoreConfig
 * @typedef {import('../github/types.js').GitHubClient} GitHubClient
 * @typedef {import('../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('./types.js').ConcreteIssuePublishOutput} ConcreteIssuePublishOutput
 * @typedef {import('./types.js').ConcreteIssuePublishFailureOutput} ConcreteIssuePublishFailureOutput
 * @typedef {import('./types.js').ConcreteIssuePublishSuccessOutput} ConcreteIssuePublishSuccessOutput
 * @typedef {import('./types.js').NormalizedConcreteIssueRequest} NormalizedConcreteIssueRequest
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
 * @returns {Promise<ConcreteIssuePublishOutput>}
 */
export async function publishConcreteIssue({
  cwd,
  config,
  githubClient,
  rawRequest,
  createdAt = new Date(),
}) {
  const rawRequestText = serializeRawRequest(rawRequest);

  try {
    const normalizedRequest = normalizeConcreteIssuePublicationRequest(rawRequest);
    const runRecord = createRunRecordLocation({
      cwd,
      operationReference: 'issues:publish-issue',
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
        summary: 'Publish issue request failed.',
        failureReason: `Issue Store provider "${provider}" is not supported by publish-issue.`,
      });
    }

    if (normalizedRequest.issueNumber === undefined) {
      return await createConcreteIssue({
        githubClient,
        normalizedRequest,
        runRecord,
      });
    }

    return await updateConcreteIssue({
      githubClient,
      normalizedRequest,
      runRecord,
    });
  } catch (error) {
    const runRecord = createRunRecordLocation({
      cwd,
      operationReference: 'issues:publish-issue',
      targetReference: 'invalid',
      createdAt,
    });
    await writeRunArtifact(runRecord, 'request.raw.txt', `${rawRequestText}\n`);
    return await writeFailureResult(runRecord, {
      summary: 'Publish issue request failed.',
      failureReason: getErrorMessage(error),
    });
  }
}

/**
 * @param {{
 *   githubClient: GitHubClient,
 *   normalizedRequest: NormalizedConcreteIssueRequest,
 *   runRecord: { directory: string },
 * }} options
 * @returns {Promise<ConcreteIssuePublishOutput>}
 */
async function createConcreteIssue({ githubClient, normalizedRequest, runRecord }) {
  /** @type {GitHubIssue | undefined} */
  let createdIssue;
  try {
    const createIssue = githubClient.createIssue;
    if (typeof createIssue !== 'function') {
      throw new Error('GitHub client does not support issue creation.');
    }

    createdIssue = await createIssue.call(githubClient, {
      title: normalizedRequest.title,
      body: createConcreteIssueBody(normalizedRequest),
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
          ? 'Publish issue request failed.'
          : `Created PullOps-published Concrete Issue #${createdIssue.number}, but publication failed.`,
      warnings: [],
    });
  }
}

/**
 * @param {{
 *   githubClient: GitHubClient,
 *   normalizedRequest: NormalizedConcreteIssueRequest,
 *   runRecord: { directory: string },
 * }} options
 * @returns {Promise<ConcreteIssuePublishOutput>}
 */
async function updateConcreteIssue({ githubClient, normalizedRequest, runRecord }) {
  /** @type {GitHubIssue | undefined} */
  let existingIssue;
  /** @type {GitHubIssue | undefined} */
  let updatedIssue;
  try {
    const issueNumber = normalizedRequest.issueNumber;
    if (issueNumber === undefined) {
      throw new Error('Issue number is required to update a concrete issue.');
    }

    existingIssue = await githubClient.getIssue(issueNumber);
    if (readConcreteIssuePublicationMarker(existingIssue.body) === undefined) {
      return await writeFailureResult(runRecord, {
        summary: `Refused to update issue #${issueNumber}.`,
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
      body: createConcreteIssueBody(normalizedRequest),
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
          ? `Refused to update issue #${normalizedRequest.issueNumber}.`
          : `Updated PullOps-published Concrete Issue #${updatedIssue.number}, but publication failed.`,
      warnings: [],
    });
  }
}

/**
 * @param {{
 *   action: 'created' | 'updated',
 *   issue: GitHubIssue,
 *   normalizedRequest: NormalizedConcreteIssueRequest,
 *   localRunRecord: string,
 *   warnings: string[],
 * }} options
 * @returns {ConcreteIssuePublishSuccessOutput}
 */
function createSuccessOutput({ action, issue, normalizedRequest, localRunRecord, warnings }) {
  /** @type {ConcreteIssuePublishSuccessOutput} */
  const output = {
    status: 'accepted',
    summary:
      action === 'created'
        ? `Created PullOps-published Concrete Issue #${issue.number}.`
        : `Updated PullOps-published Concrete Issue #${issue.number}.`,
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
 * @returns {Promise<ConcreteIssuePublishFailureOutput>}
 */
async function writeFailureResult(runRecord, options) {
  const { summary, failureReason } = options;
  /** @type {ConcreteIssuePublishFailureOutput} */
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
 *   normalizedRequest: NormalizedConcreteIssueRequest,
 *   issue: GitHubIssue | undefined,
 *   action: 'created' | 'updated' | undefined,
 *   localRunRecord: string,
 *   failureReason: string,
 *   summary: string,
 *   warnings: string[],
 * }} options
 * @returns {Promise<ConcreteIssuePublishFailureOutput>}
 */
async function writePartialFailure(runRecord, options) {
  const { normalizedRequest, issue, action, localRunRecord, failureReason, summary, warnings } =
    options;
  /** @type {ConcreteIssuePublishFailureOutput} */
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
 * @returns {NormalizedConcreteIssueRequest}
 */
function normalizeConcreteIssuePublicationRequest(rawRequest) {
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

  const payload = selectPayloadObject(rawRequest);
  if (!isPlainObject(payload)) {
    throw new Error('Publish request must be a JSON object.');
  }

  const kind = readOptionalString(payload.kind ?? payload.type);
  if (kind !== undefined && kind !== 'concrete-issue') {
    throw new Error(
      `Publish request kind must be "concrete-issue". Received ${JSON.stringify(kind)}.`,
    );
  }

  const issueNumber = readOptionalPositiveInteger(
    firstDefined(payload.issueNumber, payload.number, rawRequest.issueNumber, rawRequest.number),
    'Request.issueNumber',
  );
  const title = readNonEmptyString(firstDefined(payload.title, rawRequest.title), 'Request.title');
  const whatToBuild = readNonEmptyString(
    firstDefined(payload.whatToBuild, payload.body, rawRequest.whatToBuild, rawRequest.body),
    'Request.whatToBuild',
  );
  const acceptanceCriteria = readStringArray(
    firstDefined(payload.acceptanceCriteria, rawRequest.acceptanceCriteria),
    'Request.acceptanceCriteria',
  );
  if (acceptanceCriteria.length === 0) {
    throw new Error('Request.acceptanceCriteria must contain at least one item.');
  }

  const blockedBy = uniquePositiveIntegers(
    firstDefined(payload.blockedBy, rawRequest.blockedBy),
    'Request.blockedBy',
  );
  const auditDetails = readStringArray(
    firstDefined(payload.auditDetails, rawRequest.auditDetails),
    'Request.auditDetails',
  );
  const triageRoleValue = firstDefined(payload.triageRole, rawRequest.triageRole);
  const triageRole =
    triageRoleValue === undefined
      ? undefined
      : readTriageRole(triageRoleValue, 'Request.triageRole');

  return {
    ...(issueNumber === undefined ? {} : { issueNumber }),
    title,
    whatToBuild,
    acceptanceCriteria,
    blockedBy,
    ...(auditDetails.length === 0 ? {} : { auditDetails }),
    ...(triageRole === undefined ? {} : { triageRole }),
  };
}

/**
 * @param {Record<string, unknown>} value
 * @returns {Record<string, unknown>}
 */
function selectPayloadObject(value) {
  const candidates = [value.issue, value.request, value.concreteIssue, value];
  for (const candidate of candidates) {
    if (isPlainObject(candidate)) {
      return candidate;
    }
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
function readStringArray(value, path) {
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
 * @returns {number[]}
 */
function uniquePositiveIntegers(value, path) {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array.`);
  }

  /** @type {number[]} */
  const numbers = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'number' || !Number.isInteger(item) || item <= 0) {
      throw new Error(`${path}[${index}] must be a positive integer.`);
    }
    if (!numbers.includes(item)) {
      numbers.push(item);
    }
  }

  return numbers;
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

/**
 * @template T
 * @param {...T | undefined} values
 * @returns {T | undefined}
 */
function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}
