import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseRunnerCommand, readRunnerCommandCli } from './runnerCommand.js';

describe('parseRunnerCommand', () => {
  it('01: parses quoted command arguments', () => {
    assert.deepEqual(parseRunnerCommand('codex exec --profile "Pull Ops"'), {
      file: 'codex',
      args: ['exec', '--profile', 'Pull Ops'],
    });
  });

  it('02: rejects commands without an executable', () => {
    assert.throws(() => parseRunnerCommand('   '), /must include an executable/);
  });
});

describe('readRunnerCommandCli', () => {
  it('01: reads codex from the default Runner Command', () => {
    assert.equal(readRunnerCommandCli('codex exec'), 'codex');
  });

  it('02: reads claude from claude Runner Commands, including absolute paths', () => {
    assert.equal(readRunnerCommandCli('claude'), 'claude');
    assert.equal(readRunnerCommandCli('claude --permission-mode bypassPermissions'), 'claude');
    assert.equal(readRunnerCommandCli('/usr/local/bin/claude -p'), 'claude');
  });

  it('03: falls back to codex for custom or malformed Runner Commands', () => {
    assert.equal(readRunnerCommandCli('custom-runner'), 'codex');
    assert.equal(readRunnerCommandCli("claude '"), 'codex');
  });
});
