# Static export — implementation notes

Maintainer/contributor documentation for **`slice export`**: packaging a Slice
app so any static file server (Cloudflare Pages, Vercel, nginx, GitHub Pages,
S3) serves it **without Express and without a Node process**.

This is an internal design doc. The user-facing guide lives in
`repos/slice.js_docs/markdown/getting-started/deployment.md`.

Status: **MVP + phase 2 implemented and audit-hardened on
`experiment/static-export`** (2026-11-15). The exporter is **root-only** by
decision: the app must be served at the root of a domain or subdomain. Subpath
hosting (`user.github.io/repo/`) is out of scope; it would require translating a
deployment prefix in the router, and the product keeps the public route equal to
the app route.

The production audit — findings, priorities, decisions and verification — is in
[`static-export-audit.md`](./static-export-audit.md). The user-facing guide is
`repos/slice.js_docs/markdown/getting-started/deployment.md`.

Related: `features/0005-static-export.md` (feature record).

---

## 1. Overview

`slice build` already produces every byte the app needs: bundles, runtime,
assets and minified components. What is missing is **reordering `dist/` for a
file server** and **emitting at build time what the Express server generates at
runtime** (per-route HTML, 404, redirects, `slice-env.json`, headers).

The runtime does **not** need changes when the site is served at the **root of a
domain**. The exporter is root-only: serving under a subpath
(`user.github.io/repo/`) is out of scope because the public route must stay the
same as the app route.

The command is **`slice export`**, separate from `build`, so CI that assumes
`dist/` keeps working.

---

## 2. Current state

### 2.1 What `slice build` emits

`processDirectory` copies **all of `src/`** into `dist/`, processing file by
file (`commands/buildProduction/buildProduction.js`), then adds bundles and the
runtime:

```
dist/
  App/index.html          # the shell (server sends this file)
  App/index.js
  App/style.css
  Components/             # minified per-component copies
  bundles/                # slice-bundle.*.js + bundle.config.json
  events/
  public/                 # images/, Styles/, Themes/, workers/, manifest.json
  Slice/Slice.js          # self-contained runtime
  locales/                # only when translator is enabled
  routes.js               # served as-is (the router imports it)
  sliceConfig.json        # served as-is
  sitemap.xml  robots.txt
  slice-build.generated.d.ts
  slice-events.generated.js
  slice-runtime.generated.d.ts
```

There is **no root `dist/index.html`**; the shell lives at `App/index.html`.

### 2.2 What `createSliceServer` does at runtime

| Responsibility | Source | Can it move to build time? |
|---|---|---|
| Serve `dist/public` at `/` and `dist/App` at `/App` | `repos/slice.js/api/framework/server.js:789,793` | Yes: flatten |
| `/slice-env.json` from `.env` + `process.env` | `server.js:582` | Build writes `dist/slice-env.json` + `slice-env.generated.js`; the server serves them as static assets |
| PWA (`service-worker.js`, `manifest.json`) | `server.js:596-625` | Yes: files + flatten |
| `/Slice/Slice.js` | `server.js:632-651` | Already in `dist/Slice/` |
| SPA fallback + 404 + locale redirects | `sliceFallback` (`server.js:129`) | Partial: `prepareSeo().resolve()` |
| Per-route SEO head | `prepareSeo` (`server.js:278`) | Yes: `pages` + `notFound` |
| Security headers + CORS + compression | `server.js:531-576` | No: host rules |
| `/api/*` 404 JSON | `server.js:178` | Not applicable |

### 2.3 Hardcoded absolute paths (root-only)

- `repos/slice.js/Slice/Slice.js:449` `fetch('/sliceConfig.json')`
- `Slice.js:472` `fetch('/slice-env.json')`
- `Slice.js:475` `fetch('/bundles/bundle.config.json')`
- `Slice.js:498` `import('/bundles/...')`
- `Slice.js:528` `structuralComponentFolderPath = '/Slice/Components/Structural'`
- `App/index.html`: `/App/index.js`, `/App/style.css`

`slice.paths.*` and `paths.routesFile` are configurable; the list above is not.

---

## 3. Design decisions

### 3.1 Separate command

`slice export`, not `slice build --static`:

- `build` keeps meaning "compile for `slice start`" (self-hosted, serverless,
  development).
- `export` means "package for a file server".
- They share 90%: `export` runs `build` internally, or reuses `dist/` with
  `--from-dist`.
- Avoids breaking existing pipelines that assume `dist/`.

### 3.2 Output layout (root)

```
dist-static/
  index.html                 # shell, or '/' prerender
  App/                       # index.js, style.css (the shell references them)
  bundles/
  Slice/Slice.js
  images/ Styles/ Themes/ workers/ manifest.json   # from dist/public, at root
  locales/
  routes.js
  sliceConfig.json
  sitemap.xml  robots.txt
  slice-env.json             # generated at build
  <route>/index.html         # prerender per literal route
  404.html
  _redirects | vercel.json | nginx.conf | (none)
```

The final layout **does not depend on the host**. Host rule files are optional
and selected with `--host`.

**Why `dist-static` and not a single `dist`:** `dist/` is the Express/serverless
layout (`App/` at `/App`, `public/` at `/`, explicit root files). A static host
needs a flattened root, `index.html`, `404.html` and host rules. Making `dist/`
satisfy both would break `slice start` or force every Express deployment to learn
the static layout. Keeping the artifacts separate also makes the upload boundary
auditable: `dist-static/` is the only folder a static host sees. This is a
decision, not an accident of history.

### 3.3 Prerender

Reuse `prepareSeo`. Today it returns `resolve()`; expose also:

```js
return {
  origin, manifest, routes, translator, prerendered,
  pages,        // Map<'/pricing' | '/es/pricing', { html, gzip, br, etag }>
  notFound,     // Map<locale|null, { html, ... }>
  redirects,    // [{ from: '/es/pricing', to: '/pricing', status: 301 }]
  resolve
};
```

- **Literal routes** (`pages`): `dist-static${url}/index.html` (`/index.html`
  for `/`).
- **`${param}` routes**: not enumerable. Policy:
  - `--patterns=skip` (default): not emitted; the host decides (SPA fallback or
    404).
  - `--patterns=shell`: emit the generic shell at a sentinel path.
  - Values declared in `seo.json → routes[pattern].sitemap.paths` **are**
    prerendered.
- **No SEO configured**: only `index.html` + the host SPA rule. Document that
  404 becomes a soft 404.
- **Locales**: `pages` keys are already localized URLs, so the file path is
  direct (`es/pricing/index.html`).
- **Trailing slash**: static hosts redirect `/stickers` → `/stickers/` when the
  directory exists. `MultiRoute` already normalizes the slash.

### 3.4 404

- With SEO: `404.html` from `notFound` (includes `noindex`).
- Without SEO: `404.html` = the shell.
- Hosts: Cloudflare Pages / Netlify use `404.html` automatically; Vercel serves
  it for static deployments; nginx needs `error_page 404 /404.html;`; GitHub
  Pages serves it with a real 404 status.

### 3.5 Redirects

- `redirects` from `prepareSeo` (locale `301`/`302`) → host rules.
- `_redirects` (Cloudflare/Netlify): one `from to status` line. **No regex**, so
  `${param}` routes cannot be expressed.
- Vercel: `redirects[]`.
- nginx: `location = /es/pricing { return 301 /pricing; }`.
- GitHub Pages / S3 / `--host none`: no server redirects, so the exporter writes
  a tiny HTML redirect page (`meta refresh` + `rel=canonical` + `noindex`) at the
  non-canonical path. It is a 200 soft redirect, but portable and crawlable.

### 3.6 `slice-env.json`

- `slice build` emits two artifacts into `dist/`:
  - `slice-env.json` — the shared, auditable payload.
  - `slice-env.generated.js` — an ESM shim that exports the same object. The
    runtime imports this shim, so there is no env endpoint in production.
- The shim exists because native JSON modules (`import ... with { type: 'json' }`)
  are not available in every browser/webview Slice supports. The JSON stays the
  source of truth; the shim is only the import mechanism.
- **Trade-off:** frozen at build. Per-environment values need one build per
  environment or an edge function.
- Do not duplicate the resolver: the CLI uses
  `slicejs-web-framework/api/framework/publicEnvResolver.js`.
- `slice dev` keeps the live `/slice-env.json` endpoint (and serves a live shim)
  so `.env` edits do not require a build. `slice start` serves the built files as
  static assets; the old endpoint remains only as a fallback for older builds.

### 3.7 PWA and headers

Flattening `dist/public/*` to the root puts `service-worker.js` and
`manifest.json` at `/`; the service worker scope is already `/`.

Headers the server sets and the host must replicate:

```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
```

`/bundles/*`: `Cache-Control: no-store` (the `bundle.config.json` path is
fixed; hashed bundles can be immutable).

### 3.8 What is copied (allowlist)

The export is an **allowlist**, not `dist/` minus a denylist. `dist/` also holds
the processed source tree (`utils/`, `AppConfig.js`, generated event catalogs),
and a misplaced `.env` in `public/` would otherwise ship.

Published:

| Path | Why |
|---|---|
| `App/` | Shell (`index.html`, `index.js`, `style.css`). |
| `bundles/` | Runtime bundles + `bundle.config.json`. |
| `Slice/` | Self-contained runtime. |
| `locales/` | Translator dictionaries. |
| `events/` | Event catalog, when the build emits it. |
| `public/*` → `/` | Themes, Styles, images, PWA, SEO, sitemap. |
| Root files | `routes.js`, `sliceConfig.json`, `slice-env.json`, `slice-env.generated.js`, `robots.txt`, `sitemap.xml`, `manifest.json`, `service-worker.js`. |
| `Components/` | **Only** with `--keep-components` (debug). |

Everything else is skipped: `utils/`, `AppConfig.js`,
`slice-events.generated.js`, `slice-build.generated.d.ts`,
`slice-runtime.generated.d.ts`, arbitrary source folders.

Inside copied trees the filter also rejects `.map`, `.map.br`, `.map.gz`,
`.d.ts`, `.env*`, `package.json`, lockfiles, `node_modules` and `.git`.
Precompressed `.br`/`.gz` siblings (from `slice build --compress`) are copied;
the host must be configured to use them, otherwise they are dead weight.

`dist/public` is flattened to the root but cannot overwrite the files the
exporter owns (`index.html`, `404.html`, `routes.js`, `sliceConfig.json`,
`slice-env.*`, `manifest.json`, `service-worker.js`). Express answers those with
explicit routes before its static middleware, so the static export matches that
precedence.

`Components/` is **pruned by default**. Express production 404s `/Components`,
so the static export matches it; every component used at runtime is in a bundle.
`--keep-components` is a debugging escape and `--check` fails unless that flag is
passed. A truly dynamic `slice.build` is already broken in Express production
today.

Express production also blocks the `/dist` tree (only `/dist/bundles/` is
mirrored) and any `.map`, `.d.ts`, `.env`, `package.json` or `node_modules`
request, so the static export and `slice start` agree on what is public.
Percent-encoded paths are decoded before those guards run.

### 3.9 Subpath hosting (out of scope)

The exporter is **root-only**. Deploy on a domain root (`https://example.com/`)
or a subdomain (`https://app.example.com/`); do not use a project subpath
(`https://user.github.io/repo/`).

A subpath would add a deployment prefix to every public URL while routes stay
root-relative, so the router would have to strip the prefix on the way in and
add it on the way out. That is a second URL namespace, and the product decision
is to keep the public route identical to the app route. GitHub Pages project
sites are therefore not supported; use a user site or a custom domain.

---

## 4. Command API

```bash
slice export [options]

  --out <dir>            output (default dist-static; validated before writing)
  --from-dist            reuse dist/ without rebuilding
  --host <name>          cloudflare|netlify|vercel|nginx|github|s3|none
                         (default cloudflare; omitted = not explicit)
  --seo <file>           manifest (default: seo.json / public/seo.json)
  --origin <url>         canonical/OG origin override
  --images <file>        social card manifest (default: public/og/manifest.json)
  --no-prerender         shell + SPA rule only
  --spa                  unknown routes -> index.html (default with no SEO)
  --keep-components      ship Components/ (debug; source becomes fetchable)
  --check                validate an existing export, write nothing
  --dry-run              report without writing
  --sourcemap            delegated to build, but maps are filtered from export
  --hash-filenames       delegated to build
  --compress             delegated to build
  --no-minify            delegated to build (debug; readable bundles)
  --no-obfuscate         delegated to build
```

`--out` is validated because the exporter removes the target before copying. It
rejects the project root, ancestors, paths outside the project, `src`, `dist`,
`api`, `node_modules`, `.git`, `public`, `locales`, `Components`, `App`,
`bundles`, `Slice`, existing non-directory targets, symlinked parents that leave
the project, and existing directories that do not look like a previous export
(they must contain `index.html`, `bundles/bundle.config.json` or
`slice-env.json`).

`--sourcemap` does not publish maps: the export filter removes `.map`,
`.map.br` and `.map.gz`. The CLI warns about it. `--no-minify` and
`--no-obfuscate` are debug options; the CLI warns that readable bundles are
being shipped.

Expected output:

```
✔ Exported to dist-static
• 112 files, 9.34 MB
• 30 route(s) prerendered (2 locales)
• 404.html (noindex)
• 9 locale redirect(s)
• Public env: 0 key(s) (JSON + ESM)
• Host rules: _redirects, _headers
• SPA fallback: no (unknown routes -> 404.html)
• Components: pruned (source not shipped)
```

`--check` exit code ≠ 0 when:

- a required runtime file is missing (`index.html`, `404.html`, `routes.js`,
  `sliceConfig.json`, the env pair, `bundles/bundle.config.json`, `Slice/Slice.js`);
- `Components/` is present without `--keep-components`;
- `public/` was not flattened;
- `utils/`, `src/`, `api/`, `node_modules/`, `.git/`, `AppConfig.js`,
  `slice-events.generated.js` or a generated `.d.ts` is present;
- any `.map`, `.map.br`, `.map.gz`, `.d.ts`, `.env*`, `package.json`, lockfile,
  `node_modules` or `.git` is present;
- an exported `.js` contains `sourceMappingURL=`;
- host rules are incoherent (`_redirects` without `_headers`, invalid
  `vercel.json`, nginx without `error_page 404 /404.html`, explicit GitHub host
  without `.nojekyll`);
- a literal route in `routes.js` has no prerendered page and the export has no
  SPA fallback.

`--check` does not enumerate `${param}` routes or verify every referenced asset.
Those limits are documented in the deployment guide and the audit.

---

## 5. Framework changes

| Change | File | Risk |
|---|---|---|
| Expose `pages`, `notFound`, `redirects` in `prepareSeo()` | `repos/slice.js/api/framework/server.js:278-476` | Low. Adds fields only. |
| Export the env provider (`./api/framework/publicEnvResolver.js`) | `repos/slice.js/api/framework/publicEnvResolver.js` + `package.json exports` | Low. |
| Import `/slice-env.generated.js` at boot (fetch fallback) | `repos/slice.js/Slice/Slice.js` | Low: same payload shape, no endpoint in production. |
| Serve the built env JSON + shim as static assets | `repos/slice.js/api/framework/server.js` | Low: two file reads; dev keeps the live endpoint. |

`sliceFallback` itself is reused, not rewritten. `createSliceServer` did change
for production hardening: it serves `/dist/bundles/` as a legacy mirror instead
of the whole `/dist` tree, blocks `.map`/`.d.ts`/`.env`/`package.json`/
`node_modules` requests (after decoding the path), and serves the build-time env
files as static assets. `slice start` remains the Express path.

---

## 6. CLI changes

1. **Build** (or `--from-dist`): `buildProduction({ compress, hashFilenames })`.
2. **Read config**: `sliceConfig.json`, `routes.js`, `seo.json`.
3. **Prerender**: `prepareSeo({ projectRoot, runMode: 'production', seo })`.
4. **Flatten**: `dist/public/*` → root; `dist/App/*` → `App/`; shell → `index.html`.
5. **Copy env**: `dist/slice-env.json` + `dist/slice-env.generated.js`
   (generate them for a `--from-dist` build created before this feature).
6. **Host rules**: `_redirects`, `_headers`, `vercel.json`, `nginx.conf`.
7. **Validate**: referenced assets exist, routes covered, no `.map`,
   `index.html` present.
8. **Report**: size, route count, warnings.

Integration points: `client.js` (register the command) and a new
`commands/export/export.js`. Reuse `Print` and `getProjectRoot`.

---

## 7. Host rules

### Cloudflare Pages / Netlify

```
# _redirects
/font/*  /font.html  200
/*       /index.html 200
```

```
# _headers
/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
/bundles/*
  Cache-Control: no-store
```

### Vercel

```json
{
  "outputDirectory": "dist-static",
  "rewrites": [{ "source": "/font/:id", "destination": "/font.html" }],
  "redirects": [{ "source": "/es/:path*", "destination": "/:path*", "permanent": true }],
  "headers": [
    { "source": "/bundles/(.*)", "headers": [{ "key": "Cache-Control", "value": "no-store" }] }
  ]
}
```

### nginx

```nginx
root /var/www/dist-static;
index index.html;

location / {
  try_files $uri $uri/ /index.html;
}

error_page 404 /404.html;

location /bundles/ {
  add_header Cache-Control "no-store";
}

location ~* \.(?:css|js|svg|png|woff2)$ {
  add_header Cache-Control "public, max-age=31536000, immutable";
}
```

### GitHub Pages

- No rewrites, no headers.
- `index.html` + `<route>/index.html` + `404.html` + `.nojekyll`.
- Root only (user site or custom domain). Project sites under `/repo/` are not
  supported; the public route must equal the app route.
- Locale redirects become HTML `meta refresh` pages at the non-canonical path.
- `${param}` routes need the `404.html` redirect trick (head becomes
  404/noindex).

### S3 + CloudFront

- `index.html` as the default root; `404.html` as the error document.
- Locale redirects become HTML `meta refresh` pages at the non-canonical path.
- SPA: CloudFront function or `CustomErrorResponses` to `/index.html` (soft
  404).

---

## 8. Pitfalls

| Pitfall | Rule |
|---|---|
| `dist/public` at the root | Flatten, or `/Themes`, `/images`, `/workers` 404. |
| `dist/App/index.html` is not `index.html` | Copy it to the root; the shell references `/App/*`. |
| Soft 404 | `/* → /index.html 200` answers 200 for unknown routes. Choose real 404 (no catch-all) or deep links (with catch-all). |
| `.br`/`.gz` | Many hosts do not send `Content-Encoding` by extension. Do not emit them unless the host supports it. |
| `--hash-filenames` | The HTML does not reference bundles (the loader does), but verify the loader reads the hashed names. |
| Frozen `slice-env.json` | One build per environment, or an edge function. |
| Public `/Components` | Pruned by default; `--keep-components` ships fetchable component source. |
| `--sourcemap` | Never in a public export. `--check` fails on `.map`, `.map.br`, `.map.gz` and `sourceMappingURL=`. |
| `--no-minify` | Debug only. The CLI warns; readable bundles are still application source. |
| `--out` | Validated. `.`, `src`, `dist`, `api`, ancestors and paths outside the project are rejected before `fs.remove()`. |
| `file://` | Does not work: ES modules + `fetch` need HTTP. For a local tool, a mini server or Electron/Tauri. |

---

## 9. Tests and acceptance criteria

Fixture:

- 3 literal routes + 1 `${param}` + one route with `permission`.
- `seo.json` with `origin`, sitemap and a pattern with `sitemap.paths`.
- Translator with 2 locales and `localePrefix: 'except-default'`.

Cases:

1. `slice export` produces `dist-static/index.html`, `App/`, `bundles/`,
   `Slice/`, assets at the root.
2. Served with a dumb static server (`npx serve dist-static`):
   - `/` renders;
   - `/pricing` (deep link) renders;
   - `/font/abc` follows the chosen policy;
   - `/nope` → `404.html` with status 404 (without catch-all);
   - `/es/pricing` → 301/302 per config;
   - PWA: `/manifest.json` and `/service-worker.js` answer.
3. `--check` fails with `.map`, `.map.br`, `sourceMappingURL`, `.env`,
   `package.json`, `utils/`, missing `routes.js`, missing host rules, or a route
   not emitted when there is no SPA fallback.
4. Golden test for `_redirects` / `vercel.json`.
5. Without SEO: shell + SPA rule + soft-404 warning.
6. Root-only: no `--base`; a subpath deploy is rejected by product scope.
7. `--out .`, `--out src`, `--out dist`, `--out api` and an outside path are
   rejected and the project survives.
8. An older framework without the SEO API fails only `export` (with a clear
   message), never `dev`/`build`/`start`.
9. `/%2eenv` and `/%73ecret.js.map` are rejected by the production server.

Framework CI: `slice export --check` on the fixture app, plus a Playwright smoke
test against the static output.

---

## 10. Phases and estimate

| Phase | Scope | Estimate |
|---|---|---|
| 0 | Expose `pages`/`notFound`/`redirects` + env provider | 0.5 day |
| 1 | `slice export` MVP: build + flatten + `index.html` + `slice-env.json` + smoke test | 1–2 days |
| 2 | Per-route prerender + `404.html` + locale redirects | 2–3 days |
| 3 | Host rules (`_redirects`, `vercel.json`, nginx) + `--check` + CI | 1–2 days |

Phase 1 is a useful MVP. Phase 2 is what preserves SEO. Subpath hosting
(`base`) is intentionally not a phase: the public route must equal the app
route.

---

## 11. Resolved decisions

1. **Separate command:** `slice export`, not `slice build --static`. `build`
   keeps meaning "compile for `slice start`"; `export` packages for a file
   server. They share `dist/`, and `export` runs `build` unless `--from-dist`.
2. **One layout, optional host rules:** the folder layout is host-independent;
   `--host` only selects the rule files.
3. **`${param}` default policy:** skip. Use `seo.json → sitemap.paths` to
   enumerate concrete values, or `--spa` for a client-router fallback.
4. **Build behavior:** `export` builds by default; `--from-dist` reuses an
   existing `dist/`.
5. **No `slice start --static`:** `slice start` remains the Express host. Use
   `npx serve dist-static` (or a host emulator) to preview the static output.
6. **Build-time env:** `slice-env.json` + `slice-env.generated.js`, frozen per
   build. Per-request values need an edge function.
7. **Output folder:** `dist-static` (see §3.2). A single `dist` was rejected
   because it is already the Express layout.
8. **404 policy:** real `404.html` with SEO; `--spa` opts into a soft 404;
   without SEO the SPA fallback is the default.
9. **`Components/`:** pruned by default; `--keep-components` is debug-only.
