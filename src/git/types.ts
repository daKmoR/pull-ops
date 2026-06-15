export interface GitCommitAuthor {
  name: string;
  email: string;
}

export interface CreateBranchOptions {
  branchName: string;
  baseBranch: string;
}

export interface CommitAllOptions {
  message: string;
  author: GitCommitAuthor;
}

export interface CommitEmptyOptions {
  message: string;
  author: GitCommitAuthor;
}

export interface PushBranchOptions {
  branchName: string;
}

export interface GetChangedFilesSinceBaseOptions {
  baseBranch: string;
}

export interface GetCommitsSinceBaseOptions {
  baseBranch: string;
}

export interface GitCommit {
  sha: string;
  subject: string;
  body: string;
  files: string[];
}

export interface PlannedRewriteCommit {
  message: string;
  files: string[];
}

export interface GitRewriteResult {
  headSha: string;
  treeHash: string;
}

export interface RewriteBranchWithCommitPlanOptions {
  baseBranch: string;
  branchName: string;
  commits: PlannedRewriteCommit[];
  author: GitCommitAuthor;
}

export interface GitClient {
  createBranch(options: CreateBranchOptions): Promise<void>;
  hasChanges(): Promise<boolean>;
  commitAll(options: CommitAllOptions): Promise<void>;
  commitEmpty(options: CommitEmptyOptions): Promise<void>;
  pushBranch(options: PushBranchOptions): Promise<void>;
  getCurrentHeadSha(): Promise<string>;
  getCurrentTreeHash(): Promise<string>;
  getChangedFilesSinceBase(options: GetChangedFilesSinceBaseOptions): Promise<string[]>;
  getCommitsSinceBase?(options: GetCommitsSinceBaseOptions): Promise<GitCommit[]>;
  rewriteBranchWithCommitPlan(
    options: RewriteBranchWithCommitPlanOptions,
  ): Promise<GitRewriteResult>;
}
