export interface RunnerExecFileOptions {
  cwd: string;
  maxBuffer: number;
}

export interface RunnerExecFileResult {
  stdout: string | Buffer;
  stderr?: string | Buffer;
}

export type RunnerExecFile = (
  file: string,
  args: string[],
  options: RunnerExecFileOptions,
) => Promise<RunnerExecFileResult>;

export interface CodexRunOptions {
  cwd: string;
  command: string;
  model: string;
  prompt: string;
}

export interface CodexRunner {
  run(options: CodexRunOptions): Promise<unknown>;
}
