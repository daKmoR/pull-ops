export interface NpmPackDryRunFileEntry {
  path: string;
}

export interface NpmPackDryRunEntry {
  files: NpmPackDryRunFileEntry[];
}

export type NpmPackDryRunResult = NpmPackDryRunEntry[];
