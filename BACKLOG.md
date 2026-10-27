# Backlog

Outstanding work on the CLI. For released changes see [`CHANGELOG.md`](./CHANGELOG.md).

As in the visual library's backlog, entries carry the date they were last verified against the code
and quote the claim that can be reproduced.

## types generate

- [ ] **`allowedValues` is only read when it is a literal array, so a shared constant loses its
  union.** *(verified 2026-10-18)* `astNodeToValue` (`commands/types/types.js:37`) understands
  literals, `ArrayExpression` and `ObjectExpression`, and returns `undefined` for anything else
  (`:65`). `typeFromProp` only builds a union when that array survived (`:457`), so an `Identifier`
  degrades the prop to plain `string` — with no error and no warning.

  Repro, today, with one component: a prop written inline and a prop sourced from an imported const
  produce different types. `Button` in `slicejs-components` is exactly that pair —
  `variant?: 'filled' | 'outlined' | 'ghost' | 'soft' | 'danger'` but `size?: string`, where
  `size` comes from `SIZE_VALUES`.

  Two tiers of fix, in increasing scope:

  1. **Same-file const.** While walking the component, collect top-level `const NAME = <literal>` /
     `<literal array>` declarations and resolve `Identifier` against that table. Small and
     self-contained; unblocks `Badge`, `Chip`, `Toast`, `Icon`, `ConfirmActionModal` in the library.
  2. **Imported const.** Resolve the relative specifier, parse that module and evaluate the
     initializer. This is the real feature and where the cost is: the vocabularies in this ecosystem
     are often *derived*, not literal — `export const SIZE_VALUES = Object.keys(SIZE_RECIPE)` — so it
     needs a bounded expression evaluator (`Object.keys` over a resolvable object, at least), not
     just a lookup, and every unsupported expression is another silent `string`. The path-resolution
     half already exists in 4.2.0 (`SourceDiagnostics.findUnresolvedRelativeImports`).

  Executing the component module instead of reading its AST is not the answer: components extend
  `HTMLElement` and touch `document`, which is why the generator is static-analysis-only.

  Until this lands, the library declares these lists inline in `static props` and has the setter read
  them back (see `slicejs-components/COMPONENT_API_STANDARDS.md` §10), which removes the module
  constant but not the duplication with the shared recipe.

## slice doctor

- [ ] **`slice doctor` drops the source-level results, so it reports PASS on a project `slice build`
  refuses to build.** *(verified 2026-10-18)* `validateComponentProps` returns five things
  (`commands/types/types.js:937`):

  ```js
  return { errors, warnings, sourceErrors, sourceWarnings, checkedCount };
  ```

  `slice build` takes all five (`commands/build/build.js:38`) and blocks on `sourceErrors` with a
  non-zero exit (`:42-51`). `slice doctor` takes three (`commands/doctor/doctor.js:335`):

  ```js
  const { errors, warnings, checkedCount } = await validateComponentProps({
    projectRoot: getProjectRoot(import.meta.url)
  });
  const issues = [...errors, ...warnings];   // sourceErrors / sourceWarnings never arrive
  ```

  With only source-level problems, `issues.length === 0`, so doctor takes the PASS branch
  (`:344-345`) and prints `${checkedCount} components checked, props look good` — the most misleading
  of its three outcomes, not even a warning.

  All four diagnostics added in 4.2.0 are affected, because they are the only things that push into
  those two arrays: `describeSyntaxError`, `hasDefaultExport` and `findUnresolvedRelativeImports` →
  `sourceErrors` (`types.js:869`, `:882`, `:894`); `findUnknownComponentBuilds` → `sourceWarnings`
  (`:907`). Every one of them covers the components no route reaches, which is the whole point of the
  4.2.0 change: the bundler never sees those files.

  Verified end to end, not by reading: on a project with one registered component lacking a default
  export, `validateComponentProps` returned `sourceErrors = ["NoDefault"]` (and `errors`/`warnings`
  empty), while `slice doctor` printed `Component Props ✅ PASS 0 components checked, props look
  good`, never mentioned `NoDefault` and exited 0.

  Introduced by `a8c2064` (v4.2.0 — "validate source and bundles, fail with non-zero exit"). That
  commit added the two channels, created `SourceDiagnostics.js`, wired `commands/build/build.js` and
  added three new test files — and does not touch `commands/doctor/doctor.js`, whose last change is
  `e874100` (v4.0.0). In 4.0.1 the function returned `{ errors, warnings, checkedCount }`, so doctor's
  destructuring was correct when written, and the comment above it (`:334`, "Same validation `slice
  build` runs, so doctor and build agree exactly") was true. It is now false, and the comment is what
  makes this a bug rather than a design choice.

  Nothing caught it because no test asserts that agreement: `tests/commands-doctor.test.js` contains
  no reference to `checkComponentProps` or `validateComponentProps`, and the tests added in `a8c2064`
  are all build-side.

  The fix has four parts, which is why it is not a one-liner:

  1. Destructure `sourceErrors`/`sourceWarnings` and merge them into `issues` with `severity: 'error'`
     and `'warning'` respectively. `sourceErrors` must not produce a PASS, since they block the build.
  2. `:349` counts only prop errors for the `would block "slice build"` note, so it under-reports —
     `sourceErrors` block too.
  3. `:354` renders `${i.component}.${i.prop}`, and source issues carry no `prop`, so they would show
     as `[error] NoDefault.undefined: ...`. Needs a branch for prop-less issues.
  4. A test in `tests/commands-doctor.test.js`: a project with a registered component that has no
     default export must not come back as PASS. That is the assertion whose absence let this through.

  Note `checkComponentProps` returns `{ warn: true }`, never `{ pass: false }` — doctor informs and
  `slice build` blocks, by design. The bug is narrower and sharper: today the row is green.

  Not affected in this workspace: the visual library resolves `node_modules/slicejs-cli` to 4.0.1,
  which has no source channels, so this only bites once that project upgrades to 4.2.0.

  Deferred by decision (2026-10-18): documented, not fixed. The `types generate` item above comes
  first.
