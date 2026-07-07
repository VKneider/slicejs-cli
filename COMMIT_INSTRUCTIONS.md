# Commit instructions

> Scratch note to hand off the commits across the repos touched. **Not meant to
> be committed** — the `git add` commands below list explicit paths, so it won't
> be swept in. Delete when done (`rm COMMIT_INSTRUCTIONS.md`).

Three repos were modified:

1. **`slicejs-cli`** — two features (transitive `get` deps + self-contained build).
2. **`slice.js`** (framework) — **canonical** Vercel 404-on-mount fix in the API
   server (`api/framework/server.js`, the code `slice init` wires into new
   projects via the thin `api/index.js`).
3. **`slice.js_visual_library`** — the same fix applied directly to that app's
   **own** monolithic `api/index.js` (it predates the `server.js` refactor, so it
   carries its own copy and must be patched independently).

They are independent; commit each in its own repo. The CLI build change is the
enabler (it emits `dist/Slice/Slice.js`); the two API fixes consume it.

---

## Repo 1 — `slicejs-cli`  (version 3.7.2 → 3.8.0)

Run from `/datadrive/vkneider/vk/slc/slicejs-cli`.

Files:

| File | Status | What |
| --- | --- | --- |
| `package.json` | modified | version 3.7.2 → 3.8.0 |
| `CHANGELOG.md` | modified | `[3.8.0]` — get deps + framework runtime |
| `client.js` | modified | `--no-deps` flag on both `get` commands |
| `commands/getComponent/getComponent.js` | modified | recursive dep resolution + helper download + dedupe |
| `commands/utils/analyzeSource.js` | **new** | Babel AST extractor (`slice.build` + relative imports) |
| `commands/buildProduction/buildProduction.js` | modified | copy framework runtime into `dist/Slice/Slice.js` |
| `tests/dependency-resolution.test.js` | **new** | 12 unit tests (analyzer + path resolution + classification) |
| `tests/getcomponent-deps.integration.test.js` | **new** | 5 integration tests (offline, mocked registry) |
| `tests/build-framework-runtime.test.js` | **new** | 2 tests (dist runtime emitted + graceful degradation) |

```bash
git switch -c feat/get-deps-and-selfcontained-build

# Commit A — transitive get dependencies
git add \
  client.js \
  commands/getComponent/getComponent.js \
  commands/utils/analyzeSource.js \
  tests/dependency-resolution.test.js \
  tests/getcomponent-deps.integration.test.js
git commit -m "feat(get): resolve transitive component + module dependencies

slice get now installs a component's full dependency tree (components via
slice.build('X') or relative entrypoint imports, plus relatively-imported
helper .js modules), recursively, deduped and cycle-safe. Adds --no-deps.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"

# Commit B — self-contained production build (framework runtime into dist)
git add \
  commands/buildProduction/buildProduction.js \
  tests/build-framework-runtime.test.js
git commit -m "feat(build): bundle framework runtime into dist/Slice/Slice.js

The app bootstraps with import Slice from '/Slice/Slice.js'. Emitting the
framework entry into dist makes the production build self-contained so
serverless deploys (Vercel includeFiles: dist/**) ship it, instead of a
runtime node_modules read that the file tracer prunes and pnpm hides behind
a symlink (fixes 404-on-mount on Vercel). Resolves from the project root;
warns and continues if the framework is unavailable.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"

# Commit C — version + changelog
git add package.json CHANGELOG.md
git commit -m "chore: release 3.8.0

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

Optional tag (last tag was `v3.7.2`): `git tag v3.8.0`

Verify before pushing:

```bash
node --test tests/getcomponent.test.js \
             tests/dependency-resolution.test.js \
             tests/getcomponent-deps.integration.test.js \
             tests/dependency-analyzer.test.js \
             tests/build-framework-runtime.test.js \
             tests/build-production-e2e.test.js \
             tests/build-command-integration.test.js
# expected: all pass
```

> The full suite has one **pre-existing, unrelated** failure —
> `tests/perf-budget.test.js` (framework *bundle* size, `dist/bundles/**`). It is
> not affected by these changes (the new dist/Slice/Slice.js is outside
> `dist/bundles`) and is not caused by this work.

---

## Repo 2 — `slice.js`  (framework — canonical fix)

Run from `/datadrive/vkneider/vk/slc/slice.js`.

| File | Status | What |
| --- | --- | --- |
| `api/framework/server.js` | modified | prod `/Slice/Slice.js` served from `dist` first, node_modules fallback |

```bash
git switch -c fix/vercel-framework-404

git add api/framework/server.js
git commit -m "fix(server): serve /Slice/Slice.js from dist in production

On Vercel the framework was read from node_modules at request time, but the
file tracer prunes it and pnpm hides it behind a symlink, so /Slice/Slice.js
404'd and the framework never mounted. Serve the self-contained copy that
slice build (>=3.8.0) emits into <dist>/Slice/Slice.js, falling back to
node_modules for non-serverless production (slice start). This is the server
that slice init wires into new projects.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Repo 3 — `slice.js_visual_library`

Run from `/datadrive/vkneider/vk/slc/slice.js_visual_library`.

This app owns a **monolithic** `api/index.js` (copied by `slice init` before the
`server.js` refactor), so it must be patched directly — it does not pick up the
Repo 2 fix.

| File | Status | What |
| --- | --- | --- |
| `api/index.js` | modified | prod `/Slice/Slice.js` served from `dist` first, node_modules fallback |

```bash
git switch -c fix/vercel-framework-404

git add api/index.js
git commit -m "fix(server): serve /Slice/Slice.js from dist in production

On Vercel the framework was read from node_modules at request time, but the
file tracer prunes it and pnpm hides it behind a symlink, so /Slice/Slice.js
404'd and the framework never mounted. Serve the self-contained copy that
slice build (>=3.8.0) emits into dist/Slice/Slice.js, falling back to
node_modules for non-serverless production (slice start).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> Both API fixes require `slicejs-cli >= 3.8.0` (Repo 1) so the build emits
> `dist/Slice/Slice.js`. `vercel.json` needs **no change** — `includeFiles:
> "dist/**"` already covers the emitted runtime.

## Push (when ready, each repo)

```bash
git push -u origin <branch>   # then open a PR into master
```
