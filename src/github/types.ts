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
  headSha?: string;
  baseRefName?: string;
  state?: string;
  mergedAt?: string;
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

export interface FindIssuesByBodyReferenceOptions {
  fieldName: string;
  issueNumber: number;
}

export interface MergePullRequestOptions {
  number: number;
  method: 'merge' | 'squash' | 'rebase';
}

export interface EditLabelsOptions {
  number: number;
  labels: string[];
}

export interface CommentOnIssueOptions {
  number: number;
  body: string;
}

export interface CloseIssueOptions {
  number: number;
  comment: string;
}

export interface CreateIssueOptions {
  title: string;
  body: string;
  labels?: string[];
}

export interface UpdateIssueOptions extends CreateIssueOptions {
  number: number;
}

export interface AddSubIssueOptions {
  parentIssueNumber: number;
  childIssueNumber: number;
}

export interface ClosePullRequestOptions {
  number: number;
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
  databaseId?: number;
  state: string;
  body: string;
  authorLogin: string | null;
  url?: string;
  submittedAt?: string;
  comments?: GitHubPullRequestComment[];
}

export interface GitHubPullRequestReviewThread {
  id?: string;
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

export interface DismissPullRequestReviewOptions {
  reviewId: string;
  message: string;
}

export interface GitHubClient {
  ensureLabels(labels: PullOpsLabel[]): Promise<EnsureLabelsResult>;
  getIssue(number: number): Promise<GitHubIssue>;
  getPullRequest(number: number): Promise<GitHubPullRequest>;
  getPullRequestChecks(number: number): Promise<GitHubCheckRun[]>;
  getPullRequestChecksForRef(ref: string): Promise<GitHubCheckRun[]>;
  getPullRequestReviewContext(number: number): Promise<GitHubPullRequestReviewContext>;
  getPullRequestDiff(number: number): Promise<GitHubPullRequestDiff>;
  findOpenPullRequestByHead(headBranch: string): Promise<GitHubPullRequest | undefined>;
  findPullRequestByHead?(headBranch: string): Promise<GitHubPullRequest | undefined>;
  findIssuesByBodyReference?(
    options: FindIssuesByBodyReferenceOptions,
  ): Promise<GitHubIssueReference[]>;
  createDraftPullRequest(options: CreateDraftPullRequestOptions): Promise<GitHubPullRequest>;
  createIssue?(options: CreateIssueOptions): Promise<GitHubIssue>;
  updateIssue?(options: UpdateIssueOptions): Promise<GitHubIssue>;
  addSubIssue?(options: AddSubIssueOptions): Promise<void>;
  mergePullRequest?(options: MergePullRequestOptions): Promise<void>;
  addLabelsToIssue(options: EditLabelsOptions): Promise<void>;
  removeLabelsFromIssue(options: EditLabelsOptions): Promise<void>;
  addLabelsToPullRequest(options: EditLabelsOptions): Promise<void>;
  removeLabelsFromPullRequest(options: EditLabelsOptions): Promise<void>;
  commentOnIssue(options: CommentOnIssueOptions): Promise<void>;
  closeIssue(options: CloseIssueOptions): Promise<void>;
  closePullRequest?(options: ClosePullRequestOptions): Promise<void>;
  commentOnPullRequest(options: CommentOnPullRequestOptions): Promise<void>;
  updatePullRequestBody(options: UpdatePullRequestBodyOptions): Promise<void>;
  markPullRequestReadyForReview(number: number): Promise<void>;
  publishPullRequestReview(options: PublishPullRequestReviewOptions): Promise<void>;
  replyToPullRequestReviewComment(options: ReplyToPullRequestReviewCommentOptions): Promise<void>;
  resolvePullRequestReviewThread(threadId: string): Promise<void>;
  dismissPullRequestReview?(options: DismissPullRequestReviewOptions): Promise<void>;
}
