# Classify CI failures before fixing

The `pullops-pr-fix-ci` skill must classify failed checks before changing code. It may directly fix clear formatting, lint, type, build, and legitimate test failures, but it must not weaken tests, delete assertions, bypass checks, or hack around missing secrets, external outages, or flaky infrastructure failures.

Amended by [ADR-0066](0066-keep-policy-in-prompts-and-verification-in-code.md): the runner now owns the Check Failure Classification judgment against the fixed taxonomy, instead of echoing a PullOps keyword classification. The keyword classifier is demoted to a non-binding prior recorded in the Local Run Record so disagreement stays measurable, PullOps still refuses to act on failures the runner classifies as `environment`, `flaky`, or `secret`, and the no-weakening rule is now enforced by deterministic working-tree verification before any commit, in addition to the runner's self-reported safety flags.
