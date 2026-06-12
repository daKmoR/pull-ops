export interface PullOpsLabel {
  name: string;
  color: string;
  description: string;
}

export type ExecFile = (file: string, args: string[]) => Promise<unknown>;

export interface GitHubClient {
  ensureLabels(labels: PullOpsLabel[]): Promise<unknown>;
}
