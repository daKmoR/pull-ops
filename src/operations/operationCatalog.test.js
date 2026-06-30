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

/**
 * @typedef {[import('../cli/types.js').OperationPhase, import('../runner/types.js').RunnerAdapter, boolean]} SupportedLifecycleCheck
 */

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

  it('03: returns the pr-review and pr-address-review operation facts from purpose-specific lookups', () => {
    for (const [operationName, labelReference, labelName, description, modelTier] of [
      ['pr-review', 'pr:review', 'pullops:pr:review', 'Run PullOps automated PR review.', 'high'],
      [
        'pr-address-review',
        'pr:address-review',
        'pullops:pr:address-review',
        'Address actionable PullOps PR review feedback.',
        'mid',
      ],
    ]) {
      assert.deepEqual(getOperationCatalogWorkflowOperation(operationName), {
        name: operationName,
        target: 'pr',
        option: 'pr',
        configKey: operationName === 'pr-review' ? 'prReview' : 'prAddressReview',
      });
      assert.deepEqual(getOperationCatalogOperationLabelReference(labelReference), {
        reference: labelReference,
        workflowOperationName: operationName,
        target: 'pr',
        label: labelName,
      });
      assert.deepEqual(getOperationCatalogDefaultOperationSettings(operationName), {
        modelTier,
        escalationModelTier: 'high',
        humanFeedbackResponseModelTier: 'high',
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
        ['codex-action', 'prepare'],
        ['codex-action', 'finalize'],
      ]);
      assert.deepEqual(getOperationCatalogSupportedRunnerAdapters(operationName), [
        'codex-cli',
        'codex-action',
      ]);
      assert.deepEqual(getOperationCatalogSupportedRunnerPhases(operationName), [
        'run',
        'prepare',
        'finalize',
      ]);
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
        true,
      );
      assert.equal(
        supportsOperationCatalogRunnerLifecycle(operationName, {
          phase: 'finalize',
          runnerAdapter: 'codex-action',
        }),
        true,
      );
      assert.equal(
        supportsOperationCatalogRunnerLifecycle(operationName, {
          phase: 'run',
          runnerAdapter: 'codex-action',
        }),
        false,
      );
      assert.equal(
        supportsOperationCatalogRunnerLifecycle(operationName, {
          phase: 'prepare',
          runnerAdapter: 'codex-cli',
        }),
        false,
      );
      assert.equal(typeof getOperationCatalogHandler(operationName), 'function');
      assert.equal(typeof getOperationCatalogHandler(operationName, 'prepare'), 'function');
      assert.equal(typeof getOperationCatalogHandler(operationName, 'finalize'), 'function');
    }
  });

  it('04: returns the prd:auto-advance and prd:auto-complete operation facts from purpose-specific lookups', () => {
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

  it('05: returns the pr-fix-ci, pr-update-branch, and pr-resolve-conflicts operation facts from purpose-specific lookups', () => {
    for (const {
      operationName,
      labelReference,
      labelName,
      description,
      defaultOperationSettings,
      supportedRunnerLifecycles,
      supportedRunnerAdapters,
      supportedRunnerPhases,
      supportedLifecycleChecks,
      unsupportedHandlerPhases = [],
    } of [
      {
        operationName: 'pr-fix-ci',
        labelReference: 'pr:fix-ci',
        labelName: 'pullops:pr:fix-ci',
        description: 'Classify and fix actionable CI failures.',
        defaultOperationSettings: {
          modelTier: 'mid',
        },
        supportedRunnerLifecycles: [
          ['codex-cli', 'run'],
          ['codex-action', 'prepare'],
          ['codex-action', 'finalize'],
        ],
        supportedRunnerAdapters: ['codex-cli', 'codex-action'],
        supportedRunnerPhases: ['run', 'prepare', 'finalize'],
        supportedLifecycleChecks: /** @type {SupportedLifecycleCheck[]} */ ([
          ['run', 'codex-cli', true],
          ['prepare', 'codex-action', true],
          ['finalize', 'codex-action', true],
          ['run', 'codex-action', false],
          ['prepare', 'codex-cli', false],
        ]),
        unsupportedHandlerPhases: [],
      },
      {
        operationName: 'pr-update-branch',
        labelReference: 'pr:update-branch',
        labelName: 'pullops:pr:update-branch',
        description: 'Update a same-repository PR branch.',
        defaultOperationSettings: {
          modelTier: 'low',
        },
        supportedRunnerLifecycles: [['codex-cli', 'run']],
        supportedRunnerAdapters: ['codex-cli'],
        supportedRunnerPhases: ['run'],
        supportedLifecycleChecks: /** @type {SupportedLifecycleCheck[]} */ ([
          ['run', 'codex-cli', true],
          ['run', 'codex-action', false],
          ['prepare', 'codex-action', false],
          ['finalize', 'codex-action', false],
        ]),
        unsupportedHandlerPhases: ['prepare', 'finalize'],
      },
      {
        operationName: 'pr-resolve-conflicts',
        labelReference: 'pr:resolve-conflicts',
        labelName: 'pullops:pr:resolve-conflicts',
        description: 'Resolve branch update conflicts with the PullOps runner.',
        defaultOperationSettings: {
          modelTier: 'high',
          maxConflictResolutionPasses: 3,
        },
        supportedRunnerLifecycles: [
          ['codex-cli', 'run'],
          ['codex-action', 'prepare'],
          ['codex-action', 'finalize'],
        ],
        supportedRunnerAdapters: ['codex-cli', 'codex-action'],
        supportedRunnerPhases: ['run', 'prepare', 'finalize'],
        supportedLifecycleChecks: /** @type {SupportedLifecycleCheck[]} */ ([
          ['run', 'codex-cli', true],
          ['prepare', 'codex-action', true],
          ['finalize', 'codex-action', true],
          ['run', 'codex-action', false],
          ['prepare', 'codex-cli', false],
        ]),
        unsupportedHandlerPhases: [],
      },
    ]) {
      assert.deepEqual(getOperationCatalogWorkflowOperation(operationName), {
        name: operationName,
        target: 'pr',
        option: 'pr',
        configKey:
          operationName === 'pr-fix-ci'
            ? 'prFixCi'
            : operationName === 'pr-update-branch'
              ? 'prUpdateBranch'
              : 'prResolveConflicts',
      });
      assert.deepEqual(getOperationCatalogOperationLabelReference(labelReference), {
        reference: labelReference,
        workflowOperationName: operationName,
        target: 'pr',
        label: labelName,
      });
      assert.deepEqual(
        getOperationCatalogDefaultOperationSettings(operationName),
        defaultOperationSettings,
      );
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
      assert.deepEqual(
        getOperationCatalogSupportedRunnerLifecycles(operationName),
        supportedRunnerLifecycles,
      );
      assert.deepEqual(
        getOperationCatalogSupportedRunnerAdapters(operationName),
        supportedRunnerAdapters,
      );
      assert.deepEqual(
        getOperationCatalogSupportedRunnerPhases(operationName),
        supportedRunnerPhases,
      );

      for (const [phase, runnerAdapter, expected] of supportedLifecycleChecks) {
        assert.equal(
          supportsOperationCatalogRunnerLifecycle(operationName, {
            phase,
            runnerAdapter,
          }),
          expected,
        );
      }

      assert.equal(typeof getOperationCatalogHandler(operationName), 'function');
      assert.equal(typeof getOperationCatalogHandler(operationName, 'run'), 'function');
      for (const phase of unsupportedHandlerPhases) {
        assert.equal(getOperationCatalogHandler(operationName, phase), undefined);
      }
      if (operationName !== 'pr-update-branch') {
        assert.equal(typeof getOperationCatalogHandler(operationName, 'prepare'), 'function');
        assert.equal(typeof getOperationCatalogHandler(operationName, 'finalize'), 'function');
      }
    }
  });

  it('06: returns nothing for operations outside the catalog-owned slices', () => {
    /** @type {Array<[string, string | undefined]>} */
    const cases = [
      ['pr-finalize', 'pr:finalize'],
      ['pr-close-child-issue', undefined],
    ];

    for (const [operationName, labelReference] of cases) {
      assert.equal(getOperationCatalogWorkflowOperation(operationName), undefined);
      assert.equal(
        getOperationCatalogOperationLabelReference(
          labelReference === undefined ? 'pr-close-child-issue' : labelReference,
        ),
        undefined,
      );
      assert.equal(getOperationCatalogDefaultOperationSettings(operationName), undefined);
      assert.equal(getOperationCatalogLabelDefinition(operationName), undefined);
      assert.equal(getOperationCatalogWorkflowFileName(operationName), undefined);
      assert.equal(getOperationCatalogPackageScriptName(operationName), undefined);
      assert.equal(
        supportsOperationCatalogRunnerLifecycle(operationName, {
          phase: 'run',
          runnerAdapter: 'codex-cli',
        }),
        false,
      );
      assert.equal(getOperationCatalogHandler(operationName), undefined);
    }
  });
});
