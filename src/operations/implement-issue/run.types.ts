import type { GitHubIssue } from '../../github/types.js';

export type ImplementIssuePreparation =
  | { ready: false; output: Record<string, unknown> }
  | {
      ready: true;
      issue: GitHubIssue;
      parentIssueNumber?: number;
      branchName: string;
      baseBranch: string;
    };
