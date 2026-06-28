import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const autoAdvanceWorkflowUrl = new URL(
  '../../../.github/workflows/pullops-prd-auto-advance.yml',
  import.meta.url,
);
const autoCompleteWorkflowUrl = new URL(
  '../../../.github/workflows/pullops-prd-auto-complete.yml',
  import.meta.url,
);
const dispatchWorkflowUrl = new URL(
  '../../../.github/workflows/pullops-dispatch.yml',
  import.meta.url,
);

describe('PRD automation workflows', () => {
  it('01: runs auto-advance as a thin deterministic PRD operation workflow', async () => {
    const workflow = await readFile(autoAdvanceWorkflowUrl, 'utf8');

    assert.equal(
      workflow.includes(['on:', '  workflow_dispatch:', '    inputs:'].join('\n')),
      true,
    );
    assert.equal(
      workflow.includes(
        ['permissions:', '  contents: write', '  issues: write', '  pull-requests: write'].join(
          '\n',
        ),
      ),
      true,
    );
    assert.match(
      workflow,
      /npm exec pullops -- run prd-auto-advance --issue \$\{\{ inputs\.issue \}\}/,
    );
    assert.match(
      workflow,
      /git remote set-url origin "https:\/\/x-access-token:\$\{PULLOPS_GITHUB_TOKEN\}@github\.com\/\$\{GITHUB_REPOSITORY\}\.git"/,
    );
    assert.doesNotMatch(workflow, /openai\/codex-action|codex-action|--runner/);
  });

  it('02: runs auto-complete as a thin deterministic PRD operation workflow', async () => {
    const workflow = await readFile(autoCompleteWorkflowUrl, 'utf8');

    assert.equal(
      workflow.includes(['on:', '  workflow_dispatch:', '    inputs:'].join('\n')),
      true,
    );
    assert.match(
      workflow,
      /npm exec pullops -- run prd-auto-complete --issue \$\{\{ inputs\.issue \}\}/,
    );
    assert.match(workflow, /pullops-prd-auto-complete-\$\{\{ inputs\.issue \}\}/);
    assert.doesNotMatch(workflow, /openai\/codex-action|codex-action|--runner/);
  });

  it('03: dispatches both PRD automation mode labels', async () => {
    const workflow = await readFile(dispatchWorkflowUrl, 'utf8');

    assert.match(workflow, /github\.event\.label\.name == 'pullops:prd:auto-advance'/);
    assert.match(workflow, /github\.event\.label\.name == 'pullops:prd:auto-complete'/);
    assert.match(workflow, /'pullops:prd:auto-advance': 'pullops-prd-auto-advance\.yml'/);
    assert.match(workflow, /'pullops:prd:auto-complete': 'pullops-prd-auto-complete\.yml'/);
  });
});
