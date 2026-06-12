# Only mutate same-repository PRs in v1

PullOps v1 refuses PR operations on forked pull requests and only mutates Same-Repository PRs. The PR workflows need writable credentials and check out untrusted branch code, so supporting forks requires a separate trust model that should not be hidden inside the first version.
