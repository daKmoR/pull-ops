import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createIssueStore } from './IssueStore.js';

describe('Test IssueStore', () => {
  it('01: reads an Issue Snapshot through the GitHub adapter', async () => {
    const { store } = createStoreWithIssues([
      createIssue({
        number: 12,
        body: 'Blocked by: #3',
        parent: { number: 9, relationshipSource: 'native' },
      }),
    ]);

    const snapshot = await store.readIssueSnapshot(12);

    assert.equal(snapshot.number, 12);
    assert.equal(snapshot.parentIssueNumber, 9);
    assert.deepEqual(snapshot.blockedBy, [3]);
  });

  it('02: reads Ticket Snapshots from native sub-issues', async () => {
    const { store } = createStoreWithIssues([
      createIssue({
        number: 9,
        subIssues: [
          { number: 12, relationshipSource: 'native' },
          { number: 13, relationshipSource: 'native' },
        ],
      }),
      createIssue({ number: 12, state: 'CLOSED' }),
      createIssue({ number: 13 }),
    ]);

    const tickets = await store.readTicketSnapshots(9);

    assert.deepEqual(
      tickets.map(ticket => ({ number: ticket.number, isDone: ticket.isDone })),
      [
        { number: 12, isDone: true },
        { number: 13, isDone: false },
      ],
    );
  });

  it('03: relates a Ticket to its Parent Issue through native sub-issues', async () => {
    /** @type {import('../github/types.js').AddSubIssueOptions[]} */
    const related = [];
    const { store } = createStoreWithIssues([], {
      /** @param {import('../github/types.js').AddSubIssueOptions} options */
      async addSubIssue(options) {
        related.push(options);
      },
    });

    await store.relateTicket({ parentIssueNumber: 9, ticketNumber: 12 });

    assert.deepEqual(related, [{ parentIssueNumber: 9, ticketNumber: 12 }]);
  });

  it('04: rejects relating when the GitHub client lacks sub-issue support', async () => {
    const { store } = createStoreWithIssues([], { addSubIssue: undefined });

    await assert.rejects(
      store.relateTicket({ parentIssueNumber: 9, ticketNumber: 12 }),
      /does not support sub-issue relationships/,
    );
  });

  it('05: publishes a Concrete Issue through the bound publish flow', async () => {
    /** @type {import('../github/types.js').GitHubIssue[]} */
    const created = [];
    const cwd = await mkdtemp(join(tmpdir(), 'pullops-issue-store-'));
    const { store } = createStoreWithIssues([], {
      /** @param {import('../github/types.js').CreateIssueOptions} options */
      async createIssue({ title, body }) {
        const issue = createIssue({ number: 77, title, body });
        created.push(issue);
        return issue;
      },
      cwd,
    });

    const output = await store.publishConcreteIssue({
      title: 'Add rate limiting',
      whatToBuild: 'Add a limiter.',
      acceptanceCriteria: ['Requests above the limit are rejected.'],
    });

    assert.equal(output.status, 'accepted');
    assert.equal(created.length, 1);
    assert.match(created[0].body, /PullOps publication marker/);
  });
});

/**
 * @param {ReturnType<typeof createIssue>[]} issues
 * @param {Record<string, unknown>} [overrides]
 */
function createStoreWithIssues(issues, { cwd = '/tmp', ...clientOverrides } = {}) {
  const byNumber = new Map(issues.map(issue => [issue.number, issue]));
  const githubClient = /** @type {import('../github/types.js').GitHubClient} */ (
    /** @type {unknown} */ ({
      /** @param {number} number */
      async getIssue(number) {
        const issue = byNumber.get(number);
        if (issue === undefined) {
          throw new Error(`Issue #${number} not found.`);
        }

        return issue;
      },
      async addSubIssue() {},
      ...clientOverrides,
    })
  );

  const store = createIssueStore({
    cwd: /** @type {string} */ (cwd),
    config: { issueStore: { provider: 'github' } },
    githubClient,
  });

  return { store, githubClient };
}

/**
 * @param {object} [overrides]
 * @returns {import('../github/types.js').GitHubIssue}
 */
function createIssue(overrides = {}) {
  return {
    number: 1,
    title: 'Issue',
    body: '',
    state: 'OPEN',
    url: 'https://github.com/acme/widgets/issues/1',
    authorLogin: 'maintainer',
    labels: [],
    parent: null,
    subIssues: [],
    ...overrides,
  };
}
