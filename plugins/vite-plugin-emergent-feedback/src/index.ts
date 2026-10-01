import type { Plugin } from 'vite';
import { transformJsx } from './transform.js';
import type { TransformOptions } from './transform.js';
import { findRepoRoot, toRepoRelative } from './repo-root.js';

export interface EmergentFeedbackOptions {
  /** Regex matched against the module id/path. Defaults to `\.(j|t)sx$`. */
  include?: RegExp;
  /** Regex matched against the module id/path to skip. Defaults to `node_modules`. */
  exclude?: RegExp;
  /** Attribute name to stamp. Defaults to `data-fo-src`. */
  attribute?: string;
  /** Also stamp `data-fo-component` with the nearest component name (best effort). */
  componentAttribute?: boolean;
  /** Extra tag names to treat as DOM elements (beyond lowercase-first heuristic). */
  domTags?: string[];
  /** Repository root override. Defaults to `.git` walk-up from each file. */
  root?: string;
}

/**
 * Vite plugin that stamps JSX/TSX DOM elements with `data-fo-src` so a clicked
 * element can be resolved to its exact source location in production builds.
 */
export function emergentFeedback(userOptions: EmergentFeedbackOptions = {}): Plugin {
  const {
    include = /\.(j|t)sx$/,
    exclude = /node_modules/,
    attribute = 'data-fo-src',
    componentAttribute = false,
    domTags = [],
    root,
  } = userOptions;

  return {
    name: 'vite-plugin-emergent-feedback',
    // Run before esbuild strips JSX/TS so we see the authored JSX source.
    enforce: 'pre',
    transform(code, id) {
      if (!include.test(id)) return null;
      if (exclude.test(id)) return null;
      try {
        return transformJsx(code, {
          filename: id,
          root,
          attribute,
          componentAttribute,
          domTags,
        } satisfies TransformOptions);
      } catch (err) {
        // Graceful degradation: never break the build over a parse failure.
        this.warn(
          `[vite-plugin-emergent-feedback] failed to transform ${id}: ${
            (err as Error).message
          }`,
        );
        return null;
      }
    },
  };
}

export default emergentFeedback;
export { transformJsx, findRepoRoot, toRepoRelative };
export type { TransformOptions };
