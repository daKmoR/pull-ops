# Classify CI failures before fixing

The `pullops-fix-ci` skill must classify failed checks before changing code. It may directly fix clear formatting, lint, type, build, and legitimate test failures, but it must not weaken tests, delete assertions, bypass checks, or hack around missing secrets, external outages, or flaky infrastructure failures.
