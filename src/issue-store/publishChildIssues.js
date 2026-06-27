import { createChildIssueBody, readChildIssuePublicationMarker } from './childIssueBody.js';
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
 * @param {boolean} [options.forceUpdate]
 * @param {Date} [options.createdAt]
 * @returns {Promise<ChildIssuePublishOutput>}
 */
export async function publishChildIssues({
  cwd,
  config,
  githubClient,
  rawRequest,
  parentIssueNumber,
  forceUpdate = false,
  createdAt = new Date(),
}) {
  const rawRequestText = serializeRawRequest(rawRequest);
  /** @type {NormalizedChildIssueBatchRequest} */
  let normalizedRequest;

  try {
    normalizedRequest = normalizeChildIssueBatchPublicationRequest(
      rawRequest,
      parentIssueNumber,
      forceUpdate,
    );
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

    return await publishChildIssueBatch({
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
async function publishChildIssueBatch({
  githubClient,
  normalizedRequest,
  parentIssue,
  runRecord,
  warnings,
}) {
  const addSubIssue = githubClient.addSubIssue;
  if (typeof addSubIssue !== 'function') {
    throw new Error('GitHub client does not support native sub-issue creation.');
  }

  const existingChildrenBySliceRef = await readExistingPublishedChildrenBySliceRef({
    githubClient,
    parentIssue,
  });
  /** @type {ChildIssuePublishChild[]} */
  const children = [];
  /** @type {ChildIssuePublishFailure[]} */
  const failedChildren = [];
  /** @type {Map<string, number>} */
  const publishedIssueNumbersBySliceRef = new Map();

  for (const childRequest of normalizedRequest.children) {
    try {
      const resolvedBlockedBy = resolveBlockedByIssueNumbers({
        childRequest,
        publishedIssueNumbersBySliceRef,
      });

      const publishedChild = await publishOneChildIssue({
        githubClient,
        childRequest,
        existingChild: selectExistingChild({
          childRequest,
          existingChildrenBySliceRef,
          forceUpdate: normalizedRequest.forceUpdate,
        }),
        parentIssueNumber: normalizedRequest.parentIssueNumber,
        resolvedBlockedBy,
      });

      children.push(publishedChild);
      publishedIssueNumbersBySliceRef.set(childRequest.sliceRef, publishedChild.issue.number);
    } catch (error) {
      const publishedChild = readPublishedChildFromError(error);
      if (publishedChild !== undefined) {
        children.push(publishedChild);
      }
      failedChildren.push({
        sliceRef: childRequest.sliceRef,
        failureReason: getErrorMessage(error),
        ...(publishedChild === undefined
          ? {}
          : {
              action: publishedChild.action,
              issue: publishedChild.issue,
            }),
      });
    }
  }

  if (failedChildren.length > 0) {
    return await writePartialFailure(runRecord, {
      parentIssue,
      children,
      failedChildren,
      warnings,
      failureReason: summarizeFailedChildren(failedChildren),
    });
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
 *   parentIssue: GitHubIssue,
 * }} options
 * @returns {Promise<Map<string, GitHubIssue>>}
 */
async function readExistingPublishedChildrenBySliceRef({ githubClient, parentIssue }) {
  /** @type {Map<string, GitHubIssue>} */
  const existingChildrenBySliceRef = new Map();

  for (const reference of parentIssue.subIssues) {
    const issue = await githubClient.getIssue(reference.number);
    const marker = readChildIssuePublicationMarker(issue.body);
    if (marker === undefined || marker.parentIssueNumber !== parentIssue.number) {
      continue;
    }

    const existingIssue = existingChildrenBySliceRef.get(marker.sliceRef);
    if (existingIssue !== undefined) {
      throw new Error(
        `Multiple PullOps-published Child Issues under Parent Issue #${parentIssue.number} use sliceRef "${marker.sliceRef}": #${existingIssue.number} and #${issue.number}.`,
      );
    }

    existingChildrenBySliceRef.set(marker.sliceRef, issue);
  }

  return existingChildrenBySliceRef;
}

/**
 * @param {{
 *   childRequest: NormalizedChildIssueRequest,
 *   existingChildrenBySliceRef: Map<string, GitHubIssue>,
 *   forceUpdate: boolean,
 * }} options
 * @returns {GitHubIssue | undefined}
 */
function selectExistingChild({ childRequest, existingChildrenBySliceRef, forceUpdate }) {
  if (childRequest.issueNumber !== undefined) {
    return undefined;
  }

  const existingChild = existingChildrenBySliceRef.get(childRequest.sliceRef);
  if (existingChild === undefined) {
    return undefined;
  }

  if (forceUpdate) {
    return existingChild;
  }

  throw new Error(
    `Child Issue for sliceRef "${childRequest.sliceRef}" already exists as #${existingChild.number}. Rerun with forceUpdate: true or --force to update it.`,
  );
}

/**
 * @param {{
 *   githubClient: GitHubClient,
 *   childRequest: NormalizedChildIssueRequest,
 *   existingChild: GitHubIssue | undefined,
 *   parentIssueNumber: number,
 *   resolvedBlockedBy: number[],
 * }} options
 * @returns {Promise<ChildIssuePublishChild>}
 */
async function publishOneChildIssue({
  githubClient,
  childRequest,
  existingChild,
  parentIssueNumber,
  resolvedBlockedBy,
}) {
  if (childRequest.issueNumber !== undefined) {
    return await updateChildIssue({
      githubClient,
      childRequest,
      existingIssue: await readExplicitChildIssueOverride({
        githubClient,
        childRequest,
        parentIssueNumber,
      }),
      parentIssueNumber,
      resolvedBlockedBy,
    });
  }

  if (existingChild !== undefined) {
    return await updateChildIssue({
      githubClient,
      childRequest,
      existingIssue: existingChild,
      parentIssueNumber,
      resolvedBlockedBy,
    });
  }

  return await createChildIssue({
    githubClient,
    childRequest,
    parentIssueNumber,
    resolvedBlockedBy,
  });
}

/**
 * @param {{
 *   githubClient: GitHubClient,
 *   childRequest: NormalizedChildIssueRequest,
 *   parentIssueNumber: number,
 * }} options
 * @returns {Promise<GitHubIssue>}
 */
async function readExplicitChildIssueOverride({ githubClient, childRequest, parentIssueNumber }) {
  const issueNumber = childRequest.issueNumber;
  if (issueNumber === undefined) {
    throw new Error('Issue number override is required for repair publication.');
  }

  const issue = await githubClient.getIssue(issueNumber);
  assertMarkerOwnedChildIssue({
    issue,
    childRequest,
    parentIssueNumber,
  });
  return issue;
}

/**
 * @param {{
 *   issue: GitHubIssue,
 *   childRequest: NormalizedChildIssueRequest,
 *   parentIssueNumber: number,
 * }} options
 */
function assertMarkerOwnedChildIssue({ issue, childRequest, parentIssueNumber }) {
  const marker = readChildIssuePublicationMarker(issue.body);
  if (marker === undefined) {
    throw new Error(`Issue #${issue.number} is not marked as a PullOps-published Child Issue.`);
  }

  if (marker.parentIssueNumber !== parentIssueNumber) {
    throw new Error(
      `Issue #${issue.number} is marked for Parent Issue #${marker.parentIssueNumber}, not #${parentIssueNumber}.`,
    );
  }

  if (marker.sliceRef !== childRequest.sliceRef) {
    throw new Error(
      `Issue #${issue.number} is marked for sliceRef "${marker.sliceRef}", not "${childRequest.sliceRef}".`,
    );
  }
}

/**
 * @param {{
 *   githubClient: GitHubClient,
 *   childRequest: NormalizedChildIssueRequest,
 *   parentIssueNumber: number,
 *   resolvedBlockedBy: number[],
 * }} options
 * @returns {Promise<ChildIssuePublishChild>}
 */
async function createChildIssue({
  githubClient,
  childRequest,
  parentIssueNumber,
  resolvedBlockedBy,
}) {
  const createIssue = githubClient.createIssue;
  if (typeof createIssue !== 'function') {
    throw new Error('GitHub client does not support issue creation.');
  }

  /** @type {ChildIssuePublishChild | undefined} */
  let publishedChild;
  try {
    const createdIssue = await createIssue.call(githubClient, {
      title: childRequest.title,
      body: createChildIssueBody({
        ...childRequest,
        blockedBy: resolvedBlockedBy,
        parentIssueNumber,
      }),
    });
    publishedChild = createPublishedChild(childRequest, createdIssue, 'created', resolvedBlockedBy);

    await githubClient.addSubIssue?.({
      parentIssueNumber,
      childIssueNumber: createdIssue.number,
    });

    await syncChildTriageRole({
      githubClient,
      childRequest,
      issue: createdIssue,
      currentLabels: createdIssue.labels,
    });

    return publishedChild;
  } catch (error) {
    throw createChildPublicationError(error, publishedChild);
  }
}

/**
 * @param {{
 *   githubClient: GitHubClient,
 *   childRequest: NormalizedChildIssueRequest,
 *   existingIssue: GitHubIssue,
 *   parentIssueNumber: number,
 *   resolvedBlockedBy: number[],
 * }} options
 * @returns {Promise<ChildIssuePublishChild>}
 */
async function updateChildIssue({
  githubClient,
  childRequest,
  existingIssue,
  parentIssueNumber,
  resolvedBlockedBy,
}) {
  assertMarkerOwnedChildIssue({
    issue: existingIssue,
    childRequest,
    parentIssueNumber,
  });

  const updateIssue = githubClient.updateIssue;
  if (typeof updateIssue !== 'function') {
    throw new Error('GitHub client does not support issue updates.');
  }

  /** @type {ChildIssuePublishChild | undefined} */
  let publishedChild;
  try {
    const updatedIssue = await updateIssue.call(githubClient, {
      number: existingIssue.number,
      title: childRequest.title,
      body: createChildIssueBody({
        ...childRequest,
        blockedBy: resolvedBlockedBy,
        parentIssueNumber,
      }),
    });
    publishedChild = createPublishedChild(childRequest, updatedIssue, 'updated', resolvedBlockedBy);

    if (existingIssue.parent?.number !== parentIssueNumber) {
      await githubClient.addSubIssue?.({
        parentIssueNumber,
        childIssueNumber: existingIssue.number,
      });
    }

    await syncChildTriageRole({
      githubClient,
      childRequest,
      issue: updatedIssue,
      currentLabels: existingIssue.labels,
    });

    return publishedChild;
  } catch (error) {
    throw createChildPublicationError(error, publishedChild);
  }
}

/**
 * @param {{
 *   githubClient: GitHubClient,
 *   childRequest: NormalizedChildIssueRequest,
 *   issue: GitHubIssue,
 *   currentLabels: string[],
 * }} options
 * @returns {Promise<void>}
 */
async function syncChildTriageRole({ githubClient, childRequest, issue, currentLabels }) {
  const triageRole = childRequest.triageRole;
  if (triageRole === undefined) {
    return;
  }

  await syncTriageRoleLabels({
    githubClient,
    issueNumber: issue.number,
    currentLabels,
    triageRole,
  });
}

/**
 * @param {{
 *   childRequest: NormalizedChildIssueRequest,
 *   publishedIssueNumbersBySliceRef: Map<string, number>,
 * }} options
 * @returns {number[]}
 */
function resolveBlockedByIssueNumbers({ childRequest, publishedIssueNumbersBySliceRef }) {
  /** @type {number[]} */
  const resolved = [];

  for (const sliceRef of childRequest.blockedBySliceRefs) {
    const issueNumber = publishedIssueNumbersBySliceRef.get(sliceRef);
    if (issueNumber === undefined) {
      throw new Error(
        `Blocked by sliceRef "${sliceRef}" has not been successfully published in this batch.`,
      );
    }
    pushUnique(resolved, issueNumber);
  }

  for (const issueNumber of childRequest.blockedBy) {
    pushUnique(resolved, issueNumber);
  }

  return resolved;
}

/**
 * @param {unknown} error
 * @param {ChildIssuePublishChild | undefined} publishedChild
 * @returns {Error}
 */
function createChildPublicationError(error, publishedChild) {
  const publicationError = error instanceof Error ? error : new Error(String(error));
  if (publishedChild === undefined) {
    return publicationError;
  }

  return Object.assign(publicationError, { publishedChild });
}

/**
 * @param {unknown} error
 * @returns {ChildIssuePublishChild | undefined}
 */
function readPublishedChildFromError(error) {
  if (!isPlainObject(error)) {
    return undefined;
  }

  const child = error.publishedChild;
  if (!isPlainObject(child)) {
    return undefined;
  }

  if (
    typeof child.sliceRef !== 'string' ||
    (child.action !== 'created' && child.action !== 'updated') ||
    !isPlainObject(child.issue) ||
    !Array.isArray(child.blockedBy)
  ) {
    return undefined;
  }

  return /** @type {ChildIssuePublishChild} */ (/** @type {unknown} */ (child));
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
 * @param {'created' | 'updated'} action
 * @param {number[]} blockedBy
 * @returns {ChildIssuePublishChild}
 */
function createPublishedChild(childRequest, issue, action, blockedBy) {
  return {
    sliceRef: childRequest.sliceRef,
    action,
    issue: {
      number: issue.number,
      url: issue.url,
    },
    blockedBy,
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
    action: summarizeBatchAction(children),
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
  await writeIssueStoreRunArtifact(
    runRecord,
    'warnings.json',
    `${JSON.stringify(output.warnings, null, 2)}\n`,
  );
  await writeIssueStoreRunArtifact(runRecord, 'failures.json', `${JSON.stringify([], null, 2)}\n`);
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
    summary: `Published ${children.length} Child Issues under Parent Issue #${parentIssue.number}, but ${failedChildren.length} slice(s) failed.`,
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
  await writeIssueStoreRunArtifact(
    runRecord,
    'warnings.json',
    `${JSON.stringify(warnings, null, 2)}\n`,
  );
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
 * @param {boolean} forceUpdate
 * @returns {NormalizedChildIssueBatchRequest}
 */
function normalizeChildIssueBatchPublicationRequest(rawRequest, parentIssueNumber, forceUpdate) {
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
  const requestForceUpdate =
    readOptionalConflictingBoolean(
      candidates,
      candidate => firstDefined(candidate.forceUpdate, candidate.force),
      'Request.forceUpdate',
    ) ?? false;

  return {
    parentIssueNumber: normalizedParentIssueNumber,
    children,
    forceUpdate: forceUpdate || requestForceUpdate,
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

    const sliceRef = readSliceRef(
      firstDefined(item.sliceRef, item.ref, item.slice),
      `Request.children[${index}].sliceRef`,
    );
    if (seenSliceRefs.has(sliceRef)) {
      throw new Error(`Request.children[${index}].sliceRef must be unique.`);
    }

    const title = readNonEmptyString(item.title, `Request.children[${index}].title`);
    const whatToBuild = readNonEmptyString(
      firstDefined(item.whatToBuild, item.body),
      `Request.children[${index}].whatToBuild`,
    );
    const acceptanceCriteria = readRequiredStringArray(
      item.acceptanceCriteria,
      `Request.children[${index}].acceptanceCriteria`,
    );
    const issueNumber = readOptionalChildIssueNumber(item, `Request.children[${index}]`);
    const blockedByDependencies = readBlockedByDependencies({
      value: item.blockedBy,
      path: `Request.children[${index}].blockedBy`,
      seenSliceRefs,
    });
    const blockedBySliceRefs = readBlockedBySliceRefs({
      item,
      path: `Request.children[${index}]`,
      seenSliceRefs,
    });
    const blockedBy = uniquePositiveIntegers(
      blockedByDependencies.issueNumbers,
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
      ...(issueNumber === undefined ? {} : { issueNumber }),
      sliceRef,
      title,
      whatToBuild,
      acceptanceCriteria,
      blockedBy,
      blockedBySliceRefs: uniqueStrings([
        ...blockedByDependencies.sliceRefs,
        ...blockedBySliceRefs,
      ]),
      coveredUserStories,
      supportWork,
      ...(triageRole === undefined ? {} : { triageRole }),
    });
    seenSliceRefs.add(sliceRef);
  }

  return children;
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
 * @param {Record<string, unknown>[]} candidates
 * @param {(candidate: Record<string, unknown>) => unknown} readValue
 * @param {string} path
 * @returns {boolean | undefined}
 */
function readOptionalConflictingBoolean(candidates, readValue, path) {
  return readOptionalConflictingValue(candidates, readValue, path, readOptionalBoolean);
}

/**
 * @param {Record<string, unknown>} item
 * @param {string} path
 * @returns {number | undefined}
 */
function readOptionalChildIssueNumber(item, path) {
  /** @type {number[]} */
  const values = [];
  const directValue = firstDefined(item.issueNumber, item.number);
  if (directValue !== undefined) {
    const directIssueNumber = readOptionalPositiveInteger(directValue, `${path}.issueNumber`);
    if (directIssueNumber !== undefined) {
      values.push(directIssueNumber);
    }
  }

  if (isPlainObject(item.issue)) {
    const nestedValue = firstDefined(item.issue.issueNumber, item.issue.number);
    if (nestedValue !== undefined) {
      const nestedIssueNumber = readOptionalPositiveInteger(nestedValue, `${path}.issueNumber`);
      if (nestedIssueNumber !== undefined) {
        values.push(nestedIssueNumber);
      }
    }
  }

  if (values.length === 0) {
    return undefined;
  }

  const [firstValue] = values;
  if (values.some(value => value !== firstValue)) {
    throw new Error(`${path}.issueNumber values conflict.`);
  }

  return firstValue;
}

/**
 * @param {{
 *   value: unknown,
 *   path: string,
 *   seenSliceRefs: Set<string>,
 * }} options
 * @returns {{ issueNumbers: number[], sliceRefs: string[] }}
 */
function readBlockedByDependencies({ value, path, seenSliceRefs }) {
  /** @type {number[]} */
  const issueNumbers = [];
  /** @type {string[]} */
  const sliceRefs = [];

  if (value === undefined) {
    return { issueNumbers, sliceRefs };
  }

  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array.`);
  }

  for (const [index, item] of value.entries()) {
    if (typeof item === 'number') {
      pushUnique(issueNumbers, readPositiveInteger(item, `${path}[${index}]`));
      continue;
    }

    const sliceRef = readSliceRef(item, `${path}[${index}]`);
    assertEarlierSliceRef({
      sliceRef,
      seenSliceRefs,
      path: `${path}[${index}]`,
    });
    pushUnique(sliceRefs, sliceRef);
  }

  return { issueNumbers, sliceRefs };
}

/**
 * @param {{
 *   item: Record<string, unknown>,
 *   path: string,
 *   seenSliceRefs: Set<string>,
 * }} options
 * @returns {string[]}
 */
function readBlockedBySliceRefs({ item, path, seenSliceRefs }) {
  /** @type {string[]} */
  const sliceRefs = [];

  for (const key of ['dependsOn', 'dependencies', 'blockedBySliceRefs', 'blockedBySlices']) {
    const value = item[key];
    if (value === undefined) {
      continue;
    }

    if (!Array.isArray(value)) {
      throw new Error(`${path}.${key} must be an array.`);
    }

    for (const [index, entry] of value.entries()) {
      const sliceRef = readSliceRef(entry, `${path}.${key}[${index}]`);
      assertEarlierSliceRef({
        sliceRef,
        seenSliceRefs,
        path: `${path}.${key}[${index}]`,
      });
      pushUnique(sliceRefs, sliceRef);
    }
  }

  return sliceRefs;
}

/**
 * @param {{
 *   sliceRef: string,
 *   seenSliceRefs: Set<string>,
 *   path: string,
 * }} options
 */
function assertEarlierSliceRef({ sliceRef, seenSliceRefs, path }) {
  if (!seenSliceRefs.has(sliceRef)) {
    throw new Error(
      `${path} must reference an earlier Child Issue sliceRef. Unknown "${sliceRef}".`,
    );
  }
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
 * @returns {boolean | undefined}
 */
function readOptionalBoolean(value, path = 'value') {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'boolean') {
    throw new Error(`${path} must be a boolean.`);
  }

  return value;
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
 * @returns {number | undefined}
 */
function readOptionalPositiveInteger(value, path) {
  if (value === undefined) {
    return undefined;
  }

  return readPositiveInteger(value, path);
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
 * @param {ChildIssuePublishChild[]} children
 * @returns {'created' | 'updated' | 'mixed'}
 */
function summarizeBatchAction(children) {
  const actions = uniqueStrings(children.map(child => child.action));
  if (actions.length === 1 && actions[0] === 'updated') {
    return 'updated';
  }

  if (actions.length === 1 && actions[0] === 'created') {
    return 'created';
  }

  return 'mixed';
}

/**
 * @param {ChildIssuePublishFailure[]} failedChildren
 * @returns {string}
 */
function summarizeFailedChildren(failedChildren) {
  return failedChildren
    .map(child => `sliceRef "${child.sliceRef}": ${child.failureReason}`)
    .join('\n');
}

/**
 * @param {string[]} values
 * @returns {string[]}
 */
function uniqueStrings(values) {
  /** @type {string[]} */
  const uniqueValues = [];
  for (const value of values) {
    pushUnique(uniqueValues, value);
  }
  return uniqueValues;
}

/**
 * @template TValue
 * @param {TValue[]} values
 * @param {TValue} value
 */
function pushUnique(values, value) {
  if (!values.includes(value)) {
    values.push(value);
  }
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
