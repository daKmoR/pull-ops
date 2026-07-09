import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSpecIssueBody, readSpecIssuePublicationMarker } from './specIssueBody.js';

describe('specIssueBody', () => {
  it('01: renders a Spec issue body with stable user story numbers and optional audit details', () => {
    const body = createSpecIssueBody({
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
    });

    assert.match(
      body,
      /<!-- PullOps publication marker: \{"schemaVersion":1,"provider":"github","kind":"spec-issue"\} -->/,
    );
    assert.match(body, /^## Problem Statement$/m);
    assert.match(body, /PullOps should publish specs through its own Issue Store\./);
    assert.match(body, /^## Solution$/m);
    assert.match(body, /^## User Stories$/m);
    assert.match(body, /- 1\. As a maintainer, I want PullOps to own Spec publication/);
    assert.match(body, /- 8\. As an agent, I want to submit structured Spec fields/);
    assert.match(body, /^## Implementation Decisions$/m);
    assert.match(body, /^## Testing Decisions$/m);
    assert.match(body, /^## Out of Scope$/m);
    assert.match(body, /^## Further Notes$/m);
    assert.match(body, /^<details>$/m);
    assert.match(body, /<summary>PullOps publication audit<\/summary>/);
    assert.match(body, /Requested by to-spec\./);
    assert.match(body, /Recorded in a Local Run Record\./);
    assert.deepEqual(readSpecIssuePublicationMarker(body), {
      schemaVersion: 1,
      provider: 'github',
      kind: 'spec-issue',
    });
  });

  it('02: ignores Spec issue bodies without a PullOps publication marker', () => {
    assert.equal(
      readSpecIssuePublicationMarker(
        ['## Problem Statement', '', 'Ship the Spec path.'].join('\n'),
      ),
      undefined,
    );
  });
});
