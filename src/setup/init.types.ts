import type { EnsureLabelsResult } from '../github/types.js';

export type PullOpsSetupResultStatus = 'ready' | 'changes-needed' | 'blocked';

export interface PullOpsSetupResult {
  status: PullOpsSetupResultStatus;
  area: string;
  summary: string;
  changes: string[];
  created?: EnsureLabelsResult['created'];
  updated?: EnsureLabelsResult['updated'];
  alreadyCorrect?: EnsureLabelsResult['alreadyCorrect'];
  changesNeeded: string[];
  blockers: string[];
  warnings: string[];
  suggestions: string[];
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
