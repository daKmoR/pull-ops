import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const prResolveConflictsWorkflowUrl = new URL(
  '../../../.github/workflows/pullops-pr-resolve-conflicts.yml',
  import.meta.url,
);
const dispatchWorkflowUrl = new URL(
  '../../../.github/workflows/pullops-dispatch.yml',
  import.meta.url,
);

describe('pullops-pr-resolve-conflicts workflow', () => {
  it('01: runs a bounded Codex Action conflict-resolution loop', async () => {
    const workflow = await readFile(prResolveConflictsWorkflowUrl, 'utf8');

    assert.equal(
      workflow.includes(['on:', '  workflow_dispatch:', '    inputs:'].join('\n')),
      true,
    );
    assert.match(workflow, /pullRequest\.head\.repo\?\.full_name !== `\$\{owner\}\/\$\{repo\}`/);
    assert.match(workflow, /node src\/cli\/cli\.js run pr-resolve-conflicts/);
    assert.match(workflow, /--phase prepare/);
    assert.match(workflow, /--phase finalize/);
    assert.match(workflow, /openai\/codex-action@v1/);
    assert.match(workflow, /Run Codex conflict pass 1/);
    assert.match(workflow, /Run Codex conflict pass 2/);
    assert.match(workflow, /Run Codex conflict pass 3/);
    assert.match(
      workflow,
      /git remote set-url origin "https:\/\/x-access-token:\$\{PULLOPS_GITHUB_TOKEN\}@github\.com\/\$\{GITHUB_REPOSITORY\}\.git"/,
    );
    assert.match(workflow, /GITHUB_TOKEN: \$\{\{ secrets\.PULLOPS_GITHUB_TOKEN \}\}/);
    assert.match(workflow, /PULLOPS_GITHUB_TOKEN: \$\{\{ secrets\.PULLOPS_GITHUB_TOKEN \}\}/);
  });

  it('02: is dispatched by the pull request operation label', async () => {
    const workflow = await readFile(dispatchWorkflowUrl, 'utf8');

    assert.match(workflow, /github\.event\.label\.name == 'pullops:pr:resolve-conflicts'/);
    assert.match(workflow, /'pullops:pr:resolve-conflicts': 'pullops-pr-resolve-conflicts\.yml'/);
    assert.match(
      workflow,
      /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
    );
  });
});
