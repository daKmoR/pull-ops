import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { requireOperationCatalogOperationLabelName } from '../operations/operationCatalog.js';
import {
  MANAGED_PR_OPERATION_NAMES,
  chooseNextManagedPrOperationFromState,
  getAllowedManagedPrOutcomeKinds,
  getAllowedNextManagedPrOperations,
  getBlockedManagedPrFollowUpOperations,
  getNextManagedPrOperation,
  isManagedPrTransitionAllowed,
  resolveNextManagedPrOperation,
  validateManagedPrOutcome,
} from './transitionPolicy.js';

describe('transitionPolicy graph', () => {
  it('01: routes every allowed outcome of every operation to a workflow operation or terminal', () => {
    for (const operation of MANAGED_PR_OPERATION_NAMES) {
      for (const outcomeKind of getAllowedManagedPrOutcomeKinds(operation)) {
        const next = getNextManagedPrOperation({ operation, outcomeKind });
        assert.ok(
          next === undefined || MANAGED_PR_OPERATION_NAMES.includes(next),
          `${operation} + ${outcomeKind} routed to unknown operation ${next}.`,
        );
      }
    }
  });

  it('02: every blocked outcome is terminal', () => {
    for (const operation of MANAGED_PR_OPERATION_NAMES) {
      assert.equal(getNextManagedPrOperation({ operation, outcomeKind: 'blocked' }), undefined);
    }
  });

  it('03: success edges cannot loop without passing through pr-review', () => {
    // The only cycles in the graph must include pr-review, whose Run Budget
    // and no-progress gates (ADR-0067) bound automation. Walk success edges
    // from each operation while pretending pr-review is absorbing.
    for (const start of MANAGED_PR_OPERATION_NAMES) {
      /** @type {Set<string>} */
      const visited = new Set();
      /** @type {import('./transitionPolicy.types.js').ManagedPrOperationName | undefined} */
      let operation = start;
      while (operation !== undefined && operation !== 'pr-review') {
        assert.ok(!visited.has(operation), `success edges loop without review via ${operation}.`);
        visited.add(operation);
        const [firstNonBlockedKind] = getAllowedManagedPrOutcomeKinds(operation).filter(
          kind => kind !== 'blocked',
        );
        operation = getNextManagedPrOperation({ operation, outcomeKind: firstNonBlockedKind });
      }
    }
  });

  it('04: an approving review routes to pr-finalize until finalize was the last operation', () => {
    assert.equal(
      getNextManagedPrOperation({ operation: 'pr-review', outcomeKind: 'approved' }),
      'pr-finalize',
    );
    assert.equal(
      getNextManagedPrOperation({
        operation: 'pr-review',
        outcomeKind: 'approved',
        state: { lastOperation: requireOperationCatalogOperationLabelName('pr-finalize') },
      }),
      undefined,
    );
  });

  it('05: rejects outcome kinds the graph has no edge for', () => {
    assert.throws(
      () => getNextManagedPrOperation({ operation: 'pr-review', outcomeKind: 'aproved' }),
      /aproved is not a valid pullops:pr:review PullOps-Managed PR outcome\./,
    );
    assert.throws(
      () => validateManagedPrOutcome('pr-fix-ci', 'ready'),
      /ready is not a valid pullops:pr:fix-ci PullOps-Managed PR outcome\./,
    );
  });

  it('06: blocked pr-address-review and pr-fix-ci hand the PR back to review', () => {
    assert.deepEqual(getBlockedManagedPrFollowUpOperations('pr-address-review'), ['pr-review']);
    assert.deepEqual(getBlockedManagedPrFollowUpOperations('pr-fix-ci'), ['pr-review']);
    assert.deepEqual(getBlockedManagedPrFollowUpOperations('pr-review'), []);
  });

  it('07: exhaustively resolves every edge and blocked follow-up to a terminal or known operation', () => {
    // Probe every edge with routing states that drive any state predicate down
    // both branches: a fresh workflow, and one whose last operation finalized
    // the PR (the true branch of the pr-review approved predicate).
    /** @type {(import('./transitionPolicy.types.js').ManagedPrRoutingState | undefined)[]} */
    const routingStates = [
      undefined,
      { lastOperation: requireOperationCatalogOperationLabelName('pr-finalize') },
    ];

    for (const operation of MANAGED_PR_OPERATION_NAMES) {
      for (const outcomeKind of getAllowedManagedPrOutcomeKinds(operation)) {
        /** @type {Set<string | undefined>} */
        const resolutions = new Set();
        for (const state of routingStates) {
          const next = getNextManagedPrOperation({ operation, outcomeKind, state });
          assert.ok(
            next === undefined || MANAGED_PR_OPERATION_NAMES.includes(next),
            `${operation} + ${outcomeKind} with state ${JSON.stringify(state)} routed to unknown operation ${next}.`,
          );
          resolutions.add(next);
        }

        if (operation === 'pr-review' && outcomeKind === 'approved') {
          assert.equal(
            resolutions.size,
            2,
            'the pr-review approved predicate must resolve both branches across the probed states.',
          );
        }
      }

      for (const followUp of getBlockedManagedPrFollowUpOperations(operation)) {
        assert.ok(
          MANAGED_PR_OPERATION_NAMES.includes(followUp),
          `${operation} blocked follow-up ${followUp} is not a workflow operation.`,
        );
      }
    }
  });
});

describe('chooseNextManagedPrOperationFromState', () => {
  it('01: routes a reviewed tree or approved review to pr-finalize', () => {
    assert.equal(
      chooseNextManagedPrOperationFromState({ state: { reviewedTreeHash: 'abc' } }),
      'pr-finalize',
    );
    assert.equal(
      chooseNextManagedPrOperationFromState({ state: { status: 'Review approved' } }),
      'pr-finalize',
    );
  });

  it('02: routes requested changes to pr-address-review', () => {
    assert.equal(
      chooseNextManagedPrOperationFromState({ state: { status: 'Changes requested' } }),
      'pr-address-review',
    );
  });

  it('03: routes addressed feedback and fresh implementations to pr-review', () => {
    assert.equal(
      chooseNextManagedPrOperationFromState({ state: { status: 'Review feedback addressed' } }),
      'pr-review',
    );
    assert.equal(
      chooseNextManagedPrOperationFromState({
        state: {
          lastOperation: requireOperationCatalogOperationLabelName('issue-implement'),
        },
      }),
      'pr-review',
    );
  });

  it('04: waits when the recorded state implies no next operation', () => {
    assert.equal(chooseNextManagedPrOperationFromState({ state: {} }), undefined);
    assert.equal(
      chooseNextManagedPrOperationFromState({ state: { status: 'Review required' } }),
      undefined,
    );
  });

  it('05: local-drive also reviews after finalize and on required review status', () => {
    assert.equal(
      chooseNextManagedPrOperationFromState({
        state: { status: 'Review required' },
        profile: 'local-drive',
      }),
      'pr-review',
    );
    assert.equal(
      chooseNextManagedPrOperationFromState({
        state: { lastOperation: requireOperationCatalogOperationLabelName('pr-finalize') },
        profile: 'local-drive',
      }),
      'pr-review',
    );
  });

  it('06: prefers an explicit status override over recorded state status', () => {
    assert.equal(
      chooseNextManagedPrOperationFromState({
        state: { status: undefined },
        status: 'Changes requested',
      }),
      'pr-address-review',
    );
  });
});

describe('resolveNextManagedPrOperation', () => {
  it('01: applies an allowed detour proposal', () => {
    assert.deepEqual(
      resolveNextManagedPrOperation({
        operation: 'pr-review',
        outcomeKind: 'changes-requested',
        proposedOperation: 'pr-fix-ci',
      }),
      { nextOperation: 'pr-fix-ci', proposalApplied: true },
    );
  });

  it('02: applies a proposal that names the default continuation', () => {
    assert.deepEqual(
      resolveNextManagedPrOperation({
        operation: 'pr-review',
        outcomeKind: 'changes-requested',
        proposedOperation: 'pr-address-review',
      }),
      { nextOperation: 'pr-address-review', proposalApplied: true },
    );
  });

  it('03: falls back to the default edge for a proposal the graph has no edge for', () => {
    assert.deepEqual(
      resolveNextManagedPrOperation({
        operation: 'pr-review',
        outcomeKind: 'changes-requested',
        proposedOperation: 'pr-finalize',
      }),
      { nextOperation: 'pr-address-review', proposalApplied: false },
    );
  });

  it('04: routes by the default edge when no proposal is supplied', () => {
    assert.deepEqual(
      resolveNextManagedPrOperation({
        operation: 'pr-fix-ci',
        outcomeKind: 'fixed',
      }),
      { nextOperation: 'pr-review', proposalApplied: false },
    );
  });

  it('05: a proposal can never revive a terminal outcome', () => {
    assert.deepEqual(
      resolveNextManagedPrOperation({
        operation: 'pr-review',
        outcomeKind: 'blocked',
        proposedOperation: 'pr-review',
      }),
      { nextOperation: undefined, proposalApplied: false },
    );
  });

  it('06: every allowed continuation funnels back through pr-review before finalize', () => {
    for (const operation of MANAGED_PR_OPERATION_NAMES) {
      for (const outcomeKind of getAllowedManagedPrOutcomeKinds(operation)) {
        for (const allowed of getAllowedNextManagedPrOperations({ operation, outcomeKind })) {
          assert.ok(
            isManagedPrTransitionAllowed({
              operation,
              outcomeKind,
              proposedOperation: allowed,
            }),
            `${operation} + ${outcomeKind} must allow its own continuation ${allowed}`,
          );
          if (operation !== 'pr-review') {
            assert.notEqual(
              allowed,
              'pr-finalize',
              `${operation} + ${outcomeKind} must not offer pr-finalize without a fresh review`,
            );
          }
        }
      }
    }
  });
});
