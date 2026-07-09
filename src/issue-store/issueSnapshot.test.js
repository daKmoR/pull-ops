import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createIssueSnapshot } from './issueSnapshot.js';

describe('Test issueSnapshot', () => {
  it('01: parses blocking issue references from body lines', () => {
    const snapshot = createIssueSnapshot(
      createIssue({
        body: [
          '## Task',
          '',
          'Part of: #12',
          'Blocked by: #3, #4 and #3',
          '',
          'Ship the selected slice.',
        ].join('\n'),
      }),
    );

    assert.deepEqual(snapshot.blockedBy, [3, 4]);
  });

  it('02: parses blocking issue references from markdown sections', () => {
    const snapshot = createIssueSnapshot(
      createIssue({
        body: [
          'Part of: #12',
          '',
          '## Blocked by',
          '',
          '#3',
          '- #4',
          '- #3',
          '',
          '## Notes',
          '',
          'Related to #99.',
        ].join('\n'),
      }),
    );

    assert.deepEqual(snapshot.blockedBy, [3, 4]);
  });

  it('03: uses native parent metadata as the only parent identity source', () => {
    const withNativeParent = createIssueSnapshot(
      createIssue({
        body: 'Part of: #12',
        parent: { number: 99, title: 'Native parent', relationshipSource: 'native' },
      }),
    );
    assert.equal(withNativeParent.parentIssueNumber, 99);

    const withoutNativeParent = createIssueSnapshot(createIssue({ body: 'Part of: #12' }));
    assert.equal(withoutNativeParent.parentIssueNumber, undefined);
  });

  it('04: treats only closed issues as done', () => {
    assert.equal(createIssueSnapshot(createIssue({ state: 'CLOSED' })).isDone, true);
    assert.equal(
      createIssueSnapshot(createIssue({ state: 'OPEN', labels: ['pullops:human-required'] }))
        .isDone,
      false,
    );
    assert.equal(createIssueSnapshot(createIssue({ state: 'OPEN' })).isDone, false);
  });

  it('05: reads kind and publication ownership from the publication marker', () => {
    const published = createIssueSnapshot(
      createIssue({
        body: [
          '<!-- PullOps publication marker: {"schemaVersion":1,"provider":"github","kind":"concrete-issue"} -->',
          '',
          '## What to build',
        ].join('\n'),
      }),
    );
    assert.equal(published.kind, 'concrete-issue');
    assert.equal(published.publishedByPullOps, true);

    const ticket = createIssueSnapshot(
      createIssue({
        body: '<!-- PullOps publication marker: {"schemaVersion":1,"provider":"github","kind":"ticket","parentIssueNumber":12,"sliceRef":"slice-1"} -->',
      }),
    );
    assert.equal(ticket.kind, 'ticket');
    assert.deepEqual(ticket.marker, {
      schemaVersion: 1,
      provider: 'github',
      kind: 'ticket',
      parentIssueNumber: 12,
      sliceRef: 'slice-1',
    });

    const unpublished = createIssueSnapshot(createIssue({ body: 'Manually written issue.' }));
    assert.equal(unpublished.kind, undefined);
    assert.equal(unpublished.publishedByPullOps, false);
  });

  it('06: lists native sub-issue numbers as ticket numbers', () => {
    const snapshot = createIssueSnapshot(
      createIssue({
        subIssues: [
          { number: 41, relationshipSource: 'native' },
          { number: 42, relationshipSource: 'native' },
        ],
      }),
    );

    assert.deepEqual(snapshot.ticketNumbers, [41, 42]);
  });
});

/**
 * @param {Partial<import('../github/types.js').GitHubIssue>} overrides
 * @returns {import('../github/types.js').GitHubIssue}
 */
function createIssue(overrides = {}) {
  return {
    number: 34,
    title: 'Issue',
    body: '',
    state: 'OPEN',
    url: 'https://github.com/acme/widgets/issues/34',
    authorLogin: 'maintainer',
    labels: [],
    parent: null,
    subIssues: [],
    ...overrides,
  };
}
