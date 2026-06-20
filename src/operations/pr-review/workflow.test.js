import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const prReviewWorkflowUrl = new URL(
  '../../../.github/workflows/pullops-pr-review.yml',
  import.meta.url,
);

describe('pullops-pr-review workflow', () => {
  it('01: captures the prepare JSON and feeds the selected model into Codex Action', async () => {
    const workflow = await readFile(prReviewWorkflowUrl, 'utf8');

    assert.match(workflow, /> "\$PREPARE_JSON"/);
    assert.match(workflow, /PREPARE_JSON: \$\{\{ runner\.temp \}\}\/pullops-output\/prepare\.json/);
    assert.match(workflow, /model: \$\{\{ steps\.prepare\.outputs\.model \}\}/);
  });

  it('02: still runs Codex only when the prepare step produced a prompt', async () => {
    const workflow = await readFile(prReviewWorkflowUrl, 'utf8');

    assert.match(workflow, /if: steps\.prepare\.outputs\.run_runner == 'true'/);
    assert.match(workflow, /if: always\(\)/);
  });
});
