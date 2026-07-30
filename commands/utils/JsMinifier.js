// Single entry point for every JavaScript minification the CLI performs.
//
// Terser used to be called from three places with three hand-written option
// objects, and they had drifted:
//
//   buildProduction.minifyJavaScript      parse ecma 2022, no `module`
//   buildProduction.processComponentsFile no ecma at all, no `module`
//   BundleGenerator.applyBundleTransforms parse+format ecma 2022, no `module`
//
// The missing `module` flag meant Terser parsed sources in script mode, where
// top-level `await` is a syntax error — every build printed
// `Unexpected token: name (...)` for App/index.js and shipped it unminified.
// Fixing that in one call site would have left the other two behind, which is
// exactly how the drift happened in the first place.
//
// So: the invariants (ECMA level, name preservation, comment stripping, module
// parsing) live here once, each caller picks a *profile* for what it is
// minifying, and nothing outside this module imports terser.
import { minify as terserMinify } from 'terser';

/** ECMA level used for parsing, compressing and formatting, everywhere. */
export const TERSER_ECMA = 2022;

/**
 * Identifiers Terser must never rename. Slice resolves a lot by name at
 * runtime (component classes, lifecycle hooks, framework internals reached
 * through `slice.*`), so renaming any of these breaks the app silently.
 */
export const RESERVED_NAMES = Object.freeze([
  // Core Slice
  'slice', 'Slice', 'SliceJS', 'window', 'document',
  // Main classes
  'Controller', 'StylesManager', 'Router', 'Logger', 'Debugger',
  // Slice methods
  'getClass', 'isProduction', 'getComponent', 'build', 'setTheme', 'attachTemplate',
  // Controller
  'componentCategories', 'templates', 'classes', 'requestedStyles', 'activeComponents',
  'registerComponent', 'registerComponentsRecursively', 'loadTemplateToComponent',
  'fetchText', 'setComponentProps', 'verifyComponentIds', 'destroyComponent',
  // StylesManager
  'componentStyles', 'themeManager', 'init', 'appendComponentStyles', 'registerComponentStyles',
  // Router
  'routes', 'pathToRouteMap', 'activeRoute', 'navigate', 'matchRoute', 'handleRoute',
  'onRouteChange', 'loadInitialRoute', 'renderRoutesComponentsInPage',
  // Component properties
  'sliceId', 'sliceType', 'sliceConfig', 'debuggerProps', 'parentComponent',
  'value', 'customColor', 'icon', 'layout', 'view', 'items', 'columns', 'rows',
  'onClickCallback', 'props',
  // Custom Elements
  'customElements', 'define', 'HTMLElement',
  // Critical DOM APIs
  'addEventListener', 'removeEventListener', 'querySelector', 'querySelectorAll',
  'appendChild', 'removeChild', 'innerHTML', 'textContent', 'style', 'classList',
  // Lifecycle
  'beforeMount', 'afterMount', 'beforeDestroy', 'afterDestroy',
  'mount', 'unmount', 'destroy', 'update', 'start', 'stop',
  // Browser APIs
  'fetch', 'setTimeout', 'clearTimeout', 'localStorage', 'history', 'pushState',
  // Exports/Imports
  'default', 'export', 'import', 'from', 'await', 'async',
  // Component names
  'Button', 'Grid', 'Layout', 'HomePage', 'NotFound', 'Loading', 'TreeView', 'Link',
  'FetchManager'
]);

/**
 * Options every profile shares. Kept in one place so a bump to the ECMA level
 * or a change in name preservation cannot reach one code path and miss another.
 * @returns {object}
 */
function baseOptions() {
  return {
    parse: { ecma: TERSER_ECMA },
    ecma: TERSER_ECMA,
    // Slice looks components up by class name and hooks by function name.
    keep_fnames: true,
    keep_classnames: true,
    format: {
      comments: false,
      ecma: TERSER_ECMA
    }
  };
}

/**
 * Profile for an individual source file copied src/ -> dist/.
 * @returns {object}
 */
export function sourceFileOptions() {
  const options = baseOptions();
  return {
    ...options,
    compress: {
      drop_console: false,
      drop_debugger: true,
      pure_funcs: [],
      passes: 1,
      // Slice components are reached by name at runtime, so Terser cannot see
      // every use site — dropping "unused" code or reordering side effects
      // would remove things the framework still needs.
      unused: false,
      side_effects: false,
      reduce_vars: false,
      collapse_vars: false
    },
    mangle: {
      reserved: [...RESERVED_NAMES],
      // Off, matching the bundle profile.
      //
      // af946f8 turned this off for bundles because Terser renames a property
      // access but cannot see inside a string literal, so a library doing
      // `obj['_rep']` broke. It only changed BundleGenerator, leaving source
      // files mangling `/^_/` — and the two generators write the same dist/.
      // The result was one method with two names: `_loadNotes` stayed itself
      // inside dist/bundles/*.js and became `ki` in
      // dist/Components/**/ConsensoService.js, so a component loaded from the
      // individual file could not call one loaded from a bundle.
      //
      // Measured on Conclave the saving was 3.8% of dist/Components (608KB ->
      // 631KB), on files the runtime only reads when a component is in no bundle
      // at all. Not worth a whole class of name-mismatch bugs.
      properties: false
    },
    format: {
      ...options.format,
      beautify: false
    }
  };
}

/**
 * Profile for the components.js registry. The runtime parses this file's shape,
 * so nothing is compressed or renamed — only whitespace and comments go.
 * @returns {object}
 */
export function componentsRegistryOptions() {
  const options = baseOptions();
  return {
    ...options,
    compress: false,
    mangle: false,
    format: {
      ...options.format,
      beautify: false,
      indent_level: 0
    }
  };
}

/**
 * Profile for a generated bundle.
 * @param {object} [config]
 * @param {boolean} [config.minify] run the compress pass
 * @param {boolean} [config.obfuscate] run the mangle pass
 * @param {boolean} [config.sourcemap] emit a source map
 * @param {string} [config.fileName] bundle file name, for the source map
 * @returns {object}
 */
export function bundleOptions({ minify = false, obfuscate = false, sourcemap = false, fileName = null } = {}) {
  const options = baseOptions();
  return {
    ...options,
    compress: minify ? {
      drop_console: false,
      drop_debugger: true,
      passes: 1
    } : false,
    mangle: obfuscate ? {
      // Bundle-wide property mangling breaks vendor libraries whose property
      // names also appear in string literals (see the same regression test).
      properties: false,
      // `module: true` would otherwise turn top-level mangling on and rename
      // the factory/template bindings. Pinned off so enabling module parsing
      // does not silently change what obfuscated bundles look like.
      toplevel: false
    } : false,
    // Map the minified output back to the readable pre-minified bundle
    // (embedded via includeSources so DevTools shows it without a sidecar
    // source). The URL comment is appended by the caller.
    ...(sourcemap ? { sourceMap: { includeSources: true, filename: fileName } } : {})
  };
}

function unwrap(result) {
  if (result.error) {
    throw result.error instanceof Error ? result.error : new Error(String(result.error));
  }
  return result;
}

/**
 * Runs Terser over ES-module JavaScript.
 *
 * Everything the CLI minifies is an ES module, and module-only syntax
 * (top-level `await`, top-level `await import()`) needs `module: true` to parse
 * at all. A project can still hold a classic script that only parses in sloppy
 * mode (`with`, octal literals), so a failed module parse retries in script
 * mode instead of failing the build.
 *
 * Takes a FACTORY, not an options object, because Terser writes into the object
 * it is handed: it sets `parse.module` and parks the parsed AST on
 * `parse.toplevel`. Sharing one object between the two attempts leaked
 * `module: true` into the fallback (so the fallback silently never applied),
 * and sharing it between files would hand Terser the previous file's AST
 * instead of the new source. Every attempt gets a freshly built object.
 *
 * @param {string} code
 * @param {() => object} createOptions one of the profile factories above
 * @returns {Promise<{code: string, map: string|undefined}>}
 * @throws {Error} when neither parse mode succeeds, or Terser reports an error
 */
export async function minifyJs(code, createOptions) {
  if (typeof createOptions !== 'function') {
    throw new TypeError('minifyJs expects an options factory, not an options object (Terser mutates it)');
  }

  try {
    return unwrap(await terserMinify(code, { ...createOptions(), module: true }));
  } catch (moduleParseError) {
    try {
      return unwrap(await terserMinify(code, createOptions()));
    } catch (scriptParseError) {
      // Script mode is the last word, so its error is the one reported — but
      // keep the module-mode failure reachable, since for an actual ES module
      // that is the message that explains the real problem.
      scriptParseError.cause = moduleParseError;
      throw scriptParseError;
    }
  }
}
