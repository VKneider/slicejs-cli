---
id: "0001"
title: "slice doctor: report SEO configuration"
repo: "slicejs-cli"
status: proposed
area: cli
priority: low
created: 2026-10-27
updated: 2026-10-27
target: "TBD"
owners: []
related:
  - "slice.js/features/0002-native-seo-per-route-head-sitemap-and-real-404s.md"
  - "commands/doctor/doctor.js"
---

# slice doctor: report SEO configuration

## Summary

Add an `SEO` row to `slice doctor` that answers two questions: *is per-route metadata configured?* and
*is the origin safe to deploy?* Today a project can have every doctor row green and still be
invisible to crawlers.

## Problem / motivation

`slice doctor` checks Node version, project structure, `sliceConfig.json`, port availability, package
manager, dependencies, components, component props and bare imports. Nothing about the one defect the
framework cannot detect at build time: a SPA with a single `<head>`.

The failure modes are silent and only show up in Search Console or in a shared link:

- one title/canonical/`og:image` for every route;
- unknown paths answering `200` with the shell (soft 404);
- canonical pointing at the home on every page;
- no sitemap, or a hand-written one that drifts;
- an `origin` that is still `localhost` (or missing), which then ships as the canonical.

The project has the information to catch all of it — `seo.json`, `routes.js`, `api/index.js` — and
doctor is exactly the command a user runs before deploying.

## Proposed direction

One more entry in the existing `checks` array (`commands/doctor/doctor.js`), same result contract
(`{ pass | warn | fail, message, suggestion }`) so it renders in the current table without touching
the runner:

```js
{ name: 'SEO', fn: checkSeo }
```

The check is local, offline and cheap (< 50 ms, no server, no network):

| Situation | Verdict | Message |
|---|---|---|
| No `api/` server in the project | pass | `Not a server app (no api/index.js)` |
| Server, but no `seo.json` and no `seo` option | **warn** | `Not configured — every route shares one <head>, unknown paths answer 200` + the minimal snippet |
| Invalid JSON / unknown `version` | fail | the parse error or `Unsupported seo.json version 2` |
| `origin` missing | **warn** | `origin missing — production startup will fail` |
| `origin` not absolute, with a trailing slash or a path | fail | `origin must be an absolute URL without a path` |
| `origin` is `localhost` / `127.0.0.1` / `0.0.0.0` / `*.local` | **warn** | `localhost will leak into canonical and og:url — set origin before deploying` |
| Routes without an entry (and no inline `meta`) | **warn** | `3 routes without metadata (e.g. /pricing, /blog)` |
| Two routes with the same canonical | **warn** | `duplicate canonical: /docs/x` |
| Local `image` that does not exist | **warn** | `image not found: /og/pricing.png` |
| Everything consistent | pass | `origin https://…, 70 routes, sitemap on` |

Rules are **not** re-implemented here: the check imports `validateSeoManifest()` from the project's
installed `slicejs-web-framework` (same validator `slice seo check` uses), so the two commands cannot
disagree. When it cannot be resolved — a project pinned to an older framework — the check still does
the file-level checks and says so in the message instead of pretending.

Verdict policy: **warn, never fail, for a missing optional feature** (a project that does not want
SEO should not turn red). `fail` is reserved for malformed input the user must fix. `slice seo check`
stays the strict, exit-code-1 gate for CI.

## Alternatives considered

- **A separate `slice seo doctor`**: splits the place people already look before deploying; doctor is
  the "is my project healthy" command.
- **Fail the whole doctor run on SEO problems**: turns an optional feature into a blocker and breaks
  CI scripts that treat a red doctor as "cannot run".
- **Probe the running server** (`/api/status`, a sample route): would need the server up and would
  make the check flaky; the static inputs already contain the answer.

## Scope

### In scope

- `checkSeo()` in `commands/doctor/doctor.js` + registration in the checks array.
- `tests/doctor-seo.test.js` (node:test, `withTestProject` fixtures): no server → pass; server without
  `seo.json` → warn; valid manifest → pass with the summary line; localhost origin → warn; bad version
  → fail; entries without routes → warn.
- One paragraph in `markdown/cli-commands.md` (doctor section) listing the new row.

### Out of scope

- Generating or fixing `seo.json` (app/parser concern; the framework feature owns the format).
- The runtime prerender, head injection, sitemap generation.
- Network probes of the deployed site (that is a monitoring tool, not doctor).

## Compatibility and risk

- Output: one extra table row. Scripts parsing doctor output by line count could notice; the
  `Check`/`Status`/`Details` shape is unchanged.
- Exit code: unchanged (warnings do not fail the run today).
- Must degrade when `slicejs-web-framework` is not resolvable from the project (older pin, monorepo
  local link): file-level checks only, message says so.
- Cost: read two or three files. No `cwd` assumptions — use `PathHelper` / `getProjectRoot`.

## Validation plan

- Unit tests: the six fixtures above.
- `pnpm test` in `slicejs-cli` (node:test, no new dependencies).
- Manual: `slice doctor` inside `slicejs-components` (SEO configured → green with counts) and inside a
  fresh `slice init` project (→ warn with the snippet).

## Documentation impact

- Framework docs pages: `markdown/cli-commands.md` (doctor section) + the SEO page from the framework
  feature.
- Component docs: none.
- Skill / agent guidance: one line — "before deploying, `slice doctor` tells you whether SEO is
  configured".
- Workspace docs: none.

## Open questions

- [ ] Import the validator from the project's framework, or keep a minimal duplicate in the CLI?
      (Suggested: import, with a documented fallback.)
- [ ] Warnings only, or make doctor exit non-zero when SEO is unconfigured? (Suggested: warnings.)
- [ ] Should the row report the sitemap URL state (generated by the server) or only the manifest's
      `sitemap: true`? (Suggested: the manifest flag; the server only exists at runtime.)

## Decision log

- 2026-10-27 - Created as `proposed` while designing the framework's native SEO module
  (`slice.js/features/0002`). The check consumes the framework's validator so the rules stay in one
  place.
