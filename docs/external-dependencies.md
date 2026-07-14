# External Dependencies (npm packages) — Implementation Notes

Maintainer/contributor documentation for how Slice.js resolves **bare package
imports** from `node_modules` (`import dayjs from 'dayjs'`) in both the CLI build
and the framework dev server.

This is an internal design doc. For the user-facing guide see
`slicejs_docs/markdown/external-dependencies.md`.

---

## 1. Overview

Slice components can import installed npm packages by bare specifier, exactly
like a Node/Vite/React project — **no configuration**. The feature is **always
on** (there is no `sliceConfig` flag).

A single resolver — **esbuild** — powers both environments, so a package behaves
identically across `slice dev`, `slice build`, and `slice start`:

| Environment | Mechanism |
|-------------|-----------|
| `slice dev` | The dev server rewrites bare specifiers in served source modules to a virtual `/@slice-modules/<pkg>` URL and pre-bundles each package on demand with esbuild (no app bundling). |
| `slice build` / `slice start` | The bundler resolves + bundles each package once with esbuild and registers it in the production bundle. |

The design goal was to **reuse the existing bundle runtime contract** rather than
invent a new one: external packages are registered under the same
`SLICE_BUNDLE_DEPENDENCIES` map and bound through the same class-factory prologue
already used for relative helper modules.

---

## 2. Key files

| File | Repo | Role |
|------|------|------|
| `commands/utils/bundling/ExternalModuleBundler.js` | slicejs-cli | esbuild wrapper for the **build**. The only place that imports esbuild in the CLI. |
| `commands/utils/bundling/BundleGenerator.js` | slicejs-cli | Detects bare imports, drives `ExternalModuleBundler`, emits them into bundles, dedupes into `vendor-shared`, rewrites dynamic imports. |
| `api/framework/devDepsOptimizer.js` | slice.js (framework) | esbuild + `es-module-lexer` wrapper for the **dev server** (rewrite + on-demand bundling + disk cache). |
| `api/framework/server.js` / consumer `api/index.js` | framework / app | Wire the dev middleware + `/@slice-modules/` route. |
| `commands/utils/analyzeSource.js` | slicejs-cli | `slice get` surfaces bare imports of a downloaded component. |
| `commands/doctor/doctor.js` | slicejs-cli | `slice doctor` warns about bare imports missing from `node_modules`. |

> **Wrapper rule:** esbuild / es-module-lexer are imported **only** inside
> `ExternalModuleBundler.js` and `devDepsOptimizer.js`. All other code goes
> through these wrappers.

---

## 3. Build pipeline (`slice build`)

### 3.1 Import classification

`BundleGenerator.classifyImport(importPath)` sorts each import:

- **relative** (`./`, `../`) → stripped from the component body, inlined as a
  dependency module.
- **absolute** (`/libs/x.js`) → kept **iff** the file exists under `src/public/`
  (the `public/` convention); otherwise stripped with a warning.
- **bare** (`dayjs`, `@scope/pkg`, `lodash/fp`) → stripped silently and recorded
  as an **external** dependency (resolved separately).

### 3.2 Discovery + resolution

1. `analyzeBareImports(code)` (Babel AST) extracts bare specifiers from a
   component, capturing the binding shape (default / named / namespace) and
   whether the default is needed. It also detects dynamic `import('pkg')` and
   bare **re-exports** (`export * from 'pkg'`, `export { x } from 'pkg'`), so a
   package a helper only re-exports is still bundled.
2. `collectReachableBareImports(entryPath)` walks the **relative helper graph**
   from a component so packages imported only by a helper are found too.
3. `prepareExternalModules()` runs once, up front, aggregating `needsDefault`
   globally per package, then calls `ExternalModuleBundler.bundle(name, …)` for
   each unique package. Results are cached in `this.externalModulesByName`.

### 3.3 esbuild wrapper (`ExternalModuleBundler`)

`bundle(specifier, { needsDefault })`:

- Builds a **virtual entry** re-exporting the package:
  `export * from 'pkg';` plus `export { default } from 'pkg';` when a consumer
  default-imports it. If the package has no default export, esbuild fails on the
  explicit default re-export, so the wrapper **retries** with a namespace-only
  entry.
- esbuild options: `bundle: true`, `format: 'cjs'`, `platform: 'browser'`,
  `outdir` (virtual, for CSS output), asset `loader`s, browser `define`s.
- The CJS output is wrapped in an IIFE that supplies `module`/`exports` and
  returns `module.exports` — a **module-namespace-like object** (named exports +
  a `default` key). This matches the runtime binding contract without running
  esbuild's output back through Babel.

### 3.4 Emission + runtime contract

Each external module is registered in the emitted bundle:

```javascript
SLICE_BUNDLE_DEPENDENCIES["dayjs"] = (() => { /* esbuild CJS */ return module.exports; })();
```

The component's class-factory prologue binds it (reusing
`buildDependencyBindings`):

```javascript
const dayjs = __sliceResolveDefaultExport(SLICE_BUNDLE_DEPENDENCIES["dayjs"], "dayjs", "dayjsData");
const { format } = SLICE_BUNDLE_DEPENDENCIES["date-fns"];
```

`__sliceResolveDefaultExport` returns `dep.default` when present, else falls back
(single named export → that; CJS `module.exports` → itself), so default imports
work for CJS, ESM-with-default, and UMD alike.

---

## 4. Dev server (`slice dev`)

No app bundling. `devDepsOptimizer.createDevDepsOptimizer({ projectRoot })`
exposes:

- **`rewriteBareImports(code)`** — uses `es-module-lexer` to find import
  specifiers in a served `.js` and rewrites bare ones to `/@slice-modules/<pkg>`
  (static and dynamic; relative/absolute/URL untouched). Dynamic-import
  specifiers keep their surrounding quotes.
- **`bundlePackage(spec)`** — pre-bundles a single package with esbuild
  (`format: 'esm'`) on first request. Cached in memory **and on disk** under
  `node_modules/.slice-deps/<pkg>@<version>.js` (keyed by installed version), so
  restarts reuse the build.

The server wires two things in its dev block (before the `src` static handler):

1. `GET /@slice-modules/*` → serves `bundlePackage(spec)`.
2. A middleware that rewrites served `src` `.js` modules.

Because dev and build call esbuild with the **same options**, a package that
works in dev works after build (dev/prod parity).

---

## 5. Module formats & interop (delegated to esbuild)

All handled by esbuild's resolver; verified in
`tests/external-module-shapes.test.js`:

- **CommonJS** (`module.exports`, `exports.x`), **ESM**, **UMD**.
- `package.json` **`exports`** maps with conditions (`browser`/`import`/`require`),
  the legacy **`browser`** field, **scoped** packages, **subpath** specifiers
  (`pkg/feature`).
- **Transitive** third-party deps (bundled in via `bundle: true`).
- **Dynamic** `import('pkg')` (see §8).

---

## 6. Assets imported by a package

`combineEsbuildOutputs` + asset loaders keep each dependency **self-contained**
(no sidecar files):

- **CSS** — esbuild bundles it (resolving `@import`/`url()`); the CSS output is
  appended as a runtime `<style>` injection snippet. Injection is **idempotent**
  (keyed by a content hash via `data-slice-external`), so the same stylesheet is
  injected once even across bundles.
- **WASM, images, fonts** (`.wasm/.png/.svg/.woff2/…`) — inlined as **data URLs**
  (`loader: 'dataurl'`), so `url()` references inside CSS resolve too.
- **Text assets** (`.txt/.glsl/.vert/.frag/.vs/.fs`) — loaded as **strings**
  (`loader: 'text'`), so `import src from './shader.glsl'` yields the file
  contents (GLSL shaders, templates).

---

## 7. Browser defines + Node-global shim

Both bundlers pass esbuild `define`:

- `process.env.NODE_ENV` → `"production"` (build) / `"development"` (dev).
- `global` → `globalThis`.

This is the standard browser-build substitution (as Vite/webpack do) so packages
that gate on `NODE_ENV` or reference `global` work **without a polyfill**.
esbuild respects local shadowing, so only free references are rewritten.

`define` only folds **static** member expressions, so a **dynamic** reference —
`process.platform`, `process.env[key]`, a free `global` — would still throw a
`ReferenceError` in the browser. To cover those, each bundled package is prefixed
with a small **runtime shim** (`nodeGlobalsBanner`, emitted as an esbuild
`banner`): it defines `globalThis.process` (`env`, `platform: "browser"`,
`browser: true`, `nextTick`, …) and `globalThis.global` **once, guarded** — it
never clobbers a real `process`. It is **not** a Node polyfill: no `Buffer`,
stream, or `fs`. The banner is byte-identical across the build and dev bundlers,
so a package behaves the same in `slice dev` and after `slice build`.

---

## 8. Deduplication

- **Across route bundles:** a package used by ≥2 route bundles (and over a size
  threshold) is extracted into `slice-bundle.vendor-shared.js`. Route bundles
  omit their local copy and resolve it from `window.__SLICE_SHARED_DEPS__` via
  `__sliceResolveBundleDependency`. `prepareVendorSharedDependencies` +
  `computeSharedDependencySet` drive this; external modules are measured by their
  bundled expression size.
- **Critical bundle:** the `critical` bundle participates in the same shared-usage
  analysis. If it uses a package that is also in a route bundle, the package is
  extracted to `vendor-shared`, `critical` omits its inline copy and declares
  `dependencies: ['vendor-shared']` so the runtime loads vendor-shared **before**
  critical (via `loadBundleWithDependencies`).

---

## 9. Dynamic imports in the build

`await import('pkg')` would have no resolver in the built output. So the build:

1. Detects the dynamic bare import (`analyzeBareImports` CallExpression), bundles
   and registers the package like a static one.
2. `rewriteDynamicExternalImports(code)` rewrites `import('pkg')` in the component
   body to resolve from the registry:
   `Promise.resolve(window.__SLICE_SHARED_DEPS__?.['pkg'] ?? SLICE_BUNDLE_DEPENDENCIES['pkg'])`.

Dynamic imports request the default (namespace-like), so the bundler builds them
with `needsDefault: true` (falling back to namespace-only when there is no
default).

---

## 10. Tooling

- **`slice build --strict-external`** — fail the build (non-zero exit) if any
  package cannot be resolved from `node_modules`, instead of warning + emitting
  an empty module.
- **`slice doctor`** — the "External Dependencies" check lists imported packages
  missing from `node_modules` (and which components import them).
- **`slice get`** — `analyzeSource` reports the bare imports of a downloaded
  component so the user knows what to `pnpm add`.

---

## 11. Limitations

1. **Browser-only packages.** A package that imports Node built-ins (`fs`, `os`,
   `util`, real `stream`, …) fails the build with a clear esbuild resolution
   error. There is **no Node polyfill layer** — only the `process.env.NODE_ENV`
   / `global` defines plus the minimal runtime `process`/`global` shim (§7).
   Packages needing `Buffer`/`stream`/`fs`/etc. are **not** supported; use a
   browser build of the library or the `src/public/` pattern.
2. **Asset loaders are a fixed set.** CSS, a fixed set of binary extensions
   (wasm/images/fonts, inlined as data URLs), and a fixed set of text extensions
   (`.glsl/.vert/.frag/.vs/.fs/.txt`, loaded as strings) are handled. Any other
   non-JS import a package uses is not configured, and there is no user hook to
   add esbuild loaders.
3. **Web Workers.** A package that spins a worker via
   `new Worker(new URL('./w.js', import.meta.url))` is not specially handled —
   esbuild's worker-URL handling emits a sidecar, which the self-contained model
   doesn't serve.
4. **Dev disk cache keeps only the installed version.** On each rebuild the
   optimizer writes `node_modules/.slice-deps/<pkg>@<version>.js` and prunes
   older cached versions of that same package, so the folder does not accumulate
   stale versions across upgrades. It is still fully rebuildable by deleting the
   folder.
5. **`critical` ↔ inline vs `vendor-shared`.** Dedup covers route↔route and
   critical↔route. A package used **only** by the critical bundle stays inline in
   critical (correct — it loads once anyway), matching how relative deps behave.
6. **CSS `@import` inside an injected stylesheet** is resolved by esbuild at
   bundle time (flattened); a package that expects to `@import` a URL at runtime
   relative to its own path is not supported.
7. **No opt-out / allowlist.** The feature is always on; there is no config to
   disable it or restrict which packages resolve. Removing a bad import is the
   escape hatch (`--strict-external` turns unresolved packages into hard errors).

---

## 12. Test map

| Concern | Test file (slicejs-cli unless noted) |
|---------|--------------------------------------|
| Bundler wrapper, classification, emission, dedup, strict, dynamic, prod contract | `tests/external-dependencies.test.js` |
| Module shapes (CJS/ESM/UMD/exports/browser/scoped/subpath/transitive/side-effect/WASM/CSS/defines/node-builtin rejection) | `tests/external-module-shapes.test.js` |
| Import classification + stripImports (public/ resolution) | `tests/bundling-imports-unit.test.js`, `tests/bundle-generator.test.js`, `tests/builder-edge-cases.test.js` |
| Dev optimizer (rewrite, on-demand bundle, disk cache) | `slice.js/api/tests/dev-deps-optimizer.test.js` |
| Dev server integration (HTTP) | `slice.js/api/tests/dev-server-external.test.js` |
| Browser end-to-end (real npm libs) | `slice.js_visual_library/src/Components/DemoComponents/{ExternalDepsProbe,GsapDemo,GsapShowcase}/*.spec.js` |
| `slice doctor` external check | `tests/commands-doctor.test.js` |
| `slice get` awareness | `tests/dependency-resolution.test.js` |
