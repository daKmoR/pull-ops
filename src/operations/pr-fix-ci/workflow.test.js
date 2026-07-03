import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { getOperationCatalogWorkflowFileName } from '../operationCatalog.js';

const prFixCiWorkflowUrl = new URL(
  '../../../.github/workflows/pullops-pr-fix-ci.yml',
  import.meta.url,
);
const dispatchWorkflowUrl = new URL(
  '../../../.github/workflows/pullops-dispatch.yml',
  import.meta.url,
);

describe('pullops-pr-fix-ci workflow', () => {
  it('01: runs as a codex-backed CI fix workflow and is dispatched by the pull request label', async () => {
    const workflow = await readFile(prFixCiWorkflowUrl, 'utf8');
    const workflowFileName = getOperationCatalogWorkflowFileName('pr-fix-ci');

    assert.equal(workflowFileName, 'pullops-pr-fix-ci.yml');
    assert.equal(
      workflow.includes(['on:', '  workflow_dispatch:', '    inputs:'].join('\n')),
      true,
    );
    assert.match(workflow, /github\.event_name == 'workflow_dispatch'/);
    assert.match(workflow, /github\.event_name == 'check_suite'/);
    assert.match(workflow, /npm exec pullops -- run pr-fix-ci/);
    assert.match(workflow, /--phase prepare/);
    assert.match(workflow, /--phase complete/);
    assert.match(workflow, /--runner external/);
    assert.match(workflow, /PREPARE_JSON: \$\{\{ runner\.temp \}\}\/pullops-output\/prepare\.json/);
    assert.match(workflow, /> "\$PREPARE_JSON"/);
    assert.match(workflow, /prompt-file: \$\{\{ steps\.prepare\.outputs\.prompt_file \}\}/);
    assert.match(workflow, /output-file: \$\{\{ steps\.prepare\.outputs\.output_file \}\}/);
    assert.match(workflow, /model: \$\{\{ steps\.prepare\.outputs\.model \}\}/);
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
    assert.doesNotMatch(workflow, /if \[ -f "\$OUTPUT_DIR\/runner_prompt\.md" \]/);
    assert.doesNotMatch(workflow, /runner_outcome=/);
    assert.match(workflow, /openai\/codex-action@v1/);
    assert.match(workflow, /Verify OpenAI API key/);
    assert.match(workflow, /Run Codex/);

    const dispatchWorkflow = await readFile(dispatchWorkflowUrl, 'utf8');
    assert.match(dispatchWorkflow, /github\.event\.label\.name == 'pullops:pr:fix-ci'/);
    assert.match(dispatchWorkflow, /'pullops:pr:fix-ci': 'pullops-pr-fix-ci\.yml'/);
    assert.match(
      dispatchWorkflow,
      /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
    );
  });
});
