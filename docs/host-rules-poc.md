# Host rules PoC — local emulators

Date: 2026-11-16
Scope: verify every generated host preset against the current provider docs
and against the provider's local server/emulator.

Fixture: Portfolio production build (`repos/portfolio/dist`), exported with
`slice export --from-dist`. It has SEO enabled, two locales
(`en`, `es`, `localePrefix: "except-default"`), 30 prerendered routes, bundles
and public assets.

| Tool | Version |
|---|---|
| `wrangler pages dev` | 4.162.0 |
| `netlify-cli dev --dir` | 27.19.0 |
| `vercel dev --local` | 65.16.0 |
| nginx (Windows) | 1.30.6 |

Each host was exported twice:

```bash
slice export --from-dist --host <host> --out dist-poc-<host>
slice export --from-dist --host <host> --spa --out dist-poc-<host>-spa
```

Test URLs:

| URL | Expected |
|---|---|
| `/` | prerendered home, `200 text/html` |
| `/experience` | prerendered route |
| `/bundles/slice-bundle.critical.js` | bundle, `200 application/javascript` |
| `/Themes/Light.css` | public asset, `200 text/css` |
| `/nope` | real `404.html` (no `--spa`) or shell `200` (`--spa`) |
| `/en/experience` | locale redirect `301` to `/experience` |

---

## Results

### Cloudflare Pages

Command:

```bash
npx wrangler pages dev dist-poc-cloudflare --port 8901 --ip 127.0.0.1
npx wrangler pages dev dist-poc-cloudflare-spa --port 8902 --ip 127.0.0.1
```

Wrangler reported:

```text
Parsed 9 valid redirect rules.
Parsed 4 valid header rules.
```

| URL | Real 404 | `--spa` |
|---|---|---|
| `/` | 200 html | 200 html |
| `/experience` | 308 → `/experience/` | 308 → `/experience/` |
| `/bundles/...critical.js` | 200 JS | 200 JS |
| `/Themes/Light.css` | 200 CSS | 200 CSS |
| `/nope` | **404 html** | **200 html** |
| `/en/experience` | 301 → `/experience` | 301 → `/experience` |

Headers on the real export:

```text
/                               x-frame-options: DENY
                                x-content-type-options: nosniff
                                referrer-policy: strict-origin-when-cross-origin
/bundles/*.js                   cache-control: no-store
/slice-env.json                 cache-control: no-store
/slice-env.generated.js         cache-control: no-store
```

`/experience` → `/experience/` is Cloudflare Pages' own canonicalization: a
directory with `index.html` is served through its trailing-slash URL. The
router normalizes the trailing slash. It is not a rule the exporter can remove
without changing the file layout for every host.

**Issue found:** the previous `--spa` output wrote
`_redirects: /* /index.html 200`. Wrangler rejects it:

```text
Infinite loop detected in this rule and has been ignored. This will cause a
redirect to strip `.html` or `/index` and end up triggering this rule again.
```

`/* / 200` is accepted but wrong: `/bundles/app.js` returned the shell. The fix
is to omit `404.html` for Cloudflare `--spa`, which enables Pages' automatic SPA
mode. Verified: without `404.html`, `/nope` → 200 shell and assets still serve
normally.

### Netlify

Command:

```bash
npx netlify-cli dev --dir dist-poc-netlify --port 8910 --offline --no-open
npx netlify-cli dev --dir dist-poc-netlify-spa --port 8911 --offline --no-open
```

`netlify serve --dir ...` failed on this CLI version with
`TypeError: The "paths[0]" argument must be of type string`; `netlify dev --dir`
worked.

| URL | Real 404 | `--spa` |
|---|---|---|
| `/` | 200 html | 200 html |
| `/experience` | 200 html | 200 html |
| `/bundles/...critical.js` | 200 JS | 200 JS |
| `/Themes/Light.css` | 200 CSS | 200 CSS |
| `/nope` | **404 html** | **200 html** |
| `/en/experience` | 301 → `/experience` | 301 → `/experience` |

Security headers were applied. Caveat: `netlify dev` replaced the generated
`Cache-Control: no-store` for `/bundles/*` and the env files with its own
`cache-control: public, max-age=0`, even though a custom `X-Test-Bundle` header
on the same rule was applied. This is a local dev-server behavior; Netlify's
docs document `Cache-Control` in `_headers`, so verify it in a deploy preview.

### Vercel

Command:

```bash
npx vercel dev dist-poc-vercel --local --listen 127.0.0.1:8920 --yes
npx vercel dev dist-poc-vercel-spa --local --listen 127.0.0.1:8921 --yes
```

| URL | Real 404 | `--spa` |
|---|---|---|
| `/` | 200 html | 200 html |
| `/experience` | 200 html | 200 html |
| `/bundles/...critical.js` | 200 JS | 200 JS |
| `/Themes/Light.css` | 200 CSS | 200 CSS |
| `/nope` | **404 html** | **200 html** |
| `/en/experience` | **301** → `/experience` | **301** → `/experience` |

The `/(.*)` rewrite does not shadow assets: Vercel checks the filesystem before
applying rewrites. Verified with the real bundle and CSS.

**Issue found:** the previous export used `permanent: true|false`, which Vercel
maps to **308/307**, not 301/302. The export now writes `statusCode: 301|302`.
Verified: `/en/experience` returns **301**, not 308.

**Issue found:** Vercel and nginx did not replicate the three security headers
that Cloudflare/Netlify got. Both presets now write them.

Caveat: `vercel dev --local` also replaces `Cache-Control` with
`public, max-age=0, must-revalidate`; the custom header was accepted but
overridden by the local static server. Vercel's docs document `Cache-Control`
in `vercel.json` headers, so verify it in a deployment/preview.

### nginx

Downloaded `nginx/Windows-1.30.6` and generated a full config from the export's
`nginx.conf`:

```bash
nginx -t -p <prefix> -c conf/nginx-poc.conf
nginx -p <prefix> -c conf/nginx-poc.conf -g "daemon off;"
```

| URL | Real 404 | `--spa` |
|---|---|---|
| `/` | 200 html | 200 html |
| `/experience` | 301 → `/experience/` | 301 → `/experience/` |
| `/bundles/...critical.js` | 200 JS | 200 JS |
| `/Themes/Light.css` | 200 CSS | 200 CSS |
| `/nope` | **404 html** | **200 html** |
| `/en/experience` | 301 → `/experience` | 301 → `/experience` |

Headers on the real export:

```text
/                          X-Content-Type-Options: nosniff
                           X-Frame-Options: DENY
                           Referrer-Policy: strict-origin-when-cross-origin
/bundles/*                 the three security headers + Cache-Control: no-store
/slice-env.json            the three security headers + Cache-Control: no-store
/404.html (via /nope)      the three security headers
```

`nginx -t` accepted the generated snippet wrapped in a server block. The
`root /var/www/dist-static;` line is a placeholder and must be replaced with the
real deployment path.

### GitHub Pages

No official local emulator. Validated by docs and layout:

- `404.html` is served by GitHub Pages for missing paths, with a `404` status.
- `.nojekyll` is still the mechanism that disables Jekyll's `_`/`.` filtering.
- There are no server-side redirects or custom headers.
- `--spa` writes the shell as `404.html`; unknown routes render the app with a
  `404` status. A `200` fallback is not possible on Pages.

### S3 / CloudFront

No emulator (no Docker/LocalStack in this environment). The export writes no
host files. The documented setup remains:

- `index.html` as the default root document,
- `404.html` as the error document,
- `--spa` writes the shell as `404.html` (status 404),
- a CloudFront function is required for a true `200` navigation fallback;
  `CustomErrorResponses` alone keeps the 404 status.

### Build parity smoke (Playwright)

Exported `slicejs-components` and loaded `/docs` from a static server:

- before the fix: `404 /slice-events.generated.js`;
- after adding the event catalog, the ComponentsPage docs modules and the PWA
  rules: **no failed requests**, `/docs` and `/docs/input/button` render.

Exported Portfolio and loaded `/`, `/experience` and `/projects`:

- no missing bundles or theme assets;
- `/api/themes` is a real Express route, so a pure static host cannot serve it;
- two project images are not present in `src/public` (app data, not exporter).

---

## Findings and fixes

| Finding | Status |
|---|---|
| Cloudflare `/* /index.html 200` is an infinite loop; `/* / 200` hijacks assets | Fixed: Cloudflare `--spa` omits `404.html` and uses auto-SPA |
| Vercel `permanent` produced 308/307 instead of 301/302 | Fixed: `statusCode` |
| Vercel/nginx missing the security headers | Fixed: `/*` headers in `vercel.json`; `add_header ... always` in nginx locations |
| `netlify serve --dir` crashes (`paths[0]` undefined) | Tooling bug; use `netlify dev --dir` |
| Netlify/Vercel dev override `Cache-Control` on static files | Local-server behavior; verify in a deploy preview |
| Cloudflare canonicalizes `/route` → `/route/` | Host behavior; router normalizes the slash |
| GitHub Pages / S3 not emulated locally | Docs + layout validated; no Docker available |
| `/slice-events.generated.js` 404 in the Components export | Fixed: the runtime event catalog is now exported and served by Express |
| PWA files in `public/` were skipped | Fixed: `manifest.json`/`service-worker.js` keep Express's public-first precedence |
| Custom `translator.path` was skipped | Fixed: the export copies the configured folder |
| ComponentsPage docs modules were pruned with Components | Fixed: the two files Express special-cases are copied to `bundles/` |
| Custom host rules in `public/` were overwritten | Fixed: the export fails instead of losing them |
| Portfolio `/api/themes` 404 | App-level: a static host has no Express routes; use `slice start` or a static fallback |

## Conclusion

The presets now behave as documented on the emulators:

- real 404 exports return `404.html` with status 404,
- `--spa` exports return the shell for unknown routes,
- assets are never shadowed by the fallback,
- locale redirects keep their 301/302 status,
- security headers are present on every host.

The only unverified part in the local emulators is `Cache-Control` on Netlify
and Vercel, because their dev servers override it; the generated files use the
documented syntax and should be checked in a deploy preview.
