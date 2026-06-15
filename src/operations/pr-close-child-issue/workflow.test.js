import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const closeChildWorkflowUrl = new URL(
  '../../../.github/workflows/pullops-pr-close-child-issue.yml',
  import.meta.url,
);
const dispatchWorkflowUrl = new URL(
  '../../../.github/workflows/pullops-dispatch.yml',
  import.meta.url,
);

describe('pullops-pr-close-child-issue workflow', () => {
  it('01: runs automatically for merged same-repository child PRs', async () => {
    const workflow = await readFile(closeChildWorkflowUrl, 'utf8');

    assert.equal(
      workflow.includes(['on:', '  pull_request:', '    types: [closed]'].join('\n')),
      true,
    );
    assert.equal(
      workflow.includes(
        ['permissions:', '  contents: read', '  pull-requests: read', '  issues: write'].join('\n'),
      ),
      true,
    );
    assert.equal(
      workflow.includes(
        [
          'github.event.pull_request.merged == true &&',
          '      github.event.pull_request.head.repo.full_name == github.repository',
        ].join('\n'),
      ),
      true,
    );
    assert.equal(workflow.includes("base_pattern='^pullops/prd-([0-9]+)$'"), true);
    assert.equal(workflow.includes("head_pattern='^pullops/prd-([0-9]+)-issue-([0-9]+)$'"), true);
    assert.match(
      workflow,
      /node src\/cli\/cli\.js run pr-close-child-issue --pr "\$\{\{ github\.event\.pull_request\.number \}\}"/,
    );
    assert.match(workflow, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
    assert.match(workflow, /PULLOPS_GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
    assert.doesNotMatch(workflow, /workflow_dispatch/);
    assert.doesNotMatch(workflow, /pull_request_target/);
    assert.doesNotMatch(workflow, /head_ref/);
    assert.doesNotMatch(workflow, /secrets\.PULLOPS_GITHUB_TOKEN/);
    assert.doesNotMatch(workflow, /openai\/codex-action|codex-action|--runner/);
  });

  it('02: is not dispatched manually from the label dispatcher', async () => {
    const workflow = await readFile(dispatchWorkflowUrl, 'utf8');

    assert.doesNotMatch(workflow, /pullops-pr-close-child-issue/);
    assert.doesNotMatch(workflow, /dispatch-merged-child-pr/);
    assert.doesNotMatch(workflow, /- closed/);
  });
});
