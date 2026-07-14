// commands/utils/analyzeSource.js
//
// Static dependency extraction for a single component/module source file.
// Used by the `get` flow to discover what a downloaded component needs so the
// whole dependency tree is installed, not just its own three files.
//
// Two kinds of dependency are reported:
//   - builds:  component names referenced via slice.build('Name')          → components
//   - imports: relative import/export specifiers (start with '.')          → components OR helper modules
//
// Only static forms are detected (string-literal build names, static import
// specifiers). Dynamic `slice.build(variable)` cannot be resolved here.

import { parse } from '@babel/parser';
import traverse from '@babel/traverse';

/** True for bare node_modules specifiers (not relative/absolute/URL/subpath-#). */
function isBare(spec) {
  return typeof spec === 'string' && spec.length > 0 &&
    !spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('#') &&
    !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(spec);
}

/**
 * @param {string} sourceText
 * @returns {{ builds: Set<string>, imports: string[], bareImports: string[] }}
 */
export function analyzeSource(sourceText) {
  const builds = new Set();
  const imports = new Set();
  const bareImports = new Set();

  const addImport = (node) => {
    const src = node?.source?.value;
    if (typeof src !== 'string') return;
    if (src.startsWith('.')) imports.add(src);
    else if (isBare(src)) bareImports.add(src);
  };

  try {
    const ast = parse(sourceText, { sourceType: 'module', plugins: ['jsx'] });

    traverse.default(ast, {
      CallExpression(path) {
        const { callee, arguments: args } = path.node;

        // slice.build('Name', ...)
        if (
          callee.type === 'MemberExpression' &&
          callee.object?.name === 'slice' &&
          callee.property?.name === 'build' &&
          args[0]?.type === 'StringLiteral'
        ) {
          builds.add(args[0].value);
          return;
        }

        // dynamic import('./x.js') or import('some-pkg')
        if (callee.type === 'Import' && args[0]?.type === 'StringLiteral') {
          const spec = args[0].value;
          if (spec.startsWith('.')) imports.add(spec);
          else if (isBare(spec)) bareImports.add(spec);
        }
      },

      ImportDeclaration(path) { addImport(path.node); },
      ExportNamedDeclaration(path) { addImport(path.node); },
      ExportAllDeclaration(path) { addImport(path.node); }
    });
  } catch {
    // Unparseable source → discover nothing; the component still installs as-is.
  }

  return { builds, imports: Array.from(imports), bareImports: Array.from(bareImports) };
}

export default analyzeSource;
