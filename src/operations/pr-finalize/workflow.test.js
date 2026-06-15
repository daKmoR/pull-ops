import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const prFinalizeWorkflowUrl = new URL(
  '../../../.github/workflows/pullops-pr-finalize.yml',
  import.meta.url,
);

describe('pullops-pr-finalize workflow', () => {
  it('01: authenticates git origin before deterministic prepare can push', async () => {
    const workflow = await readFile(prFinalizeWorkflowUrl, 'utf8');
    const prepareStep = readWorkflowStep(workflow, 'Prepare PullOps PR Finalize');

    const setOriginIndex = prepareStep.indexOf(
      'git remote set-url origin "https://x-access-token:${PULLOPS_GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"',
    );
    const runPrepareIndex = prepareStep.indexOf('node src/cli/cli.js run pr-finalize');

    assert.notEqual(setOriginIndex, -1);
    assert.notEqual(runPrepareIndex, -1);
    assert.equal(setOriginIndex < runPrepareIndex, true);
    assert.match(prepareStep, /GITHUB_TOKEN: \$\{\{ secrets\.PULLOPS_GITHUB_TOKEN \}\}/);
    assert.match(prepareStep, /PULLOPS_GITHUB_TOKEN: \$\{\{ secrets\.PULLOPS_GITHUB_TOKEN \}\}/);
  });
});

/**
 * @param {string} workflow
 * @param {string} name
 * @returns {string}
 */
function readWorkflowStep(workflow, name) {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `Expected workflow step "${name}"`);

  const next = workflow.indexOf('\n      - name: ', start + marker.length);
  return workflow.slice(start, next === -1 ? undefined : next);
}
