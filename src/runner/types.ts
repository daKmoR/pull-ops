import type { ChildProcess } from 'node:child_process';
import type { RunnerResultStatus } from './runnerResult.types.js';

export interface RunnerExecFileOptions {
  cwd: string;
  maxBuffer: number;
}

export interface RunnerExecFileResult {
  stdout: string | Buffer;
  stderr?: string | Buffer;
}

export type RunnerAdapter = 'codex-cli' | 'external';

export interface ExternalRunnerCommand {
  argv: string[];
  env: Record<string, string>;
}

export interface ExternalRunnerJob {
  cwd: string;
  promptFile: string;
  outputFile: string;
  resultFile: string;
  workerPrompt: string;
  model: string;
  branch: string;
  completionCommands: Record<RunnerResultStatus, ExternalRunnerCommand>;
  completeCommand: ExternalRunnerCommand;
}

export interface ExternalRunnerJobResult {
  status?: RunnerResultStatus;
}

export type ExternalRunnerJobRunner = (
  runnerJob: ExternalRunnerJob,
) => Promise<ExternalRunnerJobResult | RunnerResultStatus | void>;

export type ExternalRunnerCommandRunner = (
  command: ExternalRunnerCommand,
) => Promise<Record<string, unknown>>;

export type RunnerExecFile = (
  file: string,
  args: string[],
  options: RunnerExecFileOptions,
) => Promise<RunnerExecFileResult>;

export interface RunnerSpawnOptions {
  cwd: string;
  stdio: ['inherit', 'pipe', 'pipe'];
  env?: NodeJS.ProcessEnv;
}

export type RunnerSpawn = (
  file: string,
  args: string[],
  options: RunnerSpawnOptions,
) => ChildProcess;

export interface RunnerOutput {
  write(chunk: string): void;
}

export interface CodexRunOptions {
  cwd: string;
  command: string;
  model: string;
  prompt: string;
  streamOutput?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface CodexRunner {
  run(options: CodexRunOptions): Promise<unknown>;
}
