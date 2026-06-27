import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { publishConcreteIssue } from './publishConcreteIssue.js';

describe('publishConcreteIssue', () => {
  it('01: creates a PullOps-published concrete issue with a triage role and run record artifacts', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-concrete-create-'));
    const github = createFakeGitHubClient({
      async createIssue(options) {
        github.createdIssueInputs.push(options);
        return createIssue({
          number: 17,
          title: options.title,
          body: options.body,
          labels: [],
        });
      },
      async addLabelsToIssue(options) {
        github.labelAdds.push(options);
      },
    });

    const result = await publishConcreteIssue({
      cwd,
      config: {
        issueStore: { provider: 'github' },
      },
      githubClient: github,
      rawRequest: JSON.stringify({
        title: 'Publish concrete issue support',
        whatToBuild: 'Add a standalone publish-issue command.',
        acceptanceCriteria: ['Command accepts structured JSON.', 'Command writes a run record.'],
        blockedBy: [12, 34],
        auditDetails: [
          'Source review: [Escalation Review Cycle on PR #100](https://github.test/pulls/100)',
        ],
        triageRole: 'ready-for-agent',
      }),
      createdAt: new Date('2026-06-20T10:15:00.000Z'),
    });

    assert.deepEqual(result, {
      status: 'accepted',
      summary: 'Created PullOps-published Concrete Issue #17.',
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
        '2026-06-20T101500000Z-issues-publish-issue-new',
      ),
      triageRole: 'ready-for-agent',
    });
    assert.equal(github.createdIssueInputs.length, 1);
    assert.match(github.createdIssueInputs[0].body, /^<!-- PullOps publication marker:/m);
    assert.match(github.createdIssueInputs[0].body, /^## What to build$/m);
    assert.match(github.createdIssueInputs[0].body, /^## Acceptance criteria$/m);
    assert.match(github.createdIssueInputs[0].body, /- #12/);
    assert.match(github.createdIssueInputs[0].body, /- #34/);
    assert.match(
      github.createdIssueInputs[0].body,
      /<summary>PullOps publication audit<\/summary>/,
    );
    assert.match(
      github.createdIssueInputs[0].body,
      /- Source review: \[Escalation Review Cycle on PR #100\]\(https:\/\/github\.test\/pulls\/100\)/,
    );
    assert.deepEqual(github.labelAdds, [
      {
        number: 17,
        labels: ['ready-for-agent'],
      },
    ]);
    assert.equal(
      await readFile(join(result.localRunRecord, 'request.json'), 'utf8')
        .then(JSON.parse)
        .then(value => value.title),
      'Publish concrete issue support',
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(result.localRunRecord, 'response.json'), 'utf8')),
      result,
    );
  });

  it('02: updates only PullOps-published issues and removes conflicting triage labels', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-concrete-update-'));
    const github = createFakeGitHubClient({
      async getIssue(number) {
        assert.equal(number, 41);
        return createIssue({
          number: 41,
          title: 'Old title',
          body: [
            '<!-- PullOps publication marker: {"schemaVersion":1,"provider":"github","kind":"concrete-issue"} -->',
            '',
            '## What to build',
            '',
            'Old body.',
            '',
            '## Acceptance criteria',
            '',
            '- Old criterion.',
          ].join('\n'),
          labels: ['needs-triage', 'ready-for-agent'],
        });
      },
      async updateIssue(options) {
        github.updatedIssueInputs.push(options);
        return createIssue({
          number: 41,
          title: options.title,
          body: options.body,
          labels: ['ready-for-human'],
        });
      },
      async removeLabelsFromIssue(options) {
        github.labelRemovals.push(options);
      },
      async addLabelsToIssue(options) {
        github.labelAdds.push(options);
      },
    });

    const result = await publishConcreteIssue({
      cwd,
      config: {
        issueStore: { provider: 'github' },
      },
      githubClient: github,
      rawRequest: {
        issueNumber: 41,
        title: 'Updated title',
        whatToBuild: 'Updated body.',
        acceptanceCriteria: ['Updated criterion.'],
        blockedBy: [],
        auditDetails: [],
        triageRole: 'ready-for-human',
      },
      createdAt: new Date('2026-06-20T10:15:00.000Z'),
    });

    assert.deepEqual(result, {
      status: 'accepted',
      summary: 'Updated PullOps-published Concrete Issue #41.',
      action: 'updated',
      issue: {
        number: 41,
        url: 'https://github.test/issues/41',
      },
      warnings: [],
      localRunRecord: join(
        cwd,
        '.pullops',
        'runs',
        '2026-06-20T101500000Z-issues-publish-issue-41',
      ),
      triageRole: 'ready-for-human',
    });
    assert.deepEqual(github.updatedIssueInputs, [
      {
        number: 41,
        title: 'Updated title',
        body: expectConcreteIssueBody('Updated body.', ['Updated criterion.'], []),
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
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-concrete-malformed-'));
    const github = createFakeGitHubClient();

    const result = await publishConcreteIssue({
      cwd,
      config: {
        issueStore: { provider: 'github' },
      },
      githubClient: github,
      rawRequest: '{"title":"Missing close brace"',
      createdAt: new Date('2026-06-20T10:15:00.000Z'),
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.summary, 'Publish issue request failed.');
    assert.match(result.failureReason, /Publish request must be valid JSON:/);
    assert.equal(
      result.localRunRecord,
      join(cwd, '.pullops', 'runs', '2026-06-20T101500000Z-issues-publish-issue-invalid'),
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

  it('04: refuses to update unmarked manual issues', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-concrete-unmarked-'));
    const github = createFakeGitHubClient({
      async getIssue(number) {
        assert.equal(number, 88);
        return createIssue({
          number: 88,
          title: 'Manual issue',
          body: '## What to build\n\nDo the thing.',
          labels: [],
        });
      },
    });

    const result = await publishConcreteIssue({
      cwd,
      config: {
        issueStore: { provider: 'github' },
      },
      githubClient: github,
      rawRequest: {
        issueNumber: 88,
        title: 'Manual issue',
        whatToBuild: 'Do the thing.',
        acceptanceCriteria: ['Do the thing.'],
        blockedBy: [],
      },
      createdAt: new Date('2026-06-20T10:15:00.000Z'),
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.summary, 'Refused to update issue #88.');
    assert.match(result.failureReason, /not marked as a PullOps-published issue/);
    assert.equal(github.updatedIssueInputs.length, 0);
    assert.equal(
      JSON.parse(await readFile(join(result.localRunRecord, 'response.json'), 'utf8')).status,
      'failed',
    );
  });

  it('05: returns a partial failure with the created issue when triage-label sync fails after creation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-concrete-partial-failure-'));
    const github = createFakeGitHubClient({
      async createIssue(options) {
        github.createdIssueInputs.push(options);
        return createIssue({
          number: 23,
          title: options.title,
          body: options.body,
          labels: [],
        });
      },
      async addLabelsToIssue(options) {
        github.labelAdds.push(options);
        throw new Error('Triage label sync failed.');
      },
    });

    const result = await publishConcreteIssue({
      cwd,
      config: {
        issueStore: { provider: 'github' },
      },
      githubClient: github,
      rawRequest: {
        title: 'Publish concrete issue support',
        whatToBuild: 'Add a standalone publish-issue command.',
        acceptanceCriteria: ['Command accepts structured JSON.'],
        blockedBy: [],
        triageRole: 'needs-triage',
      },
      createdAt: new Date('2026-06-20T10:15:00.000Z'),
    });

    assert.deepEqual(result, {
      status: 'failed',
      summary: 'Created PullOps-published Concrete Issue #23, but publication failed.',
      failureReason: 'Triage label sync failed.',
      warnings: [],
      localRunRecord: join(
        cwd,
        '.pullops',
        'runs',
        '2026-06-20T101500000Z-issues-publish-issue-new',
      ),
      issue: {
        number: 23,
        url: 'https://github.test/issues/23',
      },
      action: 'created',
      triageRole: 'needs-triage',
    });
    assert.deepEqual(github.labelAdds, [
      {
        number: 23,
        labels: ['needs-triage'],
      },
    ]);
    assert.deepEqual(
      JSON.parse(await readFile(join(result.localRunRecord, 'response.json'), 'utf8')),
      result,
    );
  });
});

/**
 * @param {string} whatToBuild
 * @param {string[]} acceptanceCriteria
 * @param {number[]} blockedBy
 * @returns {string}
 */
function expectConcreteIssueBody(whatToBuild, acceptanceCriteria, blockedBy) {
  return [
    '<!-- PullOps publication marker: {"schemaVersion":1,"provider":"github","kind":"concrete-issue"} -->',
    '',
    '## What to build',
    '',
    whatToBuild,
    '',
    '## Acceptance criteria',
    '',
    ...acceptanceCriteria.map(criterion => `- ${criterion}`),
    ...(blockedBy.length > 0
      ? ['', '## Blocked by', '', ...blockedBy.map(number => `- #${number}`)]
      : []),
    '',
  ].join('\n');
}

/**
 * @param {Partial<import('../github/types.js').GitHubIssue>} [overrides]
 * @returns {import('../github/types.js').GitHubIssue}
 */
function createIssue(overrides = {}) {
  const number = overrides.number ?? 1;
  return {
    number,
    title: 'Issue title',
    body: '## What to build\n\nDo the thing.',
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
