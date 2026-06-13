import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(nodeExecFile);

/**
 * @typedef {import('./types.js').PullOpsLabel} PullOpsLabel
 * @typedef {import('./types.js').GitHubLabel} GitHubLabel
 * @typedef {import('./types.js').EnsureLabelsResult} EnsureLabelsResult
 * @typedef {import('./types.js').ExecFile} ExecFile
 * @typedef {import('./types.js').ExecFileResult} ExecFileResult
 * @typedef {import('./types.js').GitHubClient} GitHubClient
 * @typedef {import('./types.js').GitHubIssue} GitHubIssue
 * @typedef {import('./types.js').GitHubIssueReference} GitHubIssueReference
 * @typedef {import('./types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('./types.js').CreateDraftPullRequestOptions} CreateDraftPullRequestOptions
 * @typedef {import('./types.js').EditLabelsOptions} EditLabelsOptions
 * @typedef {import('./types.js').CommentOnIssueOptions} CommentOnIssueOptions
 */

const ISSUE_RELATIONSHIPS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      number
      title
      body
      state
      url
      author {
        login
      }
      labels(first: 100) {
        nodes {
          name
        }
      }
      parent {
        number
        title
        state
        url
      }
      subIssues(first: 100) {
        totalCount
        nodes {
          number
          title
          state
          url
        }
      }
    }
  }
}
`;

/** @type {PullOpsLabel[]} */
export const PULL_OPS_LABELS = [
  {
    name: 'pullops:implement',
    color: '5319E7',
    description: 'Run PullOps implementation for an issue or PRD.',
  },
  {
    name: 'pullops:review',
    color: '5319E7',
    description: 'Run PullOps automated PR review.',
  },
  {
    name: 'pullops:address-review',
    color: '5319E7',
    description: 'Address actionable PullOps PR review feedback.',
  },
  {
    name: 'pullops:fix-ci',
    color: '5319E7',
    description: 'Classify and fix actionable CI failures.',
  },
  {
    name: 'pullops:update-branch',
    color: '5319E7',
    description: 'Update a same-repository PR branch.',
  },
  {
    name: 'pullops:resolve-conflicts',
    color: '5319E7',
    description: 'Resolve branch update conflicts with the PullOps runner.',
  },
  {
    name: 'pullops:prepare-merge',
    color: '5319E7',
    description: 'Prepare a PullOps-managed PR for human review and merge.',
  },
  {
    name: 'pullops:in-progress',
    color: 'FBCA04',
    description: 'PullOps automation is currently working.',
  },
  {
    name: 'pullops:blocked',
    color: 'D93F0B',
    description: 'PullOps automation is blocked and needs human attention.',
  },
];

/**
 * @param {{ execFile?: ExecFile }} [options]
 * @returns {GitHubClient}
 */
export function createGitHubClient({ execFile = execFileAsync } = {}) {
  return {
    /**
     * @param {PullOpsLabel[]} labels
     * @returns {Promise<EnsureLabelsResult>}
     */
    async ensureLabels(labels) {
      const existingLabels = await listLabels(execFile);
      const existingLabelsByName = new Map(existingLabels.map(label => [label.name, label]));
      /** @type {EnsureLabelsResult} */
      const result = {
        created: [],
        updated: [],
        alreadyCorrect: [],
      };

      for (const label of labels) {
        const existingLabel = existingLabelsByName.get(label.name);

        if (existingLabel === undefined) {
          await createLabel(execFile, label);
          result.created.push(label.name);
          continue;
        }

        if (labelNeedsUpdate(existingLabel, label)) {
          await updateLabel(execFile, label);
          result.updated.push(label.name);
          continue;
        }

        result.alreadyCorrect.push(label.name);
      }

      return result;
    },

    /**
     * @param {number} number
     * @returns {Promise<GitHubIssue>}
     */
    async getIssue(number) {
      const repository = await getCurrentRepository(execFile);
      const result = await execFile('gh', [
        'api',
        'graphql',
        '-f',
        `owner=${repository.owner}`,
        '-f',
        `repo=${repository.name}`,
        '-F',
        `number=${number}`,
        '-f',
        `query=${ISSUE_RELATIONSHIPS_QUERY}`,
      ]);
      const issue = parseGraphqlIssue(getStdout(result));
      const needsFallback = issue.parent === null || issue.subIssues.length === 0;
      const fallbackIssues = needsFallback ? await listIssuesForRelationshipFallback(execFile) : [];

      return applyIssueRelationshipFallback(issue, fallbackIssues);
    },

    /**
     * @param {string} headBranch
     * @returns {Promise<GitHubPullRequest | undefined>}
     */
    async findOpenPullRequestByHead(headBranch) {
      const result = await execFile('gh', [
        'pr',
        'list',
        '--state',
        'open',
        '--head',
        headBranch,
        '--limit',
        '1',
        '--json',
        'number,title,url,headRefName,body,isDraft',
      ]);
      const pullRequests = parsePullRequests(getStdout(result));
      return pullRequests[0];
    },

    /**
     * @param {CreateDraftPullRequestOptions} options
     * @returns {Promise<GitHubPullRequest>}
     */
    async createDraftPullRequest({ title, body, baseBranch, headBranch }) {
      const result = await execFile('gh', [
        'pr',
        'create',
        '--draft',
        '--title',
        title,
        '--body',
        body,
        '--base',
        baseBranch,
        '--head',
        headBranch,
      ]);
      const url = getStdout(result).trim();
      const number = parsePullRequestNumberFromUrl(url);

      return {
        number,
        title,
        url,
        headRefName: headBranch,
        body,
        isDraft: true,
      };
    },

    /**
     * @param {EditLabelsOptions} options
     * @returns {Promise<void>}
     */
    async addLabelsToIssue({ number, labels }) {
      await editIssueLabels(execFile, number, '--add-label', labels);
    },

    /**
     * @param {EditLabelsOptions} options
     * @returns {Promise<void>}
     */
    async removeLabelsFromIssue({ number, labels }) {
      await editIssueLabels(execFile, number, '--remove-label', labels);
    },

    /**
     * @param {EditLabelsOptions} options
     * @returns {Promise<void>}
     */
    async addLabelsToPullRequest({ number, labels }) {
      if (labels.length === 0) {
        return;
      }

      await execFile('gh', ['pr', 'edit', String(number), '--add-label', labels.join(',')]);
    },

    /**
     * @param {CommentOnIssueOptions} options
     * @returns {Promise<void>}
     */
    async commentOnIssue({ number, body }) {
      await execFile('gh', ['issue', 'comment', String(number), '--body', body]);
    },
  };
}

/**
 * @param {ExecFile} execFile
 * @returns {Promise<GitHubLabel[]>}
 */
async function listLabels(execFile) {
  try {
    const result = await execFile('gh', [
      'label',
      'list',
      '--limit',
      '1000',
      '--json',
      'name,color,description',
    ]);
    return parseGitHubLabels(getStdout(result));
  } catch (error) {
    throw new Error(`Failed to list GitHub labels: ${getGitHubErrorMessage(error)}`, {
      cause: error,
    });
  }
}

/**
 * @param {ExecFile} execFile
 * @param {PullOpsLabel} label
 * @returns {Promise<void>}
 */
async function createLabel(execFile, label) {
  try {
    await execFile('gh', [
      'label',
      'create',
      label.name,
      '--color',
      label.color,
      '--description',
      label.description,
    ]);
  } catch (error) {
    throw new Error(
      `Failed to create GitHub label "${label.name}": ${getGitHubErrorMessage(error)}`,
      { cause: error },
    );
  }
}

/**
 * @param {ExecFile} execFile
 * @param {PullOpsLabel} label
 * @returns {Promise<void>}
 */
async function updateLabel(execFile, label) {
  try {
    await execFile('gh', [
      'label',
      'edit',
      label.name,
      '--color',
      label.color,
      '--description',
      label.description,
    ]);
  } catch (error) {
    throw new Error(
      `Failed to update GitHub label "${label.name}": ${getGitHubErrorMessage(error)}`,
      { cause: error },
    );
  }
}

/**
 * @param {ExecFile} execFile
 * @returns {Promise<{ owner: string, name: string }>}
 */
async function getCurrentRepository(execFile) {
  try {
    const result = await execFile('gh', ['repo', 'view', '--json', 'nameWithOwner']);
    const parsed = JSON.parse(getStdout(result));
    if (!isPlainObject(parsed) || typeof parsed.nameWithOwner !== 'string') {
      throw new Error('Expected gh repo view to return nameWithOwner.');
    }

    const [owner, name] = parsed.nameWithOwner.split('/');
    if (owner === undefined || name === undefined) {
      throw new Error(`Invalid nameWithOwner: ${parsed.nameWithOwner}`);
    }

    return { owner, name };
  } catch (error) {
    throw new Error(
      `Failed to resolve current GitHub repository: ${getGitHubErrorMessage(error)}`,
      {
        cause: error,
      },
    );
  }
}

/**
 * @param {ExecFile} execFile
 * @returns {Promise<Array<GitHubIssueReference & { body: string }>>}
 */
async function listIssuesForRelationshipFallback(execFile) {
  try {
    const result = await execFile('gh', [
      'issue',
      'list',
      '--state',
      'all',
      '--limit',
      '1000',
      '--json',
      'number,title,body,state,url',
    ]);
    return parseIssueReferences(getStdout(result));
  } catch (error) {
    throw new Error(
      `Failed to list issues for relationship fallback: ${getGitHubErrorMessage(error)}`,
      {
        cause: error,
      },
    );
  }
}

/**
 * @param {ExecFile} execFile
 * @param {number} number
 * @param {'--add-label' | '--remove-label'} action
 * @param {string[]} labels
 * @returns {Promise<void>}
 */
async function editIssueLabels(execFile, number, action, labels) {
  if (labels.length === 0) {
    return;
  }

  await execFile('gh', ['issue', 'edit', String(number), action, labels.join(',')]);
}

/**
 * @param {string} stdout
 * @returns {GitHubIssue}
 */
function parseGraphqlIssue(stdout) {
  const parsed = JSON.parse(stdout);
  const issue = parsed?.data?.repository?.issue;

  if (!isPlainObject(issue)) {
    throw new Error('Expected GitHub GraphQL issue response to include an issue object.');
  }

  return {
    number: requireNumber(issue.number, 'issue.number'),
    title: requireString(issue.title, 'issue.title'),
    body: requireString(issue.body, 'issue.body'),
    state: requireString(issue.state, 'issue.state'),
    url: requireString(issue.url, 'issue.url'),
    authorLogin: parseAuthorLogin(issue.author),
    labels: parseLabelNames(issue.labels),
    parent: parseIssueReference(issue.parent, 'native'),
    subIssues: parseSubIssues(issue.subIssues),
  };
}

/**
 * @param {GitHubIssue} issue
 * @param {Array<GitHubIssueReference & { body: string }>} fallbackIssues
 * @returns {GitHubIssue}
 */
function applyIssueRelationshipFallback(issue, fallbackIssues) {
  const parentNumber = parseParentIssueNumber(issue.body);
  const fallbackParentCandidate = fallbackIssues.find(
    candidate => candidate.number === parentNumber,
  );
  const fallbackParent =
    parentNumber === undefined
      ? null
      : toBodyIssueReference({
          number: parentNumber,
          title: fallbackParentCandidate?.title,
          url: fallbackParentCandidate?.url,
          state: fallbackParentCandidate?.state,
        });
  const fallbackSubIssues = fallbackIssues.filter(
    candidate =>
      candidate.number !== issue.number && parseParentIssueNumber(candidate.body) === issue.number,
  );

  return {
    ...issue,
    parent: issue.parent ?? fallbackParent,
    subIssues:
      issue.subIssues.length > 0 ? issue.subIssues : fallbackSubIssues.map(toBodyIssueReference),
  };
}

/**
 * @param {{ number: number, title?: string, url?: string, state?: string }} issue
 * @returns {GitHubIssueReference}
 */
function toBodyIssueReference(issue) {
  return {
    number: issue.number,
    title: issue.title,
    url: issue.url,
    state: issue.state,
    relationshipSource: 'body',
  };
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function parseAuthorLogin(value) {
  if (!isPlainObject(value)) {
    return null;
  }

  return typeof value.login === 'string' ? value.login : null;
}

/**
 * @param {unknown} labels
 * @returns {string[]}
 */
function parseLabelNames(labels) {
  if (!isPlainObject(labels) || !Array.isArray(labels.nodes)) {
    return [];
  }

  return labels.nodes.flatMap(label => {
    if (!isPlainObject(label) || typeof label.name !== 'string') {
      return [];
    }
    return [label.name];
  });
}

/**
 * @param {unknown} subIssues
 * @returns {GitHubIssueReference[]}
 */
function parseSubIssues(subIssues) {
  if (!isPlainObject(subIssues) || !Array.isArray(subIssues.nodes)) {
    return [];
  }

  return subIssues.nodes.flatMap(subIssue => {
    const parsed = parseIssueReference(subIssue, 'native');
    return parsed === null ? [] : [parsed];
  });
}

/**
 * @param {unknown} value
 * @param {import('./types.js').IssueRelationshipSource} source
 * @returns {GitHubIssueReference | null}
 */
function parseIssueReference(value, source) {
  if (!isPlainObject(value)) {
    return null;
  }

  return {
    number: requireNumber(value.number, 'issue reference number'),
    title: typeof value.title === 'string' ? value.title : undefined,
    url: typeof value.url === 'string' ? value.url : undefined,
    state: typeof value.state === 'string' ? value.state : undefined,
    relationshipSource: source,
  };
}

/**
 * @param {string} stdout
 * @returns {Array<GitHubIssueReference & { body: string }>}
 */
function parseIssueReferences(stdout) {
  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed)) {
    throw new Error('Expected gh issue list to return an array.');
  }

  return parsed.map((issue, index) => {
    if (!isPlainObject(issue)) {
      throw new Error(`Expected GitHub issue at index ${index} to be an object.`);
    }

    return {
      number: requireNumber(issue.number, `issue at index ${index}.number`),
      title: typeof issue.title === 'string' ? issue.title : undefined,
      url: typeof issue.url === 'string' ? issue.url : undefined,
      state: typeof issue.state === 'string' ? issue.state : undefined,
      body: typeof issue.body === 'string' ? issue.body : '',
      relationshipSource: 'body',
    };
  });
}

/**
 * @param {string} body
 * @returns {number | undefined}
 */
function parseParentIssueNumber(body) {
  const parentSection = body.match(/^##\s+Parent\s*\n+([\s\S]*?)(?=^##\s+|\s*$)/m);
  const parentReference = parentSection?.[1]?.match(/#(\d+)/);
  if (parentReference?.[1] === undefined) {
    return undefined;
  }

  return Number(parentReference[1]);
}

/**
 * @param {string} stdout
 * @returns {GitHubPullRequest[]}
 */
function parsePullRequests(stdout) {
  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed)) {
    throw new Error('Expected gh pr list to return an array.');
  }

  return parsed.map((pullRequest, index) => {
    if (!isPlainObject(pullRequest)) {
      throw new Error(`Expected pull request at index ${index} to be an object.`);
    }

    return {
      number: requireNumber(pullRequest.number, `pull request at index ${index}.number`),
      title: requireString(pullRequest.title, `pull request at index ${index}.title`),
      url: requireString(pullRequest.url, `pull request at index ${index}.url`),
      headRefName: requireString(
        pullRequest.headRefName,
        `pull request at index ${index}.headRefName`,
      ),
      body: typeof pullRequest.body === 'string' ? pullRequest.body : '',
      isDraft: Boolean(pullRequest.isDraft),
    };
  });
}

/**
 * @param {string} url
 * @returns {number}
 */
function parsePullRequestNumberFromUrl(url) {
  const match = url.match(/\/pull\/(\d+)$/);
  if (match?.[1] === undefined) {
    throw new Error(`Unable to parse pull request number from ${url}.`);
  }

  return Number(match[1]);
}

/**
 * @param {GitHubLabel} existingLabel
 * @param {PullOpsLabel} expectedLabel
 * @returns {boolean}
 */
function labelNeedsUpdate(existingLabel, expectedLabel) {
  return (
    normalizeColor(existingLabel.color) !== normalizeColor(expectedLabel.color) ||
    existingLabel.description !== expectedLabel.description
  );
}

/**
 * @param {string} color
 * @returns {string}
 */
function normalizeColor(color) {
  return color.replace(/^#/, '').toLowerCase();
}

/**
 * @param {ExecFileResult} result
 * @returns {string}
 */
function getStdout(result) {
  return result.stdout.toString();
}

/**
 * @param {string} stdout
 * @returns {GitHubLabel[]}
 */
function parseGitHubLabels(stdout) {
  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed)) {
    throw new Error('Expected gh label list to return an array.');
  }

  return parsed.map(parseGitHubLabel);
}

/**
 * @param {unknown} label
 * @param {number} index
 * @returns {GitHubLabel}
 */
function parseGitHubLabel(label, index) {
  if (!isPlainObject(label)) {
    throw new Error(`Expected GitHub label at index ${index} to be an object.`);
  }

  if (typeof label.name !== 'string') {
    throw new Error(`Expected GitHub label at index ${index} to include a name.`);
  }

  if (typeof label.color !== 'string') {
    throw new Error(`Expected GitHub label "${label.name}" to include a color.`);
  }

  if (label.description !== null && typeof label.description !== 'string') {
    throw new Error(`Expected GitHub label "${label.name}" to include a description.`);
  }

  return {
    name: label.name,
    color: label.color,
    description: label.description,
  };
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {string}
 */
function requireString(value, path) {
  if (typeof value !== 'string') {
    throw new Error(`Expected ${path} to be a string.`);
  }

  return value;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {number}
 */
function requireNumber(value, path) {
  if (typeof value !== 'number') {
    throw new Error(`Expected ${path} to be a number.`);
  }

  return value;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function getGitHubErrorMessage(error) {
  if (isPlainObject(error)) {
    const stderr = error.stderr;
    if (typeof stderr === 'string' && stderr.trim() !== '') {
      return stderr.trim();
    }
    if (Buffer.isBuffer(stderr) && stderr.toString().trim() !== '') {
      return stderr.toString().trim();
    }
  }

  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
