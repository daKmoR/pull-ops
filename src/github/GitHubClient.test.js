import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createGitHubClient, parseGitHubRepository, PULL_OPS_LABELS } from './GitHubClient.js';

/**
 * @typedef {import('./GitHubClient.test.types.js').OctokitCall} OctokitCall
 * @typedef {import('./GitHubClient.test.types.js').ExistingLabel} ExistingLabel
 */

describe('createGitHubClient', () => {
  it('01: defines PullOps task and state labels', () => {
    assert.deepEqual(
      PULL_OPS_LABELS.map(label => [label.name, label.color, label.description]),
      [
        [
          'pullops:prd:prepare',
          '5319E7',
          'Prepare an umbrella branch and draft PR for a PRD issue.',
        ],
        [
          'pullops:prd:coordinate',
          '5319E7',
          'Reserved for future automatic PRD child issue orchestration.',
        ],
        [
          'pullops:issue:implement',
          '5319E7',
          'Implement one concrete issue. Does not coordinate child issues.',
        ],
        ['pullops:pr:review', '5319E7', 'Run PullOps automated PR review.'],
        ['pullops:pr:address-review', '5319E7', 'Address actionable PullOps PR review feedback.'],
        ['pullops:pr:fix-ci', '5319E7', 'Classify and fix actionable CI failures.'],
        ['pullops:pr:update-branch', '5319E7', 'Update a same-repository PR branch.'],
        [
          'pullops:pr:resolve-conflicts',
          '5319E7',
          'Resolve branch update conflicts with the PullOps runner.',
        ],
        [
          'pullops:pr:prepare-merge',
          '5319E7',
          'Prepare a PullOps-managed PR for human review and merge.',
        ],
        ['pullops:status:in-progress', 'FBCA04', 'PullOps automation is currently working.'],
        [
          'pullops:status:blocked',
          'D93F0B',
          'PullOps automation is blocked and needs human attention.',
        ],
        [
          'pullops:status:prepared',
          '1D76DB',
          'PullOps prepared this target; downstream work remains.',
        ],
        ['pullops:status:done', '0E8A16', 'PullOps automation completed successfully.'],
        ['pullops:status:failed', 'B60205', 'PullOps automation failed and needs investigation.'],
      ],
    );
  });

  it('02: creates missing PullOps labels through Octokit', async () => {
    const { calls, octokit } = createFakeOctokit({ labels: [] });
    const client = createGitHubClient({ octokit, repository: TEST_REPOSITORY });

    const result = await client.ensureLabels(PULL_OPS_LABELS);

    assert.deepEqual(result, {
      created: PULL_OPS_LABELS.map(label => label.name),
      updated: [],
      alreadyCorrect: [],
    });
    assert.equal(calls.length, PULL_OPS_LABELS.length + 1);
    assert.deepEqual(calls[0], {
      name: 'issues.listLabelsForRepo',
      params: {
        ...TEST_REPOSITORY,
        per_page: 100,
      },
    });
    assert.deepEqual(calls[1], {
      name: 'issues.createLabel',
      params: {
        ...TEST_REPOSITORY,
        name: 'pullops:prd:prepare',
        color: '5319E7',
        description: 'Prepare an umbrella branch and draft PR for a PRD issue.',
      },
    });
  });

  it('03: leaves existing PullOps labels unchanged when already correct', async () => {
    const labels = PULL_OPS_LABELS.map(label => ({
      ...label,
      color: label.color.toLowerCase(),
    }));
    const { calls, octokit } = createFakeOctokit({ labels });
    const client = createGitHubClient({ octokit, repository: TEST_REPOSITORY });

    const result = await client.ensureLabels(PULL_OPS_LABELS);

    assert.deepEqual(result, {
      created: [],
      updated: [],
      alreadyCorrect: PULL_OPS_LABELS.map(label => label.name),
    });
    assert.deepEqual(
      calls.map(call => call.name),
      ['issues.listLabelsForRepo'],
    );
  });

  it('04: creates missing labels and updates incorrect existing labels', async () => {
    const labels = [
      {
        name: 'pullops:missing',
        color: '111111',
        description: 'Missing label.',
      },
      {
        name: 'pullops:wrong-color',
        color: '222222',
        description: 'Correct description.',
      },
      {
        name: 'pullops:wrong-description',
        color: '333333',
        description: 'Correct description.',
      },
      {
        name: 'pullops:already-correct',
        color: '444444',
        description: 'Already correct.',
      },
    ];
    const { calls, octokit } = createFakeOctokit({
      labels: [
        {
          name: 'pullops:wrong-color',
          color: '000000',
          description: 'Correct description.',
        },
        {
          name: 'pullops:wrong-description',
          color: '333333',
          description: 'Old description.',
        },
        {
          name: 'pullops:already-correct',
          color: '444444',
          description: 'Already correct.',
        },
      ],
    });
    const client = createGitHubClient({ octokit, repository: TEST_REPOSITORY });

    const result = await client.ensureLabels(labels);

    assert.deepEqual(result, {
      created: ['pullops:missing'],
      updated: ['pullops:wrong-color', 'pullops:wrong-description'],
      alreadyCorrect: ['pullops:already-correct'],
    });
    assert.deepEqual(
      calls.map(call => call.name),
      [
        'issues.listLabelsForRepo',
        'issues.createLabel',
        'issues.updateLabel',
        'issues.updateLabel',
      ],
    );
  });

  it('05: reports GitHub API failures with label context', async () => {
    const { octokit } = createFakeOctokit({
      labels: [
        {
          name: 'pullops:wrong-color',
          color: '000000',
          description: 'Correct description.',
        },
      ],
      failOn: call => call.name === 'issues.updateLabel',
    });
    const client = createGitHubClient({ octokit, repository: TEST_REPOSITORY });

    await assert.rejects(
      client.ensureLabels([
        {
          name: 'pullops:wrong-color',
          color: '222222',
          description: 'Correct description.',
        },
      ]),
      /Failed to update GitHub label "pullops:wrong-color": GitHub refused the label change./,
    );
  });

  it('06: reads native issue parent and sub-issue relationships', async () => {
    const { calls, octokit } = createFakeOctokit({
      issue: createIssue({
        number: 1,
        title: 'PRD',
        body: '## What to build\n\nShip the workflow kit.',
        subIssues: {
          totalCount: 1,
          nodes: [
            {
              number: 4,
              title: 'Implement a leaf issue',
              body: '## What to build\n\nDo the work.',
              state: 'OPEN',
              url: 'https://github.com/acme/widgets/issues/4',
            },
          ],
        },
      }),
    });
    const client = createGitHubClient({ octokit, repository: TEST_REPOSITORY });

    const issue = await client.getIssue(1);

    assert.deepEqual(issue.subIssues, [
      {
        number: 4,
        title: 'Implement a leaf issue',
        state: 'OPEN',
        url: 'https://github.com/acme/widgets/issues/4',
        relationshipSource: 'native',
      },
    ]);
    assert.deepEqual(calls[0].name, 'graphql');
    assert.deepEqual(calls[0].params, {
      ...TEST_REPOSITORY,
      number: 1,
    });
  });

  it('07: ignores legacy Parent body sections when native relationships are absent', async () => {
    const { octokit } = createFakeOctokit({
      issue: createIssue({
        number: 4,
        title: 'Implement a leaf issue',
        body: '## Parent\n\n#1\n\n## What to build\n\nDo the work.',
      }),
    });
    const client = createGitHubClient({ octokit, repository: TEST_REPOSITORY });

    const issue = await client.getIssue(4);

    assert.equal(issue.parent, null);
    assert.deepEqual(issue.subIssues, []);
  });

  it('08: loads pull request metadata, review context, diff, open PRs, drafts, and checks', async () => {
    const { calls, octokit } = createFakeOctokit({
      pullRequest: createPullRequest(),
      openPullRequests: [createPullRequest()],
      reviewContext: createReviewContext(),
      diff: 'diff --git a/src/example.js b/src/example.js\n',
      checkRuns: [
        {
          name: 'ESLint lint',
          status: 'completed',
          conclusion: 'failure',
          details_url: 'https://github.com/acme/widgets/actions/runs/1',
          output: {
            summary: 'ESLint reported an unused variable.',
          },
          check_suite: {
            app: {
              name: 'CI',
            },
          },
        },
      ],
      statuses: [
        {
          context: 'coverage',
          state: 'pending',
          target_url: 'https://github.com/acme/widgets/actions/runs/2',
          description: 'Waiting for coverage.',
        },
      ],
    });
    const client = createGitHubClient({ octokit, repository: TEST_REPOSITORY });

    const pullRequest = await client.getPullRequest(100);
    const reviewContext = await client.getPullRequestReviewContext(100);
    const diff = await client.getPullRequestDiff(100);
    const existingPullRequest = await client.findOpenPullRequestByHead('pullops/issue-42');
    const createdPullRequest = await client.createDraftPullRequest({
      title: 'Implement #42',
      body: 'Managed PR: yes',
      baseBranch: 'main',
      headBranch: 'pullops/issue-42',
    });
    const checks = await client.getPullRequestChecks(100);
    const checksByRef = await client.getPullRequestChecksForRef('def456');

    assert.equal(pullRequest.number, 100);
    assert.equal(pullRequest.state, 'MERGED');
    assert.equal(pullRequest.mergedAt, '2026-06-14T10:00:00Z');
    assert.equal(pullRequest.isCrossRepository, false);
    assert.deepEqual(pullRequest.labels, ['pullops:pr:fix-ci']);
    assert.deepEqual(reviewContext.files, [
      {
        path: 'src/example.js',
        additions: 1,
        deletions: 0,
      },
    ]);
    assert.deepEqual(reviewContext.unresolvedThreads[0].comments[0].databaseId, 9001);
    assert.equal(reviewContext.reviews[0].submittedAt, '2026-06-14T09:00:00Z');
    assert.equal(diff.patch, 'diff --git a/src/example.js b/src/example.js\n');
    assert.equal(existingPullRequest?.number, 100);
    assert.equal(createdPullRequest.headRefName, 'pullops/issue-42');
    assert.deepEqual(checks, [
      {
        name: 'ESLint lint',
        workflowName: 'CI',
        state: 'completed',
        conclusion: 'failure',
        bucket: 'fail',
        detailsUrl: 'https://github.com/acme/widgets/actions/runs/1',
        summary: 'ESLint reported an unused variable.',
      },
      {
        name: 'coverage',
        state: 'pending',
        bucket: 'pending',
        detailsUrl: 'https://github.com/acme/widgets/actions/runs/2',
        summary: 'Waiting for coverage.',
      },
    ]);
    assert.deepEqual(checksByRef, checks);
    assert.equal(reviewContext.unresolvedThreads[0].id, 'PRRT_1');
    assert.deepEqual(
      calls.map(call => call.name),
      [
        'pulls.get',
        'graphql',
        'pulls.get',
        'pulls.list',
        'pulls.create',
        'pulls.get',
        'checks.listForRef',
        'repos.getCombinedStatusForRef',
        'checks.listForRef',
        'repos.getCombinedStatusForRef',
      ],
    );
  });

  it('09: publishes review decisions, replies, PR body updates, issue close, labels, and comments', async () => {
    const { calls, octokit } = createFakeOctokit();
    const client = createGitHubClient({ octokit, repository: TEST_REPOSITORY });

    await client.publishPullRequestReview({
      number: 100,
      event: 'REQUEST_CHANGES',
      body: 'Needs changes.',
      comments: [
        {
          path: 'src/example.js',
          line: 2,
          body: 'Inline feedback.',
        },
      ],
    });
    await client.replyToPullRequestReviewComment({
      commentId: 9001,
      body: 'Reply body.',
    });
    await client.updatePullRequestBody({
      number: 100,
      body: 'Updated body.',
    });
    await client.markPullRequestReadyForReview(100);
    await client.closeIssue({
      number: 42,
      comment: 'Child PR merged into the PRD branch.',
    });
    await client.resolvePullRequestReviewThread('PRRT_1');
    await client.removeLabelsFromPullRequest({
      number: 100,
      labels: ['pullops:pr:review'],
    });
    await client.addLabelsToIssue({
      number: 42,
      labels: ['pullops:status:done'],
    });
    await client.commentOnPullRequest({
      number: 100,
      body: 'Failure reason.',
    });

    assert.deepEqual(calls[0], {
      name: 'pulls.createReview',
      params: {
        ...TEST_REPOSITORY,
        pull_number: 100,
        event: 'REQUEST_CHANGES',
        body: 'Needs changes.',
        comments: [
          {
            path: 'src/example.js',
            line: 2,
            side: 'RIGHT',
            body: 'Inline feedback.',
          },
        ],
      },
    });
    assert.deepEqual(
      calls.slice(1).map(call => call.name),
      [
        'pulls.getReviewComment',
        'pulls.createReplyForReviewComment',
        'pulls.update',
        'graphql',
        'graphql',
        'issues.createComment',
        'issues.update',
        'graphql',
        'issues.removeLabel',
        'issues.addLabels',
        'issues.createComment',
      ],
    );
    assert.deepEqual(calls[5].params, { pullRequestId: 'PR_100' });
    assert.deepEqual(calls[8].params, { threadId: 'PRRT_1' });
    assert.deepEqual(calls[2].params, {
      ...TEST_REPOSITORY,
      pull_number: 100,
      comment_id: 9001,
      body: 'Reply body.',
    });
  });

  it('10: ignores missing labels while removing issue labels', async () => {
    const { calls, octokit } = createFakeOctokit({
      missingLabels: ['pullops:status:blocked'],
    });
    const client = createGitHubClient({ octokit, repository: TEST_REPOSITORY });

    await client.removeLabelsFromIssue({
      number: 42,
      labels: ['pullops:issue:implement', 'pullops:status:blocked'],
    });

    assert.deepEqual(
      calls.map(call => call.name),
      ['issues.removeLabel', 'issues.removeLabel'],
    );
    assert.deepEqual(calls[1].params, {
      ...TEST_REPOSITORY,
      issue_number: 42,
      name: 'pullops:status:blocked',
    });
  });

  it('11: reports non-missing label removal failures', async () => {
    const { octokit } = createFakeOctokit({
      failOn: call => call.name === 'issues.removeLabel',
    });
    const client = createGitHubClient({ octokit, repository: TEST_REPOSITORY });

    await assert.rejects(
      client.removeLabelsFromIssue({
        number: 42,
        labels: ['pullops:issue:implement'],
      }),
      /GitHub API failed/,
    );
  });

  it('12: reads auth from PULLOPS_GITHUB_TOKEN before GITHUB_TOKEN and parses GITHUB_REPOSITORY', async () => {
    const { octokit } = createFakeOctokit({ labels: [] });
    /** @type {string | undefined} */
    let auth;
    const client = createGitHubClient({
      env: {
        PULLOPS_GITHUB_TOKEN: 'pullops-token',
        GITHUB_TOKEN: 'github-token',
        GITHUB_REPOSITORY: 'acme/widgets',
      },
      createOctokit(options) {
        auth = options.auth;
        return octokit;
      },
    });

    await client.ensureLabels([]);

    assert.equal(auth, 'pullops-token');
    assert.deepEqual(parseGitHubRepository('acme/widgets'), TEST_REPOSITORY);
    assert.throws(() => parseGitHubRepository(undefined), /GITHUB_REPOSITORY/);
    assert.throws(() => parseGitHubRepository('acme/widgets/extra'), /Invalid GITHUB_REPOSITORY/);
  });
});

const TEST_REPOSITORY = {
  owner: 'acme',
  repo: 'widgets',
};

/**
 * @param {object} [options]
 * @param {ExistingLabel[]} [options.labels]
 * @param {Record<string, unknown>} [options.issue]
 * @param {Record<string, unknown>} [options.pullRequest]
 * @param {Record<string, unknown>[]} [options.openPullRequests]
 * @param {Record<string, unknown>} [options.reviewContext]
 * @param {string} [options.diff]
 * @param {Record<string, unknown>[]} [options.checkRuns]
 * @param {Record<string, unknown>[]} [options.statuses]
 * @param {string[]} [options.missingLabels]
 * @param {(call: OctokitCall) => boolean} [options.failOn]
 * @returns {{ calls: OctokitCall[], octokit: import('./GitHubClient.types.js').GitHubApiClient }}
 */
function createFakeOctokit({
  labels = [],
  issue = createIssue(),
  pullRequest = createPullRequest(),
  openPullRequests = [],
  reviewContext = createReviewContext(),
  diff = '',
  checkRuns = [],
  statuses = [],
  missingLabels = [],
  failOn = () => false,
} = {}) {
  /** @type {OctokitCall[]} */
  const calls = [];

  /**
   * @param {string} name
   * @param {(params: Record<string, unknown>) => unknown} handler
   * @returns {(params: Record<string, unknown>) => Promise<{ data: unknown }>}
   */
  function endpoint(name, handler) {
    return async params => {
      const call = { name, params };
      calls.push(call);

      if (failOn(call)) {
        const error = new Error('GitHub API failed.');
        Object.assign(error, {
          response: {
            data: {
              message: 'GitHub refused the label change.',
            },
          },
        });
        throw error;
      }

      return { data: handler(params) };
    };
  }

  const octokit = {
    /**
     * @param {(params: Record<string, unknown>) => Promise<{ data: unknown }>} endpointToPaginate
     * @param {Record<string, unknown>} params
     * @returns {Promise<unknown[]>}
     */
    async paginate(endpointToPaginate, params) {
      const response = await endpointToPaginate(params);
      assert.ok(Array.isArray(response.data));
      return response.data;
    },
    /**
     * @param {string} query
     * @param {Record<string, unknown>} variables
     * @returns {Promise<unknown>}
     */
    async graphql(query, variables) {
      calls.push({ name: 'graphql', params: variables, query });
      if (query.includes('issue(number: $number)')) {
        return {
          repository: {
            issue,
          },
        };
      }

      if (query.includes('pullRequest(number: $number)') && !query.includes('reviewThreads')) {
        return {
          repository: {
            pullRequest: {
              id: 'PR_100',
            },
          },
        };
      }

      if (query.includes('markPullRequestReadyForReview')) {
        return {
          markPullRequestReadyForReview: {
            pullRequest: {
              number: 100,
            },
          },
        };
      }

      if (query.includes('resolveReviewThread')) {
        return {
          resolveReviewThread: {
            thread: {
              id: variables.threadId,
              isResolved: true,
            },
          },
        };
      }

      return {
        repository: {
          pullRequest: reviewContext,
        },
      };
    },
    rest: {
      checks: {
        listForRef: endpoint('checks.listForRef', () => ({
          total_count: checkRuns.length,
          check_runs: checkRuns,
        })),
      },
      issues: {
        addLabels: endpoint('issues.addLabels', () => ({})),
        createComment: endpoint('issues.createComment', () => ({})),
        createLabel: endpoint('issues.createLabel', () => ({})),
        listLabelsForRepo: endpoint('issues.listLabelsForRepo', () => labels),
        removeLabel: endpoint('issues.removeLabel', params => {
          if (missingLabels.includes(requireStringParam(params.name))) {
            const error = new Error('Label does not exist');
            Object.assign(error, {
              status: 404,
              response: {
                status: 404,
                data: {
                  message: 'Label does not exist',
                },
              },
            });
            throw error;
          }

          return {};
        }),
        update: endpoint('issues.update', () => ({})),
        updateLabel: endpoint('issues.updateLabel', () => ({})),
      },
      pulls: {
        create: endpoint('pulls.create', params =>
          createPullRequest({
            title: requireStringParam(params.title),
            body: requireStringParam(params.body),
            baseRefName: requireStringParam(params.base),
            headRefName: requireStringParam(params.head),
            mergedAt: undefined,
          }),
        ),
        createReplyForReviewComment: endpoint('pulls.createReplyForReviewComment', () => ({})),
        createReview: endpoint('pulls.createReview', () => ({})),
        get: endpoint('pulls.get', params => {
          if (isPlainObject(params.mediaType) && params.mediaType.format === 'diff') {
            return diff;
          }

          return pullRequest;
        }),
        getReviewComment: endpoint('pulls.getReviewComment', () => ({
          pull_request_url: 'https://api.github.com/repos/acme/widgets/pulls/100',
        })),
        list: endpoint('pulls.list', () => openPullRequests),
        update: endpoint('pulls.update', () => ({})),
      },
      repos: {
        getCombinedStatusForRef: endpoint('repos.getCombinedStatusForRef', () => ({
          statuses,
        })),
      },
    },
  };

  return {
    calls,
    octokit,
  };
}

/**
 * @param {object} [options]
 * @param {number} [options.number]
 * @param {string} [options.title]
 * @param {string} [options.body]
 * @param {Record<string, unknown> | null} [options.parent]
 * @param {Record<string, unknown>} [options.subIssues]
 * @returns {Record<string, unknown>}
 */
function createIssue({
  number = 1,
  title = 'PRD',
  body = '## What to build\n\nShip the workflow kit.',
  parent = null,
  subIssues = {
    totalCount: 0,
    nodes: [],
  },
} = {}) {
  return {
    number,
    title,
    body,
    state: 'OPEN',
    url: `https://github.com/acme/widgets/issues/${number}`,
    author: {
      login: 'maintainer',
    },
    labels: {
      nodes: [],
    },
    parent,
    subIssues,
  };
}

/**
 * @param {object} [options]
 * @param {number} [options.number]
 * @param {string} [options.title]
 * @param {string} [options.body]
 * @param {string} [options.headRefName]
 * @param {string} [options.headSha]
 * @param {string} [options.baseRefName]
 * @param {string | undefined} [options.mergedAt]
 * @param {string} [options.headRepository]
 * @param {string} [options.baseRepository]
 * @param {string[]} [options.labels]
 * @returns {Record<string, unknown>}
 */
function createPullRequest({
  number = 100,
  title = 'Implement #42',
  body = 'Managed PR: yes',
  headRefName = 'pullops/issue-42',
  headSha = 'abc123',
  baseRefName = 'main',
  mergedAt = '2026-06-14T10:00:00Z',
  headRepository = 'acme/widgets',
  baseRepository = 'acme/widgets',
  labels = ['pullops:pr:fix-ci'],
} = {}) {
  return {
    number,
    title,
    html_url: `https://github.com/acme/widgets/pull/${number}`,
    head: {
      ref: headRefName,
      sha: headSha,
      repo: {
        full_name: headRepository,
      },
    },
    base: {
      ref: baseRefName,
      repo: {
        full_name: baseRepository,
      },
    },
    state: mergedAt === undefined ? 'open' : 'closed',
    merged_at: mergedAt,
    body,
    draft: true,
    labels: labels.map(name => ({ name })),
  };
}

/**
 * @returns {Record<string, unknown>}
 */
function createReviewContext() {
  return {
    comments: {
      nodes: [
        {
          body: 'PR comment.',
          url: 'https://github.com/acme/widgets/pull/100#issuecomment-1',
          author: {
            login: 'maintainer',
          },
        },
      ],
    },
    reviews: {
      nodes: [
        {
          id: 'R_1',
          state: 'COMMENTED',
          body: 'Review summary.',
          url: 'https://github.com/acme/widgets/pull/100#pullrequestreview-1',
          submittedAt: '2026-06-14T09:00:00Z',
          author: {
            login: 'reviewer',
          },
        },
      ],
    },
    reviewThreads: {
      nodes: [
        {
          id: 'PRRT_1',
          isResolved: false,
          comments: {
            nodes: [
              {
                id: 'PRRC_1',
                databaseId: 9001,
                body: 'Unresolved feedback.',
                path: 'src/example.js',
                line: 2,
                diffHunk: '@@ -1 +1 @@',
                url: 'https://github.com/acme/widgets/pull/100#discussion_r9001',
                author: {
                  login: 'reviewer',
                },
              },
            ],
          },
        },
      ],
    },
    files: {
      nodes: [
        {
          path: 'src/example.js',
          additions: 1,
          deletions: 0,
        },
      ],
    },
  };
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function requireStringParam(value) {
  if (typeof value !== 'string') {
    assert.fail('Expected a string parameter.');
  }

  return value;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
