import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  getOperationCatalogDefaultOperationSettings,
  getOperationCatalogHandler,
  getOperationCatalogLabelDefinition,
  getOperationCatalogOperationLabelReference,
  getOperationCatalogPackageScriptName,
  getOperationCatalogSupportedRunnerAdapters,
  getOperationCatalogSupportedRunnerPhases,
  getOperationCatalogWorkflowFileName,
  getOperationCatalogWorkflowOperation,
  supportsOperationCatalogRunnerLifecycle,
} from './operationCatalog.js';

const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);

describe('operationCatalog', () => {
  it('01: returns the prd:prepare operation facts from purpose-specific lookups', () => {
    assert.deepEqual(getOperationCatalogWorkflowOperation('prd-prepare'), {
      name: 'prd-prepare',
      target: 'issue',
      option: 'issue',
      configKey: 'prdPrepare',
    });
    assert.deepEqual(getOperationCatalogOperationLabelReference('prd:prepare'), {
      reference: 'prd:prepare',
      workflowOperationName: 'prd-prepare',
      target: 'issue',
      label: 'pullops:prd:prepare',
    });
    assert.deepEqual(getOperationCatalogDefaultOperationSettings('prd-prepare'), {
      modelTier: 'low',
    });
    assert.deepEqual(getOperationCatalogLabelDefinition('prd-prepare'), {
      name: 'pullops:prd:prepare',
      color: '5319E7',
      description: 'Prepare an umbrella branch and draft PR for a PRD issue.',
    });
    assert.equal(getOperationCatalogWorkflowFileName('prd-prepare'), 'pullops-prd-prepare.yml');
    assert.equal(getOperationCatalogPackageScriptName('prd-prepare'), 'pullops:prd-prepare');
    assert.equal(Object.hasOwn(packageJson.scripts, 'pullops:prd-prepare'), true);
    assert.deepEqual(getOperationCatalogSupportedRunnerAdapters('prd-prepare'), ['codex-cli']);
    assert.deepEqual(getOperationCatalogSupportedRunnerPhases('prd-prepare'), ['run']);
    assert.equal(
      supportsOperationCatalogRunnerLifecycle('prd-prepare', {
        phase: 'run',
        runnerAdapter: 'codex-cli',
      }),
      true,
    );
    assert.equal(
      supportsOperationCatalogRunnerLifecycle('prd-prepare', {
        phase: 'prepare',
        runnerAdapter: 'codex-action',
      }),
      false,
    );
    assert.equal(typeof getOperationCatalogHandler('prd-prepare'), 'function');
  });

  it('02: returns nothing for operations outside the prd:prepare catalog slice', () => {
    assert.equal(getOperationCatalogWorkflowOperation('issue-implement'), undefined);
    assert.equal(getOperationCatalogOperationLabelReference('issue:implement'), undefined);
    assert.equal(getOperationCatalogDefaultOperationSettings('issue-implement'), undefined);
    assert.equal(getOperationCatalogLabelDefinition('issue-implement'), undefined);
    assert.equal(getOperationCatalogWorkflowFileName('issue-implement'), undefined);
    assert.equal(getOperationCatalogPackageScriptName('issue-implement'), undefined);
    assert.equal(
      supportsOperationCatalogRunnerLifecycle('issue-implement', {
        phase: 'run',
        runnerAdapter: 'codex-cli',
      }),
      false,
    );
    assert.equal(getOperationCatalogHandler('issue-implement'), undefined);
  });
});
