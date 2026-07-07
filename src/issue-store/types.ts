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

export interface NormalizedPrdIssueUserStory {
  number: number;
  story: string;
}

export interface NormalizedPrdIssueRequest {
  issueNumber?: number;
  title: string;
  problemStatement: string;
  solution: string;
  userStories: NormalizedPrdIssueUserStory[];
  implementationDecisions: string[];
  testingDecisions: string[];
  outOfScope: string[];
  furtherNotes: string[];
  auditDetails: string[];
  triageRole?: TriageRole;
}

export interface PrdIssuePublicationMarker {
  schemaVersion: 1;
  provider: 'github';
  kind: 'prd-issue';
}

export interface PrdIssuePublishIssue {
  number: number;
  url: string;
}

export interface PrdIssuePublishSuccessOutput {
  status: 'accepted';
  summary: string;
  action: 'created' | 'updated';
  issue: PrdIssuePublishIssue;
  warnings: string[];
  localRunRecord: string;
  triageRole?: TriageRole;
}

export interface PrdIssuePublishFailureOutput {
  status: 'failed';
  summary: string;
  failureReason: string;
  warnings: string[];
  localRunRecord: string;
  issue?: PrdIssuePublishIssue;
  action?: 'created' | 'updated';
  triageRole?: TriageRole;
}

export type PrdIssuePublishOutput = PrdIssuePublishSuccessOutput | PrdIssuePublishFailureOutput;

export interface NormalizedChildIssueRequest {
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

export interface NormalizedChildIssueBatchRequest {
  parentIssueNumber: number;
  children: NormalizedChildIssueRequest[];
  forceUpdate: boolean;
}

export interface ChildIssuePublicationMarker {
  schemaVersion: 1;
  provider: 'github';
  kind: 'child-issue';
  parentIssueNumber: number;
  sliceRef: string;
}

export type PublicationMarker =
  | PrdIssuePublicationMarker
  | ChildIssuePublicationMarker
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
  childIssueNumbers: number[];
  blockedBy: number[];
  isDone: boolean;
}

export interface IssueStorePublishWarning {
  code: string;
  message: string;
}

export interface ChildIssuePublishIssue {
  number: number;
  url: string;
}

export interface ChildIssuePublishChild {
  sliceRef: string;
  action: 'created' | 'updated' | 'reused';
  issue: ChildIssuePublishIssue;
  blockedBy: number[];
  triageRole?: TriageRole;
}

export interface ChildIssuePublishMapping {
  sliceRef: string;
  issueNumber: number;
  issueUrl: string;
}

export interface ChildIssuePublishFailure {
  sliceRef: string;
  failureReason: string;
  action?: 'created' | 'updated';
  issue?: ChildIssuePublishIssue;
}

export interface ChildIssuePublishSuccessOutput {
  status: 'accepted';
  summary: string;
  action: 'created' | 'updated' | 'reused' | 'mixed';
  parent: ChildIssuePublishIssue;
  children: ChildIssuePublishChild[];
  mappings: ChildIssuePublishMapping[];
  warnings: IssueStorePublishWarning[];
  localRunRecord: string;
}

export interface ChildIssuePublishFailureOutput {
  status: 'failed';
  summary: string;
  failureReason: string;
  warnings: IssueStorePublishWarning[];
  localRunRecord: string;
  parent?: ChildIssuePublishIssue;
  children?: ChildIssuePublishChild[];
  mappings?: ChildIssuePublishMapping[];
  failedChildren?: ChildIssuePublishFailure[];
}

export type ChildIssuePublishOutput =
  | ChildIssuePublishSuccessOutput
  | ChildIssuePublishFailureOutput;

export interface IssueStorePublishOptions {
  createdAt?: Date;
}

export interface IssueStoreContext {
  cwd: string;
  config: Pick<PullOpsConfig, 'issueStore'>;
  githubClient: GitHubClient;
}

export interface IssueStore {
  publishPrdIssue(
    rawRequest: unknown,
    options?: IssueStorePublishOptions,
  ): Promise<PrdIssuePublishOutput>;
  publishChildIssues(
    rawRequest: unknown,
    options?: IssueStorePublishOptions & {
      parentIssueNumber?: number;
      forceUpdate?: boolean;
    },
  ): Promise<ChildIssuePublishOutput>;
  publishConcreteIssue(
    rawRequest: unknown,
    options?: IssueStorePublishOptions,
  ): Promise<ConcreteIssuePublishOutput>;
  readIssueSnapshot(issueNumber: number): Promise<IssueSnapshot>;
  readChildIssueSnapshots(parentIssueNumber: number): Promise<IssueSnapshot[]>;
  relateChildIssue(options: { parentIssueNumber: number; childIssueNumber: number }): Promise<void>;
}
