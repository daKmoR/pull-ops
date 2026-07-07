# Run Scorecard

The Run Scorecard aggregates the Local Run Records under `.pullops/runs/` into
outcome metrics, so PullOps behavior changes can be judged against measured
runs instead of anecdote.

## Report the scorecard

```sh
npm exec -- pullops runs scorecard
```

The human summary reports, in total and grouped by operation and Model Tier:

- run counts by status, with accepted and blocked rates over terminal runs
  (blocked runs are the runs that stopped for maintainer attention),
- Run Duration totals and averages for runs whose duration is known,
- Context Usage token totals for runs whose usage was runner-reported.

Unknown Run Duration and unknown Context Usage stay unknown rather than being
estimated, and unreadable run records are listed as skipped instead of
failing the scorecard.

Use `--json` for the machine-readable form and `--dir <path>` to aggregate a
different runs directory:

```sh
npm exec -- pullops runs scorecard --json
npm exec -- pullops runs scorecard --dir /path/to/.pullops/runs --json
```

## Capture a baseline

Local Run Records are gitignored, so scorecards are point-in-time snapshots of
one checkout's runs. Before landing a change that alters PullOps behavior,
capture a baseline from a checkout that has accumulated representative runs
and commit it:

```sh
mkdir -p docs/baselines
npm exec -- pullops runs scorecard --json > docs/baselines/run-scorecard-$(date +%F).json
```

Committed baselines live in `docs/baselines/`, named
`run-scorecard-<date>.json`. After the behavior change has produced new runs,
report the scorecard again and compare acceptance rate, blocked rate, Run
Duration, and Context Usage against the committed baseline.
