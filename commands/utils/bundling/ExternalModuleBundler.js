// commands/utils/bundling/ExternalModuleBundler.js
//
// Internal wrapper around esbuild used to resolve and bundle bare package
// imports (e.g. `import dayjs from 'dayjs'`) from the project's node_modules
// into a single, self-contained module string that the Slice bundle runtime
// can evaluate.
//
// Design notes:
//   - esbuild does the hard parts we deliberately do NOT reimplement by hand:
//     Node resolution (package.json exports/main/module, index fallback,
//     nested node_modules), CommonJS <-> ESM interop, transitive third-party
//     graph, and tree-shaking.
//   - Output format is CJS. esbuild wraps the virtual entry's exports onto a
//     `module.exports` object; we evaluate that inside an IIFE that provides
//     `module`/`exports`, and return the resulting namespace-like object. This
//     avoids running esbuild's already-bundled output back through the Babel
//     export-rewriting used for hand-written relative helper modules.
//   - The returned object mirrors an ES module namespace: named exports as own
//     keys plus a `default` key (when requested), which is exactly what the
//     existing `buildDependencyBindings` runtime contract expects.
//
// This module is the ONLY place allowed to import esbuild. All other code must
// go through this wrapper (team rule: external libraries stay behind an
// internal abstraction).

import { build } from 'esbuild';

const URL_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

// Non-JS assets a package may import. They are inlined as base64 data URLs so
// the emitted dependency module stays self-contained (no sidecar files). WASM
// as a data URL works with the common `fetch(url) -> WebAssembly.instantiate`
// pattern; url() references inside bundled CSS are inlined the same way.
export const ASSET_LOADERS = {
  '.wasm': 'dataurl',
  '.png': 'dataurl',
  '.jpg': 'dataurl',
  '.jpeg': 'dataurl',
  '.gif': 'dataurl',
  '.svg': 'dataurl',
  '.webp': 'dataurl',
  '.avif': 'dataurl',
  '.woff': 'dataurl',
  '.woff2': 'dataurl',
  '.ttf': 'dataurl',
  '.eot': 'dataurl',
  // Text assets some packages import as strings (GLSL shaders, templates).
  // Loaded verbatim so `import src from './x.glsl'` yields the file contents.
  '.txt': 'text',
  '.glsl': 'text',
  '.vert': 'text',
  '.frag': 'text',
  '.vs': 'text',
  '.fs': 'text'
};

/**
 * Minimal browser shims for the Node globals that browser-targeted packages
 * still touch at runtime: `process` (env/platform/nextTick) and `global`. This
 * is NOT a Node polyfill — there is no Buffer, stream, or fs. It only prevents
 * a ReferenceError when a package reads e.g. `process.platform` or `global`
 * dynamically; static `process.env.NODE_ENV` is still folded at bundle time by
 * the esbuild `define`. The snippet is idempotent and guarded (it never
 * clobbers a real `process`), so prepending it to every bundled package as an
 * esbuild banner is safe.
 * @param {string} nodeEnv value exposed as process.env.NODE_ENV at runtime.
 * @returns {string}
 */
export function nodeGlobalsBanner(nodeEnv) {
  return [
    '(function(){',
    '  if (typeof globalThis === "undefined") return;',
    '  if (typeof globalThis.global === "undefined") globalThis.global = globalThis;',
    '  if (typeof globalThis.process === "undefined") {',
    `    globalThis.process = { env: { NODE_ENV: ${JSON.stringify(nodeEnv)} }, argv: [], platform: "browser", browser: true, version: "", versions: {}, cwd: function(){ return "/"; }, nextTick: function(cb){ Promise.resolve().then(cb); } };`,
    '  } else if (typeof globalThis.process.env === "undefined") {',
    `    globalThis.process.env = { NODE_ENV: ${JSON.stringify(nodeEnv)} };`,
    '  }',
    '})();'
  ].join('\n');
}

/** Stable short key for a CSS payload (djb2), used to de-duplicate injection. */
export function cssInjectionKey(css) {
  let h = 5381;
  for (let i = 0; i < css.length; i += 1) {
    h = ((h << 5) + h + css.charCodeAt(i)) >>> 0;
  }
  return `ext-${h.toString(36)}`;
}

/**
 * Runtime snippet that injects a package's bundled CSS as a <style> element.
 * esbuild resolves @import and url() while bundling, so the passed CSS is
 * already flattened and self-contained. Injection is idempotent: the same CSS
 * (e.g. a package present in two route bundles) is only injected once.
 * @param {string} css
 * @returns {string}
 */
export function buildCssInjectionSnippet(css) {
  const key = cssInjectionKey(css);
  return [
    '(function(){',
    '  if (typeof document === "undefined") return;',
    `  var __k = ${JSON.stringify(key)};`,
    "  if (document.querySelector('style[data-slice-external=\"' + __k + '\"]')) return;",
    '  var __sliceStyle = document.createElement("style");',
    '  __sliceStyle.setAttribute("data-slice-external", __k);',
    `  __sliceStyle.textContent = ${JSON.stringify(css)};`,
    '  document.head.appendChild(__sliceStyle);',
    '})();'
  ].join('\n');
}

/**
 * Splits esbuild's outputFiles into the JS entry text plus an optional injected
 * CSS side-effect snippet. Shared by the build and dev bundlers.
 * @param {Array<{ path: string, text: string }>} outputFiles
 * @returns {string}
 */
export function combineEsbuildOutputs(outputFiles = []) {
  const jsOut = outputFiles.find((f) => /\.(js|mjs|cjs)$/.test(f.path)) || outputFiles[0];
  const cssOut = outputFiles.find((f) => f.path.endsWith('.css'));
  let code = jsOut?.text || '';
  if (cssOut?.text && cssOut.text.trim()) {
    code += `\n${buildCssInjectionSnippet(cssOut.text)}`;
  }
  return code;
}

export default class ExternalModuleBundler {
  /**
   * @param {object} options
   * @param {string} options.resolveDir Directory esbuild resolves node_modules from (project root).
   * @param {string} [options.target] esbuild target (default 'es2020').
   * @param {boolean} [options.minify] Minify the bundled dependency output.
   */
  constructor({ resolveDir, target = 'es2020', minify = false } = {}) {
    if (!resolveDir) {
      throw new Error('ExternalModuleBundler requires a resolveDir');
    }
    this.resolveDir = resolveDir;
    this.target = target;
    this.minify = minify;
    // Cache keyed by `${specifier}::${needsDefault}` so a package used by many
    // components is only bundled once per build.
    this.cache = new Map();
  }

  /**
   * Returns true for bare package specifiers: not relative ('./', '../'), not
   * absolute ('/…' — those are served from src/public/), not a URL/data/blob
   * scheme, not a Node subpath import ('#…'). Scoped packages ('@scope/pkg')
   * and deep subpaths ('lodash/fp') are bare.
   * @param {string} spec
   * @returns {boolean}
   */
  static isBareSpecifier(spec) {
    if (typeof spec !== 'string' || spec.length === 0) return false;
    if (spec.startsWith('.')) return false;
    if (spec.startsWith('/')) return false;
    if (spec.startsWith('#')) return false;
    if (URL_SCHEME_RE.test(spec)) return false;
    return true;
  }

  /**
   * Bundles a bare package into a self-contained module expression.
   *
   * @param {string} specifier e.g. 'dayjs', '@scope/pkg', 'lodash/fp'
   * @param {object} [usage]
   * @param {boolean} [usage.needsDefault] Whether any consumer default-imports it.
   * @returns {Promise<{ name: string, expression: string, warnings: string[] }>}
   * @throws when esbuild cannot resolve or bundle the package.
   */
  async bundle(specifier, usage = {}) {
    const needsDefault = usage.needsDefault !== false; // default true unless explicitly false
    const cacheKey = `${specifier}::${needsDefault}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    let result;
    try {
      result = await this.runEsbuild(this.buildVirtualEntry(specifier, needsDefault));
    } catch (error) {
      // A package with no default export makes the explicit default re-export
      // fail; retry with a namespace-only entry so named-only ESM packages still
      // resolve (esp. for dynamic imports, which request the default blindly).
      if (needsDefault && /default/i.test(this.formatEsbuildError(error))) {
        try {
          result = await this.runEsbuild(this.buildVirtualEntry(specifier, false));
        } catch (retryError) {
          throw new Error(`Could not bundle external dependency "${specifier}": ${this.formatEsbuildError(retryError)}`);
        }
      } else {
        throw new Error(`Could not bundle external dependency "${specifier}": ${this.formatEsbuildError(error)}`);
      }
    }

    // JS entry plus an optional injected-CSS side effect (kept self-contained).
    const code = combineEsbuildOutputs(result.outputFiles);
    const warnings = (result.warnings || []).map((w) => w.text);
    const out = {
      name: specifier,
      expression: this.wrapAsModuleExpression(code),
      warnings
    };
    this.cache.set(cacheKey, out);
    return out;
  }

  runEsbuild(entry) {
    return build({
      stdin: {
        contents: entry,
        resolveDir: this.resolveDir,
        sourcefile: 'slice-external-entry.js',
        loader: 'js'
      },
      bundle: true,
      format: 'cjs',
      platform: 'browser',
      target: this.target,
      minify: this.minify,
      write: false,
      metafile: false,
      legalComments: 'none',
      logLevel: 'silent',
      // Standard browser-build substitutions (as Vite/webpack do): let packages
      // that gate on NODE_ENV or reference `global` work without a polyfill.
      // esbuild respects local shadowing, so this only rewrites free references.
      define: {
        'process.env.NODE_ENV': JSON.stringify('production'),
        global: 'globalThis'
      },
      // Runtime shim for the Node globals `define` cannot fold statically (a
      // dynamic `process.platform` / `process.env[key]` / free `global`). Runs
      // once, guarded, before the package body — see nodeGlobalsBanner.
      banner: { js: nodeGlobalsBanner('production') },
      // A virtual outdir is required for esbuild to emit a CSS output file
      // (in outputFiles) when a package imports CSS; nothing is written to
      // disk because write:false.
      outdir: 'slice-external-out',
      // Inline non-JS assets (WASM, images, fonts) as data URLs, and let
      // esbuild bundle any CSS the package imports (resolving @import/url()).
      loader: ASSET_LOADERS,
      // Keep import.meta from crashing browser CJS output for packages that
      // reference it; esbuild replaces it with an empty object shim.
      supported: { 'import-meta': false }
    });
  }

  /**
   * Virtual entry re-exporting the target package. `export *` covers named +
   * namespace usage; the explicit default re-export is added only when a
   * consumer actually default-imports the package, so ESM packages without a
   * default export don't fail to build when nobody asked for their default.
   */
  buildVirtualEntry(specifier, needsDefault) {
    const spec = JSON.stringify(specifier);
    const lines = [`export * from ${spec};`];
    if (needsDefault) {
      lines.push(`export { default } from ${spec};`);
    }
    return lines.join('\n');
  }

  /**
   * Wraps esbuild's CJS output in an IIFE that provides the CommonJS scaffolding
   * and returns the populated `module.exports`. The result is an expression that
   * can be assigned directly: `SLICE_BUNDLE_DEPENDENCIES["pkg"] = <expression>;`
   */
  wrapAsModuleExpression(cjsCode) {
    const indented = String(cjsCode)
      .split('\n')
      .map((line) => (line ? `    ${line}` : line))
      .join('\n');
    return [
      '(() => {',
      '  const module = { exports: {} };',
      '  let exports = module.exports;',
      '  const require = (id) => {',
      '    throw new Error(`[Slice.js] Unexpected runtime require("${id}") in a bundled dependency`);',
      '  };',
      indented,
      '  return module.exports;',
      '})()'
    ].join('\n');
  }

  formatEsbuildError(error) {
    if (error && Array.isArray(error.errors) && error.errors.length > 0) {
      return error.errors.map((e) => e.text).join('; ');
    }
    return error?.message || String(error);
  }
}
