---
id: "0005"
title: "Static export: serve a Slice app without the Express server"
repo: "slicejs-cli"
status: in-progress
area: cli
priority: medium
created: 2026-11-08
updated: 2026-11-14
target: TBD
owners: []
related: []
depends_on: []
blocks: []
---

# Static export: serve a Slice app without the Express server

## Summary

Add `slice export`: a command that turns `dist/` into a folder any static file
server can host (Cloudflare Pages, Vercel, nginx, GitHub Pages, S3), with no
Express and no long-running Node process. It flattens the build output, emits
per-route HTML from the SEO manifest, a real `404.html`, locale redirects,
`slice-env.json` + its ESM shim, and the host rule files.

Full design: [`../docs/static-export.md`](../docs/static-export.md).

## Problem / motivation

Today a production Slice app needs `slice start` (Express) to be correct:

- `dist/public` is served at `/` and `dist/App` at `/App`, but the build output
  does not say that. Serving `dist/` as-is breaks `/Themes`, `/images`,
  `/workers` and `/App/*`.
- `/slice-env.json` exists only as a runtime endpoint.
- Per-route `<head>`, the real 404 and locale redirects are produced by
  `sliceFallback` at request time (`prepareSeo().resolve()`).
- PWA files live under `dist/public`, not at the root.

The result: deploying to a static host requires hand-made surgery that every
user repeats, and the framework's own `--compress` flag already advertises
"static serving" without a command that produces it.

## Proposed direction

- **New command `slice export`**, separate from `build` (no change to `dist/`).
- Reuse `prepareSeo()`; expose `pages`, `notFound` and `redirects` from it
  (additive, low risk).
- Flatten `dist/` into a host-neutral layout:
  `index.html`, `App/`, `bundles/`, `Slice/`, `public/*` at the root, locales,
  `routes.js`, `sliceConfig.json`, `slice-env.json`.
- Emit `<route>/index.html` for literal routes, `404.html` and host rules
  (`_redirects`/`_headers`, `vercel.json`, `nginx.conf`).
- `--check` validates an export: no `.map`, no secret patterns, every route
  covered, assets present.
- **Root-only by decision:** the app must be served at a domain/subdomain root,
  so the public route equals the app route. Subpath hosting (`base` path) is not
  supported.

## Alternatives considered

- **`slice build --static`**: cheaper to implement, but changes what `dist/`
  means and breaks CI that assumes the current layout. Rejected.
- **A separate `slice-serve` package**: duplicates the CLI's build knowledge
  and splits the ownership of the output format. Rejected.
- **Only document host rules**: does not solve the layout mismatch or the
  prerender; every user keeps hand-rolling it. Rejected.

## Scope

### In scope

- `slice export` with `--out`, `--host`, `--seo`, `--origin`, `--no-prerender`,
  `--from-dist`, `--check`, `--dry-run`.
- Flatten + root `index.html` + `slice-env.json` + `slice-env.generated.js`.
- Build-time public env: `slice build` writes the JSON and the ESM shim; the runtime imports the
  shim, so there is no env endpoint in production.
- Per-route HTML from `prepareSeo.pages`, `404.html`, locale redirects.
- Host rule generators: Cloudflare/Netlify, Vercel, nginx, GitHub Pages, S3.
- Validation and a smoke test against a dumb static server.

### Out of scope

- Runtime `base` path / subpath hosting is **out of scope by product decision**.
- Edge functions for `${param}` SEO.
- Changing `slice start` or `sliceFallback`.
- A docs-site deployment guide (separate docs commit).

## Compatibility and risk

- **Public API impact**: new command and flags only. `build`, `start` and the
  runtime are untouched.
- **Existing apps affected**: none until they run `slice export`.
- **Migration / breaking change**: none.
- **Security / performance**: `Components/` is pruned by default so component
  source is not fetchable; `--keep-components` opts back in and `--check` fails
  when it is present. Any `.map` left by `--sourcemap` is excluded; `--check`
  fails on maps. Prerendering runs `prepareSeo` at build time (Node, no browser).
- **Framework change**: exposing three fields from `prepareSeo` is additive.
  Exporting the env provider requires a `package.json` `exports` entry.

## Validation plan

- **Unit tests**: flatten rules, page path mapping (`/` → `index.html`,
  `/es/x` → `es/x/index.html`), host rule generation, `--check` failures.
- **Browser/e2e tests**: `npx serve dist-static`, Playwright over `/`,
  a deep link, a 404, a locale redirect, PWA endpoints.
- **Product check (Conclave)**: run `slice export` on Conclave and compare the
  rendered app with `slice start`.
- **Artifact/release check**: packed CLI can run `export` on a fixture project
  outside the workspace.

## Documentation impact

- Framework docs pages: new `getting-started/deployment.md` (or
  `project-architecture/static-hosting.md`) in `repos/slice.js_docs/markdown/`.
- CLI docs: `cli-commands.md` (new command and flags).
- Component docs: none.
- Skill / agent guidance: add the export command and the root-only rule to
  `slice-js-developer`.
- Workspace docs: this feature is aggregated by `pnpm feature:list`.

## Open questions

- [ ] Command name: `slice export` vs `slice build --static`.
- [ ] Default `${param}` policy: `skip`, `shell`, or fail.
- [ ] One output layout + host rules, or one layout per host.
- [x] `slice-env.json` frozen at build vs edge function. Build-time JSON + ESM shim; edge functions remain an option.
- [x] `Components/`: pruned by default; `--keep-components` for debugging.
- [ ] Does `export` run `build`, or require `--from-dist`?

## Decision log

- 2026-11-08 - Created as `proposed` after a static-hosting analysis of the
  framework and CLI 4.2.0/4.5.0.
- 2026-11-14 - MVP implemented on `experiment/static-export`: `slice export
  --from-dist` flattens `dist/public` to the root, creates `index.html` /
  `404.html`, freezes `slice-env.json` through the framework's exported env
  resolver, and writes Cloudflare/Netlify, Vercel, nginx or GitHub rules.
- 2026-11-14 - Public env moved into `slice build`: `dist/slice-env.json` is the shared,
  auditable artifact and `dist/slice-env.generated.js` is the ESM shim the runtime
  imports. `slice export` copies both; `slice start` serves them as static assets.
  The `/slice-env.json` endpoint remains only as the development/live provider and
  as a fallback for older builds. Native JSON module imports were rejected because
  they are not available in every browser/webview Slice supports.
- 2026-11-14 - Validated against Conclave with a dumb static server: `/`,
  `/plantilla`, `/dashboard`, `/mis-respuestas` and `/comparar` render; an
  unknown route reaches the app's 404 view. The static server log shows a
  `GET /slice-env.generated.js` and no `GET /slice-env.json`. The pre-existing
  `UserMenu` `createElement` error also appears under `slice start`, so it is not
  caused by the export. Phase 2 (per-route SEO prerender, locale redirects) is
  implemented; subpath hosting is out of scope.
- 2026-11-14 - Phase 2 implemented: `prepareSeo` exposes `pages`, `notFound` and
  `redirects`; `slice export` writes per-route HTML, `sitemap.paths` patterns and
  a real `404.html`. With SEO the default is a real 404 (no catch-all); `--spa`
  restores the SPA fallback. Validated on Portfolio: 30 routes across 2 locales,
  `/en/experience` -> `/experience` 301, `/nope` -> 404 with noindex, localized
  titles and `lang` attributes. Subpath hosting is out of scope by decision.
- 2026-11-14 - GitHub Pages / S3 / `--host none` now get portable HTML redirect
  pages (`meta refresh`, `rel=canonical`, `noindex`) for locale redirects, since
  those hosts cannot express server rules. Verified `/en/experience` lands on
  `/experience` with the correct title.
- 2026-11-14 - **Root-only by product decision.** The public route must equal the
  app route, so no `base` path / subpath hosting is added. Deploy on a domain
  root or subdomain; GitHub Pages project sites under `/repo/` are not supported.
  The experimental base-path WIP was reverted.
- 2026-11-14 - **`Components/` pruned by default.** Express production 404s
  `/Components`; the static export now matches that so component source is not
  fetchable. `--keep-components` is a debugging escape and `--check` fails when
  the folder is present without it. Verified `/Components/...` returns 404 and
  Portfolio still renders from its bundles.
