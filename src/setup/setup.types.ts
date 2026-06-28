import type { GitHubClient, GitHubLabel } from '../github/types.js';

export type PullOpsSetupProfile = 'full' | 'local' | 'authoring' | 'github-actions';

export interface PullOpsSetupCommandOptions {
  cwd?: string;
  check?: boolean;
  force?: boolean;
}

export interface PullOpsSetupGitHubLabelsOptions extends PullOpsSetupCommandOptions {
  githubClient?: Pick<GitHubClient, 'ensureLabels' | 'listRepositoryLabels'>;
}

export interface PullOpsSetupDoctorOptions extends PullOpsSetupCommandOptions {
  profile?: PullOpsSetupProfile;
  readRepositoryActionsSecretNames?: (options: { cwd: string }) => Promise<string[]>;
  readRepositoryLabels?: (options: { cwd: string }) => Promise<GitHubLabel[]>;
}
