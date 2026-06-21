# Use npm ci in generated workflows

Generated PullOps GitHub Actions workflows always install dependencies with `npm ci` and then invoke the local PullOps dependency with `npm exec pullops -- ...`. PullOps treats a missing `package-lock.json` as a GitHub Actions readiness blocker in Setup Doctor, because workflows should fail setup checks rather than silently switching to less reproducible dependency installation.
