# PullOps

PullOps is an npm CLI package for running AI-native GitHub issue and pull request
workflows from GitHub Actions.

## GitHub Token Setup

PullOps requires a repository secret named `PULLOPS_GITHUB_TOKEN`. The workflows
expose that same secret as `GH_TOKEN`, `GITHUB_TOKEN`, and `PULLOPS_GITHUB_TOKEN`
so the PullOps CLI, `gh`, and other GitHub-aware tools all use the same
credential.

Prefer a fine-grained personal access token:

1. Open GitHub, then go to **Settings** -> **Developer settings** ->
   **Personal access tokens** -> **Fine-grained tokens**.
2. Click **Generate new token**.
3. Use `PULLOPS_GITHUB_TOKEN for daKmoR/pull-ops` as the token name. For other
   repositories, use `PULLOPS_GITHUB_TOKEN for OWNER/REPO`.
4. Set **Resource owner** to the user or organization that owns the repository.
5. Set **Repository access** to **Only select repositories**, then select this
   repository.
6. Grant these repository permissions:
   - **Contents**: read and write
   - **Issues**: read and write
   - **Pull requests**: read and write
   - **Workflows**: write, or read and write if GitHub shows both levels
7. Generate the token and copy it immediately.

Add the token as a repository Actions secret:

1. In the repository, go to **Settings** -> **Secrets and variables** ->
   **Actions**.
2. Open the **Secrets** tab.
3. Click **New repository secret**.
4. Name it `PULLOPS_GITHUB_TOKEN`.
5. Paste the token value and save it.

You can also set the secret with the GitHub CLI:

```sh
gh secret set PULLOPS_GITHUB_TOKEN --repo OWNER/REPO
```

GitHub CLI can store the token as a repository secret, but it does not create a
fine-grained personal access token for you. Create the token in GitHub, then pass
the copied token value to `gh secret set`.

If fine-grained tokens are not available for your repository or organization, use
a classic personal access token only as a fallback. It needs `repo` and
`workflow` scopes, which are broader than the fine-grained permissions above.

See GitHub's docs for current UI details:

- [Managing personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
- [Using secrets in GitHub Actions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)
