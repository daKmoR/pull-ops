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

Keep small, module-local types in the `.js` file that uses them:

```js
/**
 * @typedef {'high' | 'mid' | 'low'} ModelTier
 * @typedef {{ modelTier: ModelTier }} OperationConfig
 */
```

When a type is shared across modules, public, or duplicated in several files, move the type to a type-only TypeScript module and import it from JavaScript through JSDoc:

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

Type-only `.ts` files must only export erased TypeScript constructs such as `type` and `interface`. Do not export runtime values, classes, functions, or enums from them, and do not import them with runtime `import` statements from `.js` files.

Use JSDoc `@typedef {import(...)}` for reusable imported types, `@type` for constants, `@param` and `@returns` for functions, and narrow inline casts only at validated boundaries:

```js
const tier = /** @type {ModelTier} */ (rawTier);
```

Prefer plain JavaScript validation before casting unknown input. Casts should document a proven fact, not silence a type error.

Run `npm run types` after changing JSDoc or type-only TypeScript files. The TypeScript config checks JavaScript with `allowJs` and `checkJs`, and emits declarations into `dist-types`.

