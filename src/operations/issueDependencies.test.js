import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getParentIssueNumber, isIssueDone, parseIssueDependencies } from './issueDependencies.js';

describe('issueDependencies', () => {
  it('01: parses parent and blocking issue references from body lines', () => {
    assert.deepEqual(
      parseIssueDependencies(
        [
          '## Task',
          '',
          'Part of: #12',
          'Blocked by: #3, #4 and #3',
          '',
          'Ship the selected slice.',
        ].join('\n'),
      ),
      {
        partOf: 12,
        blockedBy: [3, 4],
      },
    );
  });

  it('02: parses blocking issue references from markdown sections', () => {
    assert.deepEqual(
      parseIssueDependencies(
        [
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
      ),
      {
        partOf: 12,
        blockedBy: [3, 4],
      },
    );
  });

  it('03: uses native parent metadata as the only parent identity source', () => {
    assert.equal(
      getParentIssueNumber({
        number: 34,
        title: 'Child',
        body: 'Part of: #12',
        state: 'OPEN',
        url: 'https://github.com/acme/widgets/issues/34',
        authorLogin: 'maintainer',
        labels: [],
        parent: {
          number: 99,
          title: 'Native parent',
          relationshipSource: 'native',
        },
        subIssues: [],
      }),
      99,
    );

    assert.equal(
      getParentIssueNumber({
        number: 35,
        title: 'Body-linked issue',
        body: 'Part of: #12',
        state: 'OPEN',
        url: 'https://github.com/acme/widgets/issues/35',
        authorLogin: 'maintainer',
        labels: [],
        parent: null,
        subIssues: [],
      }),
      undefined,
    );
  });

  it('04: treats only closed dependency issues as done', () => {
    assert.equal(createDoneState({ state: 'CLOSED', labels: [] }), true);
    assert.equal(createDoneState({ state: 'OPEN', labels: ['pullops:status:done'] }), false);
    assert.equal(createDoneState({ state: 'OPEN', labels: ['pullops:status:prepared'] }), false);
    assert.equal(createDoneState({ state: 'OPEN', labels: [] }), false);
  });
});

/**
 * @param {{ state: string, labels: string[] }} options
 * @returns {boolean}
 */
function createDoneState({ state, labels }) {
  return isIssueDone({
    number: 1,
    title: 'Dependency',
    body: '',
    state,
    url: 'https://github.com/acme/widgets/issues/1',
    authorLogin: 'maintainer',
    labels,
    parent: null,
    subIssues: [],
  });
}
