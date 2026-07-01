# PullOps CLI command form

Use this command form for every PullOps CLI command:

```sh
npm_config_cache=/tmp/pullops-npm-cache npm exec -- pullops <args>
```

If `npm_config_cache` is already set to a sandbox-writable cache path, keep the
existing value. The `--` immediately after `exec` is required so npm passes
flags such as `--profile`, `--check`, and `--json` to PullOps. Do not use
`npm config set cache`; keep the cache override scoped to the command or
current process.

If a setup command exits nonzero but prints JSON, read the JSON before treating
the command as a tool failure; incomplete setup is reported through structured
blockers and warnings.
