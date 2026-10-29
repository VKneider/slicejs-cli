---
id: "0003"
title: "slice translator, and multilingual slice seo"
repo: "slicejs-cli"
status: done
area: cli
priority: medium
created: 2026-10-28
updated: 2026-10-28
target: "TBD"
owners: []
related:
  - "slice.js/features/0003-slice-translator-locales-in-templates-props-urls-and-seo.md (the contract this tooling checks)"
  - "slice.js/features/0002-native-seo-per-route-head-sitemap-and-real-404s.md"
  - "0001-slice-doctor-report-seo-configuration.md"
  - "0002-seo-image-capture.md"
  - "slicejs-components/features/0007-library-texts-through-slice-translator.md"
  - "commands/seo, commands/doctor"
---

# slice translator, and multilingual slice seo

## Summary

Tooling for `slice.translator` (framework feature 0003): `slice translator init` to set it up,
`slice translator check` to find what is missing, unused or broken across locales, and a
`Translator` row in `slice doctor`. The `slice seo` commands become locale-aware by consuming the
framework's multilingual SEO functions, so the sitemap, the checks and the social cards cover every
language without logic of their own.

## Problem / motivation

With keys in templates and the key shown when a translation is missing, a missing key is not a
crash: it is `pricing.seo.title` in a production `<title>`, or `orders.save` on a button. Nobody
notices until a user does. The failures are always the same and all of them can be found statically:

| # | Failure | Where it shows |
|---|---|---|
| 1 | A key used in a template or in code is missing in one locale | the key on screen in that language |
| 2 | A plural message without `other`, or a `{param}` present in one locale and not another | wrong or raw text for some values |
| 3 | A `{ t }` field in `seo.json` / route `metadata` missing in a locale | the key as the page title in search results |
| 4 | Keys nobody uses any more | dictionaries grow forever; translators work for nothing |
| 5 | With `routing` on, raw `href="/pricing"` in templates | links drop the locale and send people to the default language |
| 6 | Social cards rendered once, in one language | every locale shares an image with the wrong text |

## Proposed direction

### `slice translator init`

Sets the translator up in an existing project, idempotent and with `--dry-run`, like `slice setup lint`:

```bash
slice translator init --locales es,en --default es [--routing prefix-except-default]
```

- adds the `translator` block to `sliceConfig.json` (never overwrites an existing one);
- creates `src/locales/<locale>.json` for each locale (`{}`), never overwriting;
- prints the next steps (mark a template with `data-t`, run `slice translator check`).

### `slice translator check`

```bash
slice translator check [--locale en] [--json] [--strict]
```

Reads the dictionaries, then collects every **key in use**:

| Source | Found as |
| --- | --- |
| Component templates (`*.html`) | `data-t="key"` → `key` (text) and `key.<attribute>` for each translatable attribute present (the same rule the framework applies, imported from it) |
| Component and app code (`*.js`) | `slice.t('key')`, `slice.t('key')`, `slice.t.ref('key')` with a string literal |
| `seo.json` and `routes.js` `metadata` | `{ "t": "key" }` fields |
| `App/index.html` | `data-t` |

And reports, per locale:

| Finding | Level |
| --- | --- |
| Key in use, missing in the locale (and in the fallback) | error |
| Key in use, missing in the locale but present in the fallback | warning (shown in the fallback language) |
| Key in a dictionary, used nowhere | warning ("unused") |
| Plural object without `other`; plural category the locale does not have | error / warning |
| `{param}` sets that differ between locales for the same key | warning |
| A key that is a group (an object that is not a plural) used as a message | error |
| `slice.t(variable)` / `key(variable)` | info ("not checkable": dynamic keys) |
| With `routing` on: a raw `href="/…"` in a template | warning (use `slice.router.href()` or `Link`) |

Exit code 1 on errors (`--strict`: also on warnings), so it runs in CI. `--json` prints the findings
for editors and bots. The template rule (which attributes, how keys are derived) is imported from
the framework, like `slice seo check` imports `validateSeoManifest`, so the two cannot drift.

### `slice doctor`: a `Translator` row

Next to `SEO`, consuming the same checker:

- not configured → `skip` (the translator is optional);
- `translator` block invalid against `sliceConfig.schema.json`, a declared locale without its file,
  a dictionary that is not valid JSON → `fail`;
- missing keys → `warn` with the count and "run `slice translator check`";
- `routing` on and `seo.json` present, but no `{ t }` fields in it → `warn` ("search results will
  show one language for every locale").

### `slice seo` becomes locale-aware

No new logic in the CLI: the framework's `buildSitemap`, `resolveMetadata` and `validateSeoManifest`
learn locales (framework 0003 §9), and the commands pass them through.

| Command | Change |
| --- | --- |
| `slice seo sitemap` | One `<url>` per route and locale with `xhtml:link` alternates and `x-default` (from `buildSitemap`). Refuses to write when a `{ t }` key is missing in a locale, like it refuses a localhost origin. |
| `slice seo check` | Adds the multilingual validation: `{ t }` keys per locale, `routing` consistent with `sliceConfig.translator`. |
| `slice seo images` | Renders one card per route **and locale** (`/en/pricing` gets the English title), into `public/og/` with the locale in the hashed name; `manifest.json` is keyed by URL (`/en/pricing`). The template's `lang` and the fonts follow the locale. |

### `slice build`

The framework bundle always includes `Translator` (Slice.js creates it in every app; disabled, it
loads nothing). Done with the framework's phase 1–2 (`DependencyAnalyzer.getEnabledStructuralComponents`).

`src/locales/**` is copied to the build like other static assets, minified (`JSON.stringify` without
spaces). With `--check-translations`, the build runs `slice translator check` first and stops on
errors.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| An `extract` command that writes default-language texts from templates | The framework contract keeps only keys in templates; there is no text to extract. `check` reports what is missing instead. |
| Writing missing keys into the dictionaries automatically (`--fix`) | A key with an invented value hides the gap the key-on-screen rule exists to show. Possible later as `--add-missing` writing an explicit `TODO` marker that `check` still reports. |
| Parsing JS with regexes | Misses keys across lines and produces false positives in comments; use the AST parser the types generator already uses. |
| Per-locale `seo-<locale>.json` files | Duplicates every route entry per language; `{ t }` keys keep one manifest and reuse the dictionaries. |

## Scope

### In scope
- `slice translator init` and `slice translator check` (`--locale`, `--json`, `--strict`).
- `Translator` row in `slice doctor`.
- Locale-aware `seo sitemap`, `seo check`, `seo images`.
- `slice build` copying and minifying `src/locales`, optional `--check-translations`.

### Out of scope
- Machine translation of dictionaries.
- A translation editor or a sync with external translation platforms (Crowdin, Lokalise…): the JSON
  format is standard enough for their importers.
- Checking texts that come from the server.

## Compatibility and risk

- Additive commands; projects without `translator` see a `skip` row in doctor and nothing else.
- `seo images` with N locales renders N× cards and writes N× files: keep the content hash so an
  unchanged title does not re-render, and say how many cards will be written before writing.
- The framework range must include the translator-aware SEO functions; `release-check` already
  verifies the declared range.

## Validation plan

- Fixtures with two locales: missing keys (template text, attributes, slots, JS literal, `seo.json`
  `{ t }`), unused keys, plural without `other`, differing params, dynamic keys, raw hrefs with
  `routing` on. Snapshot the text and `--json` outputs; assert exit codes.
- `doctor` rows for: not configured, invalid block, missing file, invalid JSON, missing keys,
  routing without `{ t }` in SEO.
- `seo sitemap` against a two-locale manifest: alternates, `x-default`, refusal on a missing key.
- `seo images`: one card per route × locale, manifest keyed by URL, no re-render when unchanged.

## Documentation impact

- CLI reference: `translator init`, `translator check`, the doctor row, the new SEO behaviour.
- The framework's "Translating an app" guide links to `translator check` as the CI step.

## Open questions

1. `slice translator` or `slice t` as the command group (short like `slice.t()`)?
2. Should `check` treat "missing in the locale, present in the fallback" as a warning or an error
   by default? (Warning lets a site launch a second language progressively.)
3. Should `seo images` render per locale by default, or behind `--locales` (cards with only a
   translated title may not justify N× files for every project)?

## Decision log

- 2026-10-28 — The CLI imports the framework's rules (template keys, SEO validation, sitemap) instead
  of re-implementing them, as with `validateSeoManifest` in 0001.
- 2026-10-28 — No `extract`: templates carry keys only (framework 0003).
- 2026-10-28 — Implemented: `slice translator init` (config block + dictionaries, never overwrites),
  `slice translator check` (templates, `data-t-*`, `slice.t()`/`t.ref()`/`tr()` calls, missing keys per
  locale, plural `other`, param drift, raw hrefs), a **Translator** row in `doctor`, and locale-aware
  `seo sitemap`/`seo check`/`seo images` (one card per route and locale, keyed by the localized URL).
  The template rules come from the framework's `Translator/dom.js`; unused-key reporting is opt-in
  (`--unused`) because keys reached through app helpers are invisible to the scan.
