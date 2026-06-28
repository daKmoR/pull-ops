import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const prUpdateBranchWorkflowUrl = new URL(
  '../../../.github/workflows/pullops-pr-update-branch.yml',
  import.meta.url,
);
const dispatchWorkflowUrl = new URL(
  '../../../.github/workflows/pullops-dispatch.yml',
  import.meta.url,
);

describe('pullops-pr-update-branch workflow', () => {
  it('01: runs as a thin deterministic same-repository PR workflow', async () => {
    const workflow = await readFile(prUpdateBranchWorkflowUrl, 'utf8');

    assert.equal(
      workflow.includes(['on:', '  workflow_dispatch:', '    inputs:'].join('\n')),
      true,
    );
    assert.match(workflow, /pullRequest\.head\.repo\?\.full_name !== `\$\{owner\}\/\$\{repo\}`/);
    assert.match(
      workflow,
      /npm exec pullops -- run pr-update-branch --pr "\$\{\{ inputs\.pr \}\}"/,
    );
    assert.match(
      workflow,
      /git remote set-url origin "https:\/\/x-access-token:\$\{PULLOPS_GITHUB_TOKEN\}@github\.com\/\$\{GITHUB_REPOSITORY\}\.git"/,
    );
    assert.match(workflow, /git config user\.name "github-actions\[bot\]"/);
    assert.match(
      workflow,
      /git config user\.email "41898282\+github-actions\[bot\]@users\.noreply\.github\.com"/,
    );
    assert.match(workflow, /GITHUB_TOKEN: \$\{\{ secrets\.PULLOPS_GITHUB_TOKEN \}\}/);
    assert.match(workflow, /PULLOPS_GITHUB_TOKEN: \$\{\{ secrets\.PULLOPS_GITHUB_TOKEN \}\}/);
    assert.doesNotMatch(workflow, /openai\/codex-action|codex-action|--runner/);
    assert.doesNotMatch(workflow, /OPENAI_API_KEY/);
  });

  it('02: is dispatched by the pull request operation label', async () => {
    const workflow = await readFile(dispatchWorkflowUrl, 'utf8');

    assert.match(workflow, /github\.event\.label\.name == 'pullops:pr:update-branch'/);
    assert.match(workflow, /'pullops:pr:update-branch': 'pullops-pr-update-branch\.yml'/);
    assert.match(
      workflow,
      /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
    );
  });
});
