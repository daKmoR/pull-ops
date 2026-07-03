import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  getOperationCatalogDefaultOperationSettings,
  getOperationCatalogHandler,
  getOperationCatalogLabelDefinitions,
  getOperationCatalogLabelDefinition,
  getOperationCatalogOperationLabelName,
  getOperationCatalogOperationLabelNames,
  getOperationCatalogOperationLabelNamesForTarget,
  getOperationCatalogOperationLabelReference,
  getOperationCatalogOperationLabelReferenceForWorkflowOperation,
  getOperationCatalogOperationLabelReferences,
  getOperationCatalogPackageScriptName,
  getOperationCatalogSupportedRunnerAdapters,
  getOperationCatalogSupportedRunnerLifecycles,
  getOperationCatalogSupportedRunnerPhases,
  getOperationCatalogWorkflowOperations,
  getOperationCatalogWorkflowFileName,
  getOperationCatalogWorkflowOperation,
  requireOperationCatalogOperationLabelName,
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
    assert.deepEqual(
      getOperationCatalogOperationLabelReferenceForWorkflowOperation('prd-prepare'),
      {
        reference: 'prd:prepare',
        workflowOperationName: 'prd-prepare',
        target: 'issue',
        label: 'pullops:prd:prepare',
      },
    );
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
        runnerAdapter: 'external',
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
    assert.deepEqual(getOperationCatalogSupportedRunnerLifecycles('issue-implement'), [
      ['codex-cli', 'run'],
      ['external', 'prepare'],
      ['external', 'complete'],
    ]);
    assert.deepEqual(getOperationCatalogSupportedRunnerAdapters('issue-implement'), [
      'codex-cli',
      'external',
    ]);
    assert.deepEqual(getOperationCatalogSupportedRunnerPhases('issue-implement'), [
      'run',
      'prepare',
      'complete',
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
        runnerAdapter: 'external',
      }),
      true,
    );
    assert.equal(
      supportsOperationCatalogRunnerLifecycle('issue-implement', {
        phase: 'complete',
        runnerAdapter: 'external',
      }),
      true,
    );
    assert.equal(
      supportsOperationCatalogRunnerLifecycle('issue-implement', {
        phase: 'run',
        runnerAdapter: 'external',
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
    assert.equal(typeof getOperationCatalogHandler('issue-implement', 'complete'), 'function');
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
      assert.deepEqual(
        getOperationCatalogOperationLabelReferenceForWorkflowOperation(operationName),
        {
          reference: labelReference,
          workflowOperationName: operationName,
          target: 'pr',
          label: labelName,
        },
      );
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
      assert.deepEqual(getOperationCatalogSupportedRunnerLifecycles(operationName), [
        ['codex-cli', 'run'],
        ['external', 'prepare'],
        ['external', 'complete'],
      ]);
      assert.deepEqual(getOperationCatalogSupportedRunnerAdapters(operationName), [
        'codex-cli',
        'external',
      ]);
      assert.deepEqual(getOperationCatalogSupportedRunnerPhases(operationName), [
        'run',
        'prepare',
        'complete',
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
          runnerAdapter: 'external',
        }),
        true,
      );
      assert.equal(
        supportsOperationCatalogRunnerLifecycle(operationName, {
          phase: 'complete',
          runnerAdapter: 'external',
        }),
        true,
      );
      assert.equal(
        supportsOperationCatalogRunnerLifecycle(operationName, {
          phase: 'run',
          runnerAdapter: 'external',
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
      assert.equal(typeof getOperationCatalogHandler(operationName, 'complete'), 'function');
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
      assert.deepEqual(
        getOperationCatalogOperationLabelReferenceForWorkflowOperation(operationName),
        {
          reference: labelReference,
          workflowOperationName: operationName,
          target: 'issue',
          label: labelName,
        },
      );
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
          runnerAdapter: 'external',
        }),
        false,
      );
      assert.equal(typeof getOperationCatalogHandler(operationName), 'function');
      assert.equal(getOperationCatalogHandler(operationName, 'prepare'), undefined);
      assert.equal(getOperationCatalogHandler(operationName, 'complete'), undefined);
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
          ['external', 'prepare'],
          ['external', 'complete'],
        ],
        supportedRunnerAdapters: ['codex-cli', 'external'],
        supportedRunnerPhases: ['run', 'prepare', 'complete'],
        supportedLifecycleChecks: /** @type {SupportedLifecycleCheck[]} */ ([
          ['run', 'codex-cli', true],
          ['prepare', 'external', true],
          ['complete', 'external', true],
          ['run', 'external', false],
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
          ['run', 'external', false],
          ['prepare', 'external', false],
          ['complete', 'external', false],
        ]),
        unsupportedHandlerPhases: ['prepare', 'complete'],
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
          ['external', 'prepare'],
          ['external', 'complete'],
        ],
        supportedRunnerAdapters: ['codex-cli', 'external'],
        supportedRunnerPhases: ['run', 'prepare', 'complete'],
        supportedLifecycleChecks: /** @type {SupportedLifecycleCheck[]} */ ([
          ['run', 'codex-cli', true],
          ['prepare', 'external', true],
          ['complete', 'external', true],
          ['run', 'external', false],
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
        getOperationCatalogOperationLabelReferenceForWorkflowOperation(operationName),
        {
          reference: labelReference,
          workflowOperationName: operationName,
          target: 'pr',
          label: labelName,
        },
      );
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
        assert.equal(
          getOperationCatalogHandler(
            operationName,
            /** @type {import('../cli/types.js').OperationPhase} */ (phase),
          ),
          undefined,
        );
      }
      if (operationName !== 'pr-update-branch') {
        assert.equal(typeof getOperationCatalogHandler(operationName, 'prepare'), 'function');
        assert.equal(typeof getOperationCatalogHandler(operationName, 'complete'), 'function');
      }
    }
  });

  it('06: returns nothing for operations outside the catalog-owned slices', () => {
    /** @type {Array<[string, string | undefined]>} */
    const cases = [
      ['pr-finalizex', 'pr:finalizex'],
      ['pr-close-child-issuex', undefined],
    ];

    for (const [operationName, labelReference] of cases) {
      assert.equal(getOperationCatalogWorkflowOperation(operationName), undefined);
      assert.equal(
        getOperationCatalogOperationLabelReference(
          labelReference === undefined ? 'pr-close-child-issue' : labelReference,
        ),
        undefined,
      );
      assert.equal(
        getOperationCatalogOperationLabelReferenceForWorkflowOperation(operationName),
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

  it('07: returns pr-finalize and pr-close-child-issue catalog facts without dispatching child closure', () => {
    assert.deepEqual(getOperationCatalogWorkflowOperation('pr-finalize'), {
      name: 'pr-finalize',
      target: 'pr',
      option: 'pr',
      configKey: 'prFinalize',
    });
    assert.deepEqual(getOperationCatalogOperationLabelReference('pr:finalize'), {
      reference: 'pr:finalize',
      workflowOperationName: 'pr-finalize',
      target: 'pr',
      label: 'pullops:pr:finalize',
    });
    assert.deepEqual(getOperationCatalogDefaultOperationSettings('pr-finalize'), {
      modelTier: 'high',
      aiHistoryCleanup: true,
    });
    assert.deepEqual(getOperationCatalogLabelDefinition('pr-finalize'), {
      name: 'pullops:pr:finalize',
      color: '5319E7',
      description: 'Finalize a PullOps-managed PR for human review and merge.',
    });
    assert.equal(getOperationCatalogWorkflowFileName('pr-finalize'), 'pullops-pr-finalize.yml');
    assert.equal(getOperationCatalogPackageScriptName('pr-finalize'), 'pullops:pr-finalize');
    assert.deepEqual(getOperationCatalogSupportedRunnerLifecycles('pr-finalize'), [
      ['codex-cli', 'run'],
      ['external', 'prepare'],
      ['external', 'complete'],
    ]);
    assert.deepEqual(getOperationCatalogSupportedRunnerAdapters('pr-finalize'), [
      'codex-cli',
      'external',
    ]);
    assert.deepEqual(getOperationCatalogSupportedRunnerPhases('pr-finalize'), [
      'run',
      'prepare',
      'complete',
    ]);
    assert.equal(typeof getOperationCatalogHandler('pr-finalize'), 'function');
    assert.equal(typeof getOperationCatalogHandler('pr-finalize', 'prepare'), 'function');
    assert.equal(typeof getOperationCatalogHandler('pr-finalize', 'complete'), 'function');

    assert.deepEqual(getOperationCatalogWorkflowOperation('pr-close-child-issue'), {
      name: 'pr-close-child-issue',
      target: 'pr',
      option: 'pr',
      configKey: 'prCloseChildIssue',
    });
    assert.equal(getOperationCatalogOperationLabelReference('pr-close-child-issue'), undefined);
    assert.equal(
      getOperationCatalogOperationLabelReferenceForWorkflowOperation('pr-close-child-issue'),
      undefined,
    );
    assert.deepEqual(getOperationCatalogDefaultOperationSettings('pr-close-child-issue'), {
      modelTier: 'low',
    });
    assert.equal(getOperationCatalogLabelDefinition('pr-close-child-issue'), undefined);
    assert.equal(
      getOperationCatalogWorkflowFileName('pr-close-child-issue'),
      'pullops-pr-close-child-issue.yml',
    );
    assert.equal(
      getOperationCatalogPackageScriptName('pr-close-child-issue'),
      'pullops:pr-close-child-issue',
    );
    assert.deepEqual(getOperationCatalogSupportedRunnerLifecycles('pr-close-child-issue'), [
      ['codex-cli', 'run'],
    ]);
    assert.deepEqual(getOperationCatalogSupportedRunnerAdapters('pr-close-child-issue'), [
      'codex-cli',
    ]);
    assert.deepEqual(getOperationCatalogSupportedRunnerPhases('pr-close-child-issue'), ['run']);
    assert.equal(typeof getOperationCatalogHandler('pr-close-child-issue'), 'function');
    assert.equal(getOperationCatalogHandler('pr-close-child-issue', 'prepare'), undefined);
    assert.equal(getOperationCatalogHandler('pr-close-child-issue', 'complete'), undefined);

    assert.ok(
      getOperationCatalogWorkflowOperations().some(operation => operation.name === 'pr-finalize'),
    );
    assert.ok(
      getOperationCatalogWorkflowOperations().some(
        operation => operation.name === 'pr-close-child-issue',
      ),
    );
    assert.ok(
      getOperationCatalogOperationLabelReferences().some(
        operation => operation.reference === 'pr:finalize',
      ),
    );
    assert.ok(
      !getOperationCatalogOperationLabelReferences().some(
        operation => operation.reference === 'pr-close-child-issue',
      ),
    );
  });

  it('08: keeps package script identity aligned with every catalog workflow operation', () => {
    const workflowOperations = getOperationCatalogWorkflowOperations();
    const expectedPackageScriptEntries = workflowOperations.map(operation => {
      const packageScriptName = getOperationCatalogPackageScriptName(operation.name);
      if (packageScriptName === undefined) {
        throw new Error(
          `${operation.name} package script identity is missing from the operation catalog.`,
        );
      }

      return [packageScriptName, `node src/cli/cli.js run ${operation.name}`];
    });

    assert.equal(
      new Set(expectedPackageScriptEntries.map(([packageScriptName]) => packageScriptName)).size,
      workflowOperations.length,
    );

    assert.deepEqual(
      Object.fromEntries(
        expectedPackageScriptEntries.map(([packageScriptName]) => [
          packageScriptName,
          packageJson.scripts[packageScriptName],
        ]),
      ),
      Object.fromEntries(expectedPackageScriptEntries),
    );
  });

  it('09: exposes operation label definitions and names from dispatchable catalog entries', () => {
    const operationLabelReferences = getOperationCatalogOperationLabelReferences();

    assert.deepEqual(
      getOperationCatalogLabelDefinitions().map(label => label.name),
      operationLabelReferences.map(operation => operation.label),
    );
    assert.deepEqual(
      getOperationCatalogOperationLabelNames(),
      operationLabelReferences.map(operation => operation.label),
    );
    assert.deepEqual(
      getOperationCatalogOperationLabelNamesForTarget('issue'),
      operationLabelReferences
        .filter(operation => operation.target === 'issue')
        .map(operation => operation.label),
    );
    assert.deepEqual(
      getOperationCatalogOperationLabelNamesForTarget('pr'),
      operationLabelReferences
        .filter(operation => operation.target === 'pr')
        .map(operation => operation.label),
    );
    assert.equal(getOperationCatalogOperationLabelName('pr-review'), 'pullops:pr:review');
    assert.equal(getOperationCatalogOperationLabelName('pr-close-child-issue'), undefined);
    assert.equal(requireOperationCatalogOperationLabelName('pr-review'), 'pullops:pr:review');
    assert.throws(
      () => requireOperationCatalogOperationLabelName('pr-close-child-issue'),
      /pr-close-child-issue label definition is missing from the operation catalog/,
    );
  });
});
