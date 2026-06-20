import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { appendOperationAuditFooter, createOperationAuditComment } from './auditComment.js';

describe('Operation audit comments', () => {
  it('01: keeps standalone audit comments readable with a fallback summary', () => {
    const comment = createOperationAuditComment(createContext(), {
      operation: 'pullops:pr:review',
    });

    assert.equal(
      comment,
      [
        'PullOps ran `pullops:pr:review`.',
        '',
        '---',
        '',
        '<details>',
        '<summary>PullOps operation audit</summary>',
        '',
        'Operation: pullops:pr:review',
        'Trigger actor: @octocat',
        'Model tier: high',
        'Model: gpt-5.5',
        'Reasoning effort: high',
        'Context used: 1200 / 200000 tokens',
        '</details>',
      ].join('\n'),
    );
    assert.doesNotMatch(comment, /^## PullOps Operation Audit$/m);
  });

  it('02: keeps standalone audit comments human-readable with an optional summary', () => {
    const comment = createOperationAuditComment(createContext(), {
      operation: 'pullops:issue:implement',
      summary: 'Finished implementing the issue.',
    });

    assert.match(comment, /^Finished implementing the issue\.\n\n---\n\n<details>/);
    assert.match(comment, /<summary>PullOps operation audit<\/summary>/);
  });

  it('03: appends audit details as a collapsed footer', () => {
    const comment = appendOperationAuditFooter('The PR satisfies the issue.\n', createContext(), {
      operation: 'pullops:pr:review',
    });

    assert.match(
      comment,
      /^The PR satisfies the issue\.\n\n---\n\n<details>\n<summary>PullOps operation audit<\/summary>/,
    );
    assert.doesNotMatch(comment, /^## PullOps Operation Audit$/m);
  });

  it('04: formats context usage when the limit is unknown', () => {
    const comment = createOperationAuditComment(
      createContext({
        contextUsage: {
          used: 1200,
        },
      }),
      {
        operation: 'pullops:pr:review',
      },
    );

    assert.match(comment, /Context used: 1200 tokens/);
  });
});

/**
 * @param {Partial<import('../cli/types.js').OperationRunnerContext>} [overrides]
 * @returns {import('../cli/types.js').OperationRunnerContext}
 */
function createContext(overrides = {}) {
  return /** @type {import('../cli/types.js').OperationRunnerContext} */ ({
    operation: 'pr-review',
    phase: 'run',
    runnerAdapter: 'codex-cli',
    target: {
      type: 'pr',
      number: 100,
    },
    cwd: '/repo',
    config: {},
    modelTier: 'high',
    model: 'gpt-5.5',
    githubClient: {},
    gitClient: {},
    codexRunner: {},
    triggerActor: 'octocat',
    reasoningEffort: 'high',
    contextUsage: {
      used: 1200,
      limit: 200000,
    },
    ...overrides,
  });
}
