import { createRequire } from 'node:module';
import { parse } from '@babel/parser';
import type { ParserPlugin } from '@babel/parser';
import type { Visitor } from '@babel/traverse';
import * as t from '@babel/types';
import { findRepoRoot, toRepoRelative } from './repo-root.js';

// @babel/traverse and @babel/generator ship CJS where the callable lives at
// `module.exports.default`. Load them through `createRequire` and unwrap, so
// the plugin works when executed directly under Node ESM (Vite loads plugins
// via `import()`, which otherwise yields the namespace object, not the fn).
const require = createRequire(import.meta.url);
const traverse = (require('@babel/traverse') as typeof import('@babel/traverse')).default;
const generate = (require('@babel/generator') as typeof import('@babel/generator')).default;

export interface TransformOptions {
  /** Absolute path of the module being transformed. */
  filename: string;
  /** Repository root (absolute). Defaults to detection via `.git` walk-up. */
  root?: string;
  /** Attribute name to stamp. Defaults to `data-fo-src`. */
  attribute?: string;
  /** Also stamp `data-fo-component` with the nearest component name (best effort). */
  componentAttribute?: boolean;
  /**
   * Extra tag names to treat as DOM elements in addition to the default
   * heuristic (tag name starts with a lowercase letter).
   */
  domTags?: string[];
}

export interface TransformResult {
  code: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  map: any;
}

function getJsxTagName(name: t.JSXOpeningElement['name']): string | null {
  // Fragments (`<>`) have a `null` name.
  if (name == null) return null;
  // Member expressions (`<Foo.Bar>`) and namespaced names are component-like,
  // not DOM elements — skip them.
  if (!t.isJSXIdentifier(name)) return null;
  return name.name;
}

function isDomElement(name: string, domTags: string[]): boolean {
  if (domTags.includes(name)) return true;
  // HTML tags and custom elements start with a lowercase letter.
  return /^[a-z]/.test(name);
}

function hasAttribute(node: t.JSXOpeningElement, name: string): boolean {
  return node.attributes.some(
    (attr) => t.isJSXAttribute(attr) && t.isJSXIdentifier(attr.name) && attr.name.name === name,
  );
}

function isPascalCase(s: string): boolean {
  return /^[A-Z][A-Za-z0-9_$]*$/.test(s);
}

/**
 * Best-effort nearest component name: walk up the ancestor chain looking for
 * a PascalCase function/class declaration, or a PascalCase variable assigned
 * an arrow/function expression. Returns `undefined` when undeterminable.
 */
function findComponentName(path: { parentPath: any }): string | undefined {
  let p = path.parentPath;
  while (p) {
    const n = p.node as t.Node;
    if (t.isFunctionDeclaration(n) || t.isFunctionExpression(n)) {
      if (n.id && isPascalCase(n.id.name)) return n.id.name;
    } else if (t.isClassDeclaration(n) || t.isClassExpression(n)) {
      if (n.id && isPascalCase(n.id.name)) return n.id.name;
    } else if (t.isArrowFunctionExpression(n)) {
      const parent = p.parentPath;
      if (
        parent &&
        parent.isVariableDeclarator() &&
        t.isIdentifier(parent.node.id) &&
        isPascalCase(parent.node.id.name)
      ) {
        return parent.node.id.name;
      }
    }
    p = p.parentPath;
  }
  return undefined;
}

/**
 * Parse `code` (JSX/TSX) and stamp every JSX opening element that maps to a
 * DOM element with `attribute="<repo-relative>:<line>:<col>"` (1-based line
 * and column). Returns the transformed code plus a source map, or `null` when
 * nothing changed so the caller can keep the original source untouched.
 */
export function transformJsx(
  code: string,
  options: TransformOptions,
): TransformResult | null {
  const attribute = options.attribute ?? 'data-fo-src';
  const componentAttribute = options.componentAttribute ?? false;
  const domTags = options.domTags ?? [];
  const filename = options.filename;

  const isTs = /\.(ts|tsx)$/i.test(filename);
  const plugins: ParserPlugin[] = ['jsx'];
  if (isTs) plugins.push('typescript');

  const ast = parse(code, {
    sourceType: 'unambiguous',
    plugins,
  });

  const root = options.root ?? findRepoRoot(filename);

  let changed = false;

  const visitor: Visitor = {
    JSXOpeningElement(path) {
      const node = path.node;
      const tagName = getJsxTagName(node.name);
      if (tagName == null) return;
      if (!isDomElement(tagName, domTags)) return;
      if (hasAttribute(node, attribute)) return;

      const loc = node.loc;
      if (!loc) return;

      // Babel `loc.start.line` is 1-based; `loc.start.column` is 0-based, so
      // add 1 to produce a 1-based column.
      const line = loc.start.line;
      const column = loc.start.column + 1;
      const rel = toRepoRelative(filename, root);
      // Out-of-root files have no repo-relative path — skip stamping entirely
      // rather than emitting a leaky `../` traversal or absolute path.
      if (rel == null) return;

      const value = `${rel}:${line}:${column}`;

      node.attributes.push(
        t.jsxAttribute(t.jsxIdentifier(attribute), t.stringLiteral(value)),
      );
      changed = true;

      if (componentAttribute && !hasAttribute(node, 'data-fo-component')) {
        const component = findComponentName(path);
        if (component) {
          node.attributes.push(
            t.jsxAttribute(
              t.jsxIdentifier('data-fo-component'),
              t.stringLiteral(component),
            ),
          );
        }
      }
    },
  };

  traverse(ast, visitor);

  if (!changed) return null;

  const output = generate(
    ast,
    {
      sourceMaps: true,
      sourceFileName: filename,
    },
    code,
  );

  return { code: output.code, map: output.map ?? null };
}
