import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const prAddressReviewWorkflowUrl = new URL(
  '../../../.github/workflows/pullops-pr-address-review.yml',
  import.meta.url,
);

describe('pullops-pr-address-review workflow', () => {
  it('01: can run from manual dispatch or trusted human requested-change reviews', async () => {
    const workflow = await readFile(prAddressReviewWorkflowUrl, 'utf8');

    assert.equal(
      workflow.includes(['  pull_request_review:', '    types:', '      - submitted'].join('\n')),
      true,
    );
    assert.match(workflow, /reviewState !== 'changes_requested'/);
    assert.match(workflow, /github\.rest\.users\.getAuthenticated\(\)/);
    assert.match(workflow, /reviewer === tokenUser\.login/);
    assert.match(workflow, /github\.rest\.repos\.getCollaboratorPermissionLevel/);
    assert.match(workflow, /let permission = 'none'/);
    assert.match(workflow, /\['admin', 'maintain', 'write'\]\.includes\(permission\)/);
    assert.match(workflow, /core\.setOutput\('run_operation', 'false'\)/);
    assert.match(workflow, /core\.setOutput\('run_operation', 'true'\)/);
    assert.match(
      workflow,
      /github\.event_name == 'workflow_dispatch' && inputs\.pr \|\| github\.event\.pull_request\.number/,
    );
    assert.match(
      workflow,
      /github\.event_name == 'workflow_dispatch' && inputs\.head_ref \|\| github\.event\.pull_request\.head\.ref/,
    );
    assert.match(
      workflow,
      /github\.event_name == 'workflow_dispatch' && inputs\.trigger_actor \|\| github\.event\.review\.user\.login/,
    );
    assert.match(
      workflow,
      /github\.event_name == 'workflow_dispatch' && '' \|\| github\.event\.review\.node_id/,
    );
    assert.match(workflow, /review_id_args=\(--review-id "\$REVIEW_ID"\)/);
    assert.match(workflow, /--pr "\$PR"/);
  });

  it('02: skips checkout, runner, and finalize work when the native review gate declines', async () => {
    const workflow = await readFile(prAddressReviewWorkflowUrl, 'utf8');

    assert.match(workflow, /if: steps\.gate\.outputs\.run_operation == 'true'/);
    assert.match(workflow, /if: always\(\) && steps\.gate\.outputs\.run_operation == 'true'/);
    assert.match(workflow, /> "\$PREPARE_JSON"/);
    assert.match(workflow, /const \{ runnerJob,/);
    assert.match(workflow, /prompt_file=\$\{runnerJob\.promptFile\}/);
    assert.match(workflow, /output_file=\$\{runnerJob\.outputFile\}/);
    assert.match(workflow, /result_file=\$\{runnerJob\.resultFile\}/);
    assert.match(workflow, /PREPARE_JSON: \$\{\{ runner\.temp \}\}\/pullops-output\/prepare\.json/);
    assert.match(workflow, /prompt-file: \$\{\{ steps\.prepare\.outputs\.prompt_file \}\}/);
    assert.match(workflow, /output-file: \$\{\{ steps\.prepare\.outputs\.output_file \}\}/);
    assert.match(workflow, /model: \$\{\{ steps\.prepare\.outputs\.model \}\}/);
  });
});
