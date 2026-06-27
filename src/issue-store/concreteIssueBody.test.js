import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createConcreteIssueBody,
  readConcreteIssuePublicationMarker,
} from './concreteIssueBody.js';

describe('concreteIssueBody', () => {
  it('01: renders a concrete issue body with a hidden PullOps publication marker', () => {
    const body = createConcreteIssueBody({
      title: 'Publish issue store support',
      whatToBuild: 'Add a publish-issue command.',
      acceptanceCriteria: ['Command accepts structured JSON.', 'Command writes a run record.'],
      blockedBy: [12, 34],
      triageRole: 'ready-for-agent',
    });

    assert.match(
      body,
      /<!-- PullOps publication marker: \{"schemaVersion":1,"provider":"github","kind":"concrete-issue"\} -->/,
    );
    assert.match(body, /^## What to build$/m);
    assert.match(body, /Add a publish-issue command\./);
    assert.match(body, /^## Acceptance criteria$/m);
    assert.match(body, /- Command accepts structured JSON\./);
    assert.match(body, /- Command writes a run record\./);
    assert.match(body, /^## Blocked by$/m);
    assert.match(body, /- #12/);
    assert.match(body, /- #34/);
    assert.deepEqual(readConcreteIssuePublicationMarker(body), {
      schemaVersion: 1,
      provider: 'github',
      kind: 'concrete-issue',
    });
  });

  it('02: ignores issue bodies without a PullOps publication marker', () => {
    assert.equal(
      readConcreteIssuePublicationMarker(
        ['## What to build', '', 'Ship the issue store path.'].join('\n'),
      ),
      undefined,
    );
  });
});
