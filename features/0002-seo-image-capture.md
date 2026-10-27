---
id: "0002"
title: "slice seo images: generate the social cards for the app's routes"
repo: "slicejs-cli"
status: done
area: cli
priority: low
created: 2026-10-27
updated: 2026-10-27
target: "TBD"
owners: []
related:
  - "slice.js/features/0002-native-seo-per-route-head-sitemap-and-real-404s.md"
  - "slicejs-components/scripts/og/generate.mjs (the working implementation this would absorb)"
  - "commands/seo"
---

# slice seo images: generate the social cards for the app's routes

## Summary

A command that produces the OG images an app's routes advertise: it walks the routes in `seo.json`,
captures each page (or an element on it), composes the 1200×630 card, writes
`public/og/<slug>-<hash>.png`, and fills in each route's `image` field. The project brings the
Playwright install; the command brings the runner — and gets out of the way when the app needs its
own.

## Problem / motivation

Per-route OG images are the one SEO asset that cannot be generated from data. `slicejs-components`
built it by hand (`scripts/og/generate.mjs`, ~250 lines) and paid for every lesson: element clips
that round outward and pick up a neighbouring border, timestamped demos that change the hash on
every run, pages that render their demo asynchronously and get captured mid-load, full-page
screenshots that are illegible once a platform scales them to 500 px. None of that is
project-specific.

Every app that wants a share card richer than a static banner re-learns the same five things. The
framework now knows the route list and the `image` field (native SEO, feature 0002 in `slice.js`); the
missing piece is the tool that fills it.

## Proposed direction

```
slice seo images                       # every indexable route
slice seo images --only=/pricing       # one route
slice seo images --check               # CI: verify every route's image exists and is in budget
slice seo images --runner ./og.mjs     # the app knows how to reach its pages
```

### Configuration lives in `seo.json`, not in the command

```json
{
  "images": {
    "theme": "default",
    "selector": "[data-og]",
    "template": "./og/card.html",
    "outDir": "src/public/og",
    "budgetKB": 120
  }
}
```

Committed, reproducible, reviewable. Flags only override for a one-off run.

### Expose intent, hide mechanism

The user has exactly one job: say *what* the card shows, *how* it is themed and *where* it goes.
Everything that makes the image small, deterministic and cacheable has a single correct answer, and
every app that hand-rolls it gets it wrong. The rule is: **no flag for a mechanism**.

**Configurable — brand, content, location**

| knob | default | why it is exposed |
|---|---|---|
| `theme` | the app's own default | brand decision; applied **through the app's theme manager**, not by poking attributes |
| `selector` | the viewport | what the card should actually show |
| `template` | built-in card | full control for an app that wants its own chrome |
| `outDir` | `src/public/og` | it must be the folder the deploy copies from |
| `routes` | indexable routes | which pages deserve a card |
| `viewport` | 1440×960 | the window the app is laid out for |
| `locale` | `lang` of `App/index.html` | dates and numbers inside the demo |
| `budgetKB` | 120 | a policy ceiling, not an algorithm |
| `runner` / `storageState` | none | how to reach a page behind auth |

**Hidden — mechanism, one correct answer**

| detail | what the command does |
|---|---|
| theme application | uses the app's own theme manager: `themeManager.defaultTheme` for the first load, `localStorage.sliceTheme` when `saveThemeLocally`, `prefers-color-scheme` when `useBrowserTheme`. `data-slice-theme` is *its* output, not an input |
| pixel density | capture at `deviceScaleFactor: 2`, always |
| edges | trim 1 CSS px per side (the clip rounds outward and grabs the neighbour's border) |
| readiness | `document.fonts.ready` + DOM-stability poll, never a fixed delay |
| motion and clock | `reducedMotion: 'reduce'`, `page.clock.setFixedTime` |
| format | PNG for flat UI, JPEG for photographic pages |
| weight | encoder quality + `budgetKB` enforcement |
| naming | content hash in the filename (platforms cache a preview per URL) |
| cleanup | orphans deleted; a failed route never leaves a half-written card |
| writes | atomic; `seo.json` patched without touching unrelated bytes |

`--runner` does **not** get to take over capture, composition or encoding: it prepares the page and
nothing else. That is what keeps every app's images as good as the best measurement we have.

#### The theme belongs to the app, not to a knob

We wrote the theme manager, so the command does not need a `themeAttribute` setting — it uses the
same door the app does:

- `themeManager.enabled: false` → there is no theme system; `theme` is ignored (with a warning) and
  only `colorScheme` is pinned, so an OS dark mode cannot surprise the capture.
- `theme: "default"` (or unset) → capture what a first-time visitor sees: `themeManager.defaultTheme`.
- `theme: "<Name>"` → applied through the app's own rules: `localStorage.sliceTheme` when
  `saveThemeLocally` is on, `prefers-color-scheme` when `useBrowserTheme` is on, `defaultTheme`
  otherwise. If the app's configuration cannot express the requested theme, the command **fails
  loudly** — it never silently captures the wrong one.
- The card's palette follows the resolved theme: the command reads `--primary-background-color` from
  the running page and uses the same luminance test the theme manager already uses for
  `color-scheme`. A custom theme (not just LIGHT/DARK) gets the right card without another setting.

### The runner: default first, escape hatch second

The user's instinct ("let them point at the Playwright runner") is right, but it should be the
**escape hatch**, not the entry point:

1. **Default**: the CLI detects `playwright` (or `@playwright/test`) in the project, boots the app on
   a free port (`slice dev`, or `--base-url` against a real build), pins the context and captures.
   If Playwright is missing it stops with the exact install line, never silently.
2. **`--runner ./og.mjs`** for the app that needs a session, seeded data or a specific boot. The
   contract is deliberately small — the CLI still owns navigation, determinism, composition and
   optimisation:

   ```js
   // og.mjs — the only part the app has to write
   export default {
     async prepare(page, route) {   // login, seed, dismiss banners; runs before the capture
       await page.evaluate(() => localStorage.setItem('theme', 'light'));
     },
     capture: '[data-og]'           // selector, or null for the viewport
   };
   ```

   `--storage-state ./auth.json` covers the common "logged-in" case without a runner at all.

### What the command has to get right (already learned the hard way)

- **Determinism**: `colorScheme: 'light'`, `reducedMotion: 'reduce'`, fixed `locale`/`timezoneId`,
  `page.clock.setFixedTime`, the app's theme attribute re-asserted, DOM-stability poll (not a fixed
  delay), `document.fonts.ready`.
- **The clip**: element screenshot at `deviceScaleFactor: 2`, then trim 1 CSS px per edge (the clip
  rounds outward and grabs the neighbour's border), then compose.
- **The card**: a neutral default (route title, section, brand mark, the capture in a frame) plus
  `template` for apps that want their own HTML. The capture is readable because the text is real
  text — a scaled-down page screenshot never is.
- **Format and weight**: PNG for flat UI, JPEG for photographic pages, budget from `budgetKB`
  (default 120), fail over it in `--check`.
- **Cache contract**: content hash in the filename (platforms cache a preview per URL), orphans
  deleted, failed routes leave the manifest untouched.
- **Only public routes by default**: `robots.index !== false`; capturing a private page per default
  would leak its UI into a preview.

### Where it runs

Never on request, and not inside `slice build` by default: the build must not require a browser for
apps whose images never change. `slice seo images` is a pre-deploy step; `--check` is the CI gate.

### Writing files: never overwrite silently

Both this command and `slice seo sitemap` write artifacts a human reviews and commits
(`public/sitemap.xml`, `public/robots.txt`, `public/og/*.png`, and the `image` fields inside
`seo.json`). The rule, shared by every `slice seo` command that writes:

- If a target file **exists and would change**, print what changes and ask for confirmation.
  The default answer is **no**.
- `--yes` (alias `--force`) skips the prompt — for scripts that already decided.
- **Non-interactive runs (no TTY, e.g. CI) never prompt.** They fail with a message naming `--yes`,
  so a pipeline cannot hang waiting for input.
- `--check` and `--dry-run` never write and never prompt.
- Files whose content is unchanged are not rewritten at all (no mtime churn, no diff noise).

## Alternatives considered

- **Bake it into `slice build`**: forces Chromium into every CI, and a build that fails because a
  font did not load is a bad trade.
- **`npx playwright screenshot`**: one line, but it cannot clip an element, compose a card, hash
  names, or update `seo.json` — it produces 70 illegible full-page PNGs.
- **Ship the card generator only (no capture)**: half the value; the hard part is the capture.
- **Require a runner script from day one**: maximum control, maximum friction; most apps are one
  `--base-url` away from working.

## Scope

### In scope

- `slice seo images` command: config from `seo.json`, route selection, boot or `--base-url`, runner
  contract, `--storage-state`, `--only`, `--concurrency`, `--check`, `--dry-run`.
- The default card template + a `template` hook.
- Writing `<outDir>/<slug>-<hash>.<ext>` and updating each route's `image`/`imageWidth`/`imageHeight`
  in `seo.json` (deterministic ordering, no unrelated churn).
- Determinism helpers shared with the CLI's own tooling.

### Out of scope

- The head/sitemap/404 runtime (framework feature 0002).
- Generating images for routes that do not exist in `seo.json`.
- Hosting/CDN upload (`outDir` is local; the deploy pipeline copies it).
- A visual editor for the card.

## Compatibility and risk

- Depends on framework feature 0002 (the `image` field and the route set). Shipping order matters:
  the command is useless until `seo.json` exists.
- Playwright is the heaviest devDependency an app can add; the command must be explicit about it and
  never install anything itself.
- Capturing a running app is inherently flaky; the runner contract is the escape hatch, and the
  command must fail loudly (route + reason), never write a half-broken card.
- Mutating `seo.json` is risky: write only the image fields, keep key order, and run the same
  validation `slice seo check` uses afterwards.

## Validation plan

- Unit tests: card composition (pure), filename hashing, budget check, `seo.json` patching keeps
  unrelated bytes untouched, route selection (indexable only, `--only`).
- Integration: a fixture app with two routes (one demo, one plain) → two images, stable across two
  runs (`--check` green), orphan removal on rename.
- Manual: run it against `slicejs-components` and diff against the images that are already committed
  there — the best possible oracle.

## Documentation impact

- Framework docs pages: `markdown/cli-commands.md` (new command) + the SEO page from feature 0002;
  `docs:generate` and `docs:llm`.
- Component docs: none.
- Skill / agent guidance: yes — "OG images are generated, never at request time" and the runner
  contract belong in the skill.
- Workspace docs: none.

## Open questions

- [x] Name: **`slice seo images`**, with `slice og` as an alias (grouped with `seo check`, but the
      shorter name is what people will type).
- [x] Capture source: **boot `slice dev`** on a free port (the capture reflects the app a user sees);
      `--base-url` for a production-accurate capture, `--production` to boot `start` after a build.
- [x] Card: **built-in neutral template**, `template` for full control. No app-specific chrome.
- [x] Output: **`src/public/og`** by default (the convention the build copies).
- [x] Write: **patch `seo.json` in place**, only the image fields, deterministic ordering, validated
      afterwards with the same validator as `seo check`.
- [x] Card palette: derived from the resolved theme's `--primary-background-color` luminance, so a
      custom theme works with no extra setting.

## Decision log

- 2026-10-27 - Created as `proposed`, after `slicejs-components` shipped a working version by hand
  (70 routes, 2.7 MB, content hashes, deterministic captures). Depends on the framework's native SEO
  module; not implemented yet.
- 2026-10-27 - Split the surface explicitly after review: intent is configurable (`theme`, `selector`,
  `template`, `outDir`, `routes`, `viewport`, `locale`, `budgetKB`, runner), mechanism is not
  (density, trim, readiness, clock, format, encoder, hash, cleanup, atomic writes). `--runner`
  prepares the page; it never takes over capture, composition or encoding.
- 2026-10-27 - Dropped `themeAttribute` after reading `ThemeManager.js`: we own the theme system, so
  there is no attribute to configure. Themes are CSS text injected into a `<style>` tag, the active
  name is exposed as `data-slice-theme` (output, not input), and the initial theme comes from
  `themeManager.defaultTheme` / `localStorage.sliceTheme` / `prefers-color-scheme`. `theme` is applied
  through those same doors, fails loudly when the app's config cannot express it, and the card
  palette is derived from `--primary-background-color` luminance (the test the theme manager already
  uses), so custom themes need no extra setting.
- 2026-10-27 - Promoted to planned: slice seo images (alias slice og), boots slice dev on a free port, built-in card plus 	emplate, src/public/og, patches seo.json in place.

- 2026-10-27 - The file-writing rule is implemented (`commands/seo/support.js#writeFileConfirmed`): unchanged → no write and no mtime churn, changed → confirm (default no), `--yes` to skip, non-TTY → fail with a message naming the flag. `slice seo sitemap` (`slice.js/features/0002`) is the first consumer; the images command inherits it.
- 2026-10-27 - Done, with two corrections to the plan. (1) It writes `<outDir>/manifest.json` instead of patching `seo.json`: that file is regenerated by the app pipeline, and the framework already merges `seo.images`, so the cards keep their own manifest. (2) It boots `api/index.js` in development on a free port by default (`--base-url` reuses a running server) instead of the CLI watcher: one child process, no orphan, same dev server. Cards: neutral built-in template (`template` gets `{{title}}`/`{{route}}`/`{{host}}`/`{{image}}`), theme resolved through the app theme manager (hard error when the config cannot express it, palette from `--primary-background-color` luminance), deterministic capture (fixed clock, reduced motion, locale/TZ, DOM stability, 2× plus a 1 px trim), PNG for element captures and JPEG for page slices, content hash in the name, orphan sweep and a KB budget. `--check` validates dimensional and weight without a browser. 7 tests, plus an end-to-end run on slicejs-components with `--dry-run --only` and `--out` into a temp directory.
