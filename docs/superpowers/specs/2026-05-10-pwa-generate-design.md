# Design of `slice generate-pwa` (V1)

## Objective

Add a dedicated CLI command, `slice generate-pwa`, that converts a Slice build into an offline-capable PWA, with configurable cache strategy and explicit backend domain exclusion to prevent accidental REST API caching.

The command must be post-bundle, operate on `dist/`, and maintain a simple V1 experience.

## V1 Scope

- New `slice generate-pwa` command.
- Automatically run `build` before the PWA process.
- Generate `manifest.json` in `dist/`.
- Generate `sw.js` in `dist/`.
- Register Service Worker in the entry HTML of `dist`.
- Support strategies: `hybrid` (default), `offline-first`, `network-first`.
- Persist and read configuration from `src/sliceConfig.json` in:
  - `pwa.cache.excludeDomains`.
- Apply effective exclusion of `localhost` and `127.0.0.1` in development.

## Out of V1 Scope

- Exclusion by paths or headers (`excludePaths`, `excludeHeaders`).
- Advanced interactive UI for creating PWA icons.
- Support for push notifications, background sync, or advanced runtime caching by API type.
- Formal plugin system; left prepared for future evolution.

## Command UX

### Syntax

```bash
slice generate-pwa
slice generate-pwa --strategy hybrid
slice generate-pwa --strategy offline-first
slice generate-pwa --strategy network-first
slice generate-pwa --name "My App" --short-name "MyApp"
```

### V1 Flags

- `--strategy <hybrid|offline-first|network-first>` (default: `hybrid`)
- `--name <string>`
- `--short-name <string>`

### Execution flow

1. Run production build.
2. Read and normalize PWA configuration from `src/sliceConfig.json`.
3. Generate asset manifest for precache from `dist/`.
4. Generate `dist/manifest.json`.
5. Generate `dist/sw.js` with the selected strategy.
6. Inject (or ensure) SW registration in entry HTML of `dist`.
7. Print final summary:
   - strategy used,
   - number of precached assets,
   - effective excluded domains.

## Configuration in `sliceConfig.json`

V1 minimal section:

```json
{
  "pwa": {
    "cache": {
      "excludeDomains": []
    }
  }
}
```

Rules:

- If `pwa` does not exist, the command creates the section without breaking existing configuration.
- `excludeDomains` accepts exact hosts (e.g., `api.mydomain.com`).
- In development execution, `localhost` and `127.0.0.1` are effectively added (not necessarily persisted).

## Proposed Architecture

### CLI Integration

- Add command in `client.js`:
  - `generate-pwa`
  - `--strategy` option
  - name options for manifest

### New Modules

- `commands/pwa/generatePwa.js`
  - Orchestrator of the complete flow.
- `commands/pwa/ConfigResolver.js`
  - Reads/creates/normalizes `pwa.cache.excludeDomains`.
- `commands/pwa/AssetManifestBuilder.js`
  - Iterates `dist/` and builds precache list.
- `commands/pwa/ManifestGenerator.js`
  - Generates `manifest.json` with defaults and flag overrides.
- `commands/pwa/ServiceWorkerGenerator.js`
  - Generates `sw.js` with selected strategy and exclusions.

## Cache Design

### Global Rules

- Intercept only `GET` requests.
- If the host is in `excludeDomains`, do a direct `fetch` (no cache).
- Cache versioning by build id (timestamp or build hash).
- On new SW activation, automatically clean old caches.

### Strategies

- `hybrid` (default):
  - static assets -> `cache-first`.
  - HTML navigation -> `network-first` with offline fallback.
- `offline-first`:
  - navigation + static -> `cache-first`.
  - background update when online.
- `network-first`:
  - navigation -> `network-first`.
  - precached static assets as fallback.

## REST API and Security Handling

To prevent unwanted backend caching:

- Domain exclusion via `excludeDomains` (main V1 rule).
- Limit runtime cache to frontend assets and navigation per strategy.
- Do not cache methods other than `GET`.

Result: client assets are accelerated offline, but the backend stays out of the cache via explicit configuration.

## Error handling

- If build fails, abort `generate-pwa` with a clear message.
- If `dist/` does not exist after build, abort with diagnostics.
- If `sliceConfig.json` is invalid, show error with repair suggestion.
- If SW registration cannot be injected into HTML, report warning and target path.

## Testing

### Unit tests

- `ConfigResolver`:
  - creates `pwa.cache.excludeDomains` section when it does not exist,
  - respects existing config.
- `AssetManifestBuilder`:
  - includes expected assets,
  - excludes unsuitable files.
- `ServiceWorkerGenerator`:
  - generates correct logic per strategy,
  - respects `excludeDomains`.

### Integration

- `slice generate-pwa` runs build and creates `dist/manifest.json` + `dist/sw.js`.
- SW registration present in output HTML.
- domain exclusions applied in generated code.

### Minimal E2E manual

- Build + generate-pwa.
- Open app, validate installability (manifest).
- Turn off network, validate offline navigation in `hybrid`.
- Verify that requests to excluded domain are not served from SW cache.

## Evolution Plan (post V1)

- `excludePaths` and `excludeHeaders`.
- Assisted PWA icon and shortcut support.
- Per-route strategy (e.g., `/api/*` network-only).
- Extract reusable postbundle pipeline for other features.

## Acceptance Criteria

- Functional `slice generate-pwa` command exists.
- Runs build before generating PWA artifacts.
- Generates `manifest.json` and `sw.js` in `dist/`.
- Registers SW in main output HTML.
- `hybrid` is default with HTML `network-first` and offline fallback.
- Reads/writes `pwa.cache.excludeDomains` in `src/sliceConfig.json`.
- Excludes configured domains from runtime cache.
- Shows a readable final summary to the user.
