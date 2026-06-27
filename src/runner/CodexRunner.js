import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { LOCAL_RUN_HEARTBEAT_PROMPT_INSTRUCTIONS } from '../local-run-state/localRunState.js';

/**
 * @typedef {import('./types.js').CodexRunner} CodexRunner
 * @typedef {import('./types.js').CodexRunOptions} CodexRunOptions
 * @typedef {import('./types.js').RunnerOutput} RunnerOutput
 * @typedef {import('./types.js').RunnerSpawn} RunnerSpawn
 */

/**
 * @param {{ spawn?: RunnerSpawn, output?: RunnerOutput, traceCommand?: (command: string) => void }} [options]
 * @returns {CodexRunner}
 */
export function createCodexRunner({ spawn = nodeSpawn, output, traceCommand } = {}) {
  return {
    /**
     * @param {CodexRunOptions} options
     * @returns {Promise<string>}
     */
    async run({ cwd, command, model, prompt, streamOutput = true, env }) {
      const runnerCommand = parseRunnerCommand(command);
      const baseArgs = [...runnerCommand.args, '--model', model, '-C', cwd];
      const codexLastMessage = await createCodexLastMessageCapture({
        cwd,
        file: runnerCommand.file,
        args: baseArgs,
      });
      const promptWithHeartbeatInstructions = appendHeartbeatInstructions(prompt, env);
      const args =
        codexLastMessage === undefined
          ? [...baseArgs, promptWithHeartbeatInstructions]
          : [
              ...baseArgs,
              '--output-last-message',
              codexLastMessage.path,
              promptWithHeartbeatInstructions,
            ];
      traceCommand?.(formatRunnerCommand(runnerCommand.file, args));

      try {
        const result = await runStreamingProcess({
          spawn,
          file: runnerCommand.file,
          args,
          cwd,
          env,
          output: streamOutput ? output : undefined,
        });

        if (codexLastMessage !== undefined) {
          try {
            return await readFile(codexLastMessage.path, 'utf8');
          } catch {
            return result.stdout;
          }
        }

        const configuredLastMessagePath = readConfiguredLastMessagePath({ cwd, args: baseArgs });
        if (configuredLastMessagePath !== undefined) {
          try {
            return await readFile(configuredLastMessagePath, 'utf8');
          } catch {
            return result.stdout;
          }
        }

        return result.stdout;
      } finally {
        if (codexLastMessage !== undefined) {
          await rm(codexLastMessage.directory, { recursive: true, force: true });
        }
      }
    },
  };
}

/**
 * @param {string} command
 * @returns {{ file: string, args: string[] }}
 */
export function parseRunnerCommand(command) {
  const parts = splitCommand(command);
  const file = parts[0];

  if (file === undefined) {
    throw new Error('PullOps runner.command must include an executable.');
  }

  return {
    file,
    args: parts.slice(1),
  };
}

/**
 * @param {string} command
 * @returns {string[]}
 */
function splitCommand(command) {
  /** @type {string[]} */
  const parts = [];
  let current = '';
  /** @type {'single' | 'double' | undefined} */
  let quote;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];

    if (quote === undefined && /\s/.test(char)) {
      if (current !== '') {
        parts.push(current);
        current = '';
      }
      continue;
    }

    if (char === "'" && quote !== 'double') {
      quote = quote === 'single' ? undefined : 'single';
      continue;
    }

    if (char === '"' && quote !== 'single') {
      quote = quote === 'double' ? undefined : 'double';
      continue;
    }

    current += char;
  }

  if (quote !== undefined) {
    throw new Error('PullOps runner.command contains an unterminated quote.');
  }

  if (current !== '') {
    parts.push(current);
  }

  return parts;
}

/**
 * @param {object} options
 * @param {RunnerSpawn} options.spawn
 * @param {string} options.file
 * @param {string[]} options.args
 * @param {string} options.cwd
 * @param {NodeJS.ProcessEnv | undefined} options.env
 * @param {RunnerOutput | undefined} options.output
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
function runStreamingProcess({ spawn, file, args, cwd, env, output }) {
  return new Promise((resolvePromise, rejectPromise) => {
    /** @type {import('./types.js').RunnerSpawnOptions} */
    const spawnOptions = {
      cwd,
      stdio: ['inherit', 'pipe', 'pipe'],
    };
    if (env !== undefined) {
      spawnOptions.env = {
        ...process.env,
        ...env,
      };
    }
    const child = spawn(file, args, spawnOptions);
    /** @type {Buffer[]} */
    const stdoutChunks = [];
    /** @type {Buffer[]} */
    const stderrChunks = [];
    let settled = false;

    child.stdout?.on('data', chunk => {
      const buffer = Buffer.from(chunk);
      stdoutChunks.push(buffer);
      output?.write(buffer.toString());
    });

    child.stderr?.on('data', chunk => {
      const buffer = Buffer.from(chunk);
      stderrChunks.push(buffer);
      output?.write(buffer.toString());
    });

    child.once('error', error => {
      settle(() => rejectPromise(error));
    });

    child.once('close', (code, signal) => {
      settle(() => {
        const stdout = Buffer.concat(stdoutChunks).toString();
        const stderr = Buffer.concat(stderrChunks).toString();
        if (code === 0) {
          resolvePromise({ stdout, stderr });
          return;
        }

        const reason =
          code === null
            ? `Codex runner exited from signal ${signal ?? 'unknown'}`
            : `Codex runner exited with code ${code}`;
        const detail = stderr.trim() === '' ? stdout.trim() : stderr.trim();
        const message = detail === '' ? reason : `${reason}: ${detail}`;
        const error = new Error(message);
        Object.assign(error, {
          code,
          signal,
          stdout,
          stderr,
        });
        rejectPromise(error);
      });
    });

    /**
     * @param {() => void} finish
     */
    function settle(finish) {
      if (settled) {
        return;
      }

      settled = true;
      finish();
    }
  });
}

/**
 * @param {{ cwd: string, file: string, args: string[] }} options
 * @returns {Promise<{ directory: string, path: string } | undefined>}
 */
async function createCodexLastMessageCapture({ cwd, file, args }) {
  if (
    !isCodexExecCommand(file, args) ||
    readConfiguredLastMessagePath({ cwd, args }) !== undefined
  ) {
    return undefined;
  }

  const directory = await mkdtemp(join(tmpdir(), 'pullops-codex-'));
  return {
    directory,
    path: join(directory, 'last-message.txt'),
  };
}

/**
 * @param {string} prompt
 * @param {NodeJS.ProcessEnv | undefined} env
 * @returns {string}
 */
function appendHeartbeatInstructions(prompt, env) {
  if (!hasHeartbeatEnvironment(env)) {
    return prompt;
  }

  return [prompt, '', LOCAL_RUN_HEARTBEAT_PROMPT_INSTRUCTIONS].join('\n');
}

/**
 * @param {NodeJS.ProcessEnv | undefined} env
 * @returns {env is NodeJS.ProcessEnv & {
 *   PULLOPS_HEARTBEAT_COMMAND: string,
 *   PULLOPS_RUN_STATE_PATH: string,
 *   PULLOPS_HEARTBEAT_TOKEN: string,
 *   PULLOPS_HEARTBEAT_INTERVAL_MS: string,
 * }}
 */
function hasHeartbeatEnvironment(env) {
  return (
    env !== undefined &&
    typeof env.PULLOPS_HEARTBEAT_COMMAND === 'string' &&
    env.PULLOPS_HEARTBEAT_COMMAND.trim() !== '' &&
    typeof env.PULLOPS_RUN_STATE_PATH === 'string' &&
    env.PULLOPS_RUN_STATE_PATH.trim() !== '' &&
    typeof env.PULLOPS_HEARTBEAT_TOKEN === 'string' &&
    env.PULLOPS_HEARTBEAT_TOKEN.trim() !== '' &&
    typeof env.PULLOPS_HEARTBEAT_INTERVAL_MS === 'string' &&
    env.PULLOPS_HEARTBEAT_INTERVAL_MS.trim() !== ''
  );
}

/**
 * @param {string} file
 * @param {string[]} args
 * @returns {boolean}
 */
function isCodexExecCommand(file, args) {
  return basename(file) === 'codex' && (args[0] === 'exec' || args[0] === 'e');
}

/**
 * @param {{ cwd: string, args: string[] }} options
 * @returns {string | undefined}
 */
function readConfiguredLastMessagePath({ cwd, args }) {
  const index = args.findIndex(arg => arg === '--output-last-message' || arg === '-o');
  if (index === -1) {
    return undefined;
  }

  const path = args[index + 1];
  if (path === undefined || path.startsWith('-')) {
    return undefined;
  }

  return path.startsWith('/') ? path : resolve(cwd, path);
}

/**
 * @param {string} file
 * @param {string[]} args
 * @returns {string}
 */
function formatRunnerCommand(file, args) {
  return [
    file,
    ...args.map((arg, index) => {
      if (index === args.length - 1) {
        return '<prompt>';
      }

      const previous = args[index - 1];
      if (previous === '--output-last-message' || previous === '-o') {
        return '<last-message-file>';
      }

      return quoteCommandPart(arg);
    }),
  ].join(' ');
}

/**
 * @param {string} value
 * @returns {string}
 */
function quoteCommandPart(value) {
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", "'\\''")}'`;
}
