import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';

import { createCodexRunner, parseRunnerCommand } from './CodexRunner.js';

describe('createCodexRunner', () => {
  it('01: streams runner output live and returns the captured last Codex message', async () => {
    const output = createWritableBuffer();
    /** @type {string[]} */
    const traces = [];
    /** @type {Array<{ file: string, args: string[], options: unknown }>} */
    const calls = [];
    const runner = createCodexRunner({
      output,
      traceCommand(command) {
        traces.push(command);
      },
      spawn: (file, args, options) => {
        calls.push({ file, args, options });
        const child = createFakeChildProcess();
        queueMicrotask(async () => {
          child.stdout.write('codex stdout\n');
          child.stderr.write('codex stderr\n');
          await writeFile(readOutputLastMessagePath(args), '{"status":"implemented"}\n');
          child.emit('close', 0, null);
        });
        return child;
      },
    });

    const result = await runner.run({
      cwd: '/repo',
      command: 'codex exec --sandbox workspace-write',
      model: 'gpt-5.5',
      prompt: 'Implement issue #1',
    });

    assert.equal(result, '{"status":"implemented"}\n');
    assert.equal(output.text, 'codex stdout\ncodex stderr\n');
    assert.deepEqual(traces, [
      'codex exec --sandbox workspace-write --model gpt-5.5 -C /repo --output-last-message <last-message-file> <prompt>',
    ]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, 'codex');
    assert.deepEqual(calls[0].args.slice(0, 6), [
      'exec',
      '--sandbox',
      'workspace-write',
      '--model',
      'gpt-5.5',
      '-C',
    ]);
    assert.equal(calls[0].args[6], '/repo');
    assert.equal(calls[0].args.at(-1), 'Implement issue #1');
    assert.deepEqual(calls[0].options, {
      cwd: '/repo',
      stdio: ['inherit', 'pipe', 'pipe'],
    });
  });

  it('02: rejects failed runner commands with stderr and captured stdout', async () => {
    const runner = createCodexRunner({
      output: createWritableBuffer(),
      spawn: () => {
        const child = createFakeChildProcess();
        queueMicrotask(() => {
          child.stdout.write('partial stdout\n');
          child.stderr.write('runner failed\n');
          child.emit('close', 2, null);
        });
        return child;
      },
    });

    await assert.rejects(
      async () =>
        await runner.run({
          cwd: '/repo',
          command: 'codex exec',
          model: 'gpt-5.5',
          prompt: 'Implement issue #1',
        }),
      error => {
        assert.match(String(error), /Codex runner exited with code 2/);
        assert.match(String(error), /runner failed/);
        const runnerError = /** @type {{ stdout?: string, stderr?: string }} */ (error);
        assert.equal(runnerError.stdout, 'partial stdout\n');
        assert.equal(runnerError.stderr, 'runner failed\n');
        return true;
      },
    );
  });
});

describe('parseRunnerCommand', () => {
  it('01: parses quoted command arguments', () => {
    assert.deepEqual(parseRunnerCommand('codex exec --profile "Pull Ops"'), {
      file: 'codex',
      args: ['exec', '--profile', 'Pull Ops'],
    });
  });
});

function createFakeChildProcess() {
  const child = new EventEmitter();
  return /** @type {import('node:child_process').ChildProcess & { stdout: PassThrough, stderr: PassThrough }} */ (
    /** @type {unknown} */ (
      Object.assign(child, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      })
    )
  );
}

/**
 * @param {string[]} args
 * @returns {string}
 */
function readOutputLastMessagePath(args) {
  const index = args.indexOf('--output-last-message');
  assert.notEqual(index, -1);
  const value = args[index + 1];
  assert.equal(typeof value, 'string');
  return value;
}

function createWritableBuffer() {
  return {
    text: '',
    /**
     * @param {string} chunk
     */
    write(chunk) {
      this.text += chunk;
    },
  };
}
