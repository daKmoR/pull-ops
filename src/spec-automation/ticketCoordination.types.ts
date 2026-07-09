import type { GitHubIssue, GitHubIssueReference } from '../github/types.js';
import type { LocalRunRunLink } from '../local-run-state/types.js';
import type { PullOpsParentEventSinkChildEnvironment } from '../parent-event-sink/types.js';
import type { ExternalRunnerJob, ExternalRunnerJobReference } from '../runner/types.js';

export type SpecAutomationMode = 'auto-advance' | 'auto-complete';

export interface SpecAutomationRunBlocker {
  targetKind: 'issue' | 'pull-request';
  targetNumber?: number;
  phase: string;
  operationLabelReference?: string;
  reason: string;
  message: string;
  retryable: boolean;
}

export interface SpecAutomationSuggestedCommandAction {
  kind: 'command';
  description: string;
  argv: string[];
  approvalRequired: boolean;
  approvalReason?: string;
}

export interface IssueWorkTarget {
  issue: GitHubIssue;
  parentIssueNumber?: number;
  branchName: string;
  baseBranch: string;
}

export interface TicketAutomationResult {
  issue: {
    number: number;
    url: string;
  };
  status: string;
  summary: string;
  blockedBy?: number[];
  blockedPhase?: string;
  blockedOperation?: string;
  dependencyDecision?: TicketDependencyDecision;
  labels?: string[];
  branch?: string;
  localRunRecord?: string;
  publicationMode?: 'dry-run' | 'publish';
  pullRequest?: {
    number: number;
    url: string;
    baseBranch?: string;
    headBranch: string;
  };
  nextOperation?: string;
  checks?: number;
  mergeMethod?: string;
  conflictedFiles?: string[];
  finalizedHeadSha?: string;
  headSha?: string;
  treeHash?: string;
  runnerJob?: ExternalRunnerJob | ExternalRunnerJobReference;
}

export interface TicketDependencyDecision {
  blockedBy: number[];
  satisfiedByClosedIssues: number[];
  satisfiedByVirtualCompletions: number[];
  remainingBlockedBy: number[];
}

export interface TicketRunOptions {
  virtualCompletedIssueNumbers?: number[];
  progress?: (message: string) => void;
  localRunRecordDirectory?: string;
  parentRun?: LocalRunRunLink;
  parentEventSinkEnvironment?: PullOpsParentEventSinkChildEnvironment;
}

export type TicketRunner = (
  ticketNumber: number,
  options?: TicketRunOptions,
) => Promise<Record<string, unknown>>;

export interface ParentReviewResult {
  status: string;
  summary?: string;
  issue?: {
    number: number;
    url: string;
  };
  openTickets?: number[];
  branch?: string;
  pullRequest?: {
    number: number;
    url: string;
    baseBranch?: string;
    headBranch: string;
  };
  labels?: string[];
  nextOperation?: string;
  review?: Record<string, unknown>;
  addressReviews?: Record<string, unknown>[];
  finalize?: Record<string, unknown>;
  localRunRecords?: string[];
  runnerJob?: ExternalRunnerJob | ExternalRunnerJobReference;
}

export interface SpecAutomationResult extends Record<string, unknown> {
  status: string;
  summary: string;
  displayMessage?: string;
  failureReason?: string;
  refusalReason?: string;
  mode?: SpecAutomationMode;
  issue?:
    | {
        number: number;
        url: string;
      }
    | number;
  preparation?: Record<string, unknown>;
  tickets?: TicketAutomationResult[];
  parentPullRequest?: ParentReviewResult;
  publicationMode?: 'dry-run' | 'publish';
  branch?: string;
  localRunRecord?: string;
  localNextSteps?: string[];
  nextSteps?: string[];
  blockers?: SpecAutomationRunBlocker[];
  suggestedActions?: SpecAutomationSuggestedCommandAction[];
  virtualCompletedTickets?: number[];
  remainingBlockedTickets?: number[];
  runnerJob?: ExternalRunnerJob;
}

export interface TicketCloseResult extends Record<string, unknown> {
  status: string;
  summary: string;
  issue?: {
    number: number;
    url: string;
  };
  pullRequest?: {
    number: number;
    url: string;
    baseBranch?: string;
    headBranch: string;
  };
  specAutomation?: SpecAutomationResult;
  parentPullRequest?: ParentReviewResult;
}

export interface ParentIssueFacts {
  parentIssue: GitHubIssue;
  tickets: GitHubIssueReference[];
  closedTickets: GitHubIssueReference[];
  openTickets: GitHubIssueReference[];
}

export interface TicketPrFacts {
  sourceIssue: GitHubIssue;
  parentIssueNumber: number;
  expectedBaseBranch: string;
  expectedTicketBranch: string;
}
