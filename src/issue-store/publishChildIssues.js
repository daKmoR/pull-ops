import { createChildIssueBody } from './childIssueBody.js';
import { createIssueStoreRunRecordLocation, writeIssueStoreRunArtifact } from './localRunRecord.js';
import { readPrdIssuePublicationMarker } from './prdIssueBody.js';

/**
 * @typedef {Pick<import('../config/types.js').PullOpsConfig, 'issueStore'>} IssueStoreConfig
 * @typedef {import('../github/types.js').GitHubClient} GitHubClient
 * @typedef {import('../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('./types.js').ChildIssuePublishChild} ChildIssuePublishChild
 * @typedef {import('./types.js').ChildIssuePublishFailure} ChildIssuePublishFailure
 * @typedef {import('./types.js').ChildIssuePublishFailureOutput} ChildIssuePublishFailureOutput
 * @typedef {import('./types.js').ChildIssuePublishMapping} ChildIssuePublishMapping
 * @typedef {import('./types.js').ChildIssuePublishOutput} ChildIssuePublishOutput
 * @typedef {import('./types.js').ChildIssuePublishSuccessOutput} ChildIssuePublishSuccessOutput
 * @typedef {import('./types.js').IssueStorePublishWarning} IssueStorePublishWarning
 * @typedef {import('./types.js').NormalizedChildIssueBatchRequest} NormalizedChildIssueBatchRequest
 * @typedef {import('./types.js').NormalizedChildIssueRequest} NormalizedChildIssueRequest
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
 * @param {number} [options.parentIssueNumber]
 * @param {Date} [options.createdAt]
 * @returns {Promise<ChildIssuePublishOutput>}
 */
export async function publishChildIssues({
  cwd,
  config,
  githubClient,
  rawRequest,
  parentIssueNumber,
  createdAt = new Date(),
}) {
  const rawRequestText = serializeRawRequest(rawRequest);
  /** @type {NormalizedChildIssueBatchRequest} */
  let normalizedRequest;

  try {
    normalizedRequest = normalizeChildIssueBatchPublicationRequest(rawRequest, parentIssueNumber);
  } catch (error) {
    const runRecord = createIssueStoreRunRecordLocation({
      cwd,
      operationReference: 'issues:publish-children',
      targetReference: 'invalid',
      createdAt,
    });
    await writeIssueStoreRunArtifact(runRecord, 'request.raw.txt', `${rawRequestText}\n`);
    return await writeFailureResult(runRecord, {
      summary: 'Publish Child Issue batch failed.',
      failureReason: getErrorMessage(error),
      warnings: [],
    });
  }

  const runRecord = createIssueStoreRunRecordLocation({
    cwd,
    operationReference: 'issues:publish-children',
    targetReference: normalizedRequest.parentIssueNumber,
    createdAt,
  });

  await writeIssueStoreRunArtifact(runRecord, 'request.raw.txt', `${rawRequestText}\n`);
  await writeIssueStoreRunArtifact(
    runRecord,
    'request.json',
    `${JSON.stringify(normalizedRequest, null, 2)}\n`,
  );

  const provider = config.issueStore.provider;
  if (provider !== 'github') {
    return await writeFailureResult(runRecord, {
      summary: 'Publish Child Issue batch failed.',
      failureReason: `Issue Store provider "${provider}" is not supported by publish-children.`,
      warnings: [],
    });
  }

  try {
    const { parentIssue, warnings } = await readValidParentIssue({
      githubClient,
      parentIssueNumber: normalizedRequest.parentIssueNumber,
    });

    return await createChildIssues({
      githubClient,
      normalizedRequest,
      parentIssue,
      runRecord,
      warnings,
    });
  } catch (error) {
    return await writeFailureResult(runRecord, {
      summary: 'Publish Child Issue batch failed.',
      failureReason: getErrorMessage(error),
      warnings: [],
    });
  }
}

/**
 * @param {{
 *   githubClient: GitHubClient,
 *   normalizedRequest: NormalizedChildIssueBatchRequest,
 *   parentIssue: GitHubIssue,
 *   runRecord: { directory: string },
 *   warnings: IssueStorePublishWarning[],
 * }} options
 * @returns {Promise<ChildIssuePublishOutput>}
 */
async function createChildIssues({
  githubClient,
  normalizedRequest,
  parentIssue,
  runRecord,
  warnings,
}) {
  const createIssue = githubClient.createIssue;
  if (typeof createIssue !== 'function') {
    throw new Error('GitHub client does not support issue creation.');
  }

  const addSubIssue = githubClient.addSubIssue;
  if (typeof addSubIssue !== 'function') {
    throw new Error('GitHub client does not support native sub-issue creation.');
  }

  /** @type {ChildIssuePublishChild[]} */
  const children = [];
  /** @type {ChildIssuePublishFailure[]} */
  const failedChildren = [];

  for (const childRequest of normalizedRequest.children) {
    try {
      const createdIssue = await createIssue.call(githubClient, {
        title: childRequest.title,
        body: createChildIssueBody({
          ...childRequest,
          parentIssueNumber: normalizedRequest.parentIssueNumber,
        }),
      });

      await addSubIssue.call(githubClient, {
        parentIssueNumber: normalizedRequest.parentIssueNumber,
        childIssueNumber: createdIssue.number,
      });

      const triageRole = childRequest.triageRole;
      if (triageRole !== undefined) {
        await syncTriageRoleLabels({
          githubClient,
          issueNumber: createdIssue.number,
          currentLabels: createdIssue.labels,
          triageRole,
        });
      }

      children.push(createPublishedChild(childRequest, createdIssue));
    } catch (error) {
      failedChildren.push({
        sliceRef: childRequest.sliceRef,
        failureReason: getErrorMessage(error),
      });
      return await writePartialFailure(runRecord, {
        parentIssue,
        children,
        failedChildren,
        warnings,
        failureReason: getErrorMessage(error),
      });
    }
  }

  const output = createSuccessOutput({
    parentIssue,
    children,
    warnings,
    localRunRecord: runRecord.directory,
  });
  await writeSuccessArtifacts(runRecord, output);
  return output;
}

/**
 * @param {{
 *   githubClient: GitHubClient,
 *   parentIssueNumber: number,
 * }} options
 * @returns {Promise<{ parentIssue: GitHubIssue, warnings: IssueStorePublishWarning[] }>}
 */
async function readValidParentIssue({ githubClient, parentIssueNumber }) {
  const parentIssue = await githubClient.getIssue(parentIssueNumber);
  if (parentIssue.state.toUpperCase() !== 'OPEN') {
    throw new Error(`Parent Issue #${parentIssueNumber} must be open for child publication.`);
  }

  if (parentIssue.parent !== null) {
    throw new Error(
      `Issue #${parentIssueNumber} is itself a Child Issue and cannot be a Parent Issue.`,
    );
  }

  /** @type {IssueStorePublishWarning[]} */
  const warnings = [];
  if (readPrdIssuePublicationMarker(parentIssue.body) === undefined) {
    warnings.push({
      code: 'parent-missing-pullops-prd-marker',
      message: `Parent Issue #${parentIssueNumber} is open but is not marked as a PullOps-published PRD Issue.`,
    });
  }

  return { parentIssue, warnings };
}

/**
 * @param {NormalizedChildIssueRequest} childRequest
 * @param {GitHubIssue} issue
 * @returns {ChildIssuePublishChild}
 */
function createPublishedChild(childRequest, issue) {
  return {
    sliceRef: childRequest.sliceRef,
    action: 'created',
    issue: {
      number: issue.number,
      url: issue.url,
    },
    ...(childRequest.triageRole === undefined ? {} : { triageRole: childRequest.triageRole }),
  };
}

/**
 * @param {{
 *   parentIssue: GitHubIssue,
 *   children: ChildIssuePublishChild[],
 *   warnings: IssueStorePublishWarning[],
 *   localRunRecord: string,
 * }} options
 * @returns {ChildIssuePublishSuccessOutput}
 */
function createSuccessOutput({ parentIssue, children, warnings, localRunRecord }) {
  return {
    status: 'accepted',
    summary: `Published ${children.length} Child Issues under Parent Issue #${parentIssue.number}.`,
    action: 'created',
    parent: {
      number: parentIssue.number,
      url: parentIssue.url,
    },
    children,
    mappings: createMappings(children),
    warnings,
    localRunRecord,
  };
}

/**
 * @param {ChildIssuePublishChild[]} children
 * @returns {ChildIssuePublishMapping[]}
 */
function createMappings(children) {
  return children.map(child => ({
    sliceRef: child.sliceRef,
    issueNumber: child.issue.number,
    issueUrl: child.issue.url,
  }));
}

/**
 * @param {{ directory: string }} runRecord
 * @param {ChildIssuePublishSuccessOutput} output
 * @returns {Promise<void>}
 */
async function writeSuccessArtifacts(runRecord, output) {
  await writeIssueStoreRunArtifact(
    runRecord,
    'response.json',
    `${JSON.stringify(output, null, 2)}\n`,
  );
  if (output.warnings.length > 0) {
    await writeIssueStoreRunArtifact(
      runRecord,
      'warnings.json',
      `${JSON.stringify(output.warnings, null, 2)}\n`,
    );
  }
}

/**
 * @param {{ directory: string }} runRecord
 * @param {{
 *   summary: string,
 *   failureReason: string,
 *   warnings: IssueStorePublishWarning[],
 * }} options
 * @returns {Promise<ChildIssuePublishFailureOutput>}
 */
async function writeFailureResult(runRecord, { summary, failureReason, warnings }) {
  /** @type {ChildIssuePublishFailureOutput} */
  const output = {
    status: 'failed',
    summary,
    failureReason,
    warnings,
    localRunRecord: runRecord.directory,
  };
  await writeIssueStoreRunArtifact(
    runRecord,
    'response.json',
    `${JSON.stringify(output, null, 2)}\n`,
  );
  await writeIssueStoreRunArtifact(runRecord, 'failure-reason.txt', `${failureReason}\n`);
  if (warnings.length > 0) {
    await writeIssueStoreRunArtifact(
      runRecord,
      'warnings.json',
      `${JSON.stringify(warnings, null, 2)}\n`,
    );
  }
  return output;
}

/**
 * @param {{ directory: string }} runRecord
 * @param {{
 *   parentIssue: GitHubIssue,
 *   children: ChildIssuePublishChild[],
 *   failedChildren: ChildIssuePublishFailure[],
 *   warnings: IssueStorePublishWarning[],
 *   failureReason: string,
 * }} options
 * @returns {Promise<ChildIssuePublishFailureOutput>}
 */
async function writePartialFailure(
  runRecord,
  { parentIssue, children, failedChildren, warnings, failureReason },
) {
  /** @type {ChildIssuePublishFailureOutput} */
  const output = {
    status: 'failed',
    summary: `Published ${children.length} Child Issues under Parent Issue #${parentIssue.number}, but the batch failed.`,
    failureReason,
    parent: {
      number: parentIssue.number,
      url: parentIssue.url,
    },
    children,
    mappings: createMappings(children),
    failedChildren,
    warnings,
    localRunRecord: runRecord.directory,
  };
  await writeIssueStoreRunArtifact(
    runRecord,
    'response.json',
    `${JSON.stringify(output, null, 2)}\n`,
  );
  await writeIssueStoreRunArtifact(runRecord, 'failure-reason.txt', `${failureReason}\n`);
  await writeIssueStoreRunArtifact(
    runRecord,
    'failures.json',
    `${JSON.stringify(failedChildren, null, 2)}\n`,
  );
  if (warnings.length > 0) {
    await writeIssueStoreRunArtifact(
      runRecord,
      'warnings.json',
      `${JSON.stringify(warnings, null, 2)}\n`,
    );
  }
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
 * @param {number | undefined} parentIssueNumber
 * @returns {NormalizedChildIssueBatchRequest}
 */
function normalizeChildIssueBatchPublicationRequest(rawRequest, parentIssueNumber) {
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
  if (
    kind !== undefined &&
    kind !== 'child-issue-batch' &&
    kind !== 'child-issues' &&
    kind !== 'children'
  ) {
    throw new Error(
      `Publish request kind must be "child-issue-batch". Received ${JSON.stringify(kind)}.`,
    );
  }

  const normalizedParentIssueNumber = readConflictingParentIssueNumber({
    parentIssueNumber,
    candidates,
  });
  const children = normalizeChildren(readChildrenValue(candidates));

  return {
    parentIssueNumber: normalizedParentIssueNumber,
    children,
  };
}

/**
 * @param {Record<string, unknown>} value
 * @returns {Record<string, unknown>[]}
 */
function collectRequestCandidates(value) {
  const candidates = [value];
  for (const key of ['request', 'batch', 'childIssueBatch']) {
    const candidate = value[key];
    if (isPlainObject(candidate)) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

/**
 * @param {{
 *   parentIssueNumber: number | undefined,
 *   candidates: Record<string, unknown>[],
 * }} options
 * @returns {number}
 */
function readConflictingParentIssueNumber({ parentIssueNumber, candidates }) {
  /** @type {number[]} */
  const values = [];
  if (parentIssueNumber !== undefined) {
    values.push(readPositiveInteger(parentIssueNumber, 'Request.parentIssueNumber'));
  }

  for (const candidate of candidates) {
    const value = readParentIssueNumberValue(candidate);
    if (value !== undefined) {
      values.push(value);
    }
  }

  if (values.length === 0) {
    throw new Error('Request.parentIssueNumber must be a positive integer.');
  }

  const [firstValue] = values;
  if (values.some(value => value !== firstValue)) {
    throw new Error('Request.parentIssueNumber values conflict.');
  }

  return firstValue;
}

/**
 * @param {Record<string, unknown>} candidate
 * @returns {number | undefined}
 */
function readParentIssueNumberValue(candidate) {
  const rawValue = firstDefined(
    candidate.parentIssueNumber,
    candidate.parentNumber,
    candidate.parent,
  );
  if (rawValue === undefined) {
    return undefined;
  }

  if (isPlainObject(rawValue)) {
    return readPositiveInteger(
      firstDefined(rawValue.issueNumber, rawValue.number),
      'Request.parentIssueNumber',
    );
  }

  return readPositiveInteger(rawValue, 'Request.parentIssueNumber');
}

/**
 * @param {Record<string, unknown>[]} candidates
 * @returns {unknown}
 */
function readChildrenValue(candidates) {
  /** @type {unknown} */
  let childrenValue;
  let hasValue = false;
  let serializedValue;

  for (const candidate of candidates) {
    const value = firstDefined(candidate.children, candidate.slices, candidate.childIssues);
    if (value === undefined) {
      continue;
    }

    const nextSerializedValue = JSON.stringify(value);
    if (!hasValue) {
      childrenValue = value;
      serializedValue = nextSerializedValue;
      hasValue = true;
      continue;
    }

    if (serializedValue !== nextSerializedValue) {
      throw new Error('Request.children values conflict.');
    }
  }

  if (!hasValue) {
    throw new Error('Request.children must contain at least one item.');
  }

  return childrenValue;
}

/**
 * @param {unknown} value
 * @returns {NormalizedChildIssueRequest[]}
 */
function normalizeChildren(value) {
  if (!Array.isArray(value)) {
    throw new Error('Request.children must be an array.');
  }

  if (value.length === 0) {
    throw new Error('Request.children must contain at least one item.');
  }

  /** @type {NormalizedChildIssueRequest[]} */
  const children = [];
  const seenSliceRefs = new Set();

  for (const [index, item] of value.entries()) {
    if (!isPlainObject(item)) {
      throw new Error(`Request.children[${index}] must be an object.`);
    }

    rejectIntraBatchDependencies(item, `Request.children[${index}]`);

    const sliceRef = readSliceRef(
      firstDefined(item.sliceRef, item.ref, item.slice),
      `Request.children[${index}].sliceRef`,
    );
    if (seenSliceRefs.has(sliceRef)) {
      throw new Error(`Request.children[${index}].sliceRef must be unique.`);
    }
    seenSliceRefs.add(sliceRef);

    const title = readNonEmptyString(item.title, `Request.children[${index}].title`);
    const whatToBuild = readNonEmptyString(
      firstDefined(item.whatToBuild, item.body),
      `Request.children[${index}].whatToBuild`,
    );
    const acceptanceCriteria = readRequiredStringArray(
      item.acceptanceCriteria,
      `Request.children[${index}].acceptanceCriteria`,
    );
    const blockedBy = uniquePositiveIntegers(
      item.blockedBy,
      `Request.children[${index}].blockedBy`,
    );
    const coveredUserStories = uniquePositiveIntegers(
      firstDefined(
        item.coveredUserStories,
        item.coveredPrdUserStories,
        item.prdUserStories,
        item.userStories,
      ),
      `Request.children[${index}].coveredUserStories`,
    ).sort((left, right) => left - right);
    const supportWork = readSupportWork(item, `Request.children[${index}]`);
    if (coveredUserStories.length === 0 && !supportWork) {
      throw new Error(
        `Request.children[${index}] must include covered PRD user story numbers or supportWork: true.`,
      );
    }

    const triageRoleValue = item.triageRole;
    const triageRole =
      triageRoleValue === undefined
        ? undefined
        : readTriageRole(triageRoleValue, `Request.children[${index}].triageRole`);

    children.push({
      sliceRef,
      title,
      whatToBuild,
      acceptanceCriteria,
      blockedBy,
      coveredUserStories,
      supportWork,
      ...(triageRole === undefined ? {} : { triageRole }),
    });
  }

  return children;
}

/**
 * @param {Record<string, unknown>} item
 * @param {string} path
 */
function rejectIntraBatchDependencies(item, path) {
  for (const key of ['dependsOn', 'dependencies', 'blockedBySliceRefs', 'blockedBySlices']) {
    const value = item[key];
    if (Array.isArray(value) && value.length > 0) {
      throw new Error(`${path}.${key} is not supported by publish-children yet.`);
    }
  }
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
 * @returns {string | undefined}
 */
function readOptionalConflictingString(candidates, readValue, path) {
  return readOptionalConflictingValue(candidates, readValue, path, readOptionalString);
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {string}
 */
function readSliceRef(value, path) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return String(value);
  }

  return readNonEmptyString(value, path);
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
 * @returns {number}
 */
function readPositiveInteger(value, path) {
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
 * @param {Record<string, unknown>} item
 * @param {string} path
 * @returns {boolean}
 */
function readSupportWork(item, path) {
  const explicitSupportWork = item.supportWork ?? item.isSupportWork;
  if (explicitSupportWork !== undefined) {
    if (typeof explicitSupportWork !== 'boolean') {
      throw new Error(`${path}.supportWork must be a boolean.`);
    }

    return explicitSupportWork;
  }

  const kind = readOptionalString(
    firstDefined(item.kind, item.type, item.workType),
    `${path}.kind`,
  );
  return kind === 'support' || kind === 'support-work';
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
