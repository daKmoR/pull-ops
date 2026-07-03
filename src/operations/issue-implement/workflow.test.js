import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const issueImplementWorkflowUrl = new URL(
  '../../../.github/workflows/pullops-issue-implement.yml',
  import.meta.url,
);

describe('pullops-issue-implement workflow', () => {
  it('01: wires issue implementation through the external runner contract', async () => {
    const workflow = await readFile(issueImplementWorkflowUrl, 'utf8');

    assert.match(workflow, /npm exec pullops -- run issue-implement/);
    assert.match(workflow, /--phase prepare/);
    assert.match(workflow, /--phase complete/);
    assert.match(workflow, /--runner external/);
    assert.match(workflow, /> "\$PREPARE_JSON"/);
    assert.match(workflow, /PREPARE_JSON: \$\{\{ runner\.temp \}\}\/pullops-output\/prepare\.json/);
    assert.match(workflow, /const \{ runnerJob \} = JSON\.parse/);
    assert.match(workflow, /prompt_file=\$\{runnerJob\.promptFile\}/);
    assert.match(workflow, /output_file=\$\{runnerJob\.outputFile\}/);
    assert.match(workflow, /result_file=\$\{runnerJob\.resultFile\}/);
    assert.match(workflow, /prompt-file: \$\{\{ steps\.prepare\.outputs\.prompt_file \}\}/);
    assert.match(workflow, /output-file: \$\{\{ steps\.prepare\.outputs\.output_file \}\}/);
    assert.match(workflow, /model: \$\{\{ steps\.prepare\.outputs\.model \}\}/);
    assert.match(workflow, /uses: openai\/codex-action@v1/);
    assert.doesNotMatch(workflow, /--runner codex-action/);
    assert.doesNotMatch(workflow, /--phase finalize/);
    assert.doesNotMatch(workflow, /codex_prompt\.md|codex_output\.json/);
  });

  it('02: records every runner outcome before complete runs', async () => {
    const workflow = await readFile(issueImplementWorkflowUrl, 'utf8');

    assert.match(workflow, /name: Record successful runner result/);
    assert.match(workflow, /name: Record failed runner result/);
    assert.match(workflow, /name: Record cancelled runner result/);
    assert.match(workflow, /name: Record skipped runner result/);
    assert.match(workflow, /steps\.codex\.outcome == 'success'/);
    assert.match(
      workflow,
      /steps\.codex\.outcome != 'success' && steps\.codex\.outcome != 'cancelled'/,
    );
    assert.match(workflow, /steps\.codex\.outcome == 'cancelled'/);
    assert.match(workflow, /steps\.prepare\.outputs\.run_runner != 'true'/);
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

    assert.ok(
      workflow.indexOf('name: Record successful runner result') <
        workflow.indexOf('name: Complete PullOps implement issue'),
    );
    assert.ok(
      workflow.indexOf('name: Record skipped runner result') <
        workflow.indexOf('name: Complete PullOps implement issue'),
    );
  });
});
