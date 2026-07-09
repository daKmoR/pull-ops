import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createSpecIssueBody } from './specIssueBody.js';
import { publishSpecIssue } from './publishSpecIssue.js';

describe('publishSpecIssue', () => {
  it('01: creates a PullOps-published Spec issue with a triage role and run record artifacts', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-spec-create-'));
    const github = createFakeGitHubClient({
      /** @param {import('../github/types.js').CreateIssueOptions} options */
      async createIssue(options) {
        github.createdIssueInputs.push(options);
        return createIssue({
          number: 17,
          title: options.title,
          body: options.body,
          labels: [],
        });
      },
      /** @param {import('../github/types.js').EditLabelsOptions} options */
      async addLabelsToIssue(options) {
        github.labelAdds.push(options);
      },
    });

    const request = {
      title: 'Publish Spec issue support',
      problemStatement: 'PullOps should publish specs through its own Issue Store.',
      solution: 'Add a Spec publish command on top of the GitHub Issue Store path.',
      userStories: [
        {
          number: 8,
          story:
            'As an agent, I want to submit structured Spec fields, so that PullOps can render stable and parseable Spec bodies.',
        },
        {
          number: 1,
          story:
            'As a maintainer, I want PullOps to own Spec publication, so that generated issue bodies stay consistent.',
        },
      ],
      implementationDecisions: [
        'Use the GitHub Issue Store adapter.',
        'Preserve stable user story numbers.',
      ],
      testingDecisions: ['Exercise the publish command through fake GitHub clients.'],
      outOfScope: ['Ticket publication.'],
      furtherNotes: ['This Spec was published from the new issue-store command.'],
      auditDetails: ['Requested by to-spec.', 'Recorded in a Local Run Record.'],
      triageRole: 'ready-for-agent',
    };

    const result = await publishSpecIssue({
      cwd,
      config: {
        issueStore: { provider: 'github' },
      },
      githubClient: github,
      rawRequest: JSON.stringify(request),
      createdAt: new Date('2026-06-20T10:15:00.000Z'),
    });

    assert.deepEqual(result, {
      status: 'accepted',
      summary: 'Created PullOps-published Spec Issue #17.',
      action: 'created',
      issue: {
        number: 17,
        url: 'https://github.test/issues/17',
      },
      warnings: [],
      localRunRecord: join(
        cwd,
        '.pullops',
        'runs',
        '2026-06-20T101500000Z-issues-publish-spec-new',
      ),
      triageRole: 'ready-for-agent',
    });
    assert.equal(github.createdIssueInputs.length, 1);
    assert.equal(github.createdIssueInputs[0].title, request.title);
    assert.equal(github.createdIssueInputs[0].labels, undefined);
    assert.equal(
      github.createdIssueInputs[0].body,
      createSpecIssueBody({
        issueNumber: undefined,
        title: request.title,
        problemStatement: request.problemStatement,
        solution: request.solution,
        userStories: [
          {
            number: 1,
            story:
              'As a maintainer, I want PullOps to own Spec publication, so that generated issue bodies stay consistent.',
          },
          {
            number: 8,
            story:
              'As an agent, I want to submit structured Spec fields, so that PullOps can render stable and parseable Spec bodies.',
          },
        ],
        implementationDecisions: request.implementationDecisions,
        testingDecisions: request.testingDecisions,
        outOfScope: request.outOfScope,
        furtherNotes: request.furtherNotes,
        auditDetails: request.auditDetails,
        triageRole: 'ready-for-agent',
      }),
    );
    assert.deepEqual(github.labelAdds, [
      {
        number: 17,
        labels: ['ready-for-agent'],
      },
    ]);
    assert.deepEqual(
      JSON.parse(await readFile(join(result.localRunRecord, 'request.json'), 'utf8')),
      {
        title: request.title,
        problemStatement: request.problemStatement,
        solution: request.solution,
        userStories: [
          {
            number: 1,
            story:
              'As a maintainer, I want PullOps to own Spec publication, so that generated issue bodies stay consistent.',
          },
          {
            number: 8,
            story:
              'As an agent, I want to submit structured Spec fields, so that PullOps can render stable and parseable Spec bodies.',
          },
        ],
        implementationDecisions: request.implementationDecisions,
        testingDecisions: request.testingDecisions,
        outOfScope: request.outOfScope,
        furtherNotes: request.furtherNotes,
        auditDetails: request.auditDetails,
        triageRole: request.triageRole,
      },
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(result.localRunRecord, 'response.json'), 'utf8')),
      result,
    );
  });

  it('02: updates only PullOps-published issues and removes conflicting triage labels', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-spec-update-'));
    const github = createFakeGitHubClient({
      /** @param {number} number */
      async getIssue(number) {
        assert.equal(number, 41);
        return createIssue({
          number: 41,
          title: 'Old title',
          body: createSpecIssueBody({
            title: 'Old title',
            problemStatement: 'Old problem statement.',
            solution: 'Old solution.',
            userStories: [
              {
                number: 1,
                story:
                  'As a maintainer, I want PullOps to own Spec publication, so that generated issue bodies stay consistent.',
              },
            ],
            implementationDecisions: ['Old decision.'],
            testingDecisions: ['Old test.'],
            outOfScope: ['Old out of scope.'],
            furtherNotes: [],
            auditDetails: [],
          }),
          labels: ['needs-triage', 'ready-for-agent'],
        });
      },
      /** @param {import('../github/types.js').UpdateIssueOptions} options */
      async updateIssue(options) {
        github.updatedIssueInputs.push(options);
        return createIssue({
          number: 41,
          title: options.title,
          body: options.body,
          labels: ['ready-for-human'],
        });
      },
      /** @param {import('../github/types.js').EditLabelsOptions} options */
      async removeLabelsFromIssue(options) {
        github.labelRemovals.push(options);
      },
      /** @param {import('../github/types.js').EditLabelsOptions} options */
      async addLabelsToIssue(options) {
        github.labelAdds.push(options);
      },
    });

    const result = await publishSpecIssue({
      cwd,
      config: {
        issueStore: { provider: 'github' },
      },
      githubClient: github,
      rawRequest: {
        issueNumber: 41,
        title: 'Updated Spec title',
        problemStatement: 'Updated problem statement.',
        solution: 'Updated solution.',
        userStories: [
          {
            number: 1,
            story:
              'As a maintainer, I want PullOps to own Spec publication, so that generated issue bodies stay consistent.',
          },
        ],
        implementationDecisions: ['Updated decision.'],
        testingDecisions: ['Updated test.'],
        outOfScope: ['Updated out of scope.'],
        triageRole: 'ready-for-human',
      },
      createdAt: new Date('2026-06-20T10:15:00.000Z'),
    });

    assert.deepEqual(result, {
      status: 'accepted',
      summary: 'Updated PullOps-published Spec Issue #41.',
      action: 'updated',
      issue: {
        number: 41,
        url: 'https://github.test/issues/41',
      },
      warnings: [],
      localRunRecord: join(cwd, '.pullops', 'runs', '2026-06-20T101500000Z-issues-publish-spec-41'),
      triageRole: 'ready-for-human',
    });
    assert.deepEqual(github.updatedIssueInputs, [
      {
        number: 41,
        title: 'Updated Spec title',
        body: createSpecIssueBody({
          title: 'Updated Spec title',
          problemStatement: 'Updated problem statement.',
          solution: 'Updated solution.',
          userStories: [
            {
              number: 1,
              story:
                'As a maintainer, I want PullOps to own Spec publication, so that generated issue bodies stay consistent.',
            },
          ],
          implementationDecisions: ['Updated decision.'],
          testingDecisions: ['Updated test.'],
          outOfScope: ['Updated out of scope.'],
          furtherNotes: [],
          auditDetails: [],
          triageRole: 'ready-for-human',
        }),
      },
    ]);
    assert.deepEqual(github.labelRemovals, [
      {
        number: 41,
        labels: ['needs-triage', 'ready-for-agent'],
      },
    ]);
    assert.deepEqual(github.labelAdds, [
      {
        number: 41,
        labels: ['ready-for-human'],
      },
    ]);
    assert.deepEqual(
      JSON.parse(await readFile(join(result.localRunRecord, 'response.json'), 'utf8')),
      result,
    );
  });

  it('03: rejects malformed JSON input with a stable failure output and run record artifacts', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-spec-malformed-'));
    const github = createFakeGitHubClient();

    const result = await publishSpecIssue({
      cwd,
      config: {
        issueStore: { provider: 'github' },
      },
      githubClient: github,
      rawRequest: '{"title":"Missing close brace"',
      createdAt: new Date('2026-06-20T10:15:00.000Z'),
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.summary, 'Publish Spec request failed.');
    assert.match(result.failureReason, /Publish request must be valid JSON:/);
    assert.equal(
      result.localRunRecord,
      join(cwd, '.pullops', 'runs', '2026-06-20T101500000Z-issues-publish-spec-invalid'),
    );
    assert.equal(
      await readFile(join(result.localRunRecord, 'request.raw.txt'), 'utf8'),
      '{"title":"Missing close brace"\n',
    );
    assert.equal(
      JSON.parse(await readFile(join(result.localRunRecord, 'response.json'), 'utf8')).status,
      'failed',
    );
    assert.equal(
      await readFile(join(result.localRunRecord, 'failure-reason.txt'), 'utf8').then(text =>
        text.trim(),
      ),
      result.failureReason,
    );
  });

  it('04: rejects conflicting Spec fields with a stable failure output and run record artifacts', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-spec-conflict-'));
    const github = createFakeGitHubClient();

    const result = await publishSpecIssue({
      cwd,
      config: {
        issueStore: { provider: 'github' },
      },
      githubClient: github,
      rawRequest: {
        title: 'Top level title',
        request: {
          title: 'Conflicting title',
          problemStatement: 'PullOps should publish specs through its own Issue Store.',
          solution: 'Add a Spec publish command on top of the GitHub Issue Store path.',
          userStories: [
            {
              number: 1,
              story:
                'As a maintainer, I want PullOps to own Spec publication, so that generated issue bodies stay consistent.',
            },
          ],
          implementationDecisions: ['Use the GitHub Issue Store adapter.'],
          testingDecisions: ['Exercise the publish command through fake GitHub clients.'],
          outOfScope: ['Ticket publication.'],
        },
      },
      createdAt: new Date('2026-06-20T10:15:00.000Z'),
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.summary, 'Publish Spec request failed.');
    assert.match(result.failureReason, /Request\.title values conflict\./);
    assert.equal(
      result.localRunRecord,
      join(cwd, '.pullops', 'runs', '2026-06-20T101500000Z-issues-publish-spec-invalid'),
    );
    assert.equal(
      JSON.parse(await readFile(join(result.localRunRecord, 'response.json'), 'utf8')).status,
      'failed',
    );
    assert.equal(github.updatedIssueInputs.length, 0);
  });

  it('05: refuses to update unmarked manual issues', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-spec-unmarked-'));
    const github = createFakeGitHubClient({
      /** @param {number} number */
      async getIssue(number) {
        assert.equal(number, 88);
        return createIssue({
          number: 88,
          title: 'Manual issue',
          body: '## Problem Statement\n\nDo the thing.',
          labels: [],
        });
      },
    });

    const result = await publishSpecIssue({
      cwd,
      config: {
        issueStore: { provider: 'github' },
      },
      githubClient: github,
      rawRequest: {
        issueNumber: 88,
        title: 'Manual issue',
        problemStatement: 'Do the thing.',
        solution: 'Do the thing in Spec form.',
        userStories: [
          {
            number: 1,
            story:
              'As a maintainer, I want PullOps to own Spec publication, so that generated issue bodies stay consistent.',
          },
        ],
        implementationDecisions: ['Use the GitHub Issue Store adapter.'],
        testingDecisions: ['Exercise the publish command through fake GitHub clients.'],
        outOfScope: ['Ticket publication.'],
      },
      createdAt: new Date('2026-06-20T10:15:00.000Z'),
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.summary, 'Refused to update Spec issue #88.');
    assert.match(result.failureReason, /not marked as a PullOps-published issue/);
    assert.equal(github.updatedIssueInputs.length, 0);
    assert.equal(
      JSON.parse(await readFile(join(result.localRunRecord, 'response.json'), 'utf8')).status,
      'failed',
    );
  });
});

/**
 * @param {Partial<import('../github/types.js').GitHubIssue>} [overrides]
 * @returns {import('../github/types.js').GitHubIssue}
 */
function createIssue(overrides = {}) {
  const number = overrides.number ?? 1;
  return {
    number,
    title: 'Issue title',
    body: '## Problem Statement\n\nDo the thing.',
    state: 'OPEN',
    url: `https://github.test/issues/${number}`,
    authorLogin: 'octocat',
    labels: [],
    parent: null,
    subIssues: [],
    ...overrides,
  };
}

/**
 * @param {Partial<import('../github/types.js').GitHubClient>} overrides
 * @returns {import('../github/types.js').GitHubClient & {
 *   createdIssueInputs: import('../github/types.js').CreateIssueOptions[],
 *   updatedIssueInputs: import('../github/types.js').UpdateIssueOptions[],
 *   labelAdds: import('../github/types.js').EditLabelsOptions[],
 *   labelRemovals: import('../github/types.js').EditLabelsOptions[],
 * }}
 */
function createFakeGitHubClient(overrides = {}) {
  return {
    createdIssueInputs: [],
    updatedIssueInputs: [],
    labelAdds: [],
    labelRemovals: [],
    async createIssue() {
      throw new Error('createIssue was not expected in this test.');
    },
    async updateIssue() {
      throw new Error('updateIssue was not expected in this test.');
    },
    async getIssue() {
      throw new Error('getIssue was not expected in this test.');
    },
    async addLabelsToIssue() {
      throw new Error('addLabelsToIssue was not expected in this test.');
    },
    async removeLabelsFromIssue() {
      throw new Error('removeLabelsFromIssue was not expected in this test.');
    },
    async ensureLabels() {
      return { created: [], updated: [], alreadyCorrect: [] };
    },
    async getPullRequest() {
      throw new Error('getPullRequest was not expected in this test.');
    },
    async getPullRequestChecks() {
      throw new Error('getPullRequestChecks was not expected in this test.');
    },
    async getPullRequestChecksForRef() {
      throw new Error('getPullRequestChecksForRef was not expected in this test.');
    },
    async getPullRequestReviewContext() {
      throw new Error('getPullRequestReviewContext was not expected in this test.');
    },
    async getPullRequestDiff() {
      throw new Error('getPullRequestDiff was not expected in this test.');
    },
    async findOpenPullRequestByHead() {
      throw new Error('findOpenPullRequestByHead was not expected in this test.');
    },
    async createDraftPullRequest() {
      throw new Error('createDraftPullRequest was not expected in this test.');
    },
    async removeLabelsFromPullRequest() {
      throw new Error('removeLabelsFromPullRequest was not expected in this test.');
    },
    async addLabelsToPullRequest() {
      throw new Error('addLabelsToPullRequest was not expected in this test.');
    },
    async commentOnIssue() {
      throw new Error('commentOnIssue was not expected in this test.');
    },
    async closeIssue() {
      throw new Error('closeIssue was not expected in this test.');
    },
    async commentOnPullRequest() {
      throw new Error('commentOnPullRequest was not expected in this test.');
    },
    async updatePullRequestBody() {
      throw new Error('updatePullRequestBody was not expected in this test.');
    },
    async markPullRequestReadyForReview() {
      throw new Error('markPullRequestReadyForReview was not expected in this test.');
    },
    async publishPullRequestReview() {
      throw new Error('publishPullRequestReview was not expected in this test.');
    },
    async replyToPullRequestReviewComment() {
      throw new Error('replyToPullRequestReviewComment was not expected in this test.');
    },
    async resolvePullRequestReviewThread() {
      throw new Error('resolvePullRequestReviewThread was not expected in this test.');
    },
    ...overrides,
  };
}
