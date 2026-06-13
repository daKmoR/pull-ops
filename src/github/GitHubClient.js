import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

export { PULL_OPS_LABELS } from '../labels/pullOpsLabels.js';

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
 * @typedef {import('./types.js').GitHubPullRequestReviewContext} GitHubPullRequestReviewContext
 * @typedef {import('./types.js').GitHubPullRequestComment} GitHubPullRequestComment
 * @typedef {import('./types.js').GitHubPullRequestReviewSummary} GitHubPullRequestReviewSummary
 * @typedef {import('./types.js').GitHubPullRequestReviewThread} GitHubPullRequestReviewThread
 * @typedef {import('./types.js').GitHubPullRequestFile} GitHubPullRequestFile
 * @typedef {import('./types.js').CreateDraftPullRequestOptions} CreateDraftPullRequestOptions
 * @typedef {import('./types.js').EditLabelsOptions} EditLabelsOptions
 * @typedef {import('./types.js').CommentOnIssueOptions} CommentOnIssueOptions
 * @typedef {import('./types.js').CommentOnPullRequestOptions} CommentOnPullRequestOptions
 * @typedef {import('./types.js').UpdatePullRequestBodyOptions} UpdatePullRequestBodyOptions
 * @typedef {import('./types.js').PublishPullRequestReviewOptions} PublishPullRequestReviewOptions
 * @typedef {import('./types.js').ReplyToPullRequestReviewCommentOptions} ReplyToPullRequestReviewCommentOptions
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

const PULL_REQUEST_REVIEW_CONTEXT_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      comments(first: 100) {
        nodes {
          body
          url
          author {
            login
          }
        }
      }
      reviews(first: 100) {
        nodes {
          id
          state
          body
          url
          author {
            login
          }
        }
      }
      reviewThreads(first: 100) {
        nodes {
          isResolved
          comments(first: 100) {
            nodes {
              id
              databaseId
              body
              path
              line
              diffHunk
              url
              author {
                login
              }
            }
          }
        }
      }
      files(first: 100) {
        nodes {
          path
          additions
          deletions
        }
      }
    }
  }
}
`;

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
      return parseGraphqlIssue(getStdout(result));
    },

    /**
     * @param {number} number
     * @returns {Promise<GitHubPullRequest>}
     */
    async getPullRequest(number) {
      const result = await execFile('gh', [
        'pr',
        'view',
        String(number),
        '--json',
        'number,title,url,headRefName,baseRefName,body,isDraft,isCrossRepository',
      ]);
      return parsePullRequestObject(getStdout(result));
    },

    /**
     * @param {number} number
     * @returns {Promise<GitHubPullRequestReviewContext>}
     */
    async getPullRequestReviewContext(number) {
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
        `query=${PULL_REQUEST_REVIEW_CONTEXT_QUERY}`,
      ]);
      return parsePullRequestReviewContext(getStdout(result));
    },

    /**
     * @param {number} number
     * @returns {Promise<import('./types.js').GitHubPullRequestDiff>}
     */
    async getPullRequestDiff(number) {
      const result = await execFile('gh', ['pr', 'diff', String(number), '--patch']);
      return {
        patch: getStdout(result),
      };
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
     * @param {EditLabelsOptions} options
     * @returns {Promise<void>}
     */
    async removeLabelsFromPullRequest({ number, labels }) {
      if (labels.length === 0) {
        return;
      }

      await execFile('gh', ['pr', 'edit', String(number), '--remove-label', labels.join(',')]);
    },

    /**
     * @param {CommentOnIssueOptions} options
     * @returns {Promise<void>}
     */
    async commentOnIssue({ number, body }) {
      await execFile('gh', ['issue', 'comment', String(number), '--body', body]);
    },

    /**
     * @param {CommentOnPullRequestOptions} options
     * @returns {Promise<void>}
     */
    async commentOnPullRequest({ number, body }) {
      await execFile('gh', ['pr', 'comment', String(number), '--body', body]);
    },

    /**
     * @param {UpdatePullRequestBodyOptions} options
     * @returns {Promise<void>}
     */
    async updatePullRequestBody({ number, body }) {
      await execFile('gh', ['pr', 'edit', String(number), '--body', body]);
    },

    /**
     * @param {PublishPullRequestReviewOptions} options
     * @returns {Promise<void>}
     */
    async publishPullRequestReview(options) {
      const repository = await getCurrentRepository(execFile);
      const args = [
        'api',
        '--method',
        'POST',
        `repos/${repository.owner}/${repository.name}/pulls/${options.number}/reviews`,
        '-f',
        `event=${options.event}`,
        '-f',
        `body=${options.body}`,
      ];

      for (const [index, comment] of options.comments.entries()) {
        args.push(
          '-f',
          `comments[${index}][path]=${comment.path}`,
          '-F',
          `comments[${index}][line]=${comment.line}`,
          '-f',
          `comments[${index}][side]=RIGHT`,
          '-f',
          `comments[${index}][body]=${comment.body}`,
        );
      }

      await execFile('gh', args);
    },

    /**
     * @param {ReplyToPullRequestReviewCommentOptions} options
     * @returns {Promise<void>}
     */
    async replyToPullRequestReviewComment({ commentId, body }) {
      const repository = await getCurrentRepository(execFile);
      await execFile('gh', [
        'api',
        '--method',
        'POST',
        `repos/${repository.owner}/${repository.name}/pulls/comments/${commentId}/replies`,
        '-f',
        `body=${body}`,
      ]);
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
 * @returns {GitHubPullRequest[]}
 */
function parsePullRequests(stdout) {
  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed)) {
    throw new Error('Expected gh pr list to return an array.');
  }

  return parsed.map((pullRequest, index) =>
    parsePullRequest(pullRequest, `pull request at index ${index}`),
  );
}

/**
 * @param {string} stdout
 * @returns {GitHubPullRequest}
 */
function parsePullRequestObject(stdout) {
  const parsed = JSON.parse(stdout);
  return parsePullRequest(parsed, 'pull request');
}

/**
 * @param {unknown} pullRequest
 * @param {string} path
 * @returns {GitHubPullRequest}
 */
function parsePullRequest(pullRequest, path) {
  if (!isPlainObject(pullRequest)) {
    throw new Error(`Expected ${path} to be an object.`);
  }

  return {
    number: requireNumber(pullRequest.number, `${path}.number`),
    title: requireString(pullRequest.title, `${path}.title`),
    url: requireString(pullRequest.url, `${path}.url`),
    headRefName: requireString(pullRequest.headRefName, `${path}.headRefName`),
    baseRefName: typeof pullRequest.baseRefName === 'string' ? pullRequest.baseRefName : undefined,
    body: typeof pullRequest.body === 'string' ? pullRequest.body : '',
    isDraft: Boolean(pullRequest.isDraft),
    isCrossRepository:
      typeof pullRequest.isCrossRepository === 'boolean'
        ? pullRequest.isCrossRepository
        : undefined,
  };
}

/**
 * @param {string} stdout
 * @returns {GitHubPullRequestReviewContext}
 */
function parsePullRequestReviewContext(stdout) {
  const parsed = JSON.parse(stdout);
  const pullRequest = parsed?.data?.repository?.pullRequest;

  if (!isPlainObject(pullRequest)) {
    throw new Error('Expected GitHub GraphQL pull request response to include a pull request.');
  }

  const reviewThreads = parseReviewThreads(pullRequest.reviewThreads);

  return {
    comments: parsePullRequestComments(pullRequest.comments),
    reviews: parseReviewSummaries(pullRequest.reviews),
    unresolvedThreads: reviewThreads.filter(thread => !thread.isResolved),
    files: parsePullRequestFiles(pullRequest.files),
  };
}

/**
 * @param {unknown} comments
 * @returns {GitHubPullRequestComment[]}
 */
function parsePullRequestComments(comments) {
  if (!isPlainObject(comments) || !Array.isArray(comments.nodes)) {
    return [];
  }

  return comments.nodes.map((comment, index) =>
    parsePullRequestComment(comment, `pull request comment at index ${index}`),
  );
}

/**
 * @param {unknown} reviews
 * @returns {GitHubPullRequestReviewSummary[]}
 */
function parseReviewSummaries(reviews) {
  if (!isPlainObject(reviews) || !Array.isArray(reviews.nodes)) {
    return [];
  }

  return reviews.nodes.map((review, index) => {
    if (!isPlainObject(review)) {
      throw new Error(`Expected pull request review at index ${index} to be an object.`);
    }

    return {
      id: typeof review.id === 'string' ? review.id : undefined,
      state: requireString(review.state, `pull request review at index ${index}.state`),
      body: typeof review.body === 'string' ? review.body : '',
      authorLogin: parseAuthorLogin(review.author),
      url: typeof review.url === 'string' ? review.url : undefined,
    };
  });
}

/**
 * @param {unknown} threads
 * @returns {GitHubPullRequestReviewThread[]}
 */
function parseReviewThreads(threads) {
  if (!isPlainObject(threads) || !Array.isArray(threads.nodes)) {
    return [];
  }

  return threads.nodes.map((thread, index) => {
    if (!isPlainObject(thread)) {
      throw new Error(`Expected pull request review thread at index ${index} to be an object.`);
    }

    return {
      isResolved: Boolean(thread.isResolved),
      comments: parsePullRequestComments(thread.comments),
    };
  });
}

/**
 * @param {unknown} files
 * @returns {GitHubPullRequestFile[]}
 */
function parsePullRequestFiles(files) {
  if (!isPlainObject(files) || !Array.isArray(files.nodes)) {
    return [];
  }

  return files.nodes.map((file, index) => {
    if (!isPlainObject(file)) {
      throw new Error(`Expected pull request file at index ${index} to be an object.`);
    }

    return {
      path: requireString(file.path, `pull request file at index ${index}.path`),
      additions: requireNumber(file.additions, `pull request file at index ${index}.additions`),
      deletions: requireNumber(file.deletions, `pull request file at index ${index}.deletions`),
    };
  });
}

/**
 * @param {unknown} comment
 * @param {string} path
 * @returns {GitHubPullRequestComment}
 */
function parsePullRequestComment(comment, path) {
  if (!isPlainObject(comment)) {
    throw new Error(`Expected ${path} to be an object.`);
  }

  return {
    id: typeof comment.id === 'string' ? comment.id : undefined,
    databaseId: typeof comment.databaseId === 'number' ? comment.databaseId : undefined,
    body: typeof comment.body === 'string' ? comment.body : '',
    authorLogin: parseAuthorLogin(comment.author),
    url: typeof comment.url === 'string' ? comment.url : undefined,
    path: typeof comment.path === 'string' ? comment.path : undefined,
    line: typeof comment.line === 'number' ? comment.line : undefined,
    diffHunk: typeof comment.diffHunk === 'string' ? comment.diffHunk : undefined,
  };
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
