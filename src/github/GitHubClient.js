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
 * @typedef {import('./types.js').EditLabelsOptions} EditLabelsOptions
 * @typedef {import('./types.js').CommentOnIssueOptions} CommentOnIssueOptions
 * @typedef {import('./types.js').CloseIssueOptions} CloseIssueOptions
 * @typedef {import('./types.js').CommentOnPullRequestOptions} CommentOnPullRequestOptions
 * @typedef {import('./types.js').UpdatePullRequestBodyOptions} UpdatePullRequestBodyOptions
 * @typedef {import('./types.js').PublishPullRequestReviewOptions} PublishPullRequestReviewOptions
 * @typedef {import('./types.js').ReplyToPullRequestReviewCommentOptions} ReplyToPullRequestReviewCommentOptions
 *
 * @typedef {import('./GitHubClient.types.js').GitHubRepository} GitHubRepository
 * @typedef {import('./GitHubClient.types.js').GitHubApiClient} GitHubApiClient
 * @typedef {import('./GitHubClient.types.js').CreateOctokit} CreateOctokit
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
 * @param {object} [options]
 * @param {GitHubApiClient} [options.octokit]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {GitHubRepository} [options.repository]
 * @param {CreateOctokit} [options.createOctokit]
 * @returns {GitHubClient}
 */
export function createGitHubClient({
  octokit,
  env = process.env,
  repository,
  createOctokit = createOctokitClient,
} = {}) {
  const api = octokit ?? createOctokit({ auth: readGitHubToken(env) });
  const getRepository = createRepositoryResolver(repository, env);

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
      const checkRuns = await listCheckRunsForRef(api, repository, ref);
      const statuses = await listStatusesForRef(api, repository, ref);
      return [...checkRuns, ...statuses];
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
      const repository = getRepository();
      const response = await api.rest.pulls.list({
        ...repository,
        state: 'open',
        head: `${repository.owner}:${headBranch}`,
        per_page: 1,
      });
      const pullRequests = requireArray(response.data, 'pull request list');
      const pullRequest = pullRequests[0];
      return pullRequest === undefined
        ? undefined
        : parsePullRequest(pullRequest, 'pull request at index 0');
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
  };
}

/**
 * @param {{ auth?: string }} options
 * @returns {GitHubApiClient}
 */
function createOctokitClient({ auth }) {
  const options = auth === undefined ? {} : { auth };
  return /** @type {GitHubApiClient} */ (/** @type {unknown} */ (new Octokit(options)));
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | undefined}
 */
function readGitHubToken(env) {
  return readNonEmptyEnv(env.PULLOPS_GITHUB_TOKEN) ?? readNonEmptyEnv(env.GITHUB_TOKEN);
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
 * @param {GitHubRepository | undefined} repository
 * @param {NodeJS.ProcessEnv} env
 * @returns {() => GitHubRepository}
 */
function createRepositoryResolver(repository, env) {
  /** @type {GitHubRepository | undefined} */
  let cachedRepository = repository;

  return () => {
    cachedRepository ??= parseGitHubRepository(env.GITHUB_REPOSITORY);
    return cachedRepository;
  };
}

/**
 * @param {string | undefined} value
 * @returns {GitHubRepository}
 */
export function parseGitHubRepository(value) {
  if (value === undefined || value.trim() === '') {
    throw new Error('GITHUB_REPOSITORY must be set to "OWNER/REPO".');
  }

  const [owner, repo, ...extra] = value.split('/');
  if (
    owner === undefined ||
    owner.trim() === '' ||
    repo === undefined ||
    repo.trim() === '' ||
    extra.length > 0
  ) {
    throw new Error(`Invalid GITHUB_REPOSITORY "${value}". Expected "OWNER/REPO".`);
  }

  return { owner, repo };
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
    await octokit.rest.issues.removeLabel({
      ...repository,
      issue_number: number,
      name: label,
    });
  }
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
