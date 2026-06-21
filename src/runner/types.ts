import type { ChildProcess } from 'node:child_process';

export interface RunnerExecFileOptions {
  cwd: string;
  maxBuffer: number;
}

export interface RunnerExecFileResult {
  stdout: string | Buffer;
  stderr?: string | Buffer;
}

export type RunnerAdapter = 'codex-cli' | 'codex-action';

export type RunnerExecFile = (
  file: string,
  args: string[],
  options: RunnerExecFileOptions,
) => Promise<RunnerExecFileResult>;

export interface RunnerSpawnOptions {
  cwd: string;
  stdio: ['inherit', 'pipe', 'pipe'];
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
}

export interface CodexRunner {
  run(options: CodexRunOptions): Promise<unknown>;
}
