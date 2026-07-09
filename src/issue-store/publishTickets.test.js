import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createTicketBody } from './ticketBody.js';
import { createSpecIssueBody } from './specIssueBody.js';
import { publishTickets } from './publishTickets.js';

describe('publishTickets', () => {
  it('01: creates tickets as native sub-issues with warnings, labels, mappings, and artifacts', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-tickets-create-'));
    const github = createFakeGitHubClient({
      /** @param {number} number */
      async getIssue(number) {
        assert.equal(number, 126);
        return createIssue({
          number: 126,
          title: 'Manual parent Spec',
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
      tickets: [
        {
          sliceRef: '1',
          title: 'Publish feature ticket',
          whatToBuild: 'Implement the first user-facing slice.',
          acceptanceCriteria: ['Creates the feature path.'],
          blockedBy: [44],
          coveredUserStories: [10, 2],
          triageRole: 'ready-for-agent',
        },
        {
          sliceRef: 'support-a',
          title: 'Prepare ticket support',
          whatToBuild: 'Add supporting test fixtures.',
          acceptanceCriteria: ['Support fixtures are available.'],
          supportWork: true,
        },
      ],
    };

    const result = await publishTickets({
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
      summary: 'Published 2 Tickets under Parent Issue #126.',
      action: 'created',
      parent: {
        number: 126,
        url: 'https://github.test/issues/126',
      },
      tickets: [
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
          code: 'parent-missing-pullops-spec-marker',
          message: 'Parent Issue #126 is open but is not marked as a PullOps-published Spec Issue.',
        },
      ],
      localRunRecord: join(
        cwd,
        '.pullops',
        'runs',
        '2026-06-20T101500000Z-issues-publish-tickets-126',
      ),
    });
    assert.equal(github.createdIssueInputs.length, 2);
    assert.equal(github.createdIssueInputs[0].title, 'Publish feature ticket');
    assert.equal(github.createdIssueInputs[0].labels, undefined);
    assert.match(github.createdIssueInputs[0].body, /^<!-- PullOps publication marker:/m);
    assert.match(github.createdIssueInputs[0].body, /"kind":"ticket"/);
    assert.match(github.createdIssueInputs[0].body, /"sliceRef":"1"/);
    assert.match(github.createdIssueInputs[0].body, /^## What to build$/m);
    assert.match(github.createdIssueInputs[0].body, /^## Acceptance criteria$/m);
    assert.match(github.createdIssueInputs[0].body, /^## Blocked by$/m);
    assert.match(github.createdIssueInputs[0].body, /- #44/);
    assert.match(github.createdIssueInputs[0].body, /^## Covered Spec user stories$/m);
    assert.match(github.createdIssueInputs[0].body, /- 2/);
    assert.match(github.createdIssueInputs[0].body, /- 10/);
    assert.match(github.createdIssueInputs[1].body, /^## Support work$/m);
    assert.match(github.createdIssueInputs[1].body, /explicitly marked as support work/);
    assert.match(github.createdIssueInputs[1].body, /^## Blocked by$/m);
    assert.match(github.createdIssueInputs[1].body, /- None\./);
    assert.deepEqual(github.subIssueAdds, [
      { parentIssueNumber: 126, ticketNumber: 201 },
      { parentIssueNumber: 126, ticketNumber: 202 },
    ]);
    assert.deepEqual(github.labelRemovals, [{ number: 201, labels: ['needs-triage'] }]);
    assert.deepEqual(github.labelAdds, [{ number: 201, labels: ['ready-for-agent'] }]);
    assert.deepEqual(
      JSON.parse(await readFile(join(result.localRunRecord, 'request.json'), 'utf8')),
      {
        parentIssueNumber: 126,
        tickets: [
          {
            sliceRef: '1',
            title: 'Publish feature ticket',
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
            title: 'Prepare ticket support',
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

  it('02: accepts a marked PullOps Spec parent without warning', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-tickets-marked-parent-'));
    const github = createFakeGitHubClient({
      /** @param {number} number */
      async getIssue(number) {
        return createIssue({
          number,
          body: createSpecIssueBody({
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

    const result = await publishTickets({
      cwd,
      config: { issueStore: { provider: 'github' } },
      githubClient: github,
      parentIssueNumber: 126,
      rawRequest: {
        tickets: [
          {
            sliceRef: '1',
            title: 'Publish ticket',
            whatToBuild: 'Do ticket work.',
            acceptanceCriteria: ['Ticket work is done.'],
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
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-tickets-parent-conflict-'));
    const github = createFakeGitHubClient();

    const result = await publishTickets({
      cwd,
      config: { issueStore: { provider: 'github' } },
      githubClient: github,
      parentIssueNumber: 126,
      rawRequest: {
        parentIssueNumber: 127,
        tickets: [
          {
            sliceRef: '1',
            title: 'Publish ticket',
            whatToBuild: 'Do ticket work.',
            acceptanceCriteria: ['Ticket work is done.'],
            coveredUserStories: [1],
          },
        ],
      },
      createdAt: new Date('2026-06-20T10:15:00.000Z'),
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.summary, 'Publish Ticket batch failed.');
    assert.match(result.failureReason, /Request.parentIssueNumber values conflict/);
    assert.equal(github.createdIssueInputs.length, 0);
    assert.equal(
      result.localRunRecord,
      join(cwd, '.pullops', 'runs', '2026-06-20T101500000Z-issues-publish-tickets-invalid'),
    );
  });

  it('04: rejects feature tickets without covered Spec user stories', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-tickets-story-required-'));
    const github = createFakeGitHubClient();

    const result = await publishTickets({
      cwd,
      config: { issueStore: { provider: 'github' } },
      githubClient: github,
      rawRequest: {
        parentIssueNumber: 126,
        tickets: [
          {
            sliceRef: '1',
            title: 'Publish ticket',
            whatToBuild: 'Do ticket work.',
            acceptanceCriteria: ['Ticket work is done.'],
          },
        ],
      },
      createdAt: new Date('2026-06-20T10:15:00.000Z'),
    });

    assert.equal(result.status, 'failed');
    assert.match(
      result.failureReason,
      /Request.tickets\[0\] must include covered Spec user story numbers or supportWork: true/,
    );
    assert.equal(github.createdIssueInputs.length, 0);
  });

  it('05: rejects closed or ticket Parent Issues', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-tickets-invalid-parent-'));
    const github = createFakeGitHubClient({
      /** @param {number} number */
      async getIssue(number) {
        return createIssue({
          number,
          state: 'CLOSED',
        });
      },
    });

    const result = await publishTickets({
      cwd,
      config: { issueStore: { provider: 'github' } },
      githubClient: github,
      rawRequest: {
        parentIssueNumber: 126,
        tickets: [
          {
            sliceRef: '1',
            title: 'Publish ticket',
            whatToBuild: 'Do ticket work.',
            acceptanceCriteria: ['Ticket work is done.'],
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
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-tickets-dependencies-'));
    const github = createFakeGitHubClient({
      /** @param {number} number */
      async getIssue(number) {
        return createIssue({
          number,
          title: 'Parent Spec',
          body: createSpecIssueBody({
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

    const result = await publishTickets({
      cwd,
      config: { issueStore: { provider: 'github' } },
      githubClient: github,
      rawRequest: {
        parentIssueNumber: 126,
        tickets: [
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
      result.tickets.map(ticket => [ticket.sliceRef, ticket.blockedBy]),
      [
        ['base', []],
        ['dependent', [201, 44]],
      ],
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(result.localRunRecord, 'request.json'), 'utf8')).tickets[1],
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

  it('07: reuses existing marker-owned tickets on plain rerun and continues dependency resolution', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-tickets-rerun-reuse-'));
    const existingTicket = createIssue({
      number: 201,
      title: 'Base slice',
      body: createTicketBody({
        parentIssueNumber: 126,
        sliceRef: 'base',
        title: 'Base slice',
        whatToBuild: 'Build the first dependency.',
        acceptanceCriteria: ['Base exists.'],
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
            body: createSpecIssueBody({
              title: 'Published parent',
              problemStatement: 'Parent problem.',
              solution: 'Parent solution.',
              userStories: [{ number: 23, story: 'As an agent, I can reuse rerun tickets.' }],
              implementationDecisions: ['Reuse marker-owned tickets on rerun.'],
              testingDecisions: ['Use focused tests.'],
              outOfScope: ['Unrelated publication.'],
              furtherNotes: [],
              auditDetails: [],
            }),
            subIssues: [
              {
                number: 201,
                title: 'Base slice',
                url: 'https://github.test/issues/201',
                state: 'OPEN',
                relationshipSource: 'native',
              },
            ],
          });
        }
        assert.equal(number, 201);
        return existingTicket;
      },
      /** @param {import('../github/types.js').CreateIssueOptions} options */
      async createIssue(options) {
        github.createdIssueInputs.push(options);
        return createIssue({
          number: 202,
          title: options.title,
          body: options.body,
        });
      },
      /** @param {import('../github/types.js').AddSubIssueOptions} options */
      async addSubIssue(options) {
        github.subIssueAdds.push(options);
      },
    });

    const result = await publishTickets({
      cwd,
      config: { issueStore: { provider: 'github' } },
      githubClient: github,
      rawRequest: {
        parentIssueNumber: 126,
        tickets: [
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
            blockedBy: ['base'],
            coveredUserStories: [24],
          },
        ],
      },
      createdAt: new Date('2026-06-20T10:15:00.000Z'),
    });

    assert.equal(result.status, 'accepted');
    assert.equal(github.createdIssueInputs.length, 1);
    assert.deepEqual(result.tickets, [
      {
        sliceRef: 'base',
        action: 'reused',
        issue: {
          number: 201,
          url: 'https://github.test/issues/201',
        },
        blockedBy: [],
      },
      {
        sliceRef: 'dependent',
        action: 'created',
        issue: {
          number: 202,
          url: 'https://github.test/issues/202',
        },
        blockedBy: [201],
      },
    ]);
    assert.equal(result.action, 'mixed');
    assert.match(github.createdIssueInputs[0].body, /^## Blocked by$/m);
    assert.match(github.createdIssueInputs[0].body, /- #201/);
    assert.doesNotMatch(github.createdIssueInputs[0].body, /base/);
    assert.deepEqual(github.subIssueAdds, [{ parentIssueNumber: 126, ticketNumber: 202 }]);
  });

  it('08: plain reruns recover unattached marker-owned tickets from prior run records', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-tickets-rerun-recover-'));
    const request = {
      parentIssueNumber: 126,
      tickets: [
        {
          sliceRef: 'repair',
          title: 'Recover ticket',
          whatToBuild: 'Recover the missing native relationship.',
          acceptanceCriteria: ['The existing ticket is reused instead of duplicated.'],
          coveredUserStories: [23],
          triageRole: 'ready-for-agent',
        },
      ],
    };
    const recoveredTicket = createIssue({
      number: 201,
      title: 'Recover ticket',
      body: createTicketBody({
        parentIssueNumber: 126,
        sliceRef: 'repair',
        title: 'Recover ticket',
        whatToBuild: 'Recover the missing native relationship.',
        acceptanceCriteria: ['The existing ticket is reused instead of duplicated.'],
        blockedBy: [],
        blockedBySliceRefs: [],
        coveredUserStories: [23],
        supportWork: false,
      }),
      labels: ['needs-triage'],
      parent: null,
    });
    const firstGithub = createFakeGitHubClient({
      /** @param {number} number */
      async getIssue(number) {
        assert.equal(number, 126);
        return createIssue({
          number,
          body: createSpecIssueBody({
            title: 'Published parent',
            problemStatement: 'Parent problem.',
            solution: 'Parent solution.',
            userStories: [{ number: 23, story: 'As an agent, I can recover rerun publication.' }],
            implementationDecisions: ['Recover unattached tickets from prior run records.'],
            testingDecisions: ['Exercise the recovery path through fake clients.'],
            outOfScope: ['Unrelated publication.'],
            furtherNotes: [],
            auditDetails: [],
          }),
          subIssues: [],
        });
      },
      /** @param {import('../github/types.js').CreateIssueOptions} options */
      async createIssue(options) {
        firstGithub.createdIssueInputs.push(options);
        return recoveredTicket;
      },
      async addSubIssue() {
        throw new Error('Native sub-issue attachment failed.');
      },
    });

    const firstResult = await publishTickets({
      cwd,
      config: { issueStore: { provider: 'github' } },
      githubClient: firstGithub,
      rawRequest: request,
      createdAt: new Date('2026-06-20T10:15:00.000Z'),
    });

    assert.equal(firstResult.status, 'failed');
    assert.deepEqual(firstResult.tickets, [
      {
        sliceRef: 'repair',
        action: 'created',
        issue: {
          number: 201,
          url: 'https://github.test/issues/201',
        },
        blockedBy: [],
        triageRole: 'ready-for-agent',
      },
    ]);
    assert.deepEqual(firstResult.failedTickets, [
      {
        sliceRef: 'repair',
        failureReason: 'Native sub-issue attachment failed.',
        action: 'created',
        issue: {
          number: 201,
          url: 'https://github.test/issues/201',
        },
      },
    ]);

    const secondGithub = createFakeGitHubClient({
      /** @param {number} number */
      async getIssue(number) {
        if (number === 126) {
          return createIssue({
            number,
            body: createSpecIssueBody({
              title: 'Published parent',
              problemStatement: 'Parent problem.',
              solution: 'Parent solution.',
              userStories: [{ number: 23, story: 'As an agent, I can recover rerun publication.' }],
              implementationDecisions: ['Recover unattached tickets from prior run records.'],
              testingDecisions: ['Exercise the recovery path through fake clients.'],
              outOfScope: ['Unrelated publication.'],
              furtherNotes: [],
              auditDetails: [],
            }),
            subIssues: [],
          });
        }
        assert.equal(number, 201);
        return recoveredTicket;
      },
      /** @param {import('../github/types.js').AddSubIssueOptions} options */
      async addSubIssue(options) {
        secondGithub.subIssueAdds.push(options);
        recoveredTicket.parent = {
          number: 126,
          title: 'Published parent',
          url: 'https://github.test/issues/126',
          state: 'OPEN',
          relationshipSource: 'native',
        };
      },
      /** @param {import('../github/types.js').EditLabelsOptions} options */
      async removeLabelsFromIssue(options) {
        secondGithub.labelRemovals.push(options);
        recoveredTicket.labels = recoveredTicket.labels.filter(
          label => !options.labels.includes(label),
        );
      },
      /** @param {import('../github/types.js').EditLabelsOptions} options */
      async addLabelsToIssue(options) {
        secondGithub.labelAdds.push(options);
        recoveredTicket.labels = [...new Set([...recoveredTicket.labels, ...options.labels])];
      },
    });

    const secondResult = await publishTickets({
      cwd,
      config: { issueStore: { provider: 'github' } },
      githubClient: secondGithub,
      rawRequest: request,
      createdAt: new Date('2026-06-20T10:16:00.000Z'),
    });

    assert.equal(secondResult.status, 'accepted');
    assert.equal(secondGithub.createdIssueInputs.length, 0);
    assert.deepEqual(secondGithub.subIssueAdds, [{ parentIssueNumber: 126, ticketNumber: 201 }]);
    assert.deepEqual(secondGithub.labelRemovals, [{ number: 201, labels: ['needs-triage'] }]);
    assert.deepEqual(secondGithub.labelAdds, [{ number: 201, labels: ['ready-for-agent'] }]);
    assert.deepEqual(secondResult.tickets, [
      {
        sliceRef: 'repair',
        action: 'updated',
        issue: {
          number: 201,
          url: 'https://github.test/issues/201',
        },
        blockedBy: [],
        triageRole: 'ready-for-agent',
      },
    ]);
    assert.equal(secondResult.action, 'updated');
  });

  it('09: force-updates existing marker-owned tickets by parent and slice ref on rerun', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-tickets-rerun-'));
    /** @type {import('../github/types.js').UpdateIssueOptions[]} */
    const updates = [];
    const existingTicket = createIssue({
      number: 201,
      title: 'Old title',
      body: createTicketBody({
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
        return existingTicket;
      },
      /** @param {import('../github/types.js').UpdateIssueOptions} options */
      async updateIssue(options) {
        updates.push(options);
        return createIssue({
          ...existingTicket,
          title: options.title,
          body: options.body,
        });
      },
    });

    const result = await publishTickets({
      cwd,
      config: { issueStore: { provider: 'github' } },
      githubClient: github,
      rawRequest: {
        parentIssueNumber: 126,
        forceUpdate: true,
        tickets: [
          {
            sliceRef: '1',
            title: 'Updated ticket',
            whatToBuild: 'Updated ticket work.',
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
    assert.equal(updates[0].title, 'Updated ticket');
    assert.match(updates[0].body, /Updated ticket work/);
    assert.deepEqual(result.tickets, [
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

  it('10: reports partial failures with created updated and failed slice details and artifacts', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-tickets-partial-'));
    const existingTicket = createIssue({
      number: 201,
      title: 'Existing ticket',
      body: createTicketBody({
        parentIssueNumber: 126,
        sliceRef: 'existing',
        title: 'Existing ticket',
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
                title: 'Existing ticket',
                url: 'https://github.test/issues/201',
                state: 'OPEN',
                relationshipSource: 'native',
              },
            ],
          });
        }
        assert.equal(number, 201);
        return existingTicket;
      },
      /** @param {import('../github/types.js').UpdateIssueOptions} options */
      async updateIssue(options) {
        return createIssue({ ...existingTicket, title: options.title, body: options.body });
      },
      /** @param {import('../github/types.js').CreateIssueOptions} options */
      async createIssue(options) {
        if (options.title === 'Broken ticket') {
          throw new Error('GitHub refused this ticket.');
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

    const result = await publishTickets({
      cwd,
      config: { issueStore: { provider: 'github' } },
      githubClient: github,
      rawRequest: {
        parentIssueNumber: 126,
        forceUpdate: true,
        tickets: [
          {
            sliceRef: 'existing',
            title: 'Updated existing ticket',
            whatToBuild: 'Updated work.',
            acceptanceCriteria: ['Updated criteria.'],
            coveredUserStories: [25],
          },
          {
            sliceRef: 'new',
            title: 'New ticket',
            whatToBuild: 'New work.',
            acceptanceCriteria: ['New criteria.'],
            coveredUserStories: [26],
          },
          {
            sliceRef: 'broken',
            title: 'Broken ticket',
            whatToBuild: 'Broken work.',
            acceptanceCriteria: ['Broken criteria.'],
            coveredUserStories: [27],
          },
        ],
      },
      createdAt: new Date('2026-06-20T10:15:00.000Z'),
    });

    assert.equal(result.status, 'failed');
    assert.match(result.summary, /Published 2 Tickets under Parent Issue #126/);
    assert.deepEqual(
      result.tickets?.map(ticket => [ticket.sliceRef, ticket.action]),
      [
        ['existing', 'updated'],
        ['new', 'created'],
      ],
    );
    assert.deepEqual(result.failedTickets, [
      {
        sliceRef: 'broken',
        failureReason: 'GitHub refused this ticket.',
      },
    ]);
    assert.deepEqual(
      JSON.parse(await readFile(join(result.localRunRecord, 'response.json'), 'utf8')),
      result,
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(result.localRunRecord, 'failures.json'), 'utf8')),
      result.failedTickets,
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(result.localRunRecord, 'warnings.json'), 'utf8')),
      result.warnings,
    );
  });

  it('11: explicit issue number overrides repair unattached marker-owned tickets safely', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-tickets-override-'));
    /** @type {import('../github/types.js').UpdateIssueOptions[]} */
    const updates = [];
    const overrideTicket = createIssue({
      number: 201,
      title: 'Unattached ticket',
      body: createTicketBody({
        parentIssueNumber: 126,
        sliceRef: 'repair',
        title: 'Unattached ticket',
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
        return overrideTicket;
      },
      /** @param {import('../github/types.js').UpdateIssueOptions} options */
      async updateIssue(options) {
        updates.push(options);
        return createIssue({
          ...overrideTicket,
          title: options.title,
          body: options.body,
        });
      },
      /** @param {import('../github/types.js').AddSubIssueOptions} options */
      async addSubIssue(options) {
        github.subIssueAdds.push(options);
      },
    });

    const result = await publishTickets({
      cwd,
      config: { issueStore: { provider: 'github' } },
      githubClient: github,
      rawRequest: {
        parentIssueNumber: 126,
        tickets: [
          {
            sliceRef: 'repair',
            issueNumber: 201,
            title: 'Repaired ticket',
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
    assert.deepEqual(github.subIssueAdds, [{ parentIssueNumber: 126, ticketNumber: 201 }]);
    assert.equal(result.tickets[0].action, 'updated');
  });

  it('12: explicit issue number overrides ignore stale recovery records for the same slice ref', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-tickets-override-stale-recovery-'));
    await writeRecoveredTicketRunRecord({
      cwd,
      runId: '2026-06-20T101600000Z-issues-publish-tickets-126',
      parentIssueNumber: 126,
      mappings: [{ sliceRef: 'repair', issueNumber: 202 }],
    });
    await writeRecoveredTicketRunRecord({
      cwd,
      runId: '2026-06-20T101500000Z-issues-publish-tickets-126',
      parentIssueNumber: 126,
      mappings: [{ sliceRef: 'repair', issueNumber: 201 }],
    });
    /** @type {import('../github/types.js').UpdateIssueOptions[]} */
    const updates = [];
    const overrideTicket = createIssue({
      number: 201,
      title: 'Explicit repair ticket',
      body: createTicketBody({
        parentIssueNumber: 126,
        sliceRef: 'repair',
        title: 'Explicit repair ticket',
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
        return overrideTicket;
      },
      /** @param {import('../github/types.js').UpdateIssueOptions} options */
      async updateIssue(options) {
        updates.push(options);
        return createIssue({
          ...overrideTicket,
          title: options.title,
          body: options.body,
        });
      },
      /** @param {import('../github/types.js').AddSubIssueOptions} options */
      async addSubIssue(options) {
        github.subIssueAdds.push(options);
      },
    });

    const result = await publishTickets({
      cwd,
      config: { issueStore: { provider: 'github' } },
      githubClient: github,
      rawRequest: {
        parentIssueNumber: 126,
        tickets: [
          {
            sliceRef: 'repair',
            issueNumber: 201,
            title: 'Repaired ticket',
            whatToBuild: 'Repair publication.',
            acceptanceCriteria: ['Repair is published.'],
            coveredUserStories: [30],
          },
        ],
      },
      createdAt: new Date('2026-06-20T10:17:00.000Z'),
    });

    assert.equal(result.status, 'accepted');
    assert.deepEqual(
      updates.map(update => update.number),
      [201],
    );
    assert.deepEqual(github.subIssueAdds, [{ parentIssueNumber: 126, ticketNumber: 201 }]);
    assert.equal(result.tickets[0].issue.number, 201);
  });

  it('13: plain reruns prefer the newest valid recovery record for a slice ref', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-tickets-recovery-newest-valid-'));
    await writeRecoveredTicketRunRecord({
      cwd,
      runId: '2026-06-20T101600000Z-issues-publish-tickets-126',
      parentIssueNumber: 126,
      mappings: [{ sliceRef: 'repair', issueNumber: 202 }],
    });
    await writeRecoveredTicketRunRecord({
      cwd,
      runId: '2026-06-20T101500000Z-issues-publish-tickets-126',
      parentIssueNumber: 126,
      mappings: [{ sliceRef: 'repair', issueNumber: 201 }],
    });
    const recoveredTicket = createIssue({
      number: 201,
      title: 'Recovered ticket',
      body: createTicketBody({
        parentIssueNumber: 126,
        sliceRef: 'repair',
        title: 'Recovered ticket',
        whatToBuild: 'Recover the missing native relationship.',
        acceptanceCriteria: ['The existing ticket is reused instead of duplicated.'],
        blockedBy: [],
        blockedBySliceRefs: [],
        coveredUserStories: [30],
        supportWork: false,
      }),
      parent: null,
    });
    const staleTicket = createIssue({
      number: 202,
      title: 'Superseded ticket',
      body: '## What to build\n\nThis stale recovery record is no longer PullOps-owned.',
      parent: null,
    });
    const github = createFakeGitHubClient({
      /** @param {number} number */
      async getIssue(number) {
        if (number === 126) {
          return createIssue({ number, subIssues: [] });
        }
        if (number === 202) {
          return staleTicket;
        }
        assert.equal(number, 201);
        return recoveredTicket;
      },
      /** @param {import('../github/types.js').AddSubIssueOptions} options */
      async addSubIssue(options) {
        github.subIssueAdds.push(options);
      },
    });

    const result = await publishTickets({
      cwd,
      config: { issueStore: { provider: 'github' } },
      githubClient: github,
      rawRequest: {
        parentIssueNumber: 126,
        tickets: [
          {
            sliceRef: 'repair',
            title: 'Recovered ticket',
            whatToBuild: 'Recover the missing native relationship.',
            acceptanceCriteria: ['The existing ticket is reused instead of duplicated.'],
            coveredUserStories: [30],
          },
        ],
      },
      createdAt: new Date('2026-06-20T10:17:00.000Z'),
    });

    assert.equal(result.status, 'accepted');
    assert.equal(github.createdIssueInputs.length, 0);
    assert.deepEqual(github.subIssueAdds, [{ parentIssueNumber: 126, ticketNumber: 201 }]);
    assert.deepEqual(result.tickets, [
      {
        sliceRef: 'repair',
        action: 'updated',
        issue: {
          number: 201,
          url: 'https://github.test/issues/201',
        },
        blockedBy: [],
      },
    ]);
  });

  it('14: ignores unrelated corrupt local run records during recovery', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-tickets-recovery-filter-'));
    await writeRecoveredTicketRunRecord({
      cwd,
      runId: '2026-06-20T101500000Z-issues-publish-tickets-126',
      parentIssueNumber: 126,
      mappings: [{ sliceRef: 'repair', issueNumber: 201 }],
    });

    const unrelatedRunRecordDirectory = join(
      cwd,
      '.pullops',
      'runs',
      '2026-06-20T101600000Z-issue-implement-126',
    );
    await mkdir(unrelatedRunRecordDirectory, { recursive: true });
    await writeFile(join(unrelatedRunRecordDirectory, 'response.json'), '{not json');

    const recoveredTicket = createIssue({
      number: 201,
      title: 'Recovered ticket',
      body: createTicketBody({
        parentIssueNumber: 126,
        sliceRef: 'repair',
        title: 'Recovered ticket',
        whatToBuild: 'Recover the missing native relationship.',
        acceptanceCriteria: ['The existing ticket is reused instead of duplicated.'],
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
        return recoveredTicket;
      },
      /** @param {import('../github/types.js').AddSubIssueOptions} options */
      async addSubIssue(options) {
        github.subIssueAdds.push(options);
      },
    });

    const result = await publishTickets({
      cwd,
      config: { issueStore: { provider: 'github' } },
      githubClient: github,
      rawRequest: {
        parentIssueNumber: 126,
        tickets: [
          {
            sliceRef: 'repair',
            title: 'Recovered ticket',
            whatToBuild: 'Recover the missing native relationship.',
            acceptanceCriteria: ['The existing ticket is reused instead of duplicated.'],
            coveredUserStories: [30],
          },
        ],
      },
      createdAt: new Date('2026-06-20T10:17:00.000Z'),
    });

    assert.equal(result.status, 'accepted');
    assert.equal(github.createdIssueInputs.length, 0);
    assert.deepEqual(github.subIssueAdds, [{ parentIssueNumber: 126, ticketNumber: 201 }]);
    assert.deepEqual(result.tickets, [
      {
        sliceRef: 'repair',
        action: 'updated',
        issue: {
          number: 201,
          url: 'https://github.test/issues/201',
        },
        blockedBy: [],
      },
    ]);
  });

  it('15: refuses force updates when the explicit issue override is not marker-owned', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-publish-tickets-override-safety-'));
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

    const result = await publishTickets({
      cwd,
      config: { issueStore: { provider: 'github' } },
      githubClient: github,
      rawRequest: {
        parentIssueNumber: 126,
        forceUpdate: true,
        tickets: [
          {
            sliceRef: 'repair',
            issueNumber: 201,
            title: 'Repaired ticket',
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
      result.failedTickets?.[0].failureReason ?? '',
      /Issue #201 is not marked as a PullOps-published Ticket/,
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
 * @param {{
 *   cwd: string,
 *   runId: string,
 *   parentIssueNumber: number,
 *   mappings: Array<{ sliceRef: string, issueNumber: number }>,
 * }} options
 * @returns {Promise<void>}
 */
async function writeRecoveredTicketRunRecord({ cwd, runId, parentIssueNumber, mappings }) {
  const runRecordDirectory = join(cwd, '.pullops', 'runs', runId);
  await mkdir(runRecordDirectory, { recursive: true });
  await writeFile(
    join(runRecordDirectory, 'response.json'),
    `${JSON.stringify(
      {
        status: 'accepted',
        parent: {
          number: parentIssueNumber,
          url: `https://github.test/issues/${parentIssueNumber}`,
        },
        mappings: mappings.map(mapping => ({
          ...mapping,
          issueUrl: `https://github.test/issues/${mapping.issueNumber}`,
        })),
      },
      null,
      2,
    )}\n`,
  );
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
