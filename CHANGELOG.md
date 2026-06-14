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
