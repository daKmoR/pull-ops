import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  executeOperationPhase,
  finalizeOperationRunnerStep,
  prepareOperationRunnerStep,
  runOperationRunnerStep,
} from './runnerLifecycle.js';

/**
 * @typedef {import('../cli/types.js').OperationRunnerContext} OperationRunnerContext
 * @typedef {import('./runnerLifecycle.types.js').RunnerLifecycleOperation} RunnerLifecycleOperation
 */

/**
 * @param {object} [options]
 * @param {string} [options.outputDirectory]
 * @param {(request: Record<string, unknown>) => Promise<unknown>} [options.run]
 * @returns {Promise<OperationRunnerContext>}
 */
async function createContext({ outputDirectory, run } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'pullops-runner-lifecycle-'));
  return /** @type {OperationRunnerContext} */ (
    /** @type {unknown} */ ({
      cwd,
      outputDirectory: outputDirectory ?? join(cwd, 'output'),
      operation: 'pr-review',
      target: { type: 'pr', number: 7 },
      config: { runner: { command: 'codex' } },
      runner: {
        run: run ?? (async () => '{"status":"accepted"}'),
      },
    })
  );
}

/**
 * @param {Partial<RunnerLifecycleOperation>} [step]
 * @returns {RunnerLifecycleOperation}
 */
function createRunnerStep(step = {}) {
  return /** @type {RunnerLifecycleOperation} */ ({
    status: 'runner',
    prompt: 'Do the operation.',
    model: 'gpt-5-codex',
    branch: 'pullops/pr-7',
    waiting: { summary: 'Prepared external run for PR #7.' },
    finalize: async rawOutput => ({ status: 'accepted', rawOutput }),
    ...step,
  });
}

/**
 * @param {OperationRunnerContext} context
 * @param {'success' | 'skipped' | 'failed'} status
 * @param {string} [output]
 */
async function writeExternalRunnerFiles(context, status, output) {
  const outputDirectory = /** @type {string} */ (context.outputDirectory);
  await prepareOperationRunnerStep(context, async () => createRunnerStep());
  await writeFile(
    join(outputDirectory, 'runner_result.json'),
    JSON.stringify({ schemaVersion: 1, status }),
  );
  if (output !== undefined) {
    await writeFile(join(outputDirectory, 'runner_output.json'), output);
  }
}

describe('runOperationRunnerStep', () => {
  it('01: returns settled output without invoking the runner', async () => {
    let runnerInvocations = 0;
    const context = await createContext({
      run: async () => {
        runnerInvocations += 1;
        return '';
      },
    });

    const output = await runOperationRunnerStep(context, async () => ({
      status: 'settled',
      output: { status: 'refused' },
    }));

    assert.deepEqual(output, { status: 'refused' });
    assert.equal(runnerInvocations, 0);
  });

  it('02: runs the runner step and finalizes the raw output', async () => {
    /** @type {Record<string, unknown>[]} */
    const requests = [];
    const context = await createContext({
      run: async request => {
        requests.push(request);
        return '{"status":"accepted"}';
      },
    });

    const output = await runOperationRunnerStep(context, async () => createRunnerStep());

    assert.deepEqual(output, { status: 'accepted', rawOutput: '{"status":"accepted"}' });
    assert.deepEqual(requests, [
      {
        cwd: context.cwd,
        command: 'codex',
        argsTemplate: undefined,
        model: 'gpt-5-codex',
        prompt: 'Do the operation.',
      },
    ]);
  });

  it('03: passes stream and env run options through to the runner', async () => {
    /** @type {Record<string, unknown>[]} */
    const requests = [];
    const context = await createContext({
      run: async request => {
        requests.push(request);
        return '{}';
      },
    });

    await runOperationRunnerStep(context, async () =>
      createRunnerStep({
        runOptions: { streamOutput: true, env: { PULLOPS_HEARTBEAT_TOKEN: 'token' } },
      }),
    );

    assert.deepEqual(requests, [
      {
        cwd: context.cwd,
        command: 'codex',
        argsTemplate: undefined,
        model: 'gpt-5-codex',
        prompt: 'Do the operation.',
        streamOutput: true,
        env: { PULLOPS_HEARTBEAT_TOKEN: 'token' },
      },
    ]);
  });

  it('04: records a runner failure before rethrowing it', async () => {
    /** @type {unknown[]} */
    const recorded = [];
    const context = await createContext({
      run: async () => {
        throw new Error('runner crashed');
      },
    });

    await assert.rejects(
      runOperationRunnerStep(context, async () =>
        createRunnerStep({
          onRunnerFailure: async error => {
            recorded.push(error);
          },
        }),
      ),
      /runner crashed/,
    );

    assert.equal(recorded.length, 1);
  });
});

describe('prepareOperationRunnerStep', () => {
  it('01: returns settled output without writing a prompt', async () => {
    const context = await createContext();

    const output = await prepareOperationRunnerStep(context, async () => ({
      status: 'settled',
      output: { status: 'refused' },
    }));

    assert.deepEqual(output, { status: 'refused' });
  });

  it('02: writes the worker prompt and describes the external runner job', async () => {
    const context = await createContext();

    const output = await prepareOperationRunnerStep(context, async () =>
      createRunnerStep({ waiting: { summary: 'Waiting.', details: { reviewMode: 'normal' } } }),
    );

    assert.equal(output.status, 'waiting');
    assert.equal(output.summary, 'Waiting.');
    assert.equal(output.reviewMode, 'normal');
    const runnerJob = /** @type {Record<string, unknown>} */ (output.runnerJob);
    assert.equal(runnerJob.model, 'gpt-5-codex');
    assert.equal(runnerJob.branch, 'pullops/pr-7');
    const workerPrompt = await readFile(/** @type {string} */ (runnerJob.promptFile), 'utf8');
    assert.match(workerPrompt, /Do the operation\./);
    assert.match(workerPrompt, /git checkout pullops\/pr-7/);
  });

  it('03: records a prompt write failure before rethrowing it', async () => {
    /** @type {unknown[]} */
    const recorded = [];
    const context = await createContext({ outputDirectory: '' });

    await assert.rejects(
      prepareOperationRunnerStep(context, async () =>
        createRunnerStep({
          onRunnerFailure: async error => {
            recorded.push(error);
          },
        }),
      ),
      /OUTPUT_DIR/,
    );

    assert.equal(recorded.length, 1);
  });
});

describe('finalizeOperationRunnerStep', () => {
  it('01: prepare-first returns settled output without reading runner files', async () => {
    const context = await createContext();

    const output = await finalizeOperationRunnerStep(
      context,
      async () => ({ status: 'settled', output: { status: 'refused' } }),
      { order: 'prepare-first' },
    );

    assert.deepEqual(output, { status: 'refused' });
  });

  it('02: prepare-first finalizes the external runner output', async () => {
    const context = await createContext();
    await writeExternalRunnerFiles(context, 'success', '{"status":"accepted"}');

    const output = await finalizeOperationRunnerStep(context, async () => createRunnerStep(), {
      order: 'prepare-first',
    });

    assert.deepEqual(output, { status: 'accepted', rawOutput: '{"status":"accepted"}' });
  });

  it('03: returns skipped output when the external runner was skipped', async () => {
    const context = await createContext();
    const outputDirectory = /** @type {string} */ (context.outputDirectory);
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(
      join(outputDirectory, 'runner_result.json'),
      JSON.stringify({ schemaVersion: 1, status: 'skipped' }),
    );

    const output = await finalizeOperationRunnerStep(context, async () => createRunnerStep(), {
      order: 'prepare-first',
    });

    assert.equal(output.status, 'accepted');
    assert.deepEqual(output.runner, { adapter: 'external', status: 'skipped' });
  });

  it('04: prepare-first records a failed runner result before rethrowing', async () => {
    /** @type {unknown[]} */
    const recorded = [];
    const context = await createContext();
    await writeExternalRunnerFiles(context, 'failed');

    await assert.rejects(
      finalizeOperationRunnerStep(
        context,
        async () =>
          createRunnerStep({
            onRunnerFailure: async error => {
              recorded.push(error);
            },
          }),
        { order: 'prepare-first' },
      ),
      /status "failed"/,
    );

    assert.equal(recorded.length, 1);
  });

  it('05: output-first reads the output before building the operation', async () => {
    /** @type {unknown[]} */
    const outputErrors = [];
    let operationsBuilt = 0;
    const context = await createContext();
    await writeExternalRunnerFiles(context, 'failed');

    await assert.rejects(
      finalizeOperationRunnerStep(
        context,
        async () => {
          operationsBuilt += 1;
          return createRunnerStep();
        },
        {
          order: 'output-first',
          onOutputError: async (_, error) => {
            outputErrors.push(error);
          },
        },
      ),
      /status "failed"/,
    );

    assert.equal(operationsBuilt, 0);
    assert.equal(outputErrors.length, 1);
  });

  it('06: output-first rejects an unexpectedly skipped prepared runner', async () => {
    /** @type {unknown[]} */
    const outputErrors = [];
    const context = await createContext();
    await writeExternalRunnerFiles(context, 'skipped');

    await assert.rejects(
      finalizeOperationRunnerStep(context, async () => createRunnerStep(), {
        order: 'output-first',
        rejectSkippedPreparedRunner: true,
        onOutputError: async (_, error) => {
          outputErrors.push(error);
        },
      }),
      /skipped even though prepare requested a runner step/,
    );

    assert.equal(outputErrors.length, 1);
  });

  it('07: output-first finalizes the external runner output', async () => {
    const context = await createContext();
    await writeExternalRunnerFiles(context, 'success', '{"status":"accepted"}');

    const output = await finalizeOperationRunnerStep(context, async () => createRunnerStep(), {
      order: 'output-first',
    });

    assert.deepEqual(output, { status: 'accepted', rawOutput: '{"status":"accepted"}' });
  });
});

describe('executeOperationPhase', () => {
  it('01: run phase executes the descriptor runner step and finalizes', async () => {
    const context = await createContext({ run: async () => '{"status":"accepted"}' });

    const output = await executeOperationPhase(
      { operationReference: 'pr:review', createOperation: async () => createRunnerStep() },
      'run',
      context,
    );

    assert.deepEqual(output, { status: 'accepted', rawOutput: '{"status":"accepted"}' });
  });

  it('02: run phase uses the run override without invoking the runner', async () => {
    let runnerInvocations = 0;
    /** @type {unknown[]} */
    const overrideContexts = [];
    const context = await createContext({
      run: async () => {
        runnerInvocations += 1;
        return '';
      },
    });

    const output = await executeOperationPhase(
      {
        operationReference: 'pr:resolve-conflicts',
        run: async runContext => {
          overrideContexts.push(runContext);
          return { status: 'accepted', bespoke: true };
        },
      },
      'run',
      context,
    );

    assert.deepEqual(output, { status: 'accepted', bespoke: true });
    assert.deepEqual(overrideContexts, [context]);
    assert.equal(runnerInvocations, 0);
  });

  it('03: prepare phase writes the worker prompt and reports waiting', async () => {
    const context = await createContext();

    const output = await executeOperationPhase(
      {
        operationReference: 'pr:review',
        createOperation: async () => createRunnerStep({ waiting: { summary: 'Waiting.' } }),
      },
      'prepare',
      context,
    );

    assert.equal(output.status, 'waiting');
    assert.equal(output.summary, 'Waiting.');
  });

  it('04: complete phase defaults to prepare-first finalize ordering', async () => {
    const context = await createContext();
    await writeExternalRunnerFiles(context, 'success', '{"status":"accepted"}');

    const output = await executeOperationPhase(
      { operationReference: 'pr:review', createOperation: async () => createRunnerStep() },
      'complete',
      context,
    );

    assert.deepEqual(output, { status: 'accepted', rawOutput: '{"status":"accepted"}' });
  });

  it('05: complete phase prefers the finalize factory over createOperation', async () => {
    let createOperationCalls = 0;
    const context = await createContext();
    await writeExternalRunnerFiles(context, 'success', '{"status":"accepted"}');

    const output = await executeOperationPhase(
      {
        operationReference: 'issue:implement',
        createOperation: async () => {
          createOperationCalls += 1;
          return createRunnerStep();
        },
        createFinalizeOperation: async () =>
          createRunnerStep({
            finalize: async rawOutput => ({ status: 'accepted', prepared: true, rawOutput }),
          }),
      },
      'complete',
      context,
    );

    assert.deepEqual(output, {
      status: 'accepted',
      prepared: true,
      rawOutput: '{"status":"accepted"}',
    });
    assert.equal(createOperationCalls, 0);
  });

  it('06: complete phase honors the descriptor finalize options', async () => {
    /** @type {unknown[]} */
    const outputErrors = [];
    const context = await createContext();
    await writeExternalRunnerFiles(context, 'skipped');

    await assert.rejects(
      executeOperationPhase(
        {
          operationReference: 'pr:fix-ci',
          createOperation: async () => createRunnerStep(),
          finalize: {
            order: 'output-first',
            rejectSkippedPreparedRunner: true,
            onOutputError: async (_, error) => {
              outputErrors.push(error);
            },
          },
        },
        'complete',
        context,
      ),
      /skipped even though prepare requested a runner step/,
    );

    assert.equal(outputErrors.length, 1);
  });

  it('07: rejects an unknown phase', async () => {
    const context = await createContext();

    await assert.rejects(
      executeOperationPhase(
        { operationReference: 'pr:review', createOperation: async () => createRunnerStep() },
        /** @type {import('../cli/types.js').OperationPhase} */ (
          /** @type {unknown} */ ('publish')
        ),
        context,
      ),
      /Unknown operation phase "publish" for the pr:review descriptor/,
    );
  });

  it('08: rejects a descriptor without createOperation for a standard phase', async () => {
    const context = await createContext();

    await assert.rejects(
      executeOperationPhase({ operationReference: 'pr:review' }, 'prepare', context),
      /missing createOperation for the prepare phase/,
    );
  });
});
