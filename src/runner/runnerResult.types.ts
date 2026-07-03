export type RunnerResultStatus = 'success' | 'failed' | 'cancelled' | 'skipped';

export interface RunnerResult {
  schemaVersion: 1;
  status: RunnerResultStatus;
}
