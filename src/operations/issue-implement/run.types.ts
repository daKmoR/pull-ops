import type { GitHubIssue } from '../../github/types.js';
import type { ImplementedIssueOutput } from './output.types.js';

export type IssueImplementPreparation =
  | { ready: false; output: Record<string, unknown> }
  | {
      ready: true;
      issue: GitHubIssue;
      parentIssueNumber?: number;
      branchName: string;
      baseBranch: string;
    };

export interface BlockIssueDryRunOptions {
  reason: string;
  summary?: string;
  branchName: string;
  baseBranch: string;
  publicationMode?: 'dry-run' | 'publish';
}

export interface ReusableFinalizedDryRunRecord {
  directory: string;
  output: ImplementedIssueOutput;
  body: string;
}
