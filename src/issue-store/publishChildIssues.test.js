import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createChildIssueBody } from './childIssueBody.js';
import { createPrdIssueBody } from './prdIssueBody.js';
import { publishChildIssues } from './publishChildIssues.js';

describe('publishChildIssues', () => {
  it('01: creates child issues as native sub-issues with warnings, labels, mappings, and artifacts', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-children-create-'));
    const github = createFakeGitHubClient({
      /** @param {number} number */
      async getIssue(number) {
        assert.equal(number, 126);
        return createIssue({
          number: 126,
          title: 'Manual parent PRD',
          body: '## Problem Statement\n\nManual parent.',
          labels: [],
        });
      },
      /** @param {import('../github/types.js').CreateIssueOptions} options */
      async createIssue(options) {
        github.createdIssueInputs.push(options);
        const number = 200 + github.createdIssueInputs.length;
        return createIssue({
          number,
          title: options.title,
          body: options.body,
          labels: number === 201 ? ['needs-triage'] : [],
        });
      },
      /** @param {import('../github/types.js').AddSubIssueOptions} options */
      async addSubIssue(options) {
        github.subIssueAdds.push(options);
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

    const request = {
      parentIssueNumber: 126,
      children: [
        {
          sliceRef: '1',
          title: 'Publish feature child',
          whatToBuild: 'Implement the first user-facing slice.',
          acceptanceCriteria: ['Creates the feature path.'],
          blockedBy: [44],
          coveredUserStories: [10, 2],
          triageRole: 'ready-for-agent',
        },
        {
          sliceRef: 'support-a',
          title: 'Prepare child issue support',
          whatToBuild: 'Add supporting test fixtures.',
          acceptanceCriteria: ['Support fixtures are available.'],
          supportWork: true,
        },
      ],
    };

    const result = await publishChildIssues({
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
      summary: 'Published 2 Child Issues under Parent Issue #126.',
      action: 'created',
      parent: {
        number: 126,
        url: 'https://github.test/issues/126',
      },
      children: [
        {
          sliceRef: '1',
          action: 'created',
          issue: {
            number: 201,
            url: 'https://github.test/issues/201',
          },
          blockedBy: [44],
          triageRole: 'ready-for-agent',
        },
        {
          sliceRef: 'support-a',
          action: 'created',
          issue: {
            number: 202,
            url: 'https://github.test/issues/202',
          },
          blockedBy: [],
        },
      ],
      mappings: [
        {
          sliceRef: '1',
          issueNumber: 201,
          issueUrl: 'https://github.test/issues/201',
        },
        {
          sliceRef: 'support-a',
          issueNumber: 202,
          issueUrl: 'https://github.test/issues/202',
        },
      ],
      warnings: [
        {
          code: 'parent-missing-pullops-prd-marker',
          message: 'Parent Issue #126 is open but is not marked as a PullOps-published PRD Issue.',
        },
      ],
      localRunRecord: join(
        cwd,
        '.pullops',
        'runs',
        '2026-06-20T101500000Z-issues-publish-children-126',
      ),
    });
    assert.equal(github.createdIssueInputs.length, 2);
    assert.equal(github.createdIssueInputs[0].title, 'Publish feature child');
    assert.equal(github.createdIssueInputs[0].labels, undefined);
    assert.match(github.createdIssueInputs[0].body, /^<!-- PullOps publication marker:/m);
    assert.match(github.createdIssueInputs[0].body, /"kind":"child-issue"/);
    assert.match(github.createdIssueInputs[0].body, /"sliceRef":"1"/);
    assert.match(github.createdIssueInputs[0].body, /^## What to build$/m);
    assert.match(github.createdIssueInputs[0].body, /^## Acceptance criteria$/m);
    assert.match(github.createdIssueInputs[0].body, /^## Blocked by$/m);
    assert.match(github.createdIssueInputs[0].body, /- #44/);
    assert.match(github.createdIssueInputs[0].body, /^## Covered PRD user stories$/m);
    assert.match(github.createdIssueInputs[0].body, /- 2/);
    assert.match(github.createdIssueInputs[0].body, /- 10/);
    assert.match(github.createdIssueInputs[1].body, /^## Support work$/m);
    assert.match(github.createdIssueInputs[1].body, /explicitly marked as support work/);
    assert.match(github.createdIssueInputs[1].body, /^## Blocked by$/m);
    assert.match(github.createdIssueInputs[1].body, /- None\./);
    assert.deepEqual(github.subIssueAdds, [
      { parentIssueNumber: 126, childIssueNumber: 201 },
      { parentIssueNumber: 126, childIssueNumber: 202 },
    ]);
    assert.deepEqual(github.labelRemovals, [{ number: 201, labels: ['needs-triage'] }]);
    assert.deepEqual(github.labelAdds, [{ number: 201, labels: ['ready-for-agent'] }]);
    assert.deepEqual(
      JSON.parse(await readFile(join(result.localRunRecord, 'request.json'), 'utf8')),
      {
        parentIssueNumber: 126,
        children: [
          {
            sliceRef: '1',
            title: 'Publish feature child',
            whatToBuild: 'Implement the first user-facing slice.',
            acceptanceCriteria: ['Creates the feature path.'],
            blockedBy: [44],
            blockedBySliceRefs: [],
            coveredUserStories: [2, 10],
            supportWork: false,
            triageRole: 'ready-for-agent',
          },
          {
            sliceRef: 'support-a',
            title: 'Prepare child issue support',
            whatToBuild: 'Add supporting test fixtures.',
            acceptanceCriteria: ['Support fixtures are available.'],
            blockedBy: [],
            blockedBySliceRefs: [],
            coveredUserStories: [],
            supportWork: true,
          },
        ],
        forceUpdate: false,
      },
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(result.localRunRecord, 'response.json'), 'utf8')),
      result,
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(result.localRunRecord, 'warnings.json'), 'utf8')),
      result.warnings,
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(result.localRunRecord, 'failures.json'), 'utf8')),
      [],
    );
  });

  it('02: accepts a marked PullOps PRD parent without warning', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-children-marked-parent-'));
    const github = createFakeGitHubClient({
      /** @param {number} number */
      async getIssue(number) {
        return createIssue({
          number,
          body: createPrdIssueBody({
            title: 'Published parent',
            problemStatement: 'Parent problem.',
            solution: 'Parent solution.',
            userStories: [{ number: 1, story: 'As a user, I want the parent.' }],
            implementationDecisions: ['Use PullOps.'],
            testingDecisions: ['Use tests.'],
            outOfScope: ['Unrelated work.'],
            furtherNotes: [],
            auditDetails: [],
          }),
        });
      },
      /** @param {import('../github/types.js').CreateIssueOptions} options */
      async createIssue(options) {
        return createIssue({
          number: 201,
          title: options.title,
          body: options.body,
        });
      },
      async addSubIssue() {},
    });

    const result = await publishChildIssues({
      cwd,
      config: { issueStore: { provider: 'github' } },
      githubClient: github,
      parentIssueNumber: 126,
      rawRequest: {
        children: [
          {
            sliceRef: '1',
            title: 'Publish child',
            whatToBuild: 'Do child work.',
            acceptanceCriteria: ['Child work is done.'],
            coveredUserStories: [1],
          },
        ],
      },
      createdAt: new Date('2026-06-20T10:15:00.000Z'),
    });

    assert.equal(result.status, 'accepted');
    assert.deepEqual(result.warnings, []);
  });

  it('03: rejects conflicting parent values before creating issues', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-children-parent-conflict-'));
    const github = createFakeGitHubClient();

    const result = await publishChildIssues({
      cwd,
      config: { issueStore: { provider: 'github' } },
      githubClient: github,
      parentIssueNumber: 126,
      rawRequest: {
        parentIssueNumber: 127,
        children: [
          {
            sliceRef: '1',
            title: 'Publish child',
            whatToBuild: 'Do child work.',
            acceptanceCriteria: ['Child work is done.'],
            coveredUserStories: [1],
          },
        ],
      },
      createdAt: new Date('2026-06-20T10:15:00.000Z'),
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.summary, 'Publish Child Issue batch failed.');
    assert.match(result.failureReason, /Request.parentIssueNumber values conflict/);
    assert.equal(github.createdIssueInputs.length, 0);
    assert.equal(
      result.localRunRecord,
      join(cwd, '.pullops', 'runs', '2026-06-20T101500000Z-issues-publish-children-invalid'),
    );
  });

  it('04: rejects feature child issues without covered PRD user stories', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-children-story-required-'));
    const github = createFakeGitHubClient();

    const result = await publishChildIssues({
      cwd,
      config: { issueStore: { provider: 'github' } },
      githubClient: github,
      rawRequest: {
        parentIssueNumber: 126,
        children: [
          {
            sliceRef: '1',
            title: 'Publish child',
            whatToBuild: 'Do child work.',
            acceptanceCriteria: ['Child work is done.'],
          },
        ],
      },
      createdAt: new Date('2026-06-20T10:15:00.000Z'),
    });

    assert.equal(result.status, 'failed');
    assert.match(
      result.failureReason,
      /Request.children\[0\] must include covered PRD user story numbers or supportWork: true/,
    );
    assert.equal(github.createdIssueInputs.length, 0);
  });

  it('05: rejects closed or child Parent Issues', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-children-invalid-parent-'));
    const github = createFakeGitHubClient({
      /** @param {number} number */
      async getIssue(number) {
        return createIssue({
          number,
          state: 'CLOSED',
        });
      },
    });

    const result = await publishChildIssues({
      cwd,
      config: { issueStore: { provider: 'github' } },
      githubClient: github,
      rawRequest: {
        parentIssueNumber: 126,
        children: [
          {
            sliceRef: '1',
            title: 'Publish child',
            whatToBuild: 'Do child work.',
            acceptanceCriteria: ['Child work is done.'],
            coveredUserStories: [1],
          },
        ],
      },
      createdAt: new Date('2026-06-20T10:15:00.000Z'),
    });

    assert.equal(result.status, 'failed');
    assert.match(result.failureReason, /Parent Issue #126 must be open/);
    assert.equal(github.createdIssueInputs.length, 0);
  });

  it('06: resolves earlier slice refs to GitHub issue numbers in blocked-by bodies and output', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-children-dependencies-'));
    const github = createFakeGitHubClient({
      /** @param {number} number */
      async getIssue(number) {
        return createIssue({
          number,
          title: 'Parent PRD',
          body: createPrdIssueBody({
            title: 'Published parent',
            problemStatement: 'Parent problem.',
            solution: 'Parent solution.',
            userStories: [{ number: 23, story: 'As an agent, I can publish dependencies.' }],
            implementationDecisions: ['Use native sub-issues.'],
            testingDecisions: ['Use focused tests.'],
            outOfScope: ['Unrelated publication.'],
            furtherNotes: [],
            auditDetails: [],
          }),
        });
      },
      /** @param {import('../github/types.js').CreateIssueOptions} options */
      async createIssue(options) {
        github.createdIssueInputs.push(options);
        const number = 200 + github.createdIssueInputs.length;
        return createIssue({
          number,
          title: options.title,
          body: options.body,
        });
      },
      /** @param {import('../github/types.js').AddSubIssueOptions} options */
      async addSubIssue(options) {
        github.subIssueAdds.push(options);
      },
    });

    const result = await publishChildIssues({
      cwd,
      config: { issueStore: { provider: 'github' } },
      githubClient: github,
      rawRequest: {
        parentIssueNumber: 126,
        children: [
          {
            sliceRef: 'base',
            title: 'Base slice',
            whatToBuild: 'Build the first dependency.',
            acceptanceCriteria: ['Base exists.'],
            coveredUserStories: [23],
          },
          {
            sliceRef: 'dependent',
            title: 'Dependent slice',
            whatToBuild: 'Build on the first dependency.',
            acceptanceCriteria: ['Dependent exists.'],
            blockedBy: ['base', 44],
            coveredUserStories: [24],
          },
        ],
      },
      createdAt: new Date('2026-06-20T10:15:00.000Z'),
    });

    assert.equal(result.status, 'accepted');
    assert.equal(github.createdIssueInputs.length, 2);
    assert.match(github.createdIssueInputs[1].body, /^## Blocked by$/m);
    assert.match(github.createdIssueInputs[1].body, /- #201/);
    assert.match(github.createdIssueInputs[1].body, /- #44/);
    assert.doesNotMatch(github.createdIssueInputs[1].body, /base/);
    assert.deepEqual(
      result.children.map(child => [child.sliceRef, child.blockedBy]),
      [
        ['base', []],
        ['dependent', [201, 44]],
      ],
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(result.localRunRecord, 'request.json'), 'utf8')).children[1],
      {
        sliceRef: 'dependent',
        title: 'Dependent slice',
        whatToBuild: 'Build on the first dependency.',
        acceptanceCriteria: ['Dependent exists.'],
        blockedBy: [44],
        blockedBySliceRefs: ['base'],
        coveredUserStories: [24],
        supportWork: false,
      },
    );
  });

  it('07: force-updates existing marker-owned children by parent and slice ref on rerun', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-children-rerun-'));
    /** @type {import('../github/types.js').UpdateIssueOptions[]} */
    const updates = [];
    const existingChild = createIssue({
      number: 201,
      title: 'Old title',
      body: createChildIssueBody({
        parentIssueNumber: 126,
        sliceRef: '1',
        title: 'Old title',
        whatToBuild: 'Old work.',
        acceptanceCriteria: ['Old criteria.'],
        blockedBy: [],
        blockedBySliceRefs: [],
        coveredUserStories: [23],
        supportWork: false,
      }),
      parent: {
        number: 126,
        title: 'Parent',
        url: 'https://github.test/issues/126',
        state: 'OPEN',
        relationshipSource: 'native',
      },
    });
    const github = createFakeGitHubClient({
      /** @param {number} number */
      async getIssue(number) {
        if (number === 126) {
          return createIssue({
            number,
            subIssues: [
              {
                number: 201,
                title: 'Old title',
                url: 'https://github.test/issues/201',
                state: 'OPEN',
                relationshipSource: 'native',
              },
            ],
          });
        }
        assert.equal(number, 201);
        return existingChild;
      },
      /** @param {import('../github/types.js').UpdateIssueOptions} options */
      async updateIssue(options) {
        updates.push(options);
        return createIssue({
          ...existingChild,
          title: options.title,
          body: options.body,
        });
      },
    });

    const result = await publishChildIssues({
      cwd,
      config: { issueStore: { provider: 'github' } },
      githubClient: github,
      rawRequest: {
        parentIssueNumber: 126,
        forceUpdate: true,
        children: [
          {
            sliceRef: '1',
            title: 'Updated child',
            whatToBuild: 'Updated child work.',
            acceptanceCriteria: ['Updated criteria.'],
            coveredUserStories: [23],
          },
        ],
      },
      createdAt: new Date('2026-06-20T10:15:00.000Z'),
    });

    assert.equal(result.status, 'accepted');
    assert.equal(github.createdIssueInputs.length, 0);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].number, 201);
    assert.equal(updates[0].title, 'Updated child');
    assert.match(updates[0].body, /Updated child work/);
    assert.deepEqual(result.children, [
      {
        sliceRef: '1',
        action: 'updated',
        issue: {
          number: 201,
          url: 'https://github.test/issues/201',
        },
        blockedBy: [],
      },
    ]);
  });

  it('08: reports partial failures with created updated and failed slice details and artifacts', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-children-partial-'));
    const existingChild = createIssue({
      number: 201,
      title: 'Existing child',
      body: createChildIssueBody({
        parentIssueNumber: 126,
        sliceRef: 'existing',
        title: 'Existing child',
        whatToBuild: 'Old work.',
        acceptanceCriteria: ['Old criteria.'],
        blockedBy: [],
        blockedBySliceRefs: [],
        coveredUserStories: [25],
        supportWork: false,
      }),
      parent: {
        number: 126,
        title: 'Parent',
        url: 'https://github.test/issues/126',
        state: 'OPEN',
        relationshipSource: 'native',
      },
    });
    const github = createFakeGitHubClient({
      /** @param {number} number */
      async getIssue(number) {
        if (number === 126) {
          return createIssue({
            number,
            subIssues: [
              {
                number: 201,
                title: 'Existing child',
                url: 'https://github.test/issues/201',
                state: 'OPEN',
                relationshipSource: 'native',
              },
            ],
          });
        }
        assert.equal(number, 201);
        return existingChild;
      },
      /** @param {import('../github/types.js').UpdateIssueOptions} options */
      async updateIssue(options) {
        return createIssue({ ...existingChild, title: options.title, body: options.body });
      },
      /** @param {import('../github/types.js').CreateIssueOptions} options */
      async createIssue(options) {
        if (options.title === 'Broken child') {
          throw new Error('GitHub refused this child.');
        }
        const issue = createIssue({
          number: 202,
          title: options.title,
          body: options.body,
        });
        github.createdIssueInputs.push(options);
        return issue;
      },
      /** @param {import('../github/types.js').AddSubIssueOptions} options */
      async addSubIssue(options) {
        github.subIssueAdds.push(options);
      },
    });

    const result = await publishChildIssues({
      cwd,
      config: { issueStore: { provider: 'github' } },
      githubClient: github,
      rawRequest: {
        parentIssueNumber: 126,
        forceUpdate: true,
        children: [
          {
            sliceRef: 'existing',
            title: 'Updated existing child',
            whatToBuild: 'Updated work.',
            acceptanceCriteria: ['Updated criteria.'],
            coveredUserStories: [25],
          },
          {
            sliceRef: 'new',
            title: 'New child',
            whatToBuild: 'New work.',
            acceptanceCriteria: ['New criteria.'],
            coveredUserStories: [26],
          },
          {
            sliceRef: 'broken',
            title: 'Broken child',
            whatToBuild: 'Broken work.',
            acceptanceCriteria: ['Broken criteria.'],
            coveredUserStories: [27],
          },
        ],
      },
      createdAt: new Date('2026-06-20T10:15:00.000Z'),
    });

    assert.equal(result.status, 'failed');
    assert.match(result.summary, /Published 2 Child Issues under Parent Issue #126/);
    assert.deepEqual(
      result.children?.map(child => [child.sliceRef, child.action]),
      [
        ['existing', 'updated'],
        ['new', 'created'],
      ],
    );
    assert.deepEqual(result.failedChildren, [
      {
        sliceRef: 'broken',
        failureReason: 'GitHub refused this child.',
      },
    ]);
    assert.deepEqual(
      JSON.parse(await readFile(join(result.localRunRecord, 'response.json'), 'utf8')),
      result,
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(result.localRunRecord, 'failures.json'), 'utf8')),
      result.failedChildren,
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(result.localRunRecord, 'warnings.json'), 'utf8')),
      result.warnings,
    );
  });

  it('09: explicit issue number overrides repair unattached marker-owned children safely', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-children-override-'));
    /** @type {import('../github/types.js').UpdateIssueOptions[]} */
    const updates = [];
    const overrideChild = createIssue({
      number: 201,
      title: 'Unattached child',
      body: createChildIssueBody({
        parentIssueNumber: 126,
        sliceRef: 'repair',
        title: 'Unattached child',
        whatToBuild: 'Old repair work.',
        acceptanceCriteria: ['Old repair criteria.'],
        blockedBy: [],
        blockedBySliceRefs: [],
        coveredUserStories: [30],
        supportWork: false,
      }),
      parent: null,
    });
    const github = createFakeGitHubClient({
      /** @param {number} number */
      async getIssue(number) {
        if (number === 126) {
          return createIssue({ number, subIssues: [] });
        }
        assert.equal(number, 201);
        return overrideChild;
      },
      /** @param {import('../github/types.js').UpdateIssueOptions} options */
      async updateIssue(options) {
        updates.push(options);
        return createIssue({
          ...overrideChild,
          title: options.title,
          body: options.body,
        });
      },
      /** @param {import('../github/types.js').AddSubIssueOptions} options */
      async addSubIssue(options) {
        github.subIssueAdds.push(options);
      },
    });

    const result = await publishChildIssues({
      cwd,
      config: { issueStore: { provider: 'github' } },
      githubClient: github,
      rawRequest: {
        parentIssueNumber: 126,
        children: [
          {
            sliceRef: 'repair',
            issueNumber: 201,
            title: 'Repaired child',
            whatToBuild: 'Repair publication.',
            acceptanceCriteria: ['Repair is published.'],
            coveredUserStories: [30],
          },
        ],
      },
      createdAt: new Date('2026-06-20T10:15:00.000Z'),
    });

    assert.equal(result.status, 'accepted');
    assert.equal(updates.length, 1);
    assert.deepEqual(github.subIssueAdds, [{ parentIssueNumber: 126, childIssueNumber: 201 }]);
    assert.equal(result.children[0].action, 'updated');
  });

  it('10: refuses force updates when the explicit issue override is not marker-owned', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-children-override-safety-'));
    const github = createFakeGitHubClient({
      /** @param {number} number */
      async getIssue(number) {
        if (number === 126) {
          return createIssue({ number, subIssues: [] });
        }
        assert.equal(number, 201);
        return createIssue({
          number,
          body: '## What to build\n\nA manually authored issue.',
        });
      },
    });

    const result = await publishChildIssues({
      cwd,
      config: { issueStore: { provider: 'github' } },
      githubClient: github,
      rawRequest: {
        parentIssueNumber: 126,
        forceUpdate: true,
        children: [
          {
            sliceRef: 'repair',
            issueNumber: 201,
            title: 'Repaired child',
            whatToBuild: 'Repair publication.',
            acceptanceCriteria: ['Repair is published.'],
            coveredUserStories: [30],
          },
        ],
      },
      createdAt: new Date('2026-06-20T10:15:00.000Z'),
    });

    assert.equal(result.status, 'failed');
    assert.match(
      result.failedChildren?.[0].failureReason ?? '',
      /Issue #201 is not marked as a PullOps-published Child Issue/,
    );
    assert.equal(github.createdIssueInputs.length, 0);
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
 *   subIssueAdds: import('../github/types.js').AddSubIssueOptions[],
 *   labelAdds: import('../github/types.js').EditLabelsOptions[],
 *   labelRemovals: import('../github/types.js').EditLabelsOptions[],
 * }}
 */
function createFakeGitHubClient(overrides = {}) {
  return {
    createdIssueInputs: [],
    subIssueAdds: [],
    labelAdds: [],
    labelRemovals: [],
    async createIssue() {
      throw new Error('createIssue was not expected in this test.');
    },
    async updateIssue() {
      throw new Error('updateIssue was not expected in this test.');
    },
    async addSubIssue() {
      throw new Error('addSubIssue was not expected in this test.');
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
