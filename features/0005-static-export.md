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
`slice-env.json`, and the host rule files.

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
- Phase 4 (separate): `base` path for subpath hosting.

## Alternatives considered

- **`slice build --static`**: cheaper to implement, but changes what `dist/`
  means and breaks CI that assumes the current layout. Rejected.
- **A separate `slice-serve` package**: duplicates the CLI's build knowledge
  and splits the ownership of the output format. Rejected.
- **Only document host rules**: does not solve the layout mismatch or the
  prerender; every user keeps hand-rolling it. Rejected.

## Scope

### In scope

- `slice export` with `--out`, `--host`, `--seo`, `--origin`, `--patterns`,
  `--no-prerender`, `--from-dist`, `--check`, `--dry-run`.
- Flatten + root `index.html` + `slice-env.json`.
- Per-route HTML from `prepareSeo.pages`, `404.html`, locale redirects.
- Host rule generators: Cloudflare/Netlify, Vercel, nginx, GitHub Pages, S3.
- Validation and a smoke test against a dumb static server.

### Out of scope

- Runtime `base` path (phase 4, separate feature if needed).
- Edge functions for `${param}` SEO.
- Changing `slice start` or `sliceFallback`.
- A docs-site deployment guide (separate docs commit).

## Compatibility and risk

- **Public API impact**: new command and flags only. `build`, `start` and the
  runtime are untouched.
- **Existing apps affected**: none until they run `slice export`.
- **Migration / breaking change**: none.
- **Security / performance**: the export can expose `Components/` and any
  `.map` left by `--sourcemap`; `--check` must fail on maps and secret
  patterns. Prerendering runs `prepareSeo` at build time (Node, no browser).
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
- Skill / agent guidance: add the export command and the "root vs subpath"
  rule to `slice-js-developer`.
- Workspace docs: this feature is aggregated by `pnpm feature:list`.

## Open questions

- [ ] Command name: `slice export` vs `slice build --static`.
- [ ] Default `${param}` policy: `skip`, `shell`, or fail.
- [ ] One output layout + host rules, or one layout per host.
- [ ] `slice-env.json` frozen at build vs edge function.
- [ ] `Components/`: keep by default or prune with `--prune-components`.
- [ ] Does `export` run `build`, or require `--from-dist`?

## Decision log

- 2026-11-08 - Created as `proposed` after a static-hosting analysis of the
  framework and CLI 4.2.0/4.5.0.
- 2026-11-14 - MVP implemented on `experiment/static-export`: `slice export
  --from-dist` flattens `dist/public` to the root, creates `index.html` /
  `404.html`, freezes `slice-env.json` through the framework's exported env
  resolver, and writes Cloudflare/Netlify, Vercel, nginx or GitHub rules.
- 2026-11-14 - Validated against Conclave with a dumb static server: `/`,
  `/plantilla`, `/dashboard`, `/mis-respuestas` and `/comparar` render; an
  unknown route reaches the app's 404 view. The pre-existing `UserMenu`
  `createElement` error also appears under `slice start`, so it is not caused by
  the export. Phase 2 (per-route SEO prerender, locale redirects) and phase 4
  (`base` path) remain open.
