import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(nodeExecFile);
const RUNNER_MAX_BUFFER = 20 * 1024 * 1024;

/**
 * @typedef {import('./types.js').CodexRunner} CodexRunner
 * @typedef {import('./types.js').CodexRunOptions} CodexRunOptions
 * @typedef {import('./types.js').RunnerExecFile} RunnerExecFile
 */

/**
 * @param {{ execFile?: RunnerExecFile }} [options]
 * @returns {CodexRunner}
 */
export function createCodexRunner({ execFile = execFileAsync } = {}) {
  return {
    /**
     * @param {CodexRunOptions} options
     * @returns {Promise<string>}
     */
    async run({ cwd, command, model, prompt }) {
      const runnerCommand = parseRunnerCommand(command);
      const result = await execFile(
        runnerCommand.file,
        [...runnerCommand.args, '--model', model, '-C', cwd, prompt],
        {
          cwd,
          maxBuffer: RUNNER_MAX_BUFFER,
        },
      );

      return result.stdout.toString();
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
