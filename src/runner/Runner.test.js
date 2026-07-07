import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';

import { createRunner, parseRunnerCommand } from './Runner.js';

describe('createRunner', () => {
  it('01: streams runner output live and returns the captured last Codex message', async () => {
    const output = createWritableBuffer();
    /** @type {string[]} */
    const traces = [];
    /** @type {Array<{ file: string, args: string[], options: unknown }>} */
    const calls = [];
    const runner = createRunner({
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
    const runner = createRunner({
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

  it('03: can capture runner output without streaming it live', async () => {
    const output = createWritableBuffer();
    const runner = createRunner({
      output,
      spawn: () => {
        const child = createFakeChildProcess();
        queueMicrotask(() => {
          child.stdout.write('codex stdout\n');
          child.stderr.write('codex stderr\n');
          child.emit('close', 0, null);
        });
        return child;
      },
    });

    const result = await runner.run({
      cwd: '/repo',
      command: 'custom-runner',
      model: 'gpt-5.5',
      prompt: 'Implement issue #1',
      streamOutput: false,
    });

    assert.equal(result, 'codex stdout\n');
    assert.equal(output.text, '');
  });

  it('04: forwards heartbeat env to the runner without changing the worker prompt', async () => {
    const output = createWritableBuffer();
    /** @type {Array<{ file: string, args: string[], options: any }>} */
    const calls = [];
    const runner = createRunner({
      output,
      spawn: (file, args, options) => {
        calls.push({ file, args, options });
        const child = createFakeChildProcess();
        queueMicrotask(() => {
          child.emit('close', 0, null);
        });
        return child;
      },
    });

    await runner.run({
      cwd: '/repo',
      command: 'codex exec',
      model: 'gpt-5.5',
      prompt: 'Implement issue #1',
      env: {
        PULLOPS_HEARTBEAT_COMMAND: 'npm exec -- pullops heartbeat',
        PULLOPS_RUN_STATE_PATH: '/repo/.pullops/runs/example/state.json',
        PULLOPS_HEARTBEAT_TOKEN: 'token-123',
        PULLOPS_HEARTBEAT_INTERVAL_MS: '300000',
        npm_config_cache: '/repo/.pullops/runs/example/npm-cache',
      },
    });

    assert.equal(calls.length, 1);
    const call = calls[0];
    assert(call);
    const prompt = call.args.at(-1);
    assert(prompt);
    assert.equal(prompt, 'Implement issue #1');
    assert.doesNotMatch(prompt, /Heartbeat instructions:/);
    assert.equal(call.options.env.PULLOPS_RUN_STATE_PATH, '/repo/.pullops/runs/example/state.json');
    assert.equal(call.options.env.PULLOPS_HEARTBEAT_COMMAND, 'npm exec -- pullops heartbeat');
    assert.equal(call.options.env.PULLOPS_HEARTBEAT_TOKEN, 'token-123');
    assert.equal(call.options.env.PULLOPS_HEARTBEAT_INTERVAL_MS, '300000');
    assert.equal(call.options.env.npm_config_cache, '/repo/.pullops/runs/example/npm-cache');
    assert.equal(output.text, '');
  });
  it('05: runs claude Runner Commands with print mode and returns stdout', async () => {
    const output = createWritableBuffer();
    /** @type {string[]} */
    const traces = [];
    /** @type {Array<{ file: string, args: string[], options: unknown }>} */
    const calls = [];
    const runner = createRunner({
      output,
      traceCommand(command) {
        traces.push(command);
      },
      spawn: (file, args, options) => {
        calls.push({ file, args, options });
        const child = createFakeChildProcess();
        queueMicrotask(() => {
          child.stdout.write('{"status":"implemented"}\n');
          child.emit('close', 0, null);
        });
        return child;
      },
    });

    const result = await runner.run({
      cwd: '/repo',
      command: 'claude --permission-mode bypassPermissions',
      model: 'claude-opus-4-8',
      prompt: 'Implement issue #1',
    });

    assert.equal(result, '{"status":"implemented"}\n');
    assert.deepEqual(traces, [
      'claude --permission-mode bypassPermissions --print --model claude-opus-4-8 <prompt>',
    ]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, 'claude');
    assert.deepEqual(calls[0].args, [
      '--permission-mode',
      'bypassPermissions',
      '--print',
      '--model',
      'claude-opus-4-8',
      'Implement issue #1',
    ]);
    assert.deepEqual(calls[0].options, {
      cwd: '/repo',
      stdio: ['inherit', 'pipe', 'pipe'],
    });
  });

  it('06: keeps a configured claude print flag without duplicating it', async () => {
    /** @type {Array<{ args: string[] }>} */
    const calls = [];
    const runner = createRunner({
      spawn: (file, args) => {
        calls.push({ args });
        const child = createFakeChildProcess();
        queueMicrotask(() => {
          child.emit('close', 0, null);
        });
        return child;
      },
    });

    await runner.run({
      cwd: '/repo',
      command: 'claude -p',
      model: 'claude-sonnet-5',
      prompt: 'Review PR #2',
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ['-p', '--model', 'claude-sonnet-5', 'Review PR #2']);
  });

  it('06b: runs arbitrary agent CLIs through the configured args template', async () => {
    /** @type {string[]} */
    const traces = [];
    /** @type {Array<{ file: string, args: string[], options: unknown }>} */
    const calls = [];
    const runner = createRunner({
      traceCommand(command) {
        traces.push(command);
      },
      spawn: (file, args, options) => {
        calls.push({ file, args, options });
        const child = createFakeChildProcess();
        queueMicrotask(() => {
          child.stdout.write('{"status":"implemented"}\n');
          child.emit('close', 0, null);
        });
        return child;
      },
    });

    const result = await runner.run({
      cwd: '/repo',
      command: 'my-agent chat',
      argsTemplate: ['--model', '{model}', '--message', '{prompt}'],
      model: 'agent-large',
      prompt: 'Implement issue #1',
    });

    assert.equal(result, '{"status":"implemented"}\n');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, 'my-agent');
    assert.deepEqual(calls[0].args, [
      'chat',
      '--model',
      'agent-large',
      '--message',
      'Implement issue #1',
    ]);
    assert.deepEqual(calls[0].options, {
      cwd: '/repo',
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    assert.deepEqual(traces, ['my-agent chat --model agent-large --message <prompt>']);
  });

  it('06c: appends the prompt as the final argument when the template has no prompt placeholder', async () => {
    /** @type {Array<{ args: string[] }>} */
    const calls = [];
    const runner = createRunner({
      spawn: (file, args) => {
        calls.push({ args });
        const child = createFakeChildProcess();
        queueMicrotask(() => {
          child.emit('close', 0, null);
        });
        return child;
      },
    });

    await runner.run({
      cwd: '/repo',
      command: 'my-agent',
      argsTemplate: ['run', '--model={model}'],
      model: 'agent-small',
      prompt: 'Review PR #2',
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ['run', '--model=agent-small', 'Review PR #2']);
  });

  it('07: rejects failed claude runner commands with a Claude runner reason', async () => {
    const runner = createRunner({
      output: createWritableBuffer(),
      spawn: () => {
        const child = createFakeChildProcess();
        queueMicrotask(() => {
          child.stderr.write('claude failed\n');
          child.emit('close', 1, null);
        });
        return child;
      },
    });

    await assert.rejects(
      async () =>
        await runner.run({
          cwd: '/repo',
          command: 'claude',
          model: 'claude-opus-4-8',
          prompt: 'Implement issue #1',
        }),
      error => {
        assert.match(String(error), /Claude runner exited with code 1/);
        assert.match(String(error), /claude failed/);
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
