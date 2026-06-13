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

export interface PushBranchOptions {
  branchName: string;
}

export interface GitClient {
  createBranch(options: CreateBranchOptions): Promise<void>;
  hasChanges(): Promise<boolean>;
  commitAll(options: CommitAllOptions): Promise<void>;
  pushBranch(options: PushBranchOptions): Promise<void>;
}
