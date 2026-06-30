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
  getOperationCatalogSupportedRunnerLifecycles,
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
    assert.deepEqual(getOperationCatalogSupportedRunnerLifecycles('prd-prepare'), [
      ['codex-cli', 'run'],
    ]);
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
    assert.equal(getOperationCatalogHandler('prd-prepare', 'prepare'), undefined);
  });

  it('02: returns the issue:implement operation facts from purpose-specific lookups', () => {
    assert.deepEqual(getOperationCatalogWorkflowOperation('issue-implement'), {
      name: 'issue-implement',
      target: 'issue',
      option: 'issue',
      configKey: 'issueImplement',
    });
    assert.deepEqual(getOperationCatalogOperationLabelReference('issue:implement'), {
      reference: 'issue:implement',
      workflowOperationName: 'issue-implement',
      target: 'issue',
      label: 'pullops:issue:implement',
    });
    assert.deepEqual(getOperationCatalogDefaultOperationSettings('issue-implement'), {
      modelTier: 'high',
    });
    assert.deepEqual(getOperationCatalogLabelDefinition('issue-implement'), {
      name: 'pullops:issue:implement',
      color: '5319E7',
      description:
        'Implement one concrete issue through review and finalization. Does not coordinate child issues.',
    });
    assert.equal(
      getOperationCatalogWorkflowFileName('issue-implement'),
      'pullops-issue-implement.yml',
    );
    assert.equal(
      getOperationCatalogPackageScriptName('issue-implement'),
      'pullops:issue-implement',
    );
    assert.equal(Object.hasOwn(packageJson.scripts, 'pullops:issue-implement'), true);
    assert.deepEqual(getOperationCatalogSupportedRunnerLifecycles('issue-implement'), [
      ['codex-cli', 'run'],
      ['codex-action', 'prepare'],
      ['codex-action', 'finalize'],
    ]);
    assert.deepEqual(getOperationCatalogSupportedRunnerAdapters('issue-implement'), [
      'codex-cli',
      'codex-action',
    ]);
    assert.deepEqual(getOperationCatalogSupportedRunnerPhases('issue-implement'), [
      'run',
      'prepare',
      'finalize',
    ]);
    assert.equal(
      supportsOperationCatalogRunnerLifecycle('issue-implement', {
        phase: 'run',
        runnerAdapter: 'codex-cli',
      }),
      true,
    );
    assert.equal(
      supportsOperationCatalogRunnerLifecycle('issue-implement', {
        phase: 'prepare',
        runnerAdapter: 'codex-action',
      }),
      true,
    );
    assert.equal(
      supportsOperationCatalogRunnerLifecycle('issue-implement', {
        phase: 'finalize',
        runnerAdapter: 'codex-action',
      }),
      true,
    );
    assert.equal(
      supportsOperationCatalogRunnerLifecycle('issue-implement', {
        phase: 'run',
        runnerAdapter: 'codex-action',
      }),
      false,
    );
    assert.equal(
      supportsOperationCatalogRunnerLifecycle('issue-implement', {
        phase: 'prepare',
        runnerAdapter: 'codex-cli',
      }),
      false,
    );
    assert.equal(typeof getOperationCatalogHandler('issue-implement'), 'function');
    assert.equal(typeof getOperationCatalogHandler('issue-implement', 'prepare'), 'function');
    assert.equal(typeof getOperationCatalogHandler('issue-implement', 'finalize'), 'function');
  });

  it('03: returns the prd:auto-advance and prd:auto-complete operation facts from purpose-specific lookups', () => {
    for (const [operationName, labelReference, labelName, description] of [
      [
        'prd-auto-advance',
        'prd:auto-advance',
        'pullops:prd:auto-advance',
        'Prepare a PRD and drain the current unblocked child frontier.',
      ],
      [
        'prd-auto-complete',
        'prd:auto-complete',
        'pullops:prd:auto-complete',
        'Complete a PRD through child PRs, umbrella integration, and finalization; humans merge umbrella PR.',
      ],
    ]) {
      assert.deepEqual(getOperationCatalogWorkflowOperation(operationName), {
        name: operationName,
        target: 'issue',
        option: 'issue',
        configKey: operationName === 'prd-auto-advance' ? 'prdAutoAdvance' : 'prdAutoComplete',
      });
      assert.deepEqual(getOperationCatalogOperationLabelReference(labelReference), {
        reference: labelReference,
        workflowOperationName: operationName,
        target: 'issue',
        label: labelName,
      });
      assert.deepEqual(getOperationCatalogDefaultOperationSettings(operationName), {
        modelTier: 'low',
      });
      assert.deepEqual(getOperationCatalogLabelDefinition(operationName), {
        name: labelName,
        color: '5319E7',
        description,
      });
      assert.equal(
        getOperationCatalogWorkflowFileName(operationName),
        `pullops-${operationName}.yml`,
      );
      assert.equal(getOperationCatalogPackageScriptName(operationName), `pullops:${operationName}`);
      assert.equal(Object.hasOwn(packageJson.scripts, `pullops:${operationName}`), true);
      assert.deepEqual(getOperationCatalogSupportedRunnerLifecycles(operationName), [
        ['codex-cli', 'run'],
      ]);
      assert.deepEqual(getOperationCatalogSupportedRunnerAdapters(operationName), ['codex-cli']);
      assert.deepEqual(getOperationCatalogSupportedRunnerPhases(operationName), ['run']);
      assert.equal(
        supportsOperationCatalogRunnerLifecycle(operationName, {
          phase: 'run',
          runnerAdapter: 'codex-cli',
        }),
        true,
      );
      assert.equal(
        supportsOperationCatalogRunnerLifecycle(operationName, {
          phase: 'prepare',
          runnerAdapter: 'codex-action',
        }),
        false,
      );
      assert.equal(typeof getOperationCatalogHandler(operationName), 'function');
      assert.equal(getOperationCatalogHandler(operationName, 'prepare'), undefined);
      assert.equal(getOperationCatalogHandler(operationName, 'finalize'), undefined);
    }
  });

  it('04: returns nothing for operations outside the catalog-owned slices', () => {
    assert.equal(getOperationCatalogWorkflowOperation('pr-review'), undefined);
    assert.equal(getOperationCatalogOperationLabelReference('pr:review'), undefined);
    assert.equal(getOperationCatalogDefaultOperationSettings('pr-review'), undefined);
    assert.equal(getOperationCatalogLabelDefinition('pr-review'), undefined);
    assert.equal(getOperationCatalogWorkflowFileName('pr-review'), undefined);
    assert.equal(getOperationCatalogPackageScriptName('pr-review'), undefined);
    assert.equal(
      supportsOperationCatalogRunnerLifecycle('pr-review', {
        phase: 'run',
        runnerAdapter: 'codex-cli',
      }),
      false,
    );
    assert.equal(getOperationCatalogHandler('pr-review'), undefined);
  });
});
