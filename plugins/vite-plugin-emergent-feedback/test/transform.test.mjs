import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import { transformJsx, findRepoRoot, toRepoRelative } from '../dist/index.js';

const ROOT = '/repo';
const FILE = '/repo/src/App.tsx';

/** Re-parse transformed code and return { tagName: { attrName: value } }. */
function attrMap(code) {
  const ast = parse(code, { sourceType: 'unambiguous', plugins: ['jsx'] });
  const out = {};
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'JSXOpeningElement') {
      const tag = node.name && node.name.name;
      const attrs = {};
      for (const a of node.attributes || []) {
        if (a.type === 'JSXAttribute' && a.name && a.name.name) {
          attrs[a.name.name] = a.value ? a.value.value : true;
        }
      }
      if (tag) out[tag] = attrs;
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'tokens' || key === 'comments') continue;
      const value = node[key];
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  })(ast);
  return out;
}

test('stamps DOM elements with data-fo-src="repo-relative:line:col"', () => {
  const sample = [
    "import React from 'react';",
    '',
    'export function App() {',
    '  return (',
    '    <div className="container">',
    '      <button onClick={() => alert("hi")}>Click</button>',
    '      <span>text</span>',
    '    </div>',
    '  );',
    '}',
  ].join('\n');

  const result = transformJsx(sample, { filename: FILE, root: ROOT });
  assert.ok(result, 'transform produced output');
  assert.ok(result.map, 'source map emitted');

  const attrs = attrMap(result.code);
  assert.equal(attrs.div['data-fo-src'], 'src/App.tsx:5:5');
  assert.equal(attrs.button['data-fo-src'], 'src/App.tsx:6:7');
  assert.equal(attrs.span['data-fo-src'], 'src/App.tsx:7:7');
});

test('skips uppercase components and fragments', () => {
  const sample = [
    'export function App() {',
    '  return (',
    '    <>',
    '      <CustomThing />',
    '      <div>real</div>',
    '    </>',
    '  );',
    '}',
  ].join('\n');

  const result = transformJsx(sample, { filename: FILE, root: ROOT });
  assert.ok(result);
  const attrs = attrMap(result.code);
  assert.ok(attrs.div && attrs.div['data-fo-src'], 'DOM div stamped');
  assert.ok(!attrs.CustomThing || !attrs.CustomThing['data-fo-src'], 'component not stamped');
  assert.ok(!attrs['<'] && !attrs.Fragment, 'no fragment stamp');
});

test('does not overwrite an existing data-fo-src', () => {
  const src = '<div data-fo-src="keep:1:1">x</div>';
  const result = transformJsx(src, { filename: FILE, root: ROOT });
  // Existing attribute short-circuits the stamp; transform reports no change,
  // so the original `keep:1:1` value is preserved verbatim.
  assert.equal(result, null);
});

test('injects data-fo-component when componentAttribute=true', () => {
  const sample = [
    'export function App() {',
    '  return (',
    '    <div className="container">',
    '      <button>Click</button>',
    '    </div>',
    '  );',
    '}',
  ].join('\n');

  const result = transformJsx(sample, {
    filename: FILE,
    root: ROOT,
    componentAttribute: true,
  });
  assert.ok(result);
  const attrs = attrMap(result.code);
  assert.equal(attrs.button['data-fo-component'], 'App');
  assert.equal(attrs.div['data-fo-component'], 'App');
});

test('preserves spread props and still stamps', () => {
  const src = '<button {...props}>x</button>';
  const result = transformJsx(src, { filename: FILE, root: ROOT });
  assert.ok(result);
  assert.match(result.code, /\.\.\.props/);
  assert.match(result.code, /data-fo-src/);
});

test('honors a custom attribute name', () => {
  const result = transformJsx('<div>x</div>', {
    filename: FILE,
    root: ROOT,
    attribute: 'data-src',
  });
  assert.ok(result);
  assert.match(result.code, /data-src="src\/App\.tsx:1:1"/);
});

test('treats configured domTags as DOM even when PascalCase', () => {
  const result = transformJsx('<StyledButton>x</StyledButton>', {
    filename: FILE,
    root: ROOT,
    domTags: ['StyledButton'],
  });
  assert.ok(result);
  assert.ok(attrMap(result.code).StyledButton['data-fo-src']);
});

test('returns null (no reformat) for files with no JSX', () => {
  const result = transformJsx('export const x = 1;\n', { filename: FILE, root: ROOT });
  assert.equal(result, null);
});

test('detects repo root via .git and strips prefix', () => {
  const root = mkdtempSync(join(tmpdir(), 'fo-root-'));
  writeFileSync(join(root, '.git'), 'gitdir: /some/where\n'); // worktree-style .git file
  const sub = join(root, 'src', 'components');
  mkdirSync(sub, { recursive: true });
  const file = join(sub, 'Button.tsx');

  assert.equal(findRepoRoot(file), root);
  assert.equal(toRepoRelative(file, root), 'src/components/Button.tsx');
});

test('returns undefined for files outside root (no traversal path emitted)', () => {
  assert.equal(toRepoRelative('/other/src/App.tsx', '/repo'), undefined);
});

test('does not stamp elements for files outside root', () => {
  const result = transformJsx('<div>x</div>', {
    filename: '/other/src/App.tsx',
    root: ROOT,
  });
  assert.equal(result, null);
});
