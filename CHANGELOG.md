# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `slice translator check` understands `slice.t.list()` / `slice.t.ref.list()`: a list key must exist
  in every locale and be an array.
- `slice translator check` validates content documents: every `slice.t.content('name')` must have a
  file at `src/locales/content/name.json`, and each `copy` must have a branch for every locale, the
  same shape across branches, and no empty strings.
- `slice seo sitemap` expands a `${param}` route's `sitemap.paths` into one URL per published value
  and locale, with the usual alternates; `slice seo check` rejects a value missing a parameter.

## [4.4.0] - 2026-10-28

### Added

- `CHANGELOG.md` with Keep a Changelog format.
- `slice seo sitemap`, `slice seo check` and `slice seo images` (alias `slice og`): write and
  validate the committed `public/sitemap.xml`, and render the 1200×630 social card each indexable
  route advertises into `public/og/` plus the `manifest.json` the server merges via `seo.images`.
- `slice doctor` reports an `SEO` row: not configured warns, malformed input fails, and the
  verdicts come from the same validator as `slice seo check`.
- `scripts/release-check.mjs` (`npm run release:check`): packaging, unpublished-version, changelog
  and framework-range checks, so a release cannot ship a CLI that installs the wrong runtime.
- `slice doctor` checks three more things: `Dependencies` reports a declared framework range that
  rejects the installed version (or a CLI that requires one), `Configuration` validates the file
  against the published `sliceConfig.schema.json`, and the new `Server entry` row parses
  `api/index.js` (nothing had ever looked at it).
- `slice build` and `slice doctor` block a component registered under a category that has no
  `paths.components` entry, or in a category whose folder does not exist; both used to be skipped.
- Routes written as `/producto/:id` are reported: Slice only compiles `${id}` patterns, so a
  `:param` route is treated as a literal path and never matches.
- `commands/utils/semver.js` holds the range check shared by `slice doctor` and `release-check`.
- `slice setup lint --with-types` now also generates the first declarations and the `jsconfig.json`,
  so `slice lint` and `slice typecheck` work immediately after one command.
- `slice lint` creates the `jsconfig.json` when it is missing (it refreshed the `.d.ts` but not the
  config tsc needs).
- `slice typecheck` refreshes the generated declarations before compiling (the registry changes with
  every `slice get`, and a stale map produced false "not assignable to keyof" errors); `--no-types`
  opts out.
- `slice setup lint --with-types` also writes the `slice:types` script, so a project set up later
  matches the one `slice init` creates.
- `slice typecheck` runs the project's own TypeScript over the jsconfig that `slice types generate`
  maintains. ESLint does not type-check; this does. `slice setup lint --with-types` installs
  TypeScript and adds the script.
- `slice typecheck` covers `src/App/**/*.js` and `src/routes.js` in addition to the components, so a
  registered event emitted from the app entry is checked too. The generator writes
  `slice-runtime.generated.d.ts` so the entry's `/Slice/Slice.js` import resolves without tsc
  following the framework's untyped source.
- `slice doctor` reports four more advisories: component CSS selectors not scoped under the
  component tag (doctor-only, so build logs stay clean), a `destroy()`/`dispose()`/`teardown()` method
  the controller never calls, a `window`/`document` listener with no `removeEventListener` in the same
  file, and an `async beforeDestroy` (the framework does not await it).
- Prop metadata written as an expression (`type: TYPE_STRING`, `allowedValues: SIZES`, `schema: SHARED`,
  or `static props = SHARED`) is reported by `slice types generate`, `slice build` and `slice doctor`.
  The generator reads the AST, so those props silently became `any` with no warning anywhere.
- `slice setup lint` adds linting to an existing project: installs `eslint` and `slicejs-cli` when
  missing, writes `eslint.config.js` only if there is none, and adds `lint`/`lint:fix` scripts.
  Idempotent, `--dry-run` available, never overwrites a config or script. `slice init` prints it as
  a next step instead of installing ESLint for everyone.
- `slice lint` refreshes `src/slice-build.generated.d.ts` (and the event manifest) before running
  ESLint, when the project has a `slice:types` script or the file already exists. One command
  verifies the project: the editor never reads stale declarations. `--no-types` opts out.
- `slice lint` runs the project's ESLint, and the shared flat config ships as
  `slicejs-cli/eslint-config.js` (default = app/browser, `nodeConfig` = tooling). It does not
  duplicate build/doctor rules.
- `slice build` and `slice doctor` block `id`, `sliceId` and `singleton` declared in `static props`:
  the runtime strips them as build directives, so the prop can never reach the component.
- `slice init` writes a `.gitignore` (`node_modules/`, `dist/`, local `.env` files) when the project
  has none. A fresh project's first `git add .` used to stage the dependencies and every build.

### Changed

- Bundles have one home: `dist/bundles`. The generator and `bundle()` defaulted to `src/bundles`, and
  `slice build clean` / `slice build info` read `src/bundle.config.json`, a file nothing wrote, so
  they never found anything. Clean also removes the `.br`/`.gz` siblings of a `--compress` build and
  keeps a folder that still holds unrelated files; info reads the real config.
- Pointed the component registry and the Slice.js Components documentation catalog at the new
  `slicejs-components` repository (renamed from `slice.js_visual_library`).
- `slicejs-web-framework` range is `^4.0.2` (was `^3.5.0`, which made a fresh global install resolve
  a 3.x runtime).
- `slice doctor` and `slice build` now share one validation pass
  (`commands/utils/ProjectValidation.js`): config rules, unparseable/unloadable component files and
  prop definition errors block both, advisories only warn. Doctor's two component rows became one.
- `slice doctor` exits 1 when a row fails (0 with only warnings), so `slice doctor && slice build`
  is a usable gate.
- A component registered in `components.js` whose file is missing is now a blocking finding: the
  runtime resolves `<Category>/<Name>/<Name>.js`, so the name could never load and the loop used to
  skip it in silence.
- `src/routes.js` is validated by the shared pass: a syntax error or an unresolved relative import
  blocks `slice build` and `slice doctor` (the router loads that file as-is, so the bundle used to be
  built while navigation was broken); a route whose `component` is not in `components.js` warns.

### Fixed

- `slice lint --no-types` was wired but dropped the flag before calling the command, so it refreshed
  the declarations anyway. The refresh now also reports `reset_jsconfig`, `tsconfig_exists` and
  `editor_config_error` instead of changing the file silently.
- The shared config applied the browser globals to every file and only *added* Node globals to
  `api/`/`scripts/`, so `document` in the server passed lint. Browser and framework globals are now
  scoped to `src/`; a folder that mixes both opts in with the exported `nodeGlobals`/`sliceGlobals`.
- `slice build --analyze` wrote `dist/bundles/bundle.config.js` before returning; analysis-only runs
  no longer create output.
- `getLocalComponents()` referenced `componentsPath` from inside its `catch`, so it threw a
  ReferenceError exactly when the local registry could not be read (found by the new lint config).
- `slice init` writes `allowBuilds` for `esbuild` as well as `slicejs-cli`. The framework always ships
  esbuild, and without the entry the first `pnpm add` in a new project failed with
  `ERR_PNPM_IGNORED_BUILDS`.
- `slice doctor` reported `0 components checked, props look good` for a component that does not
  parse, while `slice build` blocked on it. Doctor now reports the same source errors.
- `slice doctor` called a `sliceConfig` valid that `slice build` refuses to bundle
  (`context.enabled` without `events.enabled`); the rule lives in one function now.
- `slice init` no longer delegates to a `slicejs-cli` found by walking up from the current folder.
  Running `npx`/`pnpm dlx slicejs-cli@latest init` inside another Slice project used that project's
  CLI instead of the requested one.
- `slice init` no longer scaffolds from a framework that sits next to a globally installed CLI.
  The only accepted fallback is the new project's own `node_modules`, and a failed install now
  stops with the retry command instead of continuing with a runtime the project does not depend on.

---

## [4.3.0] - 2026-10-23

### Added

- Added `slice docs list`, `slice docs search`, and `slice docs get`.
- Added framework, Slice.js Components, and cross-catalog documentation sources.
- Added JSON and raw Markdown output modes for agent and CI workflows.
- Added support for the Slice.js Components documentation manifest.

### Fixed

- Fixed `--no-version-check` so Commander’s negated option is respected.

---

## [4.2.0] - 2026-07-30

### ⚠️ The build now fails on things it used to let through

A minor rather than a major because no existing invocation breaks — every flag
that worked on 4.1.1 still works. But builds that passed on 4.1.1 can fail on
4.2.0, so read this before upgrading. Each of these was already a guaranteed
runtime failure: the build was reporting success on output that could not work.
The fix is in your source, not in pinning the old version.

- **A component registered in `components.js` with no default export.** The
  runtime loads components with `const { default: myClass } = await import(...)`,
  so such an entry can never resolve. Note `components.js` is auto-generated by
  scanning directories, so a plain module parked at
  `<Category>/<Name>/<Name>.js` gets registered by accident — move it out of the
  components tree.
- **An unresolved relative import.** `import { x } from './typo.js'` used to be
  dropped silently, leaving `x` undefined at runtime with nothing said at build.
- **An unresolved npm package.** Previously opt-in via `--strict-external`; now
  the default. Pass `--no-strict-external` if the package is provided some other
  way (a shim under `src/public/`).
- **A cycle between relative helper modules.** Bundled helpers are evaluated in
  dependency order and cannot reproduce ES module live bindings, so one side
  would read the other's exports before they exist. Cycles work in `slice dev`
  (real ES modules), which made this a dev/production divergence.
- **A file that cannot be minified.** It is still copied through so `dist/` stays
  usable, but the build now reports it and exits non-zero. Pass
  `--allow-unoptimized` to accept it.

`--strict-external` still parses (it now asks for the default) so existing CI
scripts keep working.

### Fixed

- **`slice build` exited 0 on failure.** `runWithVersionCheck` caught every
  command error, printed it, and returned normally, so a red `Build failed`
  still exited 0 — CI read it as a passing build. Both that path and
  `build()`'s `false` return now set a non-zero exit code.
- **Module-level named exports in a component broke the bundle.** `export const`
  / `export function` / `export class` survived into the class factory, where
  `export` is a syntax error. Only `export default` was being stripped.
- **Top-level `await` shipped unminified.** Terser ran without `module: true`,
  so it parsed sources as scripts, where top-level `await` is invalid; the error
  was caught and the file copied verbatim. The starter's own `App/index.js`
  documents this pattern in a comment, so it fired on every build that used it.
- **Component names that are not valid identifiers emitted invalid JavaScript.**
  A component named `my-btn` produced `window.my-btn = my-btn; return my-btn;`.
  The global is now keyed by string and the factory returns the module's real
  default export, whatever it is named.
- **A component using top-level `await` produced an invalid factory.** The
  factory is emitted `async` for those components, and its registration awaits
  it.
- **The generated `.d.ts` was invalid TypeScript for awkward names.** Component
  names, prop names and event payload keys went straight into identifier and
  property-key positions: `export interface my-btnProps`, `data-id?: string`.
  `jsconfig.json` includes that file, so a broken one took out editor tooling
  for the whole project.
- **vendor-shared could be emitted without part of its dependency closure.** A
  helper over `minVendorSharedTransformedSize` (2 KB) was extracted while a
  module it imports, being smaller, was not — so the helper bound a key
  vendor-shared never registered, and the bundle threw while loading.
- **Property mangling was inconsistent across files.** Source files mangled
  `/^_/` while bundles (since af946f8) did not, and both generators write into
  the same `dist/`. Measured: `_loadNotes` stayed itself inside a bundle and
  became `ki` in the individual file. Now off in both.

### Added

- **Every emitted bundle is verified to parse before it is written**, regardless
  of `--minify`. Errors name the component or dependency the invalid code came
  from, instead of a position in a generated file.
- **Source diagnostics with file, line, column and a code frame** for a
  component that does not parse, replacing Terser's `Unexpected token punc «(»`
  and a position inside the bundle.
- **Every component registered in `components.js` is validated**, not just the
  ones a route reaches. The bundler only ever sees routed components, so an
  unrouted one was checked nowhere.
- **A warning when a component builds a name that is not registered.** Kept a
  warning, not an error: components legitimately build optional ones — the
  framework's own `Button` does `if (this.icon) slice.build('Icon', ...)`.
- `--allow-unoptimized` to accept a build where some file could not be minified.
- All Terser configuration moved behind `commands/utils/JsMinifier.js`. It was
  hand-written in three places that had drifted; nothing else imports terser now.

---

## [4.1.1] - 2026-07-29

### Fixed

- **`moduleImports` survives the vendor-shared collection pipeline.** A relative
  helper extracted into `slice-bundle.vendor-shared.js` lost the record of its
  own imports in `collectRouteExternalDependencyIndex`,
  `indexExternalDependencyUsage` and
  `generateVendorSharedDependencyBundleContent`. Its IIFE was then emitted with
  no bindings for them and outside topological order, so the bundle threw on
  load — e.g. `ReferenceError: Check is not defined` for a helper importing
  named icons from `lucide`. Since the critical/vendor-shared bundles load
  before anything renders, this took down the whole production app while `dev`
  (no bundles) stayed green.

  Affects any project where a component imports a relative helper that itself
  imports a bare package, and that helper is used by enough routes to be
  extracted into `vendor-shared`.

### Known limitations

- The transitive closure of a shared dependency is not pulled into
  `vendor-shared` with it. If a helper clears `minVendorSharedTransformedSize`
  (2 KB) but a module it imports does not, the helper is emitted into
  `vendor-shared` while its dependency stays inlined in the route bundles, and
  the binding resolves to `undefined`. Pre-existing — this release changes the
  symptom (a load-time `TypeError` instead of a lazy `ReferenceError`), not the
  cause.

---

## [3.8.0] - 2026-07-07

### Added

- **Transitive dependency resolution for `slice get`**: downloading a component
  now installs the full dependency tree instead of just its own three files.
  Two dependency kinds are resolved from the downloaded source:
  - **Component dependencies** referenced via `slice.build('X')` or via a
    relative import of another component's entrypoint
    (e.g. `Pagination` → `../../Service/DataGridEngine/DataGridEngine.js`).
  - **Helper `.js` modules** imported relatively (e.g. `DragDropService` →
    `./dndGeometry.js`), downloaded into their mirrored location and scanned
    recursively for their own dependencies.
  - Resolution is recursive, deduplicated via a shared visited-set (a dependency
    shared by several requested components downloads once), and cycle-safe.
- **`--no-deps` flag** on `slice get` / `slice registry get` to restore the
  previous behavior and install only the requested component.
- New shared analyzer `commands/utils/analyzeSource.js` (Babel AST) that extracts
  `slice.build('X')` targets and relative import specifiers from a source file.
- **Self-contained production build**: `slice build` now copies the framework
  runtime entry into `dist/Slice/Slice.js`. The app bootstraps with
  `import Slice from '/Slice/Slice.js'`; emitting it into `dist` means serverless
  deploys (Vercel `includeFiles: dist/**`) ship the framework instead of relying
  on a runtime `node_modules` read — which is pruned by the file tracer and, under
  pnpm, hidden behind a symlink (fixed a 404-on-mount on Vercel). Resolution is
  done from the project root; if the framework can't be resolved the build warns
  and continues.

### Changed

- `ComponentRegistry.installComponent` accepts an options object
  (`{ seen, withDeps, isDep }`); transitively-pulled dependencies that already
  exist locally are skipped without an overwrite prompt.

---

## [3.6.5] - 2026-06-14

### Fixed

- **SIGINT/SIGTERM listener leak**: Handlers moved to module level and registered once. Watcher restarts no longer accumulate duplicate shutdown handlers.
- **Race condition in `components.js` writes**: `ComponentRegistry` is now a shared singleton. The `_registryLock` chain is preserved on error so subsequent writes are never lost.
- **Error stacks now visible**: All catch blocks across `client.js`, `bundle.js`, and `init.js` log `error.stack` in addition to `error.message`.
- **Port validation**: `parsePort()` validates `--port` values (1–65535) with a clear error for invalid input like `--port abc`.
- **`--no-version-check` now works**: `runWithVersionCheck` reads `program.opts().noVersionCheck` and skips version checks when set.
- **`parseUserAgent` test**: Passing explicit `undefined` triggered the default parameter. Changed to `null`.
- **Perf-budget test EPERM**: Replaced `ensureSymlink` + `.catch()` fallback with `fs.copy(..., { dereference: true })` for Windows compatibility.

### Changed

- **`loadConfig` deduplicated**: `startServer.js` now imports `loadConfigSync` from the shared module instead of maintaining a local copy.
- **`NODE_ENV` save/restore extracted**: The 5-line pattern duplicated in `build`, `dev`, and `start` was extracted to a `withNodeEnv(env, fn)` helper.
- **Init command** `--yes` refactored: positional `[name]` argument added, `-y`/`--yes` changed to boolean-only flag.

### Removed

- **`slice update` / `slice upgrade` commands**: Removed from CLI and documentation.
- **`postinstall` lifecycle hook**: `post.js` deleted, `"postinstall"` script removed from `package.json`.

[Unreleased]: https://github.com/VKneider/slicejs-cli/compare/v4.4.0...HEAD
[4.4.0]: https://github.com/VKneider/slicejs-cli/releases/tag/v4.4.0
[4.3.0]: https://github.com/VKneider/slicejs-cli/releases/tag/v4.3.0
[3.6.5]: https://github.com/VKneider/slicejs-cli/releases/tag/v3.6.5
