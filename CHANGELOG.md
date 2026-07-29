# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `CHANGELOG.md` with Keep a Changelog format.

### Changed

- (placeholder)

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

[Unreleased]: https://github.com/VKneider/slicejs-cli/compare/v3.6.5...HEAD
[3.6.5]: https://github.com/VKneider/slicejs-cli/releases/tag/v3.6.5
