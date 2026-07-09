import type { PullOpsConfig } from '../config/types.js';
import type { GitHubClient } from '../github/types.js';

export type TriageRole =
  | 'needs-triage'
  | 'needs-info'
  | 'ready-for-agent'
  | 'ready-for-human'
  | 'wontfix';

export interface NormalizedConcreteIssueRequest {
  issueNumber?: number;
  title: string;
  whatToBuild: string;
  acceptanceCriteria: string[];
  blockedBy: number[];
  auditDetails?: string[];
  triageRole?: TriageRole;
}

export interface ConcreteIssuePublicationMarker {
  schemaVersion: 1;
  provider: 'github';
  kind: 'concrete-issue';
}

export interface ConcreteIssuePublishIssue {
  number: number;
  url: string;
}

export interface ConcreteIssuePublishSuccessOutput {
  status: 'accepted';
  summary: string;
  action: 'created' | 'updated';
  issue: ConcreteIssuePublishIssue;
  warnings: string[];
  localRunRecord: string;
  triageRole?: TriageRole;
}

export interface ConcreteIssuePublishFailureOutput {
  status: 'failed';
  summary: string;
  failureReason: string;
  warnings: string[];
  localRunRecord: string;
  issue?: ConcreteIssuePublishIssue;
  action?: 'created' | 'updated';
  triageRole?: TriageRole;
}

export type ConcreteIssuePublishOutput =
  | ConcreteIssuePublishSuccessOutput
  | ConcreteIssuePublishFailureOutput;

export interface NormalizedSpecIssueUserStory {
  number: number;
  story: string;
}

export interface NormalizedSpecIssueRequest {
  issueNumber?: number;
  title: string;
  problemStatement: string;
  solution: string;
  userStories: NormalizedSpecIssueUserStory[];
  implementationDecisions: string[];
  testingDecisions: string[];
  outOfScope: string[];
  furtherNotes: string[];
  auditDetails: string[];
  triageRole?: TriageRole;
}

export interface SpecIssuePublicationMarker {
  schemaVersion: 1;
  provider: 'github';
  kind: 'spec-issue';
}

export interface SpecIssuePublishIssue {
  number: number;
  url: string;
}

export interface SpecIssuePublishSuccessOutput {
  status: 'accepted';
  summary: string;
  action: 'created' | 'updated';
  issue: SpecIssuePublishIssue;
  warnings: string[];
  localRunRecord: string;
  triageRole?: TriageRole;
}

export interface SpecIssuePublishFailureOutput {
  status: 'failed';
  summary: string;
  failureReason: string;
  warnings: string[];
  localRunRecord: string;
  issue?: SpecIssuePublishIssue;
  action?: 'created' | 'updated';
  triageRole?: TriageRole;
}

export type SpecIssuePublishOutput = SpecIssuePublishSuccessOutput | SpecIssuePublishFailureOutput;

export interface NormalizedTicketRequest {
  issueNumber?: number;
  sliceRef: string;
  title: string;
  whatToBuild: string;
  acceptanceCriteria: string[];
  blockedBy: number[];
  blockedBySliceRefs: string[];
  coveredUserStories: number[];
  supportWork: boolean;
  triageRole?: TriageRole;
}

export interface NormalizedTicketBatchRequest {
  parentIssueNumber: number;
  tickets: NormalizedTicketRequest[];
  forceUpdate: boolean;
}

export interface TicketPublicationMarker {
  schemaVersion: 1;
  provider: 'github';
  kind: 'ticket';
  parentIssueNumber: number;
  sliceRef: string;
}

export type PublicationMarker =
  | SpecIssuePublicationMarker
  | TicketPublicationMarker
  | ConcreteIssuePublicationMarker;

export type IssueSnapshotKind = PublicationMarker['kind'];

export interface IssueSnapshot {
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  labels: string[];
  kind: IssueSnapshotKind | undefined;
  publishedByPullOps: boolean;
  marker: PublicationMarker | undefined;
  parentIssueNumber: number | undefined;
  ticketNumbers: number[];
  blockedBy: number[];
  isDone: boolean;
}

export interface IssueStorePublishWarning {
  code: string;
  message: string;
}

export interface TicketPublishIssue {
  number: number;
  url: string;
}

export interface TicketPublishTicket {
  sliceRef: string;
  action: 'created' | 'updated' | 'reused';
  issue: TicketPublishIssue;
  blockedBy: number[];
  triageRole?: TriageRole;
}

export interface TicketPublishMapping {
  sliceRef: string;
  issueNumber: number;
  issueUrl: string;
}

export interface TicketPublishFailure {
  sliceRef: string;
  failureReason: string;
  action?: 'created' | 'updated';
  issue?: TicketPublishIssue;
}

export interface TicketPublishSuccessOutput {
  status: 'accepted';
  summary: string;
  action: 'created' | 'updated' | 'reused' | 'mixed';
  parent: TicketPublishIssue;
  tickets: TicketPublishTicket[];
  mappings: TicketPublishMapping[];
  warnings: IssueStorePublishWarning[];
  localRunRecord: string;
}

export interface TicketPublishFailureOutput {
  status: 'failed';
  summary: string;
  failureReason: string;
  warnings: IssueStorePublishWarning[];
  localRunRecord: string;
  parent?: TicketPublishIssue;
  tickets?: TicketPublishTicket[];
  mappings?: TicketPublishMapping[];
  failedTickets?: TicketPublishFailure[];
}

export type TicketPublishOutput = TicketPublishSuccessOutput | TicketPublishFailureOutput;

export interface IssueStorePublishOptions {
  createdAt?: Date;
}

export interface IssueStoreContext {
  cwd: string;
  config: Pick<PullOpsConfig, 'issueStore'>;
  githubClient: GitHubClient;
}

export interface IssueStore {
  publishSpecIssue(
    rawRequest: unknown,
    options?: IssueStorePublishOptions,
  ): Promise<SpecIssuePublishOutput>;
  publishTickets(
    rawRequest: unknown,
    options?: IssueStorePublishOptions & {
      parentIssueNumber?: number;
      forceUpdate?: boolean;
    },
  ): Promise<TicketPublishOutput>;
  publishConcreteIssue(
    rawRequest: unknown,
    options?: IssueStorePublishOptions,
  ): Promise<ConcreteIssuePublishOutput>;
  readIssueSnapshot(issueNumber: number): Promise<IssueSnapshot>;
  readTicketSnapshots(parentIssueNumber: number): Promise<IssueSnapshot[]>;
  relateTicket(options: { parentIssueNumber: number; ticketNumber: number }): Promise<void>;
}
