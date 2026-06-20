import type { PlannedRewriteCommit } from '../../git/types.js';
import type { GitHubIssue, GitHubIssueReference, GitHubPullRequest } from '../../github/types.js';

export type PrFinalizeSourceKind = 'standalone' | 'childIssue' | 'parentIssue';

export type PrFinalizeSource =
  | {
      ready: false;
      output: Record<string, unknown>;
    }
  | {
      ready: true;
      sourceKind: 'standalone';
      sourceIssueNumber: number;
      baseBranch: string;
    }
  | {
      ready: true;
      sourceKind: 'childIssue';
      sourceIssueNumber: number;
      parentIssueNumber: number;
      baseBranch: string;
    }
  | {
      ready: true;
      sourceKind: 'parentIssue';
      sourceIssueNumber: number;
      baseBranch: string;
      parentIssue: GitHubIssue;
      childIssues: GitHubIssueReference[];
      closedChildIssues: GitHubIssueReference[];
    };

export type PrFinalizePreparation =
  | { ready: false; output: Record<string, unknown> }
  | {
      ready: true;
      mode: 'rewrite';
      pullRequest: GitHubPullRequest;
      sourceKind: PrFinalizeSourceKind;
      sourceIssueNumber: number;
      parentIssueNumber?: number;
      childIssues?: GitHubIssueReference[];
      baseBranch: string;
      currentTreeHash: string;
      reviewedTreeHash: string;
      reviewedHeadSha: string;
      changedFiles: string[];
      commitPlan: PlannedRewriteCommit[];
    }
  | {
      ready: true;
      mode: 'existing-commits';
      pullRequest: GitHubPullRequest;
      sourceKind: 'parentIssue';
      sourceIssueNumber: number;
      parentIssueNumber?: number;
      childIssues: GitHubIssueReference[];
      baseBranch: string;
      currentTreeHash: string;
      reviewedTreeHash: string;
      reviewedHeadSha: string;
      changedFiles: string[];
      commitShas: string[];
      commitCount: number;
    }
  | {
      ready: true;
      mode: 'planner';
      pullRequest: GitHubPullRequest;
      sourceKind: 'parentIssue';
      sourceIssueNumber: number;
      childIssues: GitHubIssueReference[];
      baseBranch: string;
      currentTreeHash: string;
      reviewedTreeHash: string;
      reviewedHeadSha: string;
      changedFiles: string[];
      prompt: string;
    }
  | {
      ready: true;
      mode: 'finalized';
      pullRequest: GitHubPullRequest;
      sourceKind: PrFinalizeSourceKind;
      sourceIssueNumber: number;
      parentIssueNumber?: number;
      childIssues?: GitHubIssueReference[];
      baseBranch: string;
      currentTreeHash: string;
      finalizedTreeHash: string;
      finalizedHeadSha: string;
      commitCount: number;
    };
