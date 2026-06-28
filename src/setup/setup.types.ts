export type PullOpsSetupProfile = 'full' | 'local' | 'authoring';

export interface PullOpsSetupCommandOptions {
  cwd?: string;
  check?: boolean;
  force?: boolean;
}

export interface PullOpsSetupDoctorOptions extends PullOpsSetupCommandOptions {
  profile?: PullOpsSetupProfile;
}
