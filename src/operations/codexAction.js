import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const CODEX_ACTION_PROMPT_FILE = 'codex_prompt.md';
export const CODEX_ACTION_OUTPUT_FILE = 'codex_output.json';

/**
 * @typedef {import('../cli/types.js').OperationRunnerContext} OperationRunnerContext
 */

/**
 * @param {OperationRunnerContext} context
 * @param {string} prompt
 * @returns {Promise<string>}
 */
export async function writeCodexActionPrompt(context, prompt) {
  const outputDirectory = requireOutputDirectory(context);
  await mkdir(outputDirectory, { recursive: true });

  const promptFile = join(outputDirectory, CODEX_ACTION_PROMPT_FILE);
  await writeFile(promptFile, prompt);
  return promptFile;
}

/**
 * @param {OperationRunnerContext} context
 * @returns {Promise<string>}
 */
export async function readCodexActionOutput(context) {
  if (
    context.codexActionOutcome !== undefined &&
    context.codexActionOutcome !== '' &&
    context.codexActionOutcome !== 'success'
  ) {
    throw new Error(`Codex Action completed with outcome "${context.codexActionOutcome}".`);
  }

  return await readFile(join(requireOutputDirectory(context), CODEX_ACTION_OUTPUT_FILE), 'utf8');
}

/**
 * @param {OperationRunnerContext} context
 * @returns {{ promptFile: string, outputFile: string }}
 */
export function getCodexActionFiles(context) {
  const outputDirectory = requireOutputDirectory(context);
  return {
    promptFile: join(outputDirectory, CODEX_ACTION_PROMPT_FILE),
    outputFile: join(outputDirectory, CODEX_ACTION_OUTPUT_FILE),
  };
}

/**
 * @param {OperationRunnerContext} context
 * @returns {string}
 */
function requireOutputDirectory(context) {
  if (context.outputDirectory === undefined || context.outputDirectory.trim() === '') {
    throw new Error('Codex Action phases require OUTPUT_DIR.');
  }

  return context.outputDirectory;
}
