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

export interface RebaseBranchOntoBaseOptions {
  branchName: string;
  baseBranch: string;
}

export interface StartRebaseBranchOntoBaseOptions {
  branchName: string;
  baseBranch: string;
}

export interface ContinueRebaseOptions {
  branchName: string;
  baseBranch: string;
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
  rebaseBranchOntoBase(options: RebaseBranchOntoBaseOptions): Promise<GitRebaseResult>;
  startRebaseBranchOntoBase?(
    options: StartRebaseBranchOntoBaseOptions,
  ): Promise<GitRebaseStepResult>;
  continueRebase?(options: ContinueRebaseOptions): Promise<GitRebaseStepResult>;
  readRebaseConflictContext?(
    options: ReadRebaseConflictContextOptions,
  ): Promise<GitConflictContext | undefined>;
  pushBranchWithLease(options: PushBranchWithLeaseOptions): Promise<GitPushWithLeaseResult>;
  getCurrentHeadSha(): Promise<string>;
  getCurrentTreeHash(): Promise<string>;
  getChangedFilesSinceBase(options: GetChangedFilesSinceBaseOptions): Promise<string[]>;
  getCommitsSinceBase?(options: GetCommitsSinceBaseOptions): Promise<GitCommit[]>;
  rewriteBranchWithCommitPlan(
    options: RewriteBranchWithCommitPlanOptions,
  ): Promise<GitRewriteResult>;
}
