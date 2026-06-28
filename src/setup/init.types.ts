export type PullOpsSetupResultStatus = 'ready' | 'changed' | 'blocked';

export interface PullOpsSetupResult {
  status: PullOpsSetupResultStatus;
  area: string;
  summary: string;
  changes: PullOpsSetupChangeSet;
  changesNeeded: PullOpsSetupChangeSet;
  blockers: string[];
  warnings: string[];
  suggestions: string[];
}

export interface PullOpsSetupLabelChangeSet {
  created?: string[];
  updated?: string[];
}

export interface PullOpsSetupChangeSet {
  files?: string[];
  labels?: PullOpsSetupLabelChangeSet;
}

export interface PullOpsInstallManifestFileEntry {
  path: string;
  hash: string;
}

export interface PullOpsInstallManifest {
  schemaVersion: 1;
  kind: 'pullops-install-manifest';
  hashAlgorithm: 'sha256';
  files: PullOpsInstallManifestFileEntry[];
}

export interface PullOpsInitOptions {
  cwd?: string;
  check?: boolean;
  force?: boolean;
}
