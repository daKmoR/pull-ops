import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import {
  getOperationCatalogOperationLabelReference,
  getOperationCatalogWorkflowFileName,
} from '../operationCatalog.js';

const autoAdvanceWorkflowUrl = new URL(
  '../../../.github/workflows/pullops-spec-auto-advance.yml',
  import.meta.url,
);
const autoCompleteWorkflowUrl = new URL(
  '../../../.github/workflows/pullops-spec-auto-complete.yml',
  import.meta.url,
);
const dispatchWorkflowUrl = new URL(
  '../../../.github/workflows/pullops-dispatch.yml',
  import.meta.url,
);

describe('Spec automation workflows', () => {
  it('01: runs auto-advance as a thin deterministic Spec operation workflow', async () => {
    const workflow = await readFile(autoAdvanceWorkflowUrl, 'utf8');
    const workflowFileName = getOperationCatalogWorkflowFileName('spec-auto-advance');

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
      /npm exec pullops -- run spec-auto-advance --issue \$\{\{ inputs\.issue \}\}/,
    );
    assert.equal(workflowFileName, 'pullops-spec-auto-advance.yml');
    assert.match(
      workflow,
      /git remote set-url origin "https:\/\/x-access-token:\$\{PULLOPS_GITHUB_TOKEN\}@github\.com\/\$\{GITHUB_REPOSITORY\}\.git"/,
    );
    assert.doesNotMatch(workflow, /openai\/codex-action|codex-action|--runner/);
  });

  it('02: runs auto-complete as a thin deterministic Spec operation workflow', async () => {
    const workflow = await readFile(autoCompleteWorkflowUrl, 'utf8');
    const workflowFileName = getOperationCatalogWorkflowFileName('spec-auto-complete');

    assert.equal(
      workflow.includes(['on:', '  workflow_dispatch:', '    inputs:'].join('\n')),
      true,
    );
    assert.match(
      workflow,
      /npm exec pullops -- run spec-auto-complete --issue \$\{\{ inputs\.issue \}\}/,
    );
    assert.equal(workflowFileName, 'pullops-spec-auto-complete.yml');
    assert.match(workflow, /pullops-spec-auto-complete-\$\{\{ inputs\.issue \}\}/);
    assert.doesNotMatch(workflow, /openai\/codex-action|codex-action|--runner/);
  });

  it('03: dispatches both Spec automation mode labels', async () => {
    const workflow = await readFile(dispatchWorkflowUrl, 'utf8');
    const autoAdvanceLabelReference = requireOperationLabelReference('spec:auto-advance');
    const autoCompleteLabelReference = requireOperationLabelReference('spec:auto-complete');
    const autoAdvanceWorkflowFileName = requireOperationWorkflowFileName('spec-auto-advance');
    const autoCompleteWorkflowFileName = requireOperationWorkflowFileName('spec-auto-complete');

    assert.match(
      workflow,
      new RegExp(`github\\.event\\.label\\.name == '${autoAdvanceLabelReference.label}'`),
    );
    assert.match(
      workflow,
      new RegExp(`github\\.event\\.label\\.name == '${autoCompleteLabelReference.label}'`),
    );
    assert.match(
      workflow,
      new RegExp(
        `'${autoAdvanceLabelReference.label}': '${autoAdvanceWorkflowFileName.replaceAll(
          '.',
          '\\.',
        )}'`,
      ),
    );
    assert.match(
      workflow,
      new RegExp(
        `'${autoCompleteLabelReference.label}': '${autoCompleteWorkflowFileName.replaceAll(
          '.',
          '\\.',
        )}'`,
      ),
    );
  });
});

/**
 * @param {string} reference
 * @returns {import('../types.js').OperationLabelReference}
 */
function requireOperationLabelReference(reference) {
  const operationLabelReference = getOperationCatalogOperationLabelReference(reference);
  if (operationLabelReference === undefined) {
    throw new Error(`${reference} label reference is missing from the operation catalog.`);
  }

  return operationLabelReference;
}

/**
 * @param {string} operationName
 * @returns {string}
 */
function requireOperationWorkflowFileName(operationName) {
  const workflowFileName = getOperationCatalogWorkflowFileName(operationName);
  if (workflowFileName === undefined) {
    throw new Error(`${operationName} workflow file name is missing from the operation catalog.`);
  }

  return workflowFileName;
}
