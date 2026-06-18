export interface GitCommitAuthor {
  name: string;
  email: string;
}

export interface CreateBranchOptions {
  branchName: string;
  baseBranch: string;
}

export interface FetchRemoteRefsOptions {
  requiredBranchNames: string[];
  optionalBranchNames?: string[];
}

export interface CheckoutPullOpsBranchOptions {
  branchName: string;
  baseBranch: string;
}

export interface CheckoutBranchOptions {
  branchName: string;
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

export interface RebaseBranchOntoBaseOptions {
  branchName: string;
  baseBranch: string;
  committer: GitCommitAuthor;
}

export interface StartRebaseBranchOntoBaseOptions {
  branchName: string;
  baseBranch: string;
  committer: GitCommitAuthor;
}

export interface ContinueRebaseOptions {
  branchName: string;
  baseBranch: string;
  committer: GitCommitAuthor;
}

export interface ReadRebaseConflictContextOptions {
  branchName: string;
  baseBranch: string;
}

export interface GitConflictFile {
  path: string;
  exists: boolean;
  content?: string;
  baseContent?: string;
  oursContent?: string;
  theirsContent?: string;
}

export interface GitConflictContext {
  branchName: string;
  baseBranch: string;
  conflictedFiles: GitConflictFile[];
  baseHeadSha?: string;
  originalHeadSha?: string;
  currentHeadSha: string;
  rebaseHeadSha?: string;
}

export type GitRebaseResult =
  | {
      status: 'rebased';
      headSha: string;
      treeHash: string;
    }
  | {
      status: 'conflicts';
      conflictedFiles: string[];
    };

export type GitRebaseStepResult =
  | {
      status: 'complete';
      headSha: string;
      treeHash: string;
    }
  | {
      status: 'conflicts';
      conflictContext: GitConflictContext;
    };

export interface CherryPickCommitOntoBranchOptions {
  branchName: string;
  baseBranch: string;
  commitSha: string;
  committer: GitCommitAuthor;
}

export type GitCherryPickResult =
  | {
      status: 'cherry-picked';
      headSha: string;
      treeHash: string;
    }
  | {
      status: 'conflicts';
      conflictedFiles: string[];
    };

export interface PushBranchWithLeaseOptions {
  branchName: string;
}

export type GitPushWithLeaseResult =
  | {
      status: 'pushed';
      headSha: string;
      treeHash: string;
    }
  | {
      status: 'stale-lease';
    };

export interface GetChangedFilesSinceBaseOptions {
  baseBranch: string;
  preferLocalBase?: boolean;
}

export interface GetCommitsSinceBaseOptions {
  baseBranch: string;
  preferLocalBase?: boolean;
}

export interface ResetHardToRevisionOptions {
  revision: string;
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
  push?: boolean;
  preferLocalBase?: boolean;
}

export interface RewriteBranchWithExistingCommitsOptions {
  baseBranch: string;
  branchName: string;
  commitShas: string[];
  committer: GitCommitAuthor;
}

export interface GitClient {
  createBranch(options: CreateBranchOptions): Promise<void>;
  fetchRemoteRefs?(options: FetchRemoteRefsOptions): Promise<void>;
  checkoutPullOpsBranch?(options: CheckoutPullOpsBranchOptions): Promise<void>;
  getCurrentBranch?(): Promise<string>;
  checkoutBranch?(options: CheckoutBranchOptions): Promise<void>;
  hasChanges(): Promise<boolean>;
  commitAll(options: CommitAllOptions): Promise<void>;
  commitEmpty(options: CommitEmptyOptions): Promise<void>;
  readWorkingTreePatch?(): Promise<string>;
  pushBranch(options: PushBranchOptions): Promise<void>;
  rebaseBranchOntoBase(options: RebaseBranchOntoBaseOptions): Promise<GitRebaseResult>;
  startRebaseBranchOntoBase?(
    options: StartRebaseBranchOntoBaseOptions,
  ): Promise<GitRebaseStepResult>;
  continueRebase?(options: ContinueRebaseOptions): Promise<GitRebaseStepResult>;
  readRebaseConflictContext?(
    options: ReadRebaseConflictContextOptions,
  ): Promise<GitConflictContext | undefined>;
  cherryPickCommitOntoBranch?(
    options: CherryPickCommitOntoBranchOptions,
  ): Promise<GitCherryPickResult>;
  pushBranchWithLease(options: PushBranchWithLeaseOptions): Promise<GitPushWithLeaseResult>;
  getCurrentHeadSha(): Promise<string>;
  getCurrentTreeHash(): Promise<string>;
  resetHardToRevision?(options: ResetHardToRevisionOptions): Promise<void>;
  getChangedFilesSinceBase(options: GetChangedFilesSinceBaseOptions): Promise<string[]>;
  getCommitsSinceBase?(options: GetCommitsSinceBaseOptions): Promise<GitCommit[]>;
  rewriteBranchWithCommitPlan(
    options: RewriteBranchWithCommitPlanOptions,
  ): Promise<GitRewriteResult>;
  rewriteBranchWithExistingCommits?(
    options: RewriteBranchWithExistingCommitsOptions,
  ): Promise<GitRewriteResult>;
}
