// Shared reporting for "this source file does not parse".
//
// Two places hit it — buildProduction minifying a file src/ -> dist/, and
// BundleGenerator preparing a component for a bundle — and each used to report
// it in its own way: Terser's `Unexpected token punc «(», expected punc «,»`
// with no location, or a position inside the *generated* bundle. Neither told
// the developer which line of their own file to look at.
import fs from 'fs-extra';
import path from 'path';
import { parse } from '@babel/parser';

/** Extensions a relative specifier is resolved against. */
export const RESOLVABLE_MODULE_EXTENSIONS = ['.js', '.json', '.mjs'];

/**
 * Renders a few lines of source around a position, with a caret under it.
 * Deliberately hand-rolled: @babel/code-frame is not a dependency, and this is
 * all it needs to do.
 *
 * @param {string} code
 * @param {number} line 1-based
 * @param {number} column 0-based
 * @returns {string}
 */
export function formatSourceFrame(code, line, column) {
  const lines = String(code).split('\n');
  const first = Math.max(1, line - 2);
  const last = Math.min(lines.length, line + 2);
  const gutter = String(last).length;
  const out = [];

  for (let current = first; current <= last; current += 1) {
    const marker = current === line ? '>' : ' ';
    out.push(`  ${marker} ${String(current).padStart(gutter)} | ${lines[current - 1]}`);
    if (current === line) {
      out.push(`    ${' '.repeat(gutter)} | ${' '.repeat(Math.max(0, column))}^`);
    }
  }
  return out.join('\n');
}

/**
 * Parses `code`, returning a readable diagnostic when it fails.
 *
 * @param {string} code
 * @param {string} filePath shown in the message
 * @returns {{ok: true} | {ok: false, message: string, line: number|null, column: number|null}}
 */
export function describeSyntaxError(code, filePath) {
  try {
    parse(code, { sourceType: 'module', plugins: ['jsx'] });
    return { ok: true };
  } catch (error) {
    const line = error.loc?.line ?? null;
    const column = error.loc?.column ?? 0;
    const where = line ? `${filePath}:${line}:${column + 1}` : filePath;
    // Babel appends its own "(line:col)"; drop it, the location is already
    // stated above in a form editors can jump to.
    const detail = String(error.message).replace(/\s*\(\d+:\d+\)\s*$/, '');
    const frame = line ? `\n\n${formatSourceFrame(code, line, column)}\n` : '';

    return {
      ok: false,
      line,
      column,
      message: `${where}: ${detail}.${frame}`
    };
  }
}

/**
 * Resolves a relative specifier the way the bundler does.
 * @param {string} specifier
 * @param {string} fromDir
 * @returns {string|null} absolute path, or null when nothing matches
 */
export function resolveRelativeSpecifier(specifier, fromDir) {
  const resolved = path.resolve(fromDir, specifier);
  if (!path.extname(resolved)) {
    for (const extension of RESOLVABLE_MODULE_EXTENSIONS) {
      if (fs.existsSync(resolved + extension)) return resolved + extension;
    }
  }
  return fs.existsSync(resolved) ? resolved : null;
}

/**
 * Relative imports that name a JavaScript module and resolve to nothing.
 *
 * Only module-like specifiers are reported — extensionless, or one of
 * RESOLVABLE_MODULE_EXTENSIONS. A relative asset import has its own delivery
 * story and is not the bundler's business.
 *
 * @param {string} code
 * @param {string} fromDir directory the specifiers resolve against
 * @returns {string[]} unresolved specifiers, in source order
 */
export function findUnresolvedRelativeImports(code, fromDir) {
  let ast;
  try {
    ast = parse(code, { sourceType: 'module', plugins: ['jsx'] });
  } catch {
    return []; // unparseable: describeSyntaxError reports that instead
  }

  const unresolved = [];
  for (const node of ast.program.body) {
    const isImportLike = node.type === 'ImportDeclaration'
      || node.type === 'ExportNamedDeclaration'
      || node.type === 'ExportAllDeclaration';
    const specifier = isImportLike ? node.source?.value : null;
    if (typeof specifier !== 'string') continue;
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue;

    const ext = path.extname(specifier);
    const moduleLike = ext === '' || RESOLVABLE_MODULE_EXTENSIONS.includes(ext);
    if (!moduleLike) continue;

    if (!resolveRelativeSpecifier(specifier, fromDir)) unresolved.push(specifier);
  }
  return unresolved;
}

/**
 * True when the module has a default export.
 *
 * Slice loads a component with `const { default: myClass } = await import(...)`
 * (Slice.getClass), so a component without one can never be built.
 *
 * @param {string} code
 * @returns {boolean|null} null when the source does not parse
 */
export function hasDefaultExport(code) {
  try {
    const ast = parse(code, { sourceType: 'module', plugins: ['jsx'] });
    return ast.program.body.some((node) => node.type === 'ExportDefaultDeclaration');
  } catch {
    return null;
  }
}

/**
 * `slice.build('Name')` calls whose component is not in the registry.
 *
 * `slice.build` resolves a component by its registered name, so a typo returns
 * null and the component simply never renders — the framework logs
 * "Component X not found in components.js file" and carries on. Catching it at
 * build time is the closest thing to a "module not found".
 *
 * Deliberately narrow:
 *  - only a `slice.build(...)` receiver (not an arbitrary `.build()` method),
 *  - only a string-literal first argument (a computed name cannot be checked),
 *  - `getComponent` is NOT checked: it takes a sliceId, which is arbitrary
 *    (`slice.getComponent('appTopbar')`), not a component name.
 *
 * @param {string} code
 * @param {Set<string>} registeredNames
 * @returns {string[]} unknown component names, deduped, in source order
 */
export function findUnknownComponentBuilds(code, registeredNames) {
  let ast;
  try {
    ast = parse(code, { sourceType: 'module', plugins: ['jsx', 'classProperties'] });
  } catch {
    return [];
  }

  const unknown = [];
  const seen = new Set();

  const isSliceBuildCallee = (callee) => {
    if (!callee || callee.type !== 'MemberExpression') return false;
    if (callee.property?.name !== 'build') return false;
    const object = callee.object;
    if (object?.type === 'Identifier') return object.name === 'slice';
    // window.slice.build(...)
    return object?.type === 'MemberExpression' && object.property?.name === 'slice';
  };

  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (node.type === 'CallExpression' && isSliceBuildCallee(node.callee)) {
      const first = node.arguments?.[0];
      if (first?.type === 'StringLiteral' && !registeredNames.has(first.value) && !seen.has(first.value)) {
        seen.add(first.value);
        unknown.push(first.value);
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end') continue;
      walk(node[key]);
    }
  };

  walk(ast.program.body);
  return unknown;
}
