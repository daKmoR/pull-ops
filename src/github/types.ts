export interface PullOpsLabel {
  name: string;
  color: string;
  description: string;
}

export interface GitHubLabel {
  name: string;
  color: string;
  description: string | null;
}

export interface EnsureLabelsResult {
  created: string[];
  updated: string[];
  alreadyCorrect: string[];
}

export interface ExecFileResult {
  stdout: string | Buffer;
  stderr?: string | Buffer;
}

export type ExecFile = (file: string, args: string[]) => Promise<ExecFileResult>;

export interface GitHubClient {
  ensureLabels(labels: PullOpsLabel[]): Promise<EnsureLabelsResult>;
}
