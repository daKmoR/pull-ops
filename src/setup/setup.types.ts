export type PullOpsSetupProfile = 'full' | 'local' | 'authoring' | 'github-actions';

export interface PullOpsSetupCommandOptions {
  cwd?: string;
  check?: boolean;
  force?: boolean;
}

export interface PullOpsSetupDoctorOptions extends PullOpsSetupCommandOptions {
  profile?: PullOpsSetupProfile;
  readRepositoryActionsSecretNames?: (options: { cwd: string }) => Promise<string[]>;
}
