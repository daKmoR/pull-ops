import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createPrdIssueBody, readPrdIssuePublicationMarker } from './prdIssueBody.js';

describe('prdIssueBody', () => {
  it('01: renders a PRD issue body with stable user story numbers and optional audit details', () => {
    const body = createPrdIssueBody({
      title: 'Publish PRD issue support',
      problemStatement: 'PullOps should publish PRDs through its own Issue Store.',
      solution: 'Add a PRD publish command on top of the GitHub Issue Store path.',
      userStories: [
        {
          number: 8,
          story:
            'As an agent, I want to submit structured PRD fields, so that PullOps can render stable and parseable PRD bodies.',
        },
        {
          number: 1,
          story:
            'As a maintainer, I want PullOps to own PRD publication, so that generated issue bodies stay consistent.',
        },
      ],
      implementationDecisions: [
        'Use the GitHub Issue Store adapter.',
        'Preserve stable user story numbers.',
      ],
      testingDecisions: ['Exercise the publish command through fake GitHub clients.'],
      outOfScope: ['Child Issue publication.'],
      furtherNotes: ['This PRD was published from the new issue-store command.'],
      auditDetails: ['Requested by to-prd.', 'Recorded in a Local Run Record.'],
    });

    assert.match(
      body,
      /<!-- PullOps publication marker: \{"schemaVersion":1,"provider":"github","kind":"prd-issue"\} -->/,
    );
    assert.match(body, /^## Problem Statement$/m);
    assert.match(body, /PullOps should publish PRDs through its own Issue Store\./);
    assert.match(body, /^## Solution$/m);
    assert.match(body, /^## User Stories$/m);
    assert.match(body, /- 1\. As a maintainer, I want PullOps to own PRD publication/);
    assert.match(body, /- 8\. As an agent, I want to submit structured PRD fields/);
    assert.match(body, /^## Implementation Decisions$/m);
    assert.match(body, /^## Testing Decisions$/m);
    assert.match(body, /^## Out of Scope$/m);
    assert.match(body, /^## Further Notes$/m);
    assert.match(body, /^<details>$/m);
    assert.match(body, /<summary>PullOps publication audit<\/summary>/);
    assert.match(body, /Requested by to-prd\./);
    assert.match(body, /Recorded in a Local Run Record\./);
    assert.deepEqual(readPrdIssuePublicationMarker(body), {
      schemaVersion: 1,
      provider: 'github',
      kind: 'prd-issue',
    });
  });

  it('02: ignores PRD issue bodies without a PullOps publication marker', () => {
    assert.equal(
      readPrdIssuePublicationMarker(['## Problem Statement', '', 'Ship the PRD path.'].join('\n')),
      undefined,
    );
  });
});
