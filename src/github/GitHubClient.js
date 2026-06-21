import { execFileSync } from 'node:child_process';

import { Octokit } from 'octokit';

export { PULL_OPS_LABELS } from '../labels/pullOpsLabels.js';

/**
 * @typedef {import('./types.js').PullOpsLabel} PullOpsLabel
 * @typedef {import('./types.js').GitHubLabel} GitHubLabel
 * @typedef {import('./types.js').EnsureLabelsResult} EnsureLabelsResult
 * @typedef {import('./types.js').GitHubClient} GitHubClient
 * @typedef {import('./types.js').GitHubIssue} GitHubIssue
 * @typedef {import('./types.js').GitHubIssueReference} GitHubIssueReference
 * @typedef {import('./types.js').GitHubPullRequest} GitHubPullRequest
 * @typedef {import('./types.js').GitHubCheckRun} GitHubCheckRun
 * @typedef {import('./types.js').GitHubPullRequestReviewContext} GitHubPullRequestReviewContext
 * @typedef {import('./types.js').GitHubPullRequestComment} GitHubPullRequestComment
 * @typedef {import('./types.js').GitHubPullRequestReviewSummary} GitHubPullRequestReviewSummary
 * @typedef {import('./types.js').GitHubPullRequestReviewThread} GitHubPullRequestReviewThread
 * @typedef {import('./types.js').GitHubPullRequestFile} GitHubPullRequestFile
 * @typedef {import('./types.js').CreateDraftPullRequestOptions} CreateDraftPullRequestOptions
 * @typedef {import('./types.js').FindIssuesByBodyReferenceOptions} FindIssuesByBodyReferenceOptions
 * @typedef {import('./types.js').MergePullRequestOptions} MergePullRequestOptions
 * @typedef {import('./types.js').EditLabelsOptions} EditLabelsOptions
 * @typedef {import('./types.js').CommentOnIssueOptions} CommentOnIssueOptions
 * @typedef {import('./types.js').CloseIssueOptions} CloseIssueOptions
 * @typedef {import('./types.js').CreateIssueOptions} CreateIssueOptions
 * @typedef {import('./types.js').ClosePullRequestOptions} ClosePullRequestOptions
 * @typedef {import('./types.js').CommentOnPullRequestOptions} CommentOnPullRequestOptions
 * @typedef {import('./types.js').UpdatePullRequestBodyOptions} UpdatePullRequestBodyOptions
 * @typedef {import('./types.js').PublishPullRequestReviewOptions} PublishPullRequestReviewOptions
 * @typedef {import('./types.js').ReplyToPullRequestReviewCommentOptions} ReplyToPullRequestReviewCommentOptions
 * @typedef {import('./types.js').DismissPullRequestReviewOptions} DismissPullRequestReviewOptions
 *
 * @typedef {import('./GitHubClient.types.js').GitHubRepository} GitHubRepository
 * @typedef {import('./GitHubClient.types.js').GitHubApiClient} GitHubApiClient
 * @typedef {import('./GitHubClient.types.js').CreateOctokitOptions} CreateOctokitOptions
 * @typedef {import('./GitHubClient.types.js').CreateOctokit} CreateOctokit
 * @typedef {import('./GitHubClient.types.js').ReadRemoteOriginUrl} ReadRemoteOriginUrl
 * @typedef {import('./GitHubClient.types.js').ReadGitHubCliToken} ReadGitHubCliToken
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
          id
          databaseId
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
          databaseId
          state
          body
          url
          submittedAt
          author {
            login
          }
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
      reviewThreads(first: 100) {
        nodes {
          id
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

const PULL_REQUEST_ID_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      id
    }
  }
}
`;

const MARK_PULL_REQUEST_READY_FOR_REVIEW_MUTATION = `
mutation($pullRequestId: ID!) {
  markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
    pullRequest {
      number
    }
  }
}
`;

const RESOLVE_REVIEW_THREAD_MUTATION = `
mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread {
      id
      isResolved
    }
  }
}
`;

const DISMISS_PULL_REQUEST_REVIEW_MUTATION = `
mutation($pullRequestReviewId: ID!, $message: String!) {
  dismissPullRequestReview(input: { pullRequestReviewId: $pullRequestReviewId, message: $message }) {
    pullRequestReview {
      id
      state
    }
  }
}
`;

/** @type {CreateOctokitOptions['throttle']} */
const FAIL_FAST_GITHUB_THROTTLE = {
  onRateLimit() {
    return false;
  },
  onSecondaryRateLimit() {
    return false;
  },
};

/**
 * @param {object} [options]
 * @param {GitHubApiClient} [options.octokit]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {GitHubRepository} [options.repository]
 * @param {CreateOctokit} [options.createOctokit]
 * @param {ReadRemoteOriginUrl} [options.readRemoteOriginUrl]
 * @param {ReadGitHubCliToken} [options.readGitHubCliToken]
 * @returns {GitHubClient}
 */
export function createGitHubClient({
  octokit,
  env = process.env,
  repository,
  createOctokit = createOctokitClient,
  readRemoteOriginUrl = readGitRemoteOriginUrl,
  readGitHubCliToken = readLocalGitHubCliToken,
} = {}) {
  const api =
    octokit ??
    createOctokit(
      createOctokitOptions({
        auth: readGitHubToken({ env, readGitHubCliToken }),
      }),
    );
  const getRepository = createRepositoryResolver({ repository, env, readRemoteOriginUrl });

  return {
    /**
     * @param {PullOpsLabel[]} labels
     * @returns {Promise<EnsureLabelsResult>}
     */
    async ensureLabels(labels) {
      const repository = getRepository();
      const existingLabels = await listLabels(api, repository);
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
          await createLabel(api, repository, label);
          result.created.push(label.name);
          continue;
        }

        if (labelNeedsUpdate(existingLabel, label)) {
          await updateLabel(api, repository, label);
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
      return await getIssue(api, getRepository(), number);
    },

    /**
     * @param {number} number
     * @returns {Promise<GitHubPullRequest>}
     */
    async getPullRequest(number) {
      return await getPullRequest(api, getRepository(), number);
    },

    /**
     * @param {number} number
     * @returns {Promise<GitHubCheckRun[]>}
     */
    async getPullRequestChecks(number) {
      const repository = getRepository();
      const pullRequest = await getPullRequest(api, repository, number);
      const ref = pullRequest.headSha ?? pullRequest.headRefName;
      return await getPullRequestChecksForRef(api, repository, ref);
    },

    /**
     * @param {string} ref
     * @returns {Promise<GitHubCheckRun[]>}
     */
    async getPullRequestChecksForRef(ref) {
      return await getPullRequestChecksForRef(api, getRepository(), ref);
    },

    /**
     * @param {number} number
     * @returns {Promise<GitHubPullRequestReviewContext>}
     */
    async getPullRequestReviewContext(number) {
      return await getPullRequestReviewContext(api, getRepository(), number);
    },

    /**
     * @param {number} number
     * @returns {Promise<import('./types.js').GitHubPullRequestDiff>}
     */
    async getPullRequestDiff(number) {
      const repository = getRepository();
      const response = await api.rest.pulls.get({
        ...repository,
        pull_number: number,
        mediaType: { format: 'diff' },
      });
      return {
        patch: requireString(response.data, 'pull request diff'),
      };
    },

    /**
     * @param {string} headBranch
     * @returns {Promise<GitHubPullRequest | undefined>}
     */
    async findOpenPullRequestByHead(headBranch) {
      return await readPullRequestByHead(api, getRepository(), {
        headBranch,
        state: 'open',
      });
    },

    /**
     * @param {string} headBranch
     * @returns {Promise<GitHubPullRequest | undefined>}
     */
    async findPullRequestByHead(headBranch) {
      return await readPullRequestByHead(api, getRepository(), {
        headBranch,
        state: 'all',
      });
    },

    /**
     * @param {FindIssuesByBodyReferenceOptions} options
     * @returns {Promise<GitHubIssueReference[]>}
     */
    async findIssuesByBodyReference({ fieldName, issueNumber }) {
      return await findIssuesByBodyReference(api, getRepository(), { fieldName, issueNumber });
    },

    /**
     * @param {CreateDraftPullRequestOptions} options
     * @returns {Promise<GitHubPullRequest>}
     */
    async createDraftPullRequest({ title, body, baseBranch, headBranch }) {
      const repository = getRepository();
      const response = await api.rest.pulls.create({
        ...repository,
        title,
        body,
        base: baseBranch,
        head: headBranch,
        draft: true,
      });
      return parsePullRequest(response.data, 'created pull request');
    },

    /**
     * @param {MergePullRequestOptions} options
     * @returns {Promise<void>}
     */
    async mergePullRequest({ number, method }) {
      const repository = getRepository();
      await api.rest.pulls.merge({
        ...repository,
        pull_number: number,
        merge_method: method,
      });
    },

    /**
     * @param {ClosePullRequestOptions} options
     * @returns {Promise<void>}
     */
    async closePullRequest({ number }) {
      const repository = getRepository();
      await api.rest.pulls.update({
        ...repository,
        pull_number: number,
        state: 'closed',
      });
    },

    /**
     * @param {EditLabelsOptions} options
     * @returns {Promise<void>}
     */
    async addLabelsToIssue({ number, labels }) {
      await addLabels(api, getRepository(), number, labels);
    },

    /**
     * @param {EditLabelsOptions} options
     * @returns {Promise<void>}
     */
    async removeLabelsFromIssue({ number, labels }) {
      await removeLabels(api, getRepository(), number, labels);
    },

    /**
     * @param {EditLabelsOptions} options
     * @returns {Promise<void>}
     */
    async addLabelsToPullRequest({ number, labels }) {
      await addLabels(api, getRepository(), number, labels);
    },

    /**
     * @param {EditLabelsOptions} options
     * @returns {Promise<void>}
     */
    async removeLabelsFromPullRequest({ number, labels }) {
      await removeLabels(api, getRepository(), number, labels);
    },

    /**
     * @param {CommentOnIssueOptions} options
     * @returns {Promise<void>}
     */
    async commentOnIssue({ number, body }) {
      await createIssueComment(api, getRepository(), number, body);
    },

    /**
     * @param {CloseIssueOptions} options
     * @returns {Promise<void>}
     */
    async closeIssue({ number, comment }) {
      const repository = getRepository();
      await createIssueComment(api, repository, number, comment);
      await api.rest.issues.update({
        ...repository,
        issue_number: number,
        state: 'closed',
      });
    },

    /**
     * @param {CreateIssueOptions} options
     * @returns {Promise<GitHubIssue>}
     */
    async createIssue({ title, body, labels = [] }) {
      return await createIssue(api, getRepository(), { title, body, labels });
    },

    /**
     * @param {CommentOnPullRequestOptions} options
     * @returns {Promise<void>}
     */
    async commentOnPullRequest({ number, body }) {
      await createIssueComment(api, getRepository(), number, body);
    },

    /**
     * @param {UpdatePullRequestBodyOptions} options
     * @returns {Promise<void>}
     */
    async updatePullRequestBody({ number, body }) {
      const repository = getRepository();
      await api.rest.pulls.update({
        ...repository,
        pull_number: number,
        body,
      });
    },

    /**
     * @param {number} number
     * @returns {Promise<void>}
     */
    async markPullRequestReadyForReview(number) {
      const repository = getRepository();
      const pullRequestId = await getPullRequestNodeId(api, repository, number);
      await api.graphql(MARK_PULL_REQUEST_READY_FOR_REVIEW_MUTATION, { pullRequestId });
    },

    /**
     * @param {PublishPullRequestReviewOptions} options
     * @returns {Promise<void>}
     */
    async publishPullRequestReview(options) {
      const repository = getRepository();
      await api.rest.pulls.createReview({
        ...repository,
        pull_number: options.number,
        event: options.event,
        body: options.body,
        comments: options.comments.map(comment => ({
          path: comment.path,
          line: comment.line,
          side: 'RIGHT',
          body: comment.body,
        })),
      });
    },

    /**
     * @param {ReplyToPullRequestReviewCommentOptions} options
     * @returns {Promise<void>}
     */
    async replyToPullRequestReviewComment({ commentId, body }) {
      const repository = getRepository();
      const pullNumber = await getPullRequestNumberForReviewComment(api, repository, commentId);
      await api.rest.pulls.createReplyForReviewComment({
        ...repository,
        pull_number: pullNumber,
        comment_id: commentId,
        body,
      });
    },

    /**
     * @param {string} threadId
     * @returns {Promise<void>}
     */
    async resolvePullRequestReviewThread(threadId) {
      await api.graphql(RESOLVE_REVIEW_THREAD_MUTATION, { threadId });
    },

    /**
     * @param {DismissPullRequestReviewOptions} options
     * @returns {Promise<void>}
     */
    async dismissPullRequestReview({ reviewId, message }) {
      await api.graphql(DISMISS_PULL_REQUEST_REVIEW_MUTATION, {
        pullRequestReviewId: reviewId,
        message,
      });
    },
  };
}

/**
 * @param {CreateOctokitOptions} options
 * @returns {GitHubApiClient}
 */
function createOctokitClient(options) {
  return /** @type {GitHubApiClient} */ (/** @type {unknown} */ (new Octokit(options)));
}

/**
 * @param {{ auth?: string }} options
 * @returns {CreateOctokitOptions}
 */
function createOctokitOptions({ auth }) {
  return {
    ...(auth === undefined ? {} : { auth }),
    throttle: FAIL_FAST_GITHUB_THROTTLE,
  };
}

/**
 * @param {object} options
 * @param {NodeJS.ProcessEnv} options.env
 * @param {ReadGitHubCliToken} options.readGitHubCliToken
 * @returns {string | undefined}
 */
function readGitHubToken({ env, readGitHubCliToken }) {
  return (
    readNonEmptyEnv(env.PULLOPS_GITHUB_TOKEN) ??
    readNonEmptyEnv(env.GITHUB_TOKEN) ??
    readGitHubCliToken()
  );
}

/**
 * @returns {string | undefined}
 */
function readLocalGitHubCliToken() {
  try {
    return readNonEmptyEnv(
      execFileSync('gh', ['auth', 'token'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GH_PROMPT_DISABLED: '1',
        },
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch {
    return undefined;
  }
}

/**
 * @param {string | undefined} value
 * @returns {string | undefined}
 */
function readNonEmptyEnv(value) {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }

  return value;
}

/**
 * @param {object} options
 * @param {GitHubRepository | undefined} options.repository
 * @param {NodeJS.ProcessEnv} options.env
 * @param {ReadRemoteOriginUrl} options.readRemoteOriginUrl
 * @returns {() => GitHubRepository}
 */
function createRepositoryResolver({ repository, env, readRemoteOriginUrl }) {
  /** @type {GitHubRepository | undefined} */
  let cachedRepository = repository;

  return () => {
    if (cachedRepository !== undefined) {
      return cachedRepository;
    }

    const envRepository = readNonEmptyEnv(env.GITHUB_REPOSITORY);
    if (envRepository !== undefined) {
      cachedRepository = parseGitHubRepository(envRepository);
      return cachedRepository;
    }

    cachedRepository = parseGitHubRemoteUrl(readRemoteOriginUrl());
    if (cachedRepository === undefined) {
      throw new Error(
        'GITHUB_REPOSITORY must be set to "OWNER/REPO", or remote.origin.url must point at a GitHub repository.',
      );
    }

    return cachedRepository;
  };
}

/**
 * @param {string | undefined} value
 * @returns {GitHubRepository}
 */
export function parseGitHubRepository(value) {
  const trimmedValue = readNonEmptyEnv(value);
  if (trimmedValue === undefined) {
    throw new Error('GITHUB_REPOSITORY must be set to "OWNER/REPO".');
  }

  const repository = parseRepositoryPath(trimmedValue);
  if (repository === undefined) {
    throw new Error(`Invalid GITHUB_REPOSITORY "${value}". Expected "OWNER/REPO".`);
  }

  return repository;
}

/**
 * @returns {string | undefined}
 */
function readGitRemoteOriginUrl() {
  try {
    return execFileSync('git', ['config', '--get', 'remote.origin.url'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
}

/**
 * @param {string | undefined} value
 * @returns {GitHubRepository | undefined}
 */
function parseGitHubRemoteUrl(value) {
  const remoteUrl = value?.trim();
  if (remoteUrl === undefined || remoteUrl === '') {
    return undefined;
  }

  const scpLikeMatch = remoteUrl.match(/^(?:[^@\s]+@)?github\.com:([^/]+)\/(.+)$/i);
  if (scpLikeMatch !== null) {
    return parseRepositoryPath(stripGitSuffix(`${scpLikeMatch[1]}/${scpLikeMatch[2]}`));
  }

  try {
    const url = new URL(remoteUrl);
    if (url.hostname.toLowerCase() !== 'github.com') {
      return undefined;
    }

    const path = stripGitSuffix(url.pathname.replace(/^\/+/, ''));
    return parseRepositoryPath(path);
  } catch {
    return undefined;
  }
}

/**
 * @param {string} value
 * @returns {string}
 */
function stripGitSuffix(value) {
  return value.endsWith('.git') ? value.slice(0, -4) : value;
}

/**
 * @param {string} value
 * @returns {GitHubRepository | undefined}
 */
function parseRepositoryPath(value) {
  const [owner, repo, ...extra] = value.split('/');
  if (
    owner === undefined ||
    owner.trim() === '' ||
    repo === undefined ||
    repo.trim() === '' ||
    extra.length > 0
  ) {
    return undefined;
  }

  return { owner: owner.trim(), repo: repo.trim() };
}

/**
 * @param {GitHubApiClient} octokit
 * @param {GitHubRepository} repository
 * @param {number} number
 * @returns {Promise<GitHubIssue>}
 */
async function getIssue(octokit, repository, number) {
  const result = await octokit.graphql(ISSUE_RELATIONSHIPS_QUERY, {
    ...repository,
    number,
  });
  return parseGraphqlIssue(result);
}

/**
 * @param {GitHubApiClient} octokit
 * @param {GitHubRepository} repository
 * @param {number} number
 * @returns {Promise<GitHubPullRequest>}
 */
async function getPullRequest(octokit, repository, number) {
  const response = await octokit.rest.pulls.get({
    ...repository,
    pull_number: number,
  });
  return parsePullRequest(response.data, 'pull request');
}

/**
 * @param {GitHubApiClient} octokit
 * @param {GitHubRepository} repository
 * @param {{ headBranch: string, state: 'all' | 'open' }} options
 * @returns {Promise<GitHubPullRequest | undefined>}
 */
async function readPullRequestByHead(octokit, repository, { headBranch, state }) {
  const response = await octokit.rest.pulls.list({
    ...repository,
    state,
    head: `${repository.owner}:${headBranch}`,
    per_page: 1,
  });
  const pullRequests = requireArray(response.data, 'pull request list');
  const pullRequest = pullRequests[0];
  return pullRequest === undefined
    ? undefined
    : parsePullRequest(pullRequest, 'pull request at index 0');
}

/**
 * @param {GitHubApiClient} octokit
 * @param {GitHubRepository} repository
 * @param {number} number
 * @returns {Promise<GitHubPullRequestReviewContext>}
 */
async function getPullRequestReviewContext(octokit, repository, number) {
  const result = await octokit.graphql(PULL_REQUEST_REVIEW_CONTEXT_QUERY, {
    ...repository,
    number,
  });
  return parsePullRequestReviewContext(result);
}

/**
 * @param {GitHubApiClient} octokit
 * @param {GitHubRepository} repository
 * @param {FindIssuesByBodyReferenceOptions} options
 * @returns {Promise<GitHubIssueReference[]>}
 */
async function findIssuesByBodyReference(octokit, repository, { fieldName, issueNumber }) {
  const response = await octokit.rest.search.issuesAndPullRequests({
    q: `repo:${repository.owner}/${repository.repo} is:issue "${fieldName}: #${issueNumber}"`,
    per_page: 100,
  });
  const data = requirePlainObject(response.data, 'issue search response');
  const items = requireArray(data.items, 'issue search response.items');

  return items.flatMap((item, index) => parseSearchIssueReference(item, index));
}

/**
 * @param {GitHubApiClient} octokit
 * @param {GitHubRepository} repository
 * @returns {Promise<GitHubLabel[]>}
 */
async function listLabels(octokit, repository) {
  try {
    const labels = await octokit.paginate(octokit.rest.issues.listLabelsForRepo, {
      ...repository,
      per_page: 100,
    });
    return labels.map(parseGitHubLabel);
  } catch (error) {
    throw new Error(`Failed to list GitHub labels: ${getGitHubErrorMessage(error)}`, {
      cause: error,
    });
  }
}

/**
 * @param {GitHubApiClient} octokit
 * @param {GitHubRepository} repository
 * @param {PullOpsLabel} label
 * @returns {Promise<void>}
 */
async function createLabel(octokit, repository, label) {
  try {
    await octokit.rest.issues.createLabel({
      ...repository,
      name: label.name,
      color: label.color,
      description: label.description,
    });
  } catch (error) {
    throw new Error(
      `Failed to create GitHub label "${label.name}": ${getGitHubErrorMessage(error)}`,
      { cause: error },
    );
  }
}

/**
 * @param {GitHubApiClient} octokit
 * @param {GitHubRepository} repository
 * @param {PullOpsLabel} label
 * @returns {Promise<void>}
 */
async function updateLabel(octokit, repository, label) {
  try {
    await octokit.rest.issues.updateLabel({
      ...repository,
      name: label.name,
      color: label.color,
      description: label.description,
    });
  } catch (error) {
    throw new Error(
      `Failed to update GitHub label "${label.name}": ${getGitHubErrorMessage(error)}`,
      { cause: error },
    );
  }
}

/**
 * @param {GitHubApiClient} octokit
 * @param {GitHubRepository} repository
 * @param {number} number
 * @param {string[]} labels
 * @returns {Promise<void>}
 */
async function addLabels(octokit, repository, number, labels) {
  if (labels.length === 0) {
    return;
  }

  await octokit.rest.issues.addLabels({
    ...repository,
    issue_number: number,
    labels,
  });
}

/**
 * @param {GitHubApiClient} octokit
 * @param {GitHubRepository} repository
 * @param {number} number
 * @param {string[]} labels
 * @returns {Promise<void>}
 */
async function removeLabels(octokit, repository, number, labels) {
  for (const label of labels) {
    try {
      await octokit.rest.issues.removeLabel({
        ...repository,
        issue_number: number,
        name: label,
      });
    } catch (error) {
      if (!isMissingLabelRemovalError(error)) {
        throw error;
      }
    }
  }
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isMissingLabelRemovalError(error) {
  if (!isPlainObject(error)) {
    return false;
  }

  const response = isPlainObject(error.response) ? error.response : undefined;
  const status =
    typeof error.status === 'number'
      ? error.status
      : response !== undefined && typeof response.status === 'number'
        ? response.status
        : undefined;
  const message = getGitHubErrorMessage(error).toLowerCase();

  return (
    status === 404 &&
    (message === 'label does not exist' || message.startsWith('label does not exist - '))
  );
}

/**
 * @param {GitHubApiClient} octokit
 * @param {GitHubRepository} repository
 * @param {number} number
 * @param {string} body
 * @returns {Promise<void>}
 */
async function createIssueComment(octokit, repository, number, body) {
  await octokit.rest.issues.createComment({
    ...repository,
    issue_number: number,
    body,
  });
}

/**
 * @param {GitHubApiClient} octokit
 * @param {GitHubRepository} repository
 * @param {CreateIssueOptions} options
 * @returns {Promise<GitHubIssue>}
 */
async function createIssue(octokit, repository, { title, body, labels }) {
  try {
    const response = await octokit.rest.issues.create({
      ...repository,
      title,
      body,
      labels,
    });
    return parseRestIssue(response.data, 'created issue');
  } catch (error) {
    throw new Error(`Failed to create GitHub issue "${title}": ${getGitHubErrorMessage(error)}`, {
      cause: error,
    });
  }
}

/**
 * @param {GitHubApiClient} octokit
 * @param {GitHubRepository} repository
 * @param {string} ref
 * @returns {Promise<GitHubCheckRun[]>}
 */
async function getPullRequestChecksForRef(octokit, repository, ref) {
  const checkRuns = await listCheckRunsForRef(octokit, repository, ref);
  const statuses = await listStatusesForRef(octokit, repository, ref);
  return [...checkRuns, ...statuses];
}

/**
 * @param {GitHubApiClient} octokit
 * @param {GitHubRepository} repository
 * @param {string} ref
 * @returns {Promise<GitHubCheckRun[]>}
 */
async function listCheckRunsForRef(octokit, repository, ref) {
  const response = await octokit.rest.checks.listForRef({
    ...repository,
    ref,
    per_page: 100,
  });
  const data = requirePlainObject(response.data, 'check runs response');
  const checkRuns = requireArray(data.check_runs, 'check runs response.check_runs');
  return checkRuns.map((check, index) => parseCheckRun(check, index));
}

/**
 * @param {GitHubApiClient} octokit
 * @param {GitHubRepository} repository
 * @param {string} ref
 * @returns {Promise<GitHubCheckRun[]>}
 */
async function listStatusesForRef(octokit, repository, ref) {
  const response = await octokit.rest.repos.getCombinedStatusForRef({
    ...repository,
    ref,
    per_page: 100,
  });
  const data = requirePlainObject(response.data, 'combined status response');
  const statuses = requireArray(data.statuses, 'combined status response.statuses');
  return statuses.map((status, index) => parseStatus(status, index));
}

/**
 * @param {GitHubApiClient} octokit
 * @param {GitHubRepository} repository
 * @param {number} commentId
 * @returns {Promise<number>}
 */
async function getPullRequestNumberForReviewComment(octokit, repository, commentId) {
  const response = await octokit.rest.pulls.getReviewComment({
    ...repository,
    comment_id: commentId,
  });
  const comment = requirePlainObject(response.data, 'pull request review comment');
  const pullRequestUrl = requireString(
    comment.pull_request_url,
    'pull request review comment.pull_request_url',
  );
  return parsePullRequestNumberFromApiUrl(pullRequestUrl);
}

/**
 * @param {GitHubApiClient} octokit
 * @param {GitHubRepository} repository
 * @param {number} number
 * @returns {Promise<string>}
 */
async function getPullRequestNodeId(octokit, repository, number) {
  const result = await octokit.graphql(PULL_REQUEST_ID_QUERY, {
    ...repository,
    number,
  });
  const root = requirePlainObject(result, 'GitHub GraphQL pull request response');
  const resultRepository = requirePlainObject(
    root.repository,
    'GitHub GraphQL pull request response.repository',
  );
  const pullRequest = requirePlainObject(
    resultRepository.pullRequest,
    'GitHub GraphQL pull request response.repository.pullRequest',
  );
  return requireString(pullRequest.id, 'pull request.id');
}

/**
 * @param {unknown} value
 * @returns {GitHubIssue}
 */
function parseGraphqlIssue(value) {
  const root = requirePlainObject(value, 'GitHub GraphQL issue response');
  const repository = requirePlainObject(
    root.repository,
    'GitHub GraphQL issue response.repository',
  );
  const issue = repository.issue;

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
 * @param {string} path
 * @returns {GitHubIssue}
 */
function parseRestIssue(value, path) {
  if (!isPlainObject(value)) {
    throw new Error(`Expected ${path} to be an object.`);
  }

  return {
    number: requireNumber(value.number, `${path}.number`),
    title: requireString(value.title, `${path}.title`),
    body: typeof value.body === 'string' ? value.body : '',
    state: requireString(value.state, `${path}.state`).toUpperCase(),
    url: requireString(value.html_url ?? value.url, `${path}.html_url`),
    authorLogin: parseAuthorLogin(value.user),
    labels: parseFlatLabelNames(value.labels) ?? [],
    parent: null,
    subIssues: [],
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
 * @param {unknown} value
 * @param {number} index
 * @returns {GitHubIssueReference[]}
 */
function parseSearchIssueReference(value, index) {
  if (!isPlainObject(value)) {
    throw new Error(`Expected issue search result at index ${index} to be an object.`);
  }

  if (isPlainObject(value.pull_request)) {
    return [];
  }

  return [
    {
      number: requireNumber(value.number, `issue search result at index ${index}.number`),
      title: typeof value.title === 'string' ? value.title : undefined,
      url: readOptionalString(value.html_url, value.url),
      state: typeof value.state === 'string' ? value.state.toUpperCase() : undefined,
      relationshipSource: 'body',
    },
  ];
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

  const head = requirePlainObject(pullRequest.head, `${path}.head`);
  const base = isPlainObject(pullRequest.base) ? pullRequest.base : undefined;
  const headRepo = isPlainObject(head.repo) ? head.repo : undefined;
  const baseRepo = base !== undefined && isPlainObject(base.repo) ? base.repo : undefined;
  const mergedAt = readOptionalString(pullRequest.merged_at, pullRequest.mergedAt);

  return {
    number: requireNumber(pullRequest.number, `${path}.number`),
    title: requireString(pullRequest.title, `${path}.title`),
    url: requireString(pullRequest.html_url ?? pullRequest.url, `${path}.html_url`),
    headRefName: requireString(head.ref ?? pullRequest.headRefName, `${path}.head.ref`),
    ...optionalProperty('headSha', readOptionalString(head.sha, pullRequest.headSha)),
    ...optionalProperty('baseRefName', readOptionalString(base?.ref, pullRequest.baseRefName)),
    ...optionalProperty('state', normalizePullRequestState(pullRequest.state, mergedAt)),
    ...optionalProperty('mergedAt', mergedAt),
    body: typeof pullRequest.body === 'string' ? pullRequest.body : '',
    isDraft: Boolean(pullRequest.draft ?? pullRequest.isDraft),
    ...optionalProperty(
      'isCrossRepository',
      parseIsCrossRepository(headRepo, baseRepo, pullRequest),
    ),
    labels: parseFlatLabelNames(pullRequest.labels),
  };
}

/**
 * @param {unknown} state
 * @param {string | undefined} mergedAt
 * @returns {string | undefined}
 */
function normalizePullRequestState(state, mergedAt) {
  if (mergedAt !== undefined) {
    return 'MERGED';
  }

  return typeof state === 'string' ? state.toUpperCase() : undefined;
}

/**
 * @param {Record<string, unknown> | undefined} headRepo
 * @param {Record<string, unknown> | undefined} baseRepo
 * @param {Record<string, unknown>} pullRequest
 * @returns {boolean | undefined}
 */
function parseIsCrossRepository(headRepo, baseRepo, pullRequest) {
  if (typeof pullRequest.isCrossRepository === 'boolean') {
    return pullRequest.isCrossRepository;
  }

  const headFullName = readOptionalString(headRepo?.full_name, headRepo?.nameWithOwner);
  const baseFullName = readOptionalString(baseRepo?.full_name, baseRepo?.nameWithOwner);
  if (headFullName !== undefined && baseFullName !== undefined) {
    return headFullName !== baseFullName;
  }

  return undefined;
}

/**
 * @param {unknown} check
 * @param {number} index
 * @returns {GitHubCheckRun}
 */
function parseCheckRun(check, index) {
  if (!isPlainObject(check)) {
    throw new Error(`Expected pull request check at index ${index} to be an object.`);
  }

  return {
    name: requireString(check.name, `pull request check at index ${index}.name`),
    ...optionalProperty('workflowName', parseCheckRunWorkflowName(check)),
    ...optionalProperty('state', readOptionalString(check.status)),
    ...optionalProperty('conclusion', readOptionalString(check.conclusion)),
    ...optionalProperty('bucket', parseCheckRunBucket(check)),
    ...optionalProperty('detailsUrl', readOptionalString(check.details_url, check.html_url)),
    ...optionalProperty('summary', parseCheckRunSummary(check)),
  };
}

/**
 * @param {Record<string, unknown>} check
 * @returns {string | undefined}
 */
function parseCheckRunWorkflowName(check) {
  const checkSuite = isPlainObject(check.check_suite) ? check.check_suite : undefined;
  const app =
    checkSuite !== undefined && isPlainObject(checkSuite.app) ? checkSuite.app : undefined;
  return readOptionalString(check.workflow_name, app?.name);
}

/**
 * @param {Record<string, unknown>} check
 * @returns {string | undefined}
 */
function parseCheckRunBucket(check) {
  const conclusion = readOptionalString(check.conclusion);
  if (conclusion === undefined) {
    return undefined;
  }

  return conclusion === 'success' || conclusion === 'neutral' || conclusion === 'skipped'
    ? 'pass'
    : 'fail';
}

/**
 * @param {Record<string, unknown>} check
 * @returns {string | undefined}
 */
function parseCheckRunSummary(check) {
  const output = isPlainObject(check.output) ? check.output : undefined;
  return readOptionalString(output?.summary, output?.text);
}

/**
 * @param {unknown} status
 * @param {number} index
 * @returns {GitHubCheckRun}
 */
function parseStatus(status, index) {
  if (!isPlainObject(status)) {
    throw new Error(`Expected pull request status at index ${index} to be an object.`);
  }

  const state = requireString(status.state, `pull request status at index ${index}.state`);

  return {
    name: requireString(status.context, `pull request status at index ${index}.context`),
    state,
    ...optionalProperty('conclusion', parseStatusConclusion(state)),
    bucket: parseStatusBucket(state),
    ...optionalProperty('detailsUrl', readOptionalString(status.target_url)),
    ...optionalProperty('summary', readOptionalString(status.description)),
  };
}

/**
 * @param {string} state
 * @returns {string | undefined}
 */
function parseStatusConclusion(state) {
  return ['success', 'failure', 'error'].includes(state) ? state : undefined;
}

/**
 * @param {string} state
 * @returns {string}
 */
function parseStatusBucket(state) {
  if (state === 'success') {
    return 'pass';
  }

  if (state === 'failure' || state === 'error') {
    return 'fail';
  }

  return state;
}

/**
 * @param {unknown} labels
 * @returns {string[] | undefined}
 */
function parseFlatLabelNames(labels) {
  if (!Array.isArray(labels)) {
    return undefined;
  }

  return labels.flatMap(label => {
    if (isPlainObject(label) && typeof label.name === 'string') {
      return [label.name];
    }

    if (typeof label === 'string') {
      return [label];
    }

    return [];
  });
}

/**
 * @template {string} T
 * @template V
 * @param {T} key
 * @param {V | undefined} value
 * @returns {Record<T, V> | {}}
 */
function optionalProperty(key, value) {
  return value === undefined ? {} : { [key]: value };
}

/**
 * @param {...unknown} values
 * @returns {string | undefined}
 */
function readOptionalString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') {
      return value;
    }
  }

  return undefined;
}

/**
 * @param {unknown} value
 * @returns {GitHubPullRequestReviewContext}
 */
function parsePullRequestReviewContext(value) {
  const root = requirePlainObject(value, 'GitHub GraphQL pull request response');
  const repository = requirePlainObject(
    root.repository,
    'GitHub GraphQL pull request response.repository',
  );
  const pullRequest = repository.pullRequest;

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
      databaseId: typeof review.databaseId === 'number' ? review.databaseId : undefined,
      state: requireString(review.state, `pull request review at index ${index}.state`),
      body: typeof review.body === 'string' ? review.body : '',
      authorLogin: parseAuthorLogin(review.author),
      url: typeof review.url === 'string' ? review.url : undefined,
      ...optionalProperty('submittedAt', readOptionalString(review.submittedAt)),
      comments: parsePullRequestComments(review.comments),
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
      ...optionalProperty('id', readOptionalString(thread.id)),
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
function parsePullRequestNumberFromApiUrl(url) {
  const match = url.match(/\/pulls\/(\d+)$/);
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
 * @returns {Record<string, unknown>}
 */
function requirePlainObject(value, path) {
  if (!isPlainObject(value)) {
    throw new Error(`Expected ${path} to be an object.`);
  }

  return value;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {unknown[]}
 */
function requireArray(value, path) {
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${path} to be an array.`);
  }

  return value;
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
    const response = isPlainObject(error.response) ? error.response : undefined;
    const data = response !== undefined && isPlainObject(response.data) ? response.data : undefined;
    if (typeof data?.message === 'string' && data.message.trim() !== '') {
      return data.message.trim();
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
