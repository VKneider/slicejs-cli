# Static export and production hosting — audit

Date: 2026-11-15
Branch: `experiment/static-export` (`slicejs-cli`, `slice.js`, `slice.js_docs`, workspace)
Scope: `slice export`, `slice start`, `slice build`, production exposure, and the
documentation that ships with them.

This is the single consolidated record of the audit findings, the decisions taken,
what is fixed, and what is still open. The design notes live in
[`static-export.md`](./static-export.md); the user-facing guide lives in
`repos/slice.js_docs/markdown/getting-started/deployment.md`.

---

## 1. Verdict

The static export is functionally complete for the supported product shape:
**root-only, one app per domain or subdomain, no base path**. The audit found
four blocking defects (P0), all fixed in this branch:

1. `slice export --out` could delete the project.
2. A top-level framework import could break **every** CLI command when the
   published framework was older than the CLI.
3. The exporter copied `dist/` with a denylist, so source-only files could ship.
4. Percent-encoded paths could bypass the production guard (`/%2eenv`).

It also found documentation gaps and one misleading `--check` contract. Those are
fixed or explicitly documented below. The feature is ready for a final review, but
**not merged or released** yet.

---

## 2. Severity

| Level | Meaning |
|---|---|
| P0 | Data loss, secret exposure, broken install, or a real security bypass. Must be fixed before merge. |
| P1 | User-facing wrong behavior, a contract that lies, or a missing guide that makes deployment unsafe. |
| P2 | Hardening, clarity, or a known limitation that can ship with documentation. |

---

## 3. Findings

| ID | Severity | Finding | Status |
|---|---|---|---|
| P0-1 | P0 | `slice export --out .` / `--out src` removed the target before copying. | Fixed |
| P0-2 | P0 | `export.js` imported `prepareSeo` and `expandPatternPaths` at module load; an older published framework made every `slice` command fail at startup. | Fixed |
| P0-3 | P0 | Export copied `dist/` minus a denylist, so `utils/`, `AppConfig.js`, `slice-events.generated.js`, `.env*`, `.map.br` and `.map.gz` could be published. | Fixed |
| P0-4 | P0 | The production guard and `securityMiddleware` inspected the raw `req.path`; `express.static` decoded it, so `/%2eenv` could serve a `.env` from `public/`. | Fixed |
| P1-1 | P1 | No user-facing deployment guide (Express vs static, hosts, GitHub Pages, preview, CI). | Fixed |
| P1-2 | P1 | CLI/design flag tables were incomplete (`--keep-components`, `--sourcemap`, `--no-minify`, `--no-obfuscate`, `--hash-filenames`, `--compress`). | Fixed |
| P1-3 | P1 | `--check` claimed route/secret/host validation but only checked six files, `Components/`, `.map` and `.d.ts`. | Fixed |
| P1-4 | P1 | `slice start` docs contradicted the code: no auto-build, `/dist` was public, port defaults, "real 404" without SEO, and "`sliceFallback` untouched". | Fixed |
| P1-5 | P1 | The CLI suggested `npx serve -s`, which hides the real `404.html`. | Fixed |
| P1-6 | P1 | `sliceConfig.json`, `routes.js` and `bundle.config.json` are public but were not documented as such. | Fixed |
| P2-1 | P2 | `--sourcemap` is a no-op for the published export (maps are filtered). | Documented + warning |
| P2-2 | P2 | `--no-minify` / `--no-obfuscate` can ship readable bundles. | Documented + warning |
| P2-3 | P2 | `sliceConfig.json` exposes `server.port` / `server.host` (not secrets, but unnecessary). | Open; low priority |
| P2-4 | P2 | Service workers can cache old bundle names across deploys. | Open; host-specific guidance |
| P2-5 | P2 | `/api/*` is not exported; a static host has no server routes. | Documented limitation |
| P2-6 | P2 | GitHub Pages project sites (`user.github.io/repo/`) need a base path and are not supported. | Product decision |
| P2-7 | P2 | `dist-static` vs a single `dist` was not formally decided/documented. | Fixed |

---

## 4. P0 details

### P0-1 — `--out` could delete the project

**Evidence (before):**

```js
const outDir = path.resolve(projectRoot, options.out || 'dist-static');
// ...
await fs.remove(outDir);
```

`--out .` removed the project root; `--out src` removed the source tree;
`--out ..` removed the parent. There was no check for files, symlinks, `dist/`,
`api/`, `node_modules/` or paths outside the project.

**Fix:** `resolveSafeOutDir()` in `commands/export/export.js`.

It now rejects:

- the project root (`.` or an equivalent absolute path),
- any path outside the project,
- any ancestor of the project,
- the protected top-level folders `src`, `dist`, `api`, `node_modules`, `.git`,
  `public`, `locales`, `Components`, `App`, `bundles`, `Slice` (case-insensitive
  on Windows),
- an existing path that is a file or a symlink,
- an existing directory that does not look like a previous export. A folder is
  only overwritten when it contains at least one export marker: `index.html`,
  `bundles/bundle.config.json` or `slice-env.json`. This protects `docs/`,
  `tests/`, `.github/` and any other real project folder from a mistyped
  `--out`.

It also resolves the nearest existing ancestor and rejects a path whose real
target leaves the project through a symlinked parent.

`--check` still reads an arbitrary folder (it writes nothing). Every write path
(`export`, `--dry-run`) validates first. Regression tests cover `.`, `src`, `dist`,
`api`, `node_modules`, a file, an existing non-export folder (`docs/`), a
previous export (allowed), case variants on Windows, and an absolute path
outside the project.

**Why an allowlist and not a longer denylist:** the target is removed with
`fs.remove()`. A denylist is one typo away from deleting `docs/`, `.github/`, or
any other top-level folder. The protected list matches the folders that are
actually part of a Slice project; everything else still requires an explicit
`--out`.

### P0-2 — a top-level import could break every CLI command

**Evidence (before):**

```js
import { prepareSeo } from 'slicejs-web-framework/api/framework/server.js';
import { expandPatternPaths } from 'slicejs-web-framework/api/framework/seo.js';
```

Those imports are evaluated when `client.js` loads, before commander parses the
command. If a user installed a published framework without `prepareSeo`'s
`pages`/`notFound`/`redirects` or without `expandPatternPaths`, **every** command
(`dev`, `build`, `start`, `doctor`, component commands) crashed at startup, not
just `export`.

**Fix:** `loadExportFramework()` imports the two modules lazily inside
`buildPrerender()`, after an SEO manifest is found, and checks:

- `prepareSeo` is a function,
- `expandPatternPaths` is a function,
- the object returned by `prepareSeo()` has `pages` and `notFound` as `Map`s and
  `redirects` as an array.

The error names the requirement and the fix:
`Update it with "npm install slicejs-web-framework@latest"`.

`slice export --no-prerender` never loads the framework SEO API, so it keeps
working with any framework version.

### P0-3 — export copied `dist/` with a denylist

**Evidence (before):**

```js
await fs.copy(distDir, outDir, {
  filter: (src) => !shouldSkip(src) // only .map and .d.ts
});
```

`dist/` is not a static bundle: it contains the processed source tree
(`utils/`, `AppConfig.js`, generated event catalogs), and `--compress` adds
`.map.br` / `.map.gz` siblings. A misplaced `.env` inside `public/` was also
copied. `--check` did not look at any of those names.

**Fix:** `copyDist()` is now an explicit allowlist:

| Published | Source | Why |
|---|---|---|
| `App/` | `dist/App` | The shell loads `/App/index.js` and `/App/style.css`. |
| `bundles/` | `dist/bundles` | Runtime bundles and `bundle.config.json`. |
| `Slice/` | `dist/Slice` | The self-contained runtime. |
| `locales/` | `dist/locales` | Translator dictionaries. |
| `events/` | `dist/events` | Event catalog, if the build emits it. |
| `public/*` flattened to `/` | `dist/public` | Themes, Styles, images, PWA, SEO, sitemap. |
| Eight root files | `dist/<file>` | `routes.js`, `sliceConfig.json`, `slice-env.json`, `slice-env.generated.js`, `robots.txt`, `sitemap.xml`, `manifest.json`, `service-worker.js`. |
| `Components/` | `dist/Components` | **Only** with `--keep-components` (debug). |

Everything else is skipped: `utils/`, `AppConfig.js`,
`slice-events.generated.js`, `slice-build.generated.d.ts`,
`slice-runtime.generated.d.ts`, arbitrary source folders.

Inside every copied tree the same filter rejects:

- `.map`, `.map.br`, `.map.gz`,
- `.d.ts`,
- `.env`, `.env.*`,
- `package.json`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`,
  `npm-shrinkwrap.json`,
- `node_modules/`, `.git/`.

`dist/public` is flattened, but it may not overwrite files the exporter owns:
`index.html`, `404.html`, `routes.js`, `sliceConfig.json`, `slice-env.json`,
`slice-env.generated.js`, `manifest.json`, `service-worker.js`. Express answers
those paths with explicit routes before its static middleware, so the static
export matches that precedence.

**Parity note:** `slice-events.generated.js` is **not** served by Express
production (it is not imported by the runtime, the server or the bundles), so it
is not exported either. If a future runtime imports it, it must be added to both
sides of the contract.

### P0-4 — percent-encoded path bypass

**Evidence (before):**

```js
const requestPath = req.path;   // still encoded
// ...
app.use(express.static(path.join(projectRoot, folderDeployed, 'public')));
```

`req.path` is not decoded by Express, but `express.static` decodes before
resolving a file. With `.env` in `public/`, `GET /%2eenv` passed the extension
check (no extension), the blocked-path check (the string does not contain `/.env`)
and the production guard, then `express.static` decoded it and served the file.

**Fix:** `decodeRequestPath()` in `securityMiddleware.js` decodes up to three
times, tolerates malformed input and normalizes backslashes. It is used by:

- `securityMiddleware` (blocked paths, public-asset bypass, extension allowlist,
  traversal check),
- `sliceFrameworkProtection`,
- `suspiciousRequestLogger`,
- the production static guard in `createSliceServer` (maps, declarations, env,
  package manifests, `node_modules`, `/dist` tree).

Regression tests request `/%2eenv`, `/%2Eenv`, `/%2e%65nv` and
`/%73ecret.js.map` against a real production server and assert 403/404, while a
normal public asset still returns 200.

---

## 5. P1 details

### P1-1 — deployment guide

Added `repos/slice.js_docs/markdown/getting-started/deployment.md`. It covers:

- Express (`slice start`) vs static (`slice export`) and when to use each,
- the `dist/` → `dist-static/` relationship,
- local preview and the `npx serve -s` trap,
- the host matrix (Cloudflare Pages, Netlify, Vercel, nginx, GitHub Pages, S3),
- GitHub Pages root-only rules (user site or custom domain, never
  `user.github.io/repo/`),
- `--check` in CI,
- what is public and what is pruned,
- env behavior and troubleshooting.

### P1-2 — flag tables

`cli-commands.md` and `docs/static-export.md` now list every real flag:
`--out`, `--from-dist`, `--host`, `--seo`, `--origin`, `--images`,
`--no-prerender`, `--spa`, `--keep-components`, `--check`, `--dry-run`,
`--sourcemap`, `--hash-filenames`, `--compress`, `--no-minify`,
`--no-obfuscate`.

### P1-3 — what `--check` actually guarantees

`checkExport()` now validates:

1. Required runtime files: `index.html`, `404.html`, `routes.js`,
   `sliceConfig.json`, `slice-env.json`, `slice-env.generated.js`,
   `bundles/bundle.config.json`, `Slice/Slice.js`.
2. `Components/` is absent unless `--keep-components` is passed.
3. `public/` was flattened (no `/public` directory left in the export).
4. No source/build leftovers: `utils/`, `src/`, `api/`, `node_modules/`, `.git/`,
   `AppConfig.js`, `slice-events.generated.js`,
   `slice-build.generated.d.ts`, `slice-runtime.generated.d.ts`.
5. No `.map`, `.map.br`, `.map.gz`, `.d.ts`, `.env*`, `package.json`,
   lockfiles, `node_modules` or `.git` anywhere.
6. No `sourceMappingURL=` reference inside any exported `.js`.
7. Host rules are coherent:
   - `_redirects` and `_headers` exist together (Cloudflare/Netlify),
   - `vercel.json` is valid JSON,
   - `nginx.conf` maps 404 to `/404.html`,
   - `.nojekyll` exists when `--host github` is explicit.
8. Every literal route in `routes.js` has a prerendered page **unless** the
   export declares an SPA fallback (`_redirects` catch-all, Vercel rewrite,
   nginx `try_files ... /index.html`). Localized exports check every locale
   candidate. Missing localized pages are warnings, not failures.

**Documented limits:** `--check` does **not**:

- enumerate `${param}` routes (list concrete values in
  `seo.json → routes[pattern].sitemap.paths` first),
- verify that every referenced image/font/CSS file exists,
- scan `sliceConfig.json` or bundles for application-level secrets,
- prove that a remote host applies the rules (`_redirects`, `vercel.json`,
  nginx config) or that `Cache-Control` is actually sent.

### P1-4 — `slice start` documentation

Corrected/added:

- `slice start` serves `dist/`; if `dist/` or
  `dist/bundles/bundle.config.json` is missing it runs `slice build` first.
- It keeps `src/` and `api/` as a requirement (the server entrypoint lives in
  `api/index.js`).
- Port priority: `--port` → `sliceConfig.server.port` → `3000`; if busy it tries
  `port + 1`. The framework `start()` helper, used without the CLI, defaults to
  `3001`.
- Production serves only `dist/public` at `/`, `/App/*`, `/routes.js`,
  `/sliceConfig.json`, `/bundles/*` (and the legacy `/dist/bundles/*` mirror),
  `/Slice/Slice.js`, the env pair, PWA files and translator dictionaries.
- It does **not** serve `/Components`, the rest of the `/dist` tree, `.map`,
  `.d.ts`, `.env`, `package.json` or `node_modules`.
- A real 404 requires SEO; without it the fallback returns the shell with 200
  (soft 404). This is now stated next to the fallback table.
- The claim that `sliceFallback`/`createSliceServer` were "untouched" was
  removed: production static mounts and the guard did change.

### P1-5 — local preview

`slice export` now prints `npx serve dist-static` and explicitly says that
`npx serve -s` hides the real `404.html`. The deployment guide explains both
modes and when each one is appropriate.

### P1-6 — public files

The deployment guide lists what a static host can serve and warns that
`sliceConfig.json`, `routes.js`, `bundle.config.json`, `slice-env.json` and
`manifest.json` are public by design. They must not contain secrets.

---

## 6. Decisions

### 6.1 Output folder: keep `dist-static`, not a single `dist`

**Decision:** `dist/` remains the Express/serverless build. `slice export` writes
`dist-static/`.

**Why:**

- `dist/` is already the runtime layout Express serves (`App/` at `/App`,
  `public/` at `/`, explicit root files). A static host needs a flattened root
  (`public/*` at `/`), a root `index.html`, `404.html` and host rules. Making
  `dist/` satisfy both would either break `slice start` or force every Express
  deployment to learn the static layout.
- The flattened layout is a different artifact with different rules. Keeping it
  separate makes the boundary auditable: `dist-static/` is the only folder you
  upload to a static host.
- It preserves existing CI that assumes `dist/`.
- `dist-static` is explicit and does not collide with common host defaults. A
  single `dist` would be conventional for an SPA, but here it is already taken.

**Trade-off:** two folders to ignore in git and two commands to learn. This is
worth it for a framework that supports both an Express runtime and a static
host. If a future release adds a `--static` mode to `slice start`, it should
still read `dist-static/`, not repurpose `dist/`.

### 6.2 Root-only hosting

The public route equals the app route. No base path, no `--base`, no project
subpath. GitHub Pages project sites are not supported; use a user site
(`user.github.io`) or a custom domain on a project site.

### 6.3 Default real 404

With SEO, `slice export` emits a real `404.html` and no catch-all. `--spa`
restores the client-router fallback (soft 404). Without SEO, the shell is the
only page and the SPA fallback is on by default.

### 6.4 `Components/` pruned

Express production 404s `/Components`; the static export matches it. Every
component used at runtime is in a bundle. `--keep-components` is a debugging
escape and the CLI warns that component source becomes fetchable.

### 6.5 Public env is build-time

`slice build` writes `dist/slice-env.json` + `dist/slice-env.generated.js`; the
runtime imports the shim. There is no production env endpoint. Rebuild per
environment or use an edge function for per-request values.

---

## 7. Verification

Run from the workspace root:

```bash
pnpm test:framework          # 239 tests
cd repos/slicejs-cli
node --test tests/export-command.test.js \
  tests/dependency-analyzer.test.js \
  tests/docs-generate.test.js \
  tests/commands-component-crud.test.js \
  tests/commands-doctor.test.js \
  tests/build-command-integration.test.js \
  tests/build-config-validation.test.js \
  tests/build-degradation-reporting.test.js \
  tests/postinstall-command.test.js \
  tests/getcomponent.test.js \
  tests/init-command-contract.test.js
```

Manual checks used during the audit:

```text
slice start (Portfolio, production)
  /                                             200
  /Components/Visual/Button/Button.js            404
  /dist/Components/Visual/Button/Button.js       404
  /dist/sliceConfig.json                         404
  /dist/slice-build.generated.d.ts               403
  /dist/bundles/slice-bundle.critical.js         200
  /bundles/__audit.map                           403
  /%2eenv                                        403/404

slice export (Portfolio)
  343 files -> 113 files after pruning Components
  /Components/...                                404
  real 404.html                                  present
  locale redirect pages                          present for github/s3/none
```

---

## 8. Remaining work (not blockers)

| Item | Recommendation |
|---|---|
| P2-3 `sliceConfig.json` exposure | Optionally emit a runtime-only subset for production; verify the runtime does not need `server.*`. |
| P2-4 service worker caching | Document a versioned cache name / skipWaiting flow per host; consider hashing the cache on build. |
| P2-5 API routes | Document that a static host has no `/api/*`; use an edge function or a separate backend. |
| `--check` asset references | A future pass can parse `App/index.html` and bundles for local URLs and assert they exist. |
| `--check` secret scan | A future pass can scan `sliceConfig.json` for keys such as `secret`, `password`, `token`; keep it opt-in to avoid false positives. |
| Release | Bump CLI + framework together, run `node scripts/release-check.mjs`, and publish only after the deployment guide is live. |
