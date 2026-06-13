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

export type IssueRelationshipSource = 'native';

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
  baseRefName?: string;
  body: string;
  isDraft: boolean;
  isCrossRepository?: boolean;
  labels?: string[];
}

export interface GitHubCheckRun {
  name: string;
  workflowName?: string;
  state?: string;
  conclusion?: string;
  bucket?: string;
  detailsUrl?: string;
  summary?: string;
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

export interface CommentOnPullRequestOptions {
  number: number;
  body: string;
}

export interface UpdatePullRequestBodyOptions {
  number: number;
  body: string;
}

export interface GitHubPullRequestFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface GitHubPullRequestComment {
  id?: string;
  databaseId?: number;
  body: string;
  authorLogin: string | null;
  url?: string;
  path?: string;
  line?: number;
  diffHunk?: string;
}

export interface GitHubPullRequestReviewSummary {
  id?: string;
  state: string;
  body: string;
  authorLogin: string | null;
  url?: string;
}

export interface GitHubPullRequestReviewThread {
  isResolved: boolean;
  comments: GitHubPullRequestComment[];
}

export interface GitHubPullRequestReviewContext {
  comments: GitHubPullRequestComment[];
  reviews: GitHubPullRequestReviewSummary[];
  unresolvedThreads: GitHubPullRequestReviewThread[];
  files: GitHubPullRequestFile[];
}

export interface GitHubPullRequestDiff {
  patch: string;
}

export type GitHubPullRequestReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

export interface PullRequestReviewCommentInput {
  path: string;
  line: number;
  body: string;
}

export interface PublishPullRequestReviewOptions {
  number: number;
  event: GitHubPullRequestReviewEvent;
  body: string;
  comments: PullRequestReviewCommentInput[];
}

export interface ReplyToPullRequestReviewCommentOptions {
  commentId: number;
  body: string;
}

export interface GitHubClient {
  ensureLabels(labels: PullOpsLabel[]): Promise<EnsureLabelsResult>;
  getIssue(number: number): Promise<GitHubIssue>;
  getPullRequest(number: number): Promise<GitHubPullRequest>;
  getPullRequestChecks(number: number): Promise<GitHubCheckRun[]>;
  getPullRequestReviewContext(number: number): Promise<GitHubPullRequestReviewContext>;
  getPullRequestDiff(number: number): Promise<GitHubPullRequestDiff>;
  findOpenPullRequestByHead(headBranch: string): Promise<GitHubPullRequest | undefined>;
  createDraftPullRequest(options: CreateDraftPullRequestOptions): Promise<GitHubPullRequest>;
  addLabelsToIssue(options: EditLabelsOptions): Promise<void>;
  removeLabelsFromIssue(options: EditLabelsOptions): Promise<void>;
  addLabelsToPullRequest(options: EditLabelsOptions): Promise<void>;
  removeLabelsFromPullRequest(options: EditLabelsOptions): Promise<void>;
  commentOnIssue(options: CommentOnIssueOptions): Promise<void>;
  commentOnPullRequest(options: CommentOnPullRequestOptions): Promise<void>;
  updatePullRequestBody(options: UpdatePullRequestBodyOptions): Promise<void>;
  publishPullRequestReview(options: PublishPullRequestReviewOptions): Promise<void>;
  replyToPullRequestReviewComment(options: ReplyToPullRequestReviewCommentOptions): Promise<void>;
}
