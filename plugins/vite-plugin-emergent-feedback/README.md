# vite-plugin-emergent-feedback

Compile-time DOM source stamping for AI feedback tooling.

This Vite plugin parses your **JSX / TSX** source at build time and injects a
`data-fo-src` attribute onto every DOM element it can identify, encoding the
element's **exact** origin as `repo-relative-path:line:column`. The client's
`resolveSource()` ladder reads this attribute first (`resolution="build-stamp"`,
`confidence="exact"`) — no source maps, no fiber introspection, works in
production.

## Why build-time stamping

Source maps map *stack frames*, not *DOM nodes*. The only reliable way to know
"which authored file:line produced this `<button>`" in a production build is to
stamp the element at compile time. This plugin is that stamp.

## Install

```sh
npm install --save-dev vite-plugin-emergent-feedback
```

## Usage

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import emergentFeedback from 'vite-plugin-emergent-feedback';

export default defineConfig({
  plugins: [emergentFeedback()],
});
```

Rebuild. Inspect a DOM element in your production build — it now carries:

```html
<button data-fo-src="src/components/Pricing/UpgradeButton.tsx:42:7">Upgrade now</button>
```

## Emitted attribute format (exact)

```
data-fo-src="<repo-relative-path>:<line>:<column>"
```

- **path** — repository-relative, POSIX forward slashes, **no leading slash**.
  Computed by walking up from the module for a `.git` entry and stripping that
  root. Falls back to `process.cwd()`-relative when no `.git` is found.
- **line** — 1-based.
- **column** — 1-based (the `<` of the opening tag).

Example: `data-fo-src="src/components/Pricing/UpgradeButton.tsx:42:7"`.

With `componentAttribute: true`, an additional attribute is added where the
nearest component name is determinable:

```html
data-fo-component="UpgradeButton"
```

## Options

| Option              | Type      | Default          | Description                                                                 |
| ------------------- | --------- | ---------------- | --------------------------------------------------------------------------- |
| `include`           | `RegExp`  | `/\.(j\|t)sx$/`  | Modules to transform (matched against the id/path).                          |
| `exclude`           | `RegExp`  | `/node_modules/` | Modules to skip.                                                            |
| `attribute`         | `string`  | `'data-fo-src'`  | Attribute name to stamp.                                                    |
| `componentAttribute`| `boolean` | `false`          | Also stamp `data-fo-component` with the nearest component name (best effort).|
| `domTags`           | `string[]`| `[]`             | Extra tag names to treat as DOM (beyond lowercase-first heuristic).          |
| `root`              | `string`  | (auto)           | Override the repository root used to compute the relative path.             |

## What it does

1. Runs as a `enforce: 'pre'` `transform` hook, so it sees authored JSX/TSX
   *before* esbuild strips it.
2. Parses with Babel (`jsx` + `typescript` plugins).
3. Visits every `JSXOpeningElement`:
   - skips fragments (`<>`, `<Fragment>`),
   - skips components (tag starts uppercase) unless listed in `domTags`,
   - skips elements that already carry the target attribute,
   - leaves spread props (`{...props}`) untouched and adds the stamp alongside,
   - injects `data-fo-src` with 1-based line/column.
4. Regenerates the module with a **source map** (`sourceMaps: true`,
   `sourceFileName` set). If nothing changed, returns `null` so the original
   source is never reformatted.
5. On any parse failure, logs a warning and returns `null` — the build never
   breaks.

## Supported / unsupported

- ✅ **Supported:** React JSX / TSX (`.jsx`, `.tsx`). Any JSX dialect that Babel's
  `jsx` plugin accepts works too (e.g. Preact, Solid).
- ❌ **Unsupported in v0.1:** Vue (`.vue` SFC) and Svelte. Their templates live
  in a different syntax; instrument them with framework-specific inspectors
  (`vite-plugin-vue-inspector`, `@sveltejs/...`) or a future release.

## Graceful degradation

This plugin is one rung of the client's resolution ladder. It is **not**
required for the feedback tool to function:

- **No plugin** → the client falls back to React fiber `_debugSource` (dev),
  then fiber component name, then `data-component`, yielding
  `confidence="none"` (or `"approximate"` for the component name) — still a
  useful, correct envelope, just without an exact file:line:col.
- **Build with plugin** → `confidence="exact"` via `data-fo-src`.

## Development

```sh
npm install
npm run build   # tsc → dist/ (ESM + declarations)
npm test        # build + node --test on transform fixtures/assertions
```

The core transform is also exported as `transformJsx(code, options)` for direct
use outside Vite, plus `findRepoRoot` / `toRepoRelative` helpers.

## License

MIT
