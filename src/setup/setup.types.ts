import type { PullOpsInstallManifestFileEntry } from './init.types.js';
import type { GitHubClient, GitHubLabel } from '../github/types.js';

export type PullOpsSetupProfile = 'full' | 'local' | 'authoring' | 'github-actions';

export interface PullOpsSetupCommandOptions {
  cwd?: string;
  check?: boolean;
  force?: boolean;
}

export interface PullOpsSetupGitHubLabelsOptions extends PullOpsSetupCommandOptions {
  githubClient?: Pick<GitHubClient, 'ensureLabels' | 'listRepositoryLabels'>;
  repository?: string;
}

export interface PullOpsSetupDoctorOptions extends PullOpsSetupCommandOptions {
  profile?: PullOpsSetupProfile;
  repository?: string;
  readGitHubAuthToken?: () => string | undefined;
  readRepositoryActionsSecretNames?: (options: {
    cwd: string;
    repository?: string;
    readGitHubAuthToken: () => string | undefined;
  }) => Promise<string[]>;
  readRepositoryLabels?: (options: {
    cwd: string;
    repository?: string;
    readGitHubAuthToken: () => string | undefined;
  }) => Promise<GitHubLabel[]>;
}

export interface SetupWrite {
  path: string;
  contents: string;
}

export interface SetupFileState {
  path: string;
  currentContent?: string;
  desiredContent: string;
  currentHash?: string;
  manifestHash?: string;
}

export interface PullOpsInstallManifestState {
  raw: string;
  fileEntries: PullOpsInstallManifestFileEntry[];
  entries: Map<string, string>;
}

export interface SetupInspectionResult {
  changesNeeded: string[];
  blockers: string[];
  warnings: string[];
  suggestions: string[];
  writes: SetupWrite[];
}

export interface SetupPrereqResult {
  blockers: string[];
  warnings: string[];
  suggestions: string[];
  manifestState?: PullOpsInstallManifestState;
}

export interface SetupAdditionalPrereqResult {
  blockers: string[];
  warnings: string[];
  suggestions: string[];
}

export interface SetupFileCollector {
  (options: { cwd: string }): Promise<Map<string, string>>;
}

export interface SetupAdditionalPrereqReader {
  (options: { cwd: string }): Promise<SetupAdditionalPrereqResult>;
}
