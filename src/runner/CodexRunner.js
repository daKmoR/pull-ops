import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { parseRunnerCommand, readRunnerCommandCli } from './runnerCommand.js';

export { parseRunnerCommand } from './runnerCommand.js';

/**
 * @typedef {import('./types.js').CodexRunner} CodexRunner
 * @typedef {import('./types.js').CodexRunOptions} CodexRunOptions
 * @typedef {import('./types.js').RunnerOutput} RunnerOutput
 * @typedef {import('./types.js').RunnerSpawn} RunnerSpawn
 */

/**
 * Create the inline CLI runner used by the codex-cli Runner Adapter. The
 * configured Runner Command decides which agent CLI runs: `claude` commands
 * use Claude Code CLI conventions, every other command uses Codex CLI
 * conventions.
 *
 * @param {{ spawn?: RunnerSpawn, output?: RunnerOutput, traceCommand?: (command: string) => void }} [options]
 * @returns {CodexRunner}
 */
export function createCodexRunner({ spawn = nodeSpawn, output, traceCommand } = {}) {
  return {
    /**
     * @param {CodexRunOptions} options
     * @returns {Promise<string>}
     */
    async run(options) {
      if (readRunnerCommandCli(options.command) === 'claude') {
        return await runClaudeCommand({ spawn, output, traceCommand }, options);
      }

      return await runCodexCommand({ spawn, output, traceCommand }, options);
    },
  };
}

/**
 * @param {{ spawn: RunnerSpawn, output?: RunnerOutput, traceCommand?: (command: string) => void }} runner
 * @param {CodexRunOptions} options
 * @returns {Promise<string>}
 */
async function runCodexCommand(
  { spawn, output, traceCommand },
  { cwd, command, model, prompt, streamOutput = true, env },
) {
  const runnerCommand = parseRunnerCommand(command);
  const baseArgs = [...runnerCommand.args, '--model', model, '-C', cwd];
  const codexLastMessage = await createCodexLastMessageCapture({
    cwd,
    file: runnerCommand.file,
    args: baseArgs,
  });
  const args =
    codexLastMessage === undefined
      ? [...baseArgs, prompt]
      : [...baseArgs, '--output-last-message', codexLastMessage.path, prompt];
  traceCommand?.(formatRunnerCommand(runnerCommand.file, args));

  try {
    const result = await runStreamingProcess({
      spawn,
      file: runnerCommand.file,
      args,
      cwd,
      env,
      output: streamOutput ? output : undefined,
      cliDisplayName: 'Codex',
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
}

/**
 * Run the Claude Code CLI headless. Claude prints the final message to stdout
 * in print mode, works from the spawn working directory, and does not support
 * Codex flags such as `-C` or `--output-last-message`.
 *
 * @param {{ spawn: RunnerSpawn, output?: RunnerOutput, traceCommand?: (command: string) => void }} runner
 * @param {CodexRunOptions} options
 * @returns {Promise<string>}
 */
async function runClaudeCommand(
  { spawn, output, traceCommand },
  { cwd, command, model, prompt, streamOutput = true, env },
) {
  const runnerCommand = parseRunnerCommand(command);
  const printArgs = hasClaudePrintFlag(runnerCommand.args) ? [] : ['--print'];
  const args = [...runnerCommand.args, ...printArgs, '--model', model, prompt];
  traceCommand?.(formatRunnerCommand(runnerCommand.file, args));

  const result = await runStreamingProcess({
    spawn,
    file: runnerCommand.file,
    args,
    cwd,
    env,
    output: streamOutput ? output : undefined,
    cliDisplayName: 'Claude',
  });

  return result.stdout;
}

/**
 * @param {string[]} args
 * @returns {boolean}
 */
function hasClaudePrintFlag(args) {
  return args.includes('-p') || args.includes('--print');
}

/**
 * @param {object} options
 * @param {RunnerSpawn} options.spawn
 * @param {string} options.file
 * @param {string[]} options.args
 * @param {string} options.cwd
 * @param {NodeJS.ProcessEnv | undefined} options.env
 * @param {RunnerOutput | undefined} options.output
 * @param {string} options.cliDisplayName
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
function runStreamingProcess({ spawn, file, args, cwd, env, output, cliDisplayName }) {
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
            ? `${cliDisplayName} runner exited from signal ${signal ?? 'unknown'}`
            : `${cliDisplayName} runner exited with code ${code}`;
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
