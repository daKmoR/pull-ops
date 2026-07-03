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
    assert.match(workflow, /npm exec pullops -- run pr-resolve-conflicts/);
    assert.match(workflow, /--phase prepare/);
    assert.match(workflow, /--phase complete/);
    assert.match(workflow, /--runner external/);
    assert.match(workflow, /PREPARE_JSON: \$\{\{ runner\.temp \}\}\/pullops-output\/prepare\.json/);
    assert.match(
      workflow,
      /COMPLETE_JSON: \$\{\{ runner\.temp \}\}\/pullops-output\/complete-1\.json/,
    );
    assert.match(
      workflow,
      /COMPLETE_JSON: \$\{\{ runner\.temp \}\}\/pullops-output\/complete-3\.json/,
    );
    assert.match(workflow, /> "\$PREPARE_JSON"/);
    assert.match(workflow, /> "\$COMPLETE_JSON"/);
    assert.match(workflow, /prompt-file: \$\{\{ steps\.prepare\.outputs\.prompt_file \}\}/);
    assert.match(workflow, /output-file: \$\{\{ steps\.prepare\.outputs\.output_file \}\}/);
    assert.match(workflow, /model: \$\{\{ steps\.prepare\.outputs\.model \}\}/);
    assert.match(workflow, /prompt-file: \$\{\{ steps\.complete_1\.outputs\.prompt_file \}\}/);
    assert.match(workflow, /output-file: \$\{\{ steps\.complete_1\.outputs\.output_file \}\}/);
    assert.match(workflow, /model: \$\{\{ steps\.complete_1\.outputs\.model \}\}/);
    assert.match(
      workflow,
      /npm exec pullops -- runner-result --status success --file "\$\{\{ steps\.prepare\.outputs\.result_file \}\}"/,
    );
    assert.match(
      workflow,
      /npm exec pullops -- runner-result --status failed --file "\$\{\{ steps\.prepare\.outputs\.result_file \}\}"/,
    );
    assert.match(
      workflow,
      /npm exec pullops -- runner-result --status cancelled --file "\$\{\{ steps\.prepare\.outputs\.result_file \}\}"/,
    );
    assert.match(
      workflow,
      /npm exec pullops -- runner-result --status skipped --file "\$\{\{ steps\.prepare\.outputs\.result_file \}\}"/,
    );
    assert.match(
      workflow,
      /npm exec pullops -- runner-result --status success --file "\$\{\{ steps\.complete_1\.outputs\.result_file \}\}"/,
    );
    assert.doesNotMatch(workflow, /if \[ -f "\$OUTPUT_DIR\/runner_prompt\.md" \]/);
    assert.doesNotMatch(workflow, /runner_outcome=/);
    assert.match(workflow, /openai\/codex-action@v1/);
    assert.match(workflow, /Run Codex conflict pass 1/);
    assert.match(workflow, /Run Codex conflict pass 2/);
    assert.match(workflow, /Run Codex conflict pass 3/);
    assert.match(workflow, /id: complete_3/);
    assert.match(workflow, /steps\.complete_3\.outputs\.run_runner == 'true'/);
    assert.match(workflow, /Rerun pullops setup github-actions/);
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
