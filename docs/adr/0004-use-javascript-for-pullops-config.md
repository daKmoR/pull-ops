# Use JavaScript for PullOps config

PullOps stores Target Repository configuration in a JavaScript module rather than JSON. The file should be typed with JSDoc against `@pull-ops/cli/types.js`, giving users editor feedback while preserving the ability to compute values and reuse local constants without PullOps inventing a custom config language.
