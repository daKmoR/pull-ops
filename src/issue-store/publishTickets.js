import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createTicketBody, readTicketPublicationMarker } from './ticketBody.js';
import { createRunRecordLocation, writeRunArtifact } from '../local-run-record/localRunRecord.js';
import { readSpecIssuePublicationMarker } from './specIssueBody.js';

/**
 * @typedef {Pick<import('../config/types.js').PullOpsConfig, 'issueStore'>} IssueStoreConfig
 * @typedef {import('../github/types.js').GitHubClient} GitHubClient
 * @typedef {import('../github/types.js').GitHubIssue} GitHubIssue
 * @typedef {import('./types.js').TicketPublishTicket} TicketPublishTicket
 * @typedef {import('./types.js').TicketPublishFailure} TicketPublishFailure
 * @typedef {import('./types.js').TicketPublishFailureOutput} TicketPublishFailureOutput
 * @typedef {import('./types.js').TicketPublishMapping} TicketPublishMapping
 * @typedef {import('./types.js').TicketPublishOutput} TicketPublishOutput
 * @typedef {import('./types.js').TicketPublishSuccessOutput} TicketPublishSuccessOutput
 * @typedef {import('./types.js').IssueStorePublishWarning} IssueStorePublishWarning
 * @typedef {import('./types.js').NormalizedTicketBatchRequest} NormalizedTicketBatchRequest
 * @typedef {import('./types.js').NormalizedTicketRequest} NormalizedTicketRequest
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
 * @returns {Promise<TicketPublishOutput>}
 */
export async function publishTickets({
  cwd,
  config,
  githubClient,
  rawRequest,
  parentIssueNumber,
  forceUpdate = false,
  createdAt = new Date(),
}) {
  const rawRequestText = serializeRawRequest(rawRequest);
  /** @type {NormalizedTicketBatchRequest} */
  let normalizedRequest;

  try {
    normalizedRequest = normalizeTicketBatchPublicationRequest(
      rawRequest,
      parentIssueNumber,
      forceUpdate,
    );
  } catch (error) {
    const runRecord = createRunRecordLocation({
      cwd,
      operationReference: 'issues:publish-tickets',
      targetReference: 'invalid',
      createdAt,
    });
    await writeRunArtifact(runRecord, 'request.raw.txt', `${rawRequestText}\n`);
    return await writeFailureResult(runRecord, {
      summary: 'Publish Ticket batch failed.',
      failureReason: getErrorMessage(error),
      warnings: [],
    });
  }

  const runRecord = createRunRecordLocation({
    cwd,
    operationReference: 'issues:publish-tickets',
    targetReference: normalizedRequest.parentIssueNumber,
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
      summary: 'Publish Ticket batch failed.',
      failureReason: `Issue Store provider "${provider}" is not supported by publish-tickets.`,
      warnings: [],
    });
  }

  try {
    const { parentIssue, warnings } = await readValidParentIssue({
      githubClient,
      parentIssueNumber: normalizedRequest.parentIssueNumber,
    });

    return await publishTicketBatch({
      cwd,
      githubClient,
      normalizedRequest,
      parentIssue,
      runRecord,
      warnings,
    });
  } catch (error) {
    return await writeFailureResult(runRecord, {
      summary: 'Publish Ticket batch failed.',
      failureReason: getErrorMessage(error),
      warnings: [],
    });
  }
}

/**
 * @param {{
 *   cwd: string,
 *   githubClient: GitHubClient,
 *   normalizedRequest: NormalizedTicketBatchRequest,
 *   parentIssue: GitHubIssue,
 *   runRecord: { directory: string },
 *   warnings: IssueStorePublishWarning[],
 * }} options
 * @returns {Promise<TicketPublishOutput>}
 */
async function publishTicketBatch({
  cwd,
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

  const existingTicketsBySliceRef = await readExistingPublishedTicketsBySliceRef({
    cwd,
    githubClient,
    parentIssue,
    explicitOverrideSliceRefs: readExplicitIssueNumberOverrideSliceRefs(normalizedRequest),
  });
  /** @type {TicketPublishTicket[]} */
  const tickets = [];
  /** @type {TicketPublishFailure[]} */
  const failedTickets = [];
  /** @type {Map<string, number>} */
  const publishedIssueNumbersBySliceRef = new Map();

  for (const ticketRequest of normalizedRequest.tickets) {
    try {
      const resolvedBlockedBy = resolveBlockedByIssueNumbers({
        ticketRequest,
        publishedIssueNumbersBySliceRef,
      });

      const publishedTicket = await publishOneTicket({
        githubClient,
        ticketRequest,
        existingTicket: selectExistingTicket({
          ticketRequest,
          existingTicketsBySliceRef,
        }),
        forceUpdate: normalizedRequest.forceUpdate,
        parentIssueNumber: normalizedRequest.parentIssueNumber,
        resolvedBlockedBy,
      });

      tickets.push(publishedTicket);
      publishedIssueNumbersBySliceRef.set(ticketRequest.sliceRef, publishedTicket.issue.number);
    } catch (error) {
      const publishedTicket = readPublishedTicketFromError(error);
      if (publishedTicket !== undefined) {
        tickets.push(publishedTicket);
      }
      failedTickets.push({
        sliceRef: ticketRequest.sliceRef,
        failureReason: getErrorMessage(error),
        ...(publishedTicket === undefined
          ? {}
          : {
              ...(publishedTicket.action === 'created' || publishedTicket.action === 'updated'
                ? { action: publishedTicket.action }
                : {}),
              issue: publishedTicket.issue,
            }),
      });
    }
  }

  if (failedTickets.length > 0) {
    return await writePartialFailure(runRecord, {
      parentIssue,
      tickets,
      failedTickets,
      warnings,
      failureReason: summarizeFailedTickets(failedTickets),
    });
  }

  const output = createSuccessOutput({
    parentIssue,
    tickets,
    warnings,
    localRunRecord: runRecord.directory,
  });
  await writeSuccessArtifacts(runRecord, output);
  return output;
}

/**
 * @param {{
 *   cwd: string,
 *   githubClient: GitHubClient,
 *   parentIssue: GitHubIssue,
 *   explicitOverrideSliceRefs: Set<string>,
 * }} options
 * @returns {Promise<Map<string, GitHubIssue>>}
 */
async function readExistingPublishedTicketsBySliceRef({
  cwd,
  githubClient,
  parentIssue,
  explicitOverrideSliceRefs,
}) {
  /** @type {Map<string, GitHubIssue>} */
  const existingTicketsBySliceRef = new Map();

  for (const reference of parentIssue.subIssues) {
    const issue = await githubClient.getIssue(reference.number);
    const marker = readTicketPublicationMarker(issue.body);
    if (marker === undefined || marker.parentIssueNumber !== parentIssue.number) {
      continue;
    }
    if (explicitOverrideSliceRefs.has(marker.sliceRef)) {
      continue;
    }

    const existingIssue = existingTicketsBySliceRef.get(marker.sliceRef);
    if (existingIssue !== undefined) {
      throw new Error(
        `Multiple PullOps-published Tickets under Parent Issue #${parentIssue.number} use sliceRef "${marker.sliceRef}": #${existingIssue.number} and #${issue.number}.`,
      );
    }

    existingTicketsBySliceRef.set(marker.sliceRef, issue);
  }

  const recoveredTicketRefs = await readRecoveredTicketRefsByNewestRun({
    cwd,
    parentIssueNumber: parentIssue.number,
  });
  for (const [sliceRef, issueNumber] of recoveredTicketRefs) {
    if (explicitOverrideSliceRefs.has(sliceRef) || existingTicketsBySliceRef.has(sliceRef)) {
      continue;
    }

    /** @type {GitHubIssue | undefined} */
    let issue;
    try {
      issue = await githubClient.getIssue(issueNumber);
    } catch {
      continue;
    }
    if (issue === undefined) {
      continue;
    }

    const marker = readTicketPublicationMarker(issue.body);
    if (
      marker === undefined ||
      marker.parentIssueNumber !== parentIssue.number ||
      marker.sliceRef !== sliceRef
    ) {
      continue;
    }

    if (issue.parent !== null && issue.parent.number !== parentIssue.number) {
      continue;
    }

    existingTicketsBySliceRef.set(sliceRef, issue);
  }

  return existingTicketsBySliceRef;
}

/**
 * @param {NormalizedTicketBatchRequest} normalizedRequest
 * @returns {Set<string>}
 */
function readExplicitIssueNumberOverrideSliceRefs(normalizedRequest) {
  return new Set(
    normalizedRequest.tickets
      .filter(ticketRequest => ticketRequest.issueNumber !== undefined)
      .map(ticketRequest => ticketRequest.sliceRef),
  );
}

/**
 * @param {{
 *   ticketRequest: NormalizedTicketRequest,
 *   existingTicketsBySliceRef: Map<string, GitHubIssue>,
 * }} options
 * @returns {GitHubIssue | undefined}
 */
function selectExistingTicket({ ticketRequest, existingTicketsBySliceRef }) {
  if (ticketRequest.issueNumber !== undefined) {
    return undefined;
  }

  return existingTicketsBySliceRef.get(ticketRequest.sliceRef);
}

/**
 * @param {{
 *   githubClient: GitHubClient,
 *   ticketRequest: NormalizedTicketRequest,
 *   existingTicket: GitHubIssue | undefined,
 *   forceUpdate: boolean,
 *   parentIssueNumber: number,
 *   resolvedBlockedBy: number[],
 * }} options
 * @returns {Promise<TicketPublishTicket>}
 */
async function publishOneTicket({
  githubClient,
  ticketRequest,
  existingTicket,
  forceUpdate,
  parentIssueNumber,
  resolvedBlockedBy,
}) {
  if (ticketRequest.issueNumber !== undefined) {
    return await updateTicket({
      githubClient,
      ticketRequest,
      existingIssue: await readExplicitTicketOverride({
        githubClient,
        ticketRequest,
        parentIssueNumber,
      }),
      parentIssueNumber,
      resolvedBlockedBy,
    });
  }

  if (existingTicket !== undefined) {
    if (!forceUpdate) {
      if (
        shouldRepairRecoveredTicket({
          ticketRequest,
          existingIssue: existingTicket,
          parentIssueNumber,
        })
      ) {
        return await repairRecoveredTicket({
          githubClient,
          ticketRequest,
          existingIssue: existingTicket,
          parentIssueNumber,
          resolvedBlockedBy,
        });
      }

      return reuseTicket({
        ticketRequest,
        existingIssue: existingTicket,
        resolvedBlockedBy,
      });
    }

    return await updateTicket({
      githubClient,
      ticketRequest,
      existingIssue: existingTicket,
      parentIssueNumber,
      resolvedBlockedBy,
    });
  }

  return await createTicket({
    githubClient,
    ticketRequest,
    parentIssueNumber,
    resolvedBlockedBy,
  });
}

/**
 * @param {{
 *   ticketRequest: NormalizedTicketRequest,
 *   existingIssue: GitHubIssue,
 *   parentIssueNumber: number,
 * }} options
 * @returns {boolean}
 */
function shouldRepairRecoveredTicket({ ticketRequest, existingIssue, parentIssueNumber }) {
  if (existingIssue.parent?.number !== parentIssueNumber) {
    return true;
  }

  const triageRole = ticketRequest.triageRole;
  if (triageRole === undefined) {
    return false;
  }

  const currentTriageLabels = existingIssue.labels.filter(label =>
    TRIAGE_ROLES.includes(/** @type {TriageRole} */ (label)),
  );
  return currentTriageLabels.length !== 1 || currentTriageLabels[0] !== triageRole;
}

/**
 * @param {{
 *   ticketRequest: NormalizedTicketRequest,
 *   existingIssue: GitHubIssue,
 *   resolvedBlockedBy: number[],
 * }} options
 * @returns {TicketPublishTicket}
 */
function reuseTicket({ ticketRequest, existingIssue, resolvedBlockedBy }) {
  return createPublishedTicket(ticketRequest, existingIssue, 'reused', resolvedBlockedBy);
}

/**
 * @param {{
 *   githubClient: GitHubClient,
 *   ticketRequest: NormalizedTicketRequest,
 *   existingIssue: GitHubIssue,
 *   parentIssueNumber: number,
 *   resolvedBlockedBy: number[],
 * }} options
 * @returns {Promise<TicketPublishTicket>}
 */
async function repairRecoveredTicket({
  githubClient,
  ticketRequest,
  existingIssue,
  parentIssueNumber,
  resolvedBlockedBy,
}) {
  assertMarkerOwnedTicket({
    issue: existingIssue,
    ticketRequest,
    parentIssueNumber,
  });

  /** @type {TicketPublishTicket | undefined} */
  let publishedTicket;
  try {
    publishedTicket = createPublishedTicket(
      ticketRequest,
      existingIssue,
      'updated',
      resolvedBlockedBy,
    );

    if (existingIssue.parent?.number !== parentIssueNumber) {
      await githubClient.addSubIssue?.({
        parentIssueNumber,
        ticketNumber: existingIssue.number,
      });
    }

    await syncTicketTriageRole({
      githubClient,
      ticketRequest,
      issue: existingIssue,
      currentLabels: existingIssue.labels,
    });

    return publishedTicket;
  } catch (error) {
    throw createTicketPublicationError(error, publishedTicket);
  }
}

/**
 * @param {{
 *   githubClient: GitHubClient,
 *   ticketRequest: NormalizedTicketRequest,
 *   parentIssueNumber: number,
 * }} options
 * @returns {Promise<GitHubIssue>}
 */
async function readExplicitTicketOverride({ githubClient, ticketRequest, parentIssueNumber }) {
  const issueNumber = ticketRequest.issueNumber;
  if (issueNumber === undefined) {
    throw new Error('Issue number override is required for repair publication.');
  }

  const issue = await githubClient.getIssue(issueNumber);
  assertMarkerOwnedTicket({
    issue,
    ticketRequest,
    parentIssueNumber,
  });
  return issue;
}

/**
 * @param {{
 *   issue: GitHubIssue,
 *   ticketRequest: NormalizedTicketRequest,
 *   parentIssueNumber: number,
 * }} options
 */
function assertMarkerOwnedTicket({ issue, ticketRequest, parentIssueNumber }) {
  const marker = readTicketPublicationMarker(issue.body);
  if (marker === undefined) {
    throw new Error(`Issue #${issue.number} is not marked as a PullOps-published Ticket.`);
  }

  if (marker.parentIssueNumber !== parentIssueNumber) {
    throw new Error(
      `Issue #${issue.number} is marked for Parent Issue #${marker.parentIssueNumber}, not #${parentIssueNumber}.`,
    );
  }

  if (marker.sliceRef !== ticketRequest.sliceRef) {
    throw new Error(
      `Issue #${issue.number} is marked for sliceRef "${marker.sliceRef}", not "${ticketRequest.sliceRef}".`,
    );
  }
}

/**
 * @param {{
 *   githubClient: GitHubClient,
 *   ticketRequest: NormalizedTicketRequest,
 *   parentIssueNumber: number,
 *   resolvedBlockedBy: number[],
 * }} options
 * @returns {Promise<TicketPublishTicket>}
 */
async function createTicket({ githubClient, ticketRequest, parentIssueNumber, resolvedBlockedBy }) {
  const createIssue = githubClient.createIssue;
  if (typeof createIssue !== 'function') {
    throw new Error('GitHub client does not support issue creation.');
  }

  /** @type {TicketPublishTicket | undefined} */
  let publishedTicket;
  try {
    const createdIssue = await createIssue.call(githubClient, {
      title: ticketRequest.title,
      body: createTicketBody({
        ...ticketRequest,
        blockedBy: resolvedBlockedBy,
        parentIssueNumber,
      }),
    });
    publishedTicket = createPublishedTicket(
      ticketRequest,
      createdIssue,
      'created',
      resolvedBlockedBy,
    );

    await githubClient.addSubIssue?.({
      parentIssueNumber,
      ticketNumber: createdIssue.number,
    });

    await syncTicketTriageRole({
      githubClient,
      ticketRequest,
      issue: createdIssue,
      currentLabels: createdIssue.labels,
    });

    return publishedTicket;
  } catch (error) {
    throw createTicketPublicationError(error, publishedTicket);
  }
}

/**
 * @param {{
 *   githubClient: GitHubClient,
 *   ticketRequest: NormalizedTicketRequest,
 *   existingIssue: GitHubIssue,
 *   parentIssueNumber: number,
 *   resolvedBlockedBy: number[],
 * }} options
 * @returns {Promise<TicketPublishTicket>}
 */
async function updateTicket({
  githubClient,
  ticketRequest,
  existingIssue,
  parentIssueNumber,
  resolvedBlockedBy,
}) {
  assertMarkerOwnedTicket({
    issue: existingIssue,
    ticketRequest,
    parentIssueNumber,
  });

  const updateIssue = githubClient.updateIssue;
  if (typeof updateIssue !== 'function') {
    throw new Error('GitHub client does not support issue updates.');
  }

  /** @type {TicketPublishTicket | undefined} */
  let publishedTicket;
  try {
    const updatedIssue = await updateIssue.call(githubClient, {
      number: existingIssue.number,
      title: ticketRequest.title,
      body: createTicketBody({
        ...ticketRequest,
        blockedBy: resolvedBlockedBy,
        parentIssueNumber,
      }),
    });
    publishedTicket = createPublishedTicket(
      ticketRequest,
      updatedIssue,
      'updated',
      resolvedBlockedBy,
    );

    if (existingIssue.parent?.number !== parentIssueNumber) {
      await githubClient.addSubIssue?.({
        parentIssueNumber,
        ticketNumber: existingIssue.number,
      });
    }

    await syncTicketTriageRole({
      githubClient,
      ticketRequest,
      issue: updatedIssue,
      currentLabels: existingIssue.labels,
    });

    return publishedTicket;
  } catch (error) {
    throw createTicketPublicationError(error, publishedTicket);
  }
}

/**
 * @param {{
 *   githubClient: GitHubClient,
 *   ticketRequest: NormalizedTicketRequest,
 *   issue: GitHubIssue,
 *   currentLabels: string[],
 * }} options
 * @returns {Promise<void>}
 */
async function syncTicketTriageRole({ githubClient, ticketRequest, issue, currentLabels }) {
  const triageRole = ticketRequest.triageRole;
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
 *   ticketRequest: NormalizedTicketRequest,
 *   publishedIssueNumbersBySliceRef: Map<string, number>,
 * }} options
 * @returns {number[]}
 */
function resolveBlockedByIssueNumbers({ ticketRequest, publishedIssueNumbersBySliceRef }) {
  /** @type {number[]} */
  const resolved = [];

  for (const sliceRef of ticketRequest.blockedBySliceRefs) {
    const issueNumber = publishedIssueNumbersBySliceRef.get(sliceRef);
    if (issueNumber === undefined) {
      throw new Error(
        `Blocked by sliceRef "${sliceRef}" has not been successfully published in this batch.`,
      );
    }
    pushUnique(resolved, issueNumber);
  }

  for (const issueNumber of ticketRequest.blockedBy) {
    pushUnique(resolved, issueNumber);
  }

  return resolved;
}

/**
 * @param {unknown} error
 * @param {TicketPublishTicket | undefined} publishedTicket
 * @returns {Error}
 */
function createTicketPublicationError(error, publishedTicket) {
  const publicationError = error instanceof Error ? error : new Error(String(error));
  if (publishedTicket === undefined) {
    return publicationError;
  }

  return Object.assign(publicationError, { publishedTicket });
}

/**
 * @param {unknown} error
 * @returns {TicketPublishTicket | undefined}
 */
function readPublishedTicketFromError(error) {
  if (!isPlainObject(error)) {
    return undefined;
  }

  const ticket = error.publishedTicket;
  if (!isPlainObject(ticket)) {
    return undefined;
  }

  if (
    typeof ticket.sliceRef !== 'string' ||
    (ticket.action !== 'created' && ticket.action !== 'updated') ||
    !isPlainObject(ticket.issue) ||
    !Array.isArray(ticket.blockedBy)
  ) {
    return undefined;
  }

  return /** @type {TicketPublishTicket} */ (/** @type {unknown} */ (ticket));
}

/**
 * @param {{
 *   cwd: string,
 *   parentIssueNumber: number,
 * }} options
 * @returns {Promise<Array<[string, number]>>}
 */
async function readRecoveredTicketRefsByNewestRun({ cwd, parentIssueNumber }) {
  const runsDirectory = join(cwd, '.pullops', 'runs');
  let entries;
  try {
    entries = await readdir(runsDirectory, { withFileTypes: true });
  } catch (error) {
    if (isErrorWithCode(error, 'ENOENT')) {
      return [];
    }

    throw error;
  }

  /** @type {Array<[string, number]>} */
  const recoveredTicketRefs = [];
  const recordNames = entries
    .filter(
      entry =>
        entry.isDirectory() && isTicketPublicationRunRecordName(entry.name, parentIssueNumber),
    )
    .map(entry => entry.name)
    .sort()
    .reverse();

  for (const recordName of recordNames) {
    const response = await readIssueStoreJsonArtifactIfAvailable(
      join(runsDirectory, recordName),
      'response.json',
    );
    if (
      !isPlainObject(response) ||
      readRecoveredParentIssueNumber(response) !== parentIssueNumber
    ) {
      continue;
    }

    for (const [sliceRef, issueNumber] of readRecoveredTicketRefs(response)) {
      recoveredTicketRefs.push([sliceRef, issueNumber]);
    }
  }

  return recoveredTicketRefs;
}

/**
 * @param {string} recordName
 * @param {number} parentIssueNumber
 * @returns {boolean}
 */
function isTicketPublicationRunRecordName(recordName, parentIssueNumber) {
  return recordName.endsWith(`-issues-publish-tickets-${parentIssueNumber}`);
}

/**
 * @param {string} directory
 * @param {string} fileName
 * @returns {Promise<unknown>}
 */
async function readIssueStoreJsonArtifactIfAvailable(directory, fileName) {
  const filePath = join(directory, fileName);
  let contents;
  try {
    contents = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isErrorWithCode(error, 'ENOENT')) {
      return undefined;
    }

    throw error;
  }

  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `Local Run Record artifact "${filePath}" must contain valid JSON: ${getErrorMessage(error)}`,
      { cause: error },
    );
  }
}

/**
 * @param {Record<string, unknown>} response
 * @returns {number | undefined}
 */
function readRecoveredParentIssueNumber(response) {
  const parent = response.parent;
  if (!isPlainObject(parent)) {
    return undefined;
  }

  const number = parent.number;
  return typeof number === 'number' && Number.isInteger(number) && number > 0 ? number : undefined;
}

/**
 * @param {Record<string, unknown>} response
 * @returns {Array<[string, number]>}
 */
function readRecoveredTicketRefs(response) {
  const mappings = response.mappings;
  if (!Array.isArray(mappings)) {
    return [];
  }

  /** @type {Array<[string, number]>} */
  const ticketRefs = [];
  for (const mapping of mappings) {
    if (!isPlainObject(mapping)) {
      continue;
    }

    const sliceRef = readOptionalString(mapping.sliceRef);
    const issueNumber = readOptionalPositiveInteger(mapping.issueNumber, 'mapping.issueNumber');
    if (sliceRef === undefined || issueNumber === undefined) {
      continue;
    }

    ticketRefs.push([sliceRef, issueNumber]);
  }

  return ticketRefs;
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
    throw new Error(`Parent Issue #${parentIssueNumber} must be open for ticket publication.`);
  }

  if (parentIssue.parent !== null) {
    throw new Error(`Issue #${parentIssueNumber} is itself a Ticket and cannot be a Parent Issue.`);
  }

  /** @type {IssueStorePublishWarning[]} */
  const warnings = [];
  if (readSpecIssuePublicationMarker(parentIssue.body) === undefined) {
    warnings.push({
      code: 'parent-missing-pullops-spec-marker',
      message: `Parent Issue #${parentIssueNumber} is open but is not marked as a PullOps-published Spec Issue.`,
    });
  }

  return { parentIssue, warnings };
}

/**
 * @param {NormalizedTicketRequest} ticketRequest
 * @param {GitHubIssue} issue
 * @param {'created' | 'updated' | 'reused'} action
 * @param {number[]} blockedBy
 * @returns {TicketPublishTicket}
 */
function createPublishedTicket(ticketRequest, issue, action, blockedBy) {
  return {
    sliceRef: ticketRequest.sliceRef,
    action,
    issue: {
      number: issue.number,
      url: issue.url,
    },
    blockedBy,
    ...(ticketRequest.triageRole === undefined ? {} : { triageRole: ticketRequest.triageRole }),
  };
}

/**
 * @param {{
 *   parentIssue: GitHubIssue,
 *   tickets: TicketPublishTicket[],
 *   warnings: IssueStorePublishWarning[],
 *   localRunRecord: string,
 * }} options
 * @returns {TicketPublishSuccessOutput}
 */
function createSuccessOutput({ parentIssue, tickets, warnings, localRunRecord }) {
  return {
    status: 'accepted',
    summary: `Published ${tickets.length} Tickets under Parent Issue #${parentIssue.number}.`,
    action: summarizeBatchAction(tickets),
    parent: {
      number: parentIssue.number,
      url: parentIssue.url,
    },
    tickets,
    mappings: createMappings(tickets),
    warnings,
    localRunRecord,
  };
}

/**
 * @param {TicketPublishTicket[]} tickets
 * @returns {TicketPublishMapping[]}
 */
function createMappings(tickets) {
  return tickets.map(ticket => ({
    sliceRef: ticket.sliceRef,
    issueNumber: ticket.issue.number,
    issueUrl: ticket.issue.url,
  }));
}

/**
 * @param {{ directory: string }} runRecord
 * @param {TicketPublishSuccessOutput} output
 * @returns {Promise<void>}
 */
async function writeSuccessArtifacts(runRecord, output) {
  await writeRunArtifact(runRecord, 'response.json', `${JSON.stringify(output, null, 2)}\n`);
  await writeRunArtifact(
    runRecord,
    'warnings.json',
    `${JSON.stringify(output.warnings, null, 2)}\n`,
  );
  await writeRunArtifact(runRecord, 'failures.json', `${JSON.stringify([], null, 2)}\n`);
}

/**
 * @param {{ directory: string }} runRecord
 * @param {{
 *   summary: string,
 *   failureReason: string,
 *   warnings: IssueStorePublishWarning[],
 * }} options
 * @returns {Promise<TicketPublishFailureOutput>}
 */
async function writeFailureResult(runRecord, { summary, failureReason, warnings }) {
  /** @type {TicketPublishFailureOutput} */
  const output = {
    status: 'failed',
    summary,
    failureReason,
    warnings,
    localRunRecord: runRecord.directory,
  };
  await writeRunArtifact(runRecord, 'response.json', `${JSON.stringify(output, null, 2)}\n`);
  await writeRunArtifact(runRecord, 'failure-reason.txt', `${failureReason}\n`);
  if (warnings.length > 0) {
    await writeRunArtifact(runRecord, 'warnings.json', `${JSON.stringify(warnings, null, 2)}\n`);
  }
  return output;
}

/**
 * @param {{ directory: string }} runRecord
 * @param {{
 *   parentIssue: GitHubIssue,
 *   tickets: TicketPublishTicket[],
 *   failedTickets: TicketPublishFailure[],
 *   warnings: IssueStorePublishWarning[],
 *   failureReason: string,
 * }} options
 * @returns {Promise<TicketPublishFailureOutput>}
 */
async function writePartialFailure(
  runRecord,
  { parentIssue, tickets, failedTickets, warnings, failureReason },
) {
  /** @type {TicketPublishFailureOutput} */
  const output = {
    status: 'failed',
    summary: `Published ${tickets.length} Tickets under Parent Issue #${parentIssue.number}, but ${failedTickets.length} slice(s) failed.`,
    failureReason,
    parent: {
      number: parentIssue.number,
      url: parentIssue.url,
    },
    tickets,
    mappings: createMappings(tickets),
    failedTickets,
    warnings,
    localRunRecord: runRecord.directory,
  };
  await writeRunArtifact(runRecord, 'response.json', `${JSON.stringify(output, null, 2)}\n`);
  await writeRunArtifact(runRecord, 'failure-reason.txt', `${failureReason}\n`);
  await writeRunArtifact(runRecord, 'failures.json', `${JSON.stringify(failedTickets, null, 2)}\n`);
  await writeRunArtifact(runRecord, 'warnings.json', `${JSON.stringify(warnings, null, 2)}\n`);
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
 * @returns {NormalizedTicketBatchRequest}
 */
function normalizeTicketBatchPublicationRequest(rawRequest, parentIssueNumber, forceUpdate) {
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
  if (kind !== undefined && kind !== 'ticket-batch' && kind !== 'tickets' && kind !== 'tickets') {
    throw new Error(
      `Publish request kind must be "ticket-batch". Received ${JSON.stringify(kind)}.`,
    );
  }

  const normalizedParentIssueNumber = readConflictingParentIssueNumber({
    parentIssueNumber,
    candidates,
  });
  const tickets = normalizeTickets(readTicketsValue(candidates));
  const requestForceUpdate =
    readOptionalConflictingBoolean(
      candidates,
      candidate => firstDefined(candidate.forceUpdate, candidate.force),
      'Request.forceUpdate',
    ) ?? false;

  return {
    parentIssueNumber: normalizedParentIssueNumber,
    tickets,
    forceUpdate: forceUpdate || requestForceUpdate,
  };
}

/**
 * @param {Record<string, unknown>} value
 * @returns {Record<string, unknown>[]}
 */
function collectRequestCandidates(value) {
  const candidates = [value];
  for (const key of ['request', 'batch', 'ticketBatch']) {
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
function readTicketsValue(candidates) {
  /** @type {unknown} */
  let ticketsValue;
  let hasValue = false;
  let serializedValue;

  for (const candidate of candidates) {
    const value = firstDefined(candidate.tickets, candidate.slices, candidate.tickets);
    if (value === undefined) {
      continue;
    }

    const nextSerializedValue = JSON.stringify(value);
    if (!hasValue) {
      ticketsValue = value;
      serializedValue = nextSerializedValue;
      hasValue = true;
      continue;
    }

    if (serializedValue !== nextSerializedValue) {
      throw new Error('Request.tickets values conflict.');
    }
  }

  if (!hasValue) {
    throw new Error('Request.tickets must contain at least one item.');
  }

  return ticketsValue;
}

/**
 * @param {unknown} value
 * @returns {NormalizedTicketRequest[]}
 */
function normalizeTickets(value) {
  if (!Array.isArray(value)) {
    throw new Error('Request.tickets must be an array.');
  }

  if (value.length === 0) {
    throw new Error('Request.tickets must contain at least one item.');
  }

  /** @type {NormalizedTicketRequest[]} */
  const tickets = [];
  const seenSliceRefs = new Set();

  for (const [index, item] of value.entries()) {
    if (!isPlainObject(item)) {
      throw new Error(`Request.tickets[${index}] must be an object.`);
    }

    const sliceRef = readSliceRef(
      firstDefined(item.sliceRef, item.ref, item.slice),
      `Request.tickets[${index}].sliceRef`,
    );
    if (seenSliceRefs.has(sliceRef)) {
      throw new Error(`Request.tickets[${index}].sliceRef must be unique.`);
    }

    const title = readNonEmptyString(item.title, `Request.tickets[${index}].title`);
    const whatToBuild = readNonEmptyString(
      firstDefined(item.whatToBuild, item.body),
      `Request.tickets[${index}].whatToBuild`,
    );
    const acceptanceCriteria = readRequiredStringArray(
      item.acceptanceCriteria,
      `Request.tickets[${index}].acceptanceCriteria`,
    );
    const issueNumber = readOptionalTicketNumber(item, `Request.tickets[${index}]`);
    const blockedByDependencies = readBlockedByDependencies({
      value: item.blockedBy,
      path: `Request.tickets[${index}].blockedBy`,
      seenSliceRefs,
    });
    const blockedBySliceRefs = readBlockedBySliceRefs({
      item,
      path: `Request.tickets[${index}]`,
      seenSliceRefs,
    });
    const blockedBy = uniquePositiveIntegers(
      blockedByDependencies.issueNumbers,
      `Request.tickets[${index}].blockedBy`,
    );
    const coveredUserStories = uniquePositiveIntegers(
      firstDefined(
        item.coveredUserStories,
        item.coveredSpecUserStories,
        item.specUserStories,
        item.userStories,
      ),
      `Request.tickets[${index}].coveredUserStories`,
    ).sort((left, right) => left - right);
    const supportWork = readSupportWork(item, `Request.tickets[${index}]`);
    if (coveredUserStories.length === 0 && !supportWork) {
      throw new Error(
        `Request.tickets[${index}] must include covered Spec user story numbers or supportWork: true.`,
      );
    }

    const triageRoleValue = item.triageRole;
    const triageRole =
      triageRoleValue === undefined
        ? undefined
        : readTriageRole(triageRoleValue, `Request.tickets[${index}].triageRole`);

    tickets.push({
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

  return tickets;
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
function readOptionalTicketNumber(item, path) {
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
    throw new Error(`${path} must reference an earlier Ticket sliceRef. Unknown "${sliceRef}".`);
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
 * @param {TicketPublishTicket[]} tickets
 * @returns {'created' | 'updated' | 'reused' | 'mixed'}
 */
function summarizeBatchAction(tickets) {
  const actions = uniqueStrings(tickets.map(ticket => ticket.action));
  if (actions.length === 1) {
    const [action] = actions;
    if (action === 'created' || action === 'updated' || action === 'reused') {
      return action;
    }
  }

  return 'mixed';
}

/**
 * @param {TicketPublishFailure[]} failedTickets
 * @returns {string}
 */
function summarizeFailedTickets(failedTickets) {
  return failedTickets
    .map(ticket => `sliceRef "${ticket.sliceRef}": ${ticket.failureReason}`)
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
 * @param {string} code
 * @returns {boolean}
 */
function isErrorWithCode(error, code) {
  return (
    isPlainObject(error) &&
    typeof error.code === 'string' &&
    error.code.toUpperCase() === code.toUpperCase()
  );
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
