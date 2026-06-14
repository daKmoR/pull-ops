# TypeScript and JSDoc

Write implementation and tests in JavaScript. This repo uses TypeScript for static checking and declaration generation, not as the default runtime source language.

Default to `.js` files with JSDoc types:

```js
/**
 * @param {string[]} args
 * @returns {number}
 */
export function parseCount(args) {
  return Number(args[0] ?? 0);
}
```

Keep small non-object aliases in the `.js` file when they are local and clearer inline:

```js
/**
 * @typedef {'high' | 'mid' | 'low'} ModelTier
 */
```

Do not define object-shape types with inline JSDoc `@typedef {{ ... }}` blocks in `.js` files. Move object shapes to a type-only TypeScript module and import them from JavaScript through JSDoc.

Use an accompanying `*.types.ts` file when the type belongs to one runtime module:

```ts
// src/operations/implement-issue/output.types.ts
export interface ImplementedIssueOutput {
  status: 'implemented';
  summary: string;
  changes: string[];
}
```

```js
// src/operations/implement-issue/output.js
/**
 * @typedef {import('./output.types.js').ImplementedIssueOutput} ImplementedIssueOutput
 */
```

Use a shared `types.ts` file when a type is shared across a feature, public, or duplicated in several files:

```ts
// src/config/types.ts
export type ModelTier = 'high' | 'mid' | 'low';

export interface OperationConfig {
  modelTier: ModelTier;
}
```

```js
// src/config/PullOpsConfig.js
/**
 * @typedef {import('./types.js').ModelTier} ModelTier
 * @typedef {import('./types.js').OperationConfig} OperationConfig
 */
```

Prefer colocated names that mirror the runtime module: `output.js` uses `output.types.ts`, `run.js` uses `run.types.ts`, and test-only helper types can use `Foo.test.types.ts`. In JSDoc import specifiers, use the emitted `.js` path for TypeScript modules, such as `import('./output.types.js')`, because this repo uses NodeNext declaration emit.

Type-only `.ts` files must only export erased TypeScript constructs such as `type` and `interface`. Do not export runtime values, classes, functions, or enums from them, and do not import them with runtime `import` statements from `.js` files. Inside type-only `.ts` files, use `import type` when referencing types from other modules.

Use JSDoc `@typedef {import(...)}` for reusable imported types, `@type` for constants, `@param` and `@returns` for functions, and narrow inline casts only at validated boundaries:

```js
const tier = /** @type {ModelTier} */ (rawTier);
```

Prefer plain JavaScript validation before casting unknown input. Casts should document a proven fact, not silence a type error.

Run `npm run types` after changing JSDoc or type-only TypeScript files. The TypeScript config checks JavaScript with `allowJs` and `checkJs`, and emits declarations into `dist-types`.
