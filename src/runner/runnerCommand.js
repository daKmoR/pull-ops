import { basename } from 'node:path';

/**
 * @typedef {import('./types.js').RunnerCommandCli} RunnerCommandCli
 */

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
 * Read which agent CLI a Runner Command drives. Commands whose executable is
 * `claude` run the Claude Code CLI; every other command keeps the Codex CLI
 * conventions that PullOps v1 started with.
 *
 * @param {string} command
 * @returns {RunnerCommandCli}
 */
export function readRunnerCommandCli(command) {
  try {
    const runnerCommand = parseRunnerCommand(command);
    return basename(runnerCommand.file) === 'claude' ? 'claude' : 'codex';
  } catch {
    return 'codex';
  }
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
