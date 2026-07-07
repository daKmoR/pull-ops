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

export type RunnerCommandCli = 'codex' | 'claude';

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
  /**
   * PULLOPS_-prefixed liveness environment for the hidden worker, read from
   * the run record's Local Run State. Hosts that spawn worker processes
   * should export it; the same entries are embedded in the worker prompt.
   */
  heartbeatEnvironment?: Record<string, string>;
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

export interface RunnerRunOptions {
  cwd: string;
  command: string;
  model: string;
  prompt: string;
  argsTemplate?: string[];
  streamOutput?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface Runner {
  run(options: RunnerRunOptions): Promise<unknown>;
}
