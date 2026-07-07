import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createInMemoryIssueStore } from './inMemoryIssueStore.js';

describe('Test inMemoryIssueStore', () => {
  it('01: publishes a Concrete Issue with a publication marker', async () => {
    const { store, readIssue } = await createTempStore();

    const output = await store.publishConcreteIssue({
      title: 'Add rate limiting',
      whatToBuild: 'Add a limiter.',
      acceptanceCriteria: ['Requests above the limit are rejected.'],
    });

    assert.equal(output.status, 'accepted');
    if (output.status !== 'accepted') {
      return;
    }

    const issue = readIssue(output.issue.number);
    assert.match(issue.body, /PullOps publication marker/);
    const snapshot = await store.readIssueSnapshot(output.issue.number);
    assert.equal(snapshot.kind, 'concrete-issue');
    assert.equal(snapshot.publishedByPullOps, true);
  });

  it('02: publishes Child Issues related to their Parent Issue', async () => {
    const { store } = await createTempStore([
      { number: 9, title: 'PRD', body: 'Parent PRD issue.' },
    ]);

    const output = await store.publishChildIssues(
      {
        children: [
          {
            sliceRef: 'slice-1',
            title: 'First slice',
            whatToBuild: 'Build the first slice.',
            acceptanceCriteria: ['Slice works.'],
            blockedBy: [],
            blockedBySliceRefs: [],
            coveredUserStories: [1],
          },
        ],
      },
      { parentIssueNumber: 9 },
    );

    assert.equal(output.status, 'accepted');
    const children = await store.readChildIssueSnapshots(9);
    assert.equal(children.length, 1);
    assert.equal(children[0].kind, 'child-issue');
    assert.equal(children[0].parentIssueNumber, 9);
  });

  it('03: relates and reads issues without any GitHub client stubbing', async () => {
    const { store } = await createTempStore([
      { number: 9, title: 'Parent' },
      { number: 12, title: 'Child', body: 'Blocked by: #3' },
      { number: 3, title: 'Dependency', state: 'CLOSED' },
    ]);

    await store.relateChildIssue({ parentIssueNumber: 9, childIssueNumber: 12 });

    const child = await store.readIssueSnapshot(12);
    assert.equal(child.parentIssueNumber, 9);
    assert.deepEqual(child.blockedBy, [3]);
    const dependency = await store.readIssueSnapshot(3);
    assert.equal(dependency.isDone, true);
  });
});

/**
 * @param {Partial<import('../github/types.js').GitHubIssue>[]} [issues]
 */
async function createTempStore(issues = []) {
  const cwd = await mkdtemp(join(tmpdir(), 'pullops-in-memory-store-'));
  return createInMemoryIssueStore({ cwd, issues });
}
