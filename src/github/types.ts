export interface PullOpsLabel {
  name: string;
  color: string;
  description: string;
}

export interface GitHubLabel {
  name: string;
  color: string;
  description: string | null;
}

export interface EnsureLabelsResult {
  created: string[];
  updated: string[];
  alreadyCorrect: string[];
}

export interface ExecFileResult {
  stdout: string | Buffer;
  stderr?: string | Buffer;
}

export type ExecFile = (file: string, args: string[]) => Promise<ExecFileResult>;

export type IssueRelationshipSource = 'native' | 'body';

export interface GitHubIssueReference {
  number: number;
  title?: string;
  url?: string;
  state?: string;
  relationshipSource: IssueRelationshipSource;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  url: string;
  authorLogin: string | null;
  labels: string[];
  parent: GitHubIssueReference | null;
  subIssues: GitHubIssueReference[];
}

export interface GitHubPullRequest {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  body: string;
  isDraft: boolean;
}

export interface CreateDraftPullRequestOptions {
  title: string;
  body: string;
  baseBranch: string;
  headBranch: string;
}

export interface EditLabelsOptions {
  number: number;
  labels: string[];
}

export interface CommentOnIssueOptions {
  number: number;
  body: string;
}

export interface GitHubClient {
  ensureLabels(labels: PullOpsLabel[]): Promise<EnsureLabelsResult>;
  getIssue(number: number): Promise<GitHubIssue>;
  findOpenPullRequestByHead(headBranch: string): Promise<GitHubPullRequest | undefined>;
  createDraftPullRequest(options: CreateDraftPullRequestOptions): Promise<GitHubPullRequest>;
  addLabelsToIssue(options: EditLabelsOptions): Promise<void>;
  removeLabelsFromIssue(options: EditLabelsOptions): Promise<void>;
  addLabelsToPullRequest(options: EditLabelsOptions): Promise<void>;
  commentOnIssue(options: CommentOnIssueOptions): Promise<void>;
}
