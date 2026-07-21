# Releasing PullOps

PullOps publishes `@pull-ops/cli` from the `Publish` GitHub Actions workflow when a GitHub release is published.

## One-time repository setup

1. Confirm that the maintainer or npm organization owns the `@pull-ops` scope.
2. Configure npm trusted publishing for `daKmoR/pull-ops` and workflow file `release.yml`.
3. Create a protected GitHub environment named `npm` with required maintainer approval.
4. Protect `main` and require the `CI / Required checks` status check.
5. Enable GitHub private vulnerability reporting.

The publish job uses GitHub OIDC instead of a long-lived npm token. The npm package receives provenance automatically through trusted publishing.

## Prepare a release

1. Add a Changeset with every user-visible change after `0.1.0`.
2. Run `npm exec -- changeset version` and review the package version and changelog.
3. Commit the release version before running any publish operation.
4. Run the release checks locally:

   ```sh
   npm ci
   npm run lint
   npm run types
   npm test
   npm run smoke:package
   npm audit --omit=dev
   npm publish --dry-run --access public
   ```

5. Merge the release commit through the required CI checks.

## Publish

Create and publish a GitHub release tagged `v<package-version>`, such as `v0.1.0`. The workflow refuses a tag that does not exactly match `package.json`, repeats verification, and publishes through npm trusted publishing.

After the workflow succeeds, verify the registry and a clean installation:

```sh
npm view @pull-ops/cli version dist-tags
npm install --save-dev @pull-ops/cli
npm exec -- pullops --help
```

Do not publish from a developer workstation unless GitHub trusted publishing is unavailable and the exception is explicitly approved.
