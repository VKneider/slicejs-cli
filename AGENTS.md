# Slice.js CLI — Agent Context

## Project Structure

```
slicejs-cli/
├── client.js                          # CLI entry point (commander)
├── commands/
│   ├── init/init.js                   # slice init
│   ├── startServer/startServer.js     # slice dev / slice start
│   ├── build/build.js                 # slice build
│   ├── getComponent/getComponent.js   # slice get / browse / sync
│   ├── createComponent/               # slice component create
│   ├── listComponents/                # slice component list
│   ├── deleteComponent/                # slice component delete
│   ├── doctor/doctor.js               # slice doctor
│   ├── types/types.js                 # slice types generate
│   ├── bundle/bundle.js               # bundling logic
│   ├── utils/
│   │   ├── PathHelper.js              # Path resolution (critical)
│   │   ├── bundling/BundleGenerator.js
│   │   ├── updateManager.js
│   │   ├── VersionChecker.js
│   │   └── LocalCliDelegation.js
│   └── Print.js                       # Wrapper for console.log/error
├── tests/
│   ├── helpers/setup.js               # Shared test helper (createTestProject, withTestProject)
│   ├── fixtures/                      # Minimal fixture files for tests
│   ├── bundle-generator.test.js
│   ├── bundle-v2-register-output.test.js
│   ├── client-launcher-contract.test.js
│   ├── client-update-flow-contract.test.js
│   ├── component-registry-parse.test.js
│   ├── dependency-analyzer.test.js
│   ├── init-command-contract.test.js
│   ├── local-cli-delegation.test.js
│   ├── path-helper.test.js
│   ├── postinstall-command.test.js
│   ├── types-generator.test.js
│   └── update-manager-notifications.test.js
├── package.json                       # type: "module" — ES modules only
└── AGENTS.md                          # This file
```

## Testing System

### Runner
- Uses Node.js built-in test runner: `node --test`
- Run: `npm test`
- Watch mode: `node --test --watch`

### Shared Test Helper (`tests/helpers/setup.js`)
Three exported functions:

```js
import { createTestProject, cleanupTestProject, withTestProject } from './helpers/setup.js';
```

**`createTestProject(options)`** — Creates a temp directory with full Slice.js project scaffold.
- Copies real framework files from `../slice.js/` (sibling directory in monorepo)
- Falls back to `tests/fixtures/` minimal scaffold if framework not available
- Options:
  - `visualComponents: ['Button']` — creates stub component files + rewrites `components.js` to include only those
  - `frameworkDir` — custom framework source path
- Returns the temp directory path
- Temp dir path: `{os.tmpdir()}/slice-test-{PID}-{N}-{random}/`

**`cleanupTestProject(dir)`** — Removes the temp directory recursively.

**`withTestProject(fn, options)`** — Convenience wrapper that:
1. Calls `createTestProject(options)`
2. Saves and sets `process.env.INIT_CWD = dir`
3. Runs `fn(dir)`
4. Restores `process.env.INIT_CWD` to original value
5. Calls `cleanupTestProject(dir)` in `finally`

### Patterns

**For tests that need INIT_CWD pointing to the project:**
```js
test('my test', async () => {
  await withTestProject(async (tmpDir) => {
    // process.env.INIT_CWD is already set to tmpDir
    const result = someFunction(import.meta.url);
    assert.ok(result);
  });
});
```

**For tests that pass projectRoot explicitly:**
```js
test('my test', async () => {
  const tmpRoot = await createTestProject({ visualComponents: ['Button'] });
  try {
    const result = await someFunction({ projectRoot: tmpRoot });
    assert.equal(result, 1);
  } finally {
    await cleanupTestProject(tmpRoot);
  }
});
```

**For tests with shared project setup across a describe block:**
```js
let tmpRoot;
before(async () => {
  tmpRoot = await createTestProject();
  process.env.INIT_CWD = tmpRoot;
});
after(async () => {
  delete process.env.INIT_CWD;
  await cleanupTestProject(tmpRoot);
});
```

### Test types

1. **Contract tests** (`*-contract.test.js`) — Static analysis of `client.js` source code via `@babel/parser` + AST or regex. Verify command registration, option flags, and function calls. No runtime execution.
2. **Unit tests** — Test individual functions/modules in isolation. Use temp dirs for filesystem-dependent code.
3. **Snapshot/Integration tests** — Verify output files, generated declarations, bundle configs.

### Rules
- No external mocking libraries (sinon, jest, etc.). Use monkey-patching + try/finally restore.
- All temp dirs MUST be cleaned up in `finally` blocks.
- `process.env.INIT_CWD` must be saved before modification and restored in `finally`.
- Dynamic `import()` is used where module caching matters, but PathHelper reads env vars at call time so cached modules work correctly.

## PathHelper Rules (`commands/utils/PathHelper.js`)

### Project Root Resolution
`getProjectRoot(moduleUrl)` resolves in this order:
1. `process.env.INIT_CWD` — set by npm or by `withTestProject` during tests
2. `process.cwd()` — current working directory
3. `candidates(moduleUrl)` — heuristic: walk up `../../` and `../../../../` from module location, check for `src/` or `api/`

### Functions

| Function | Returns | Notes |
|---|---|---|
| `getProjectRoot(moduleUrl)` | Resolved project root path | |
| `getSrcPath(moduleUrl, ...seg)` | `<root>/src/[...seg]` | |
| `getApiPath(moduleUrl, ...seg)` | `<root>/api/[...seg]` | |
| `getDistPath(moduleUrl, ...seg)` | `<root>/dist/[...seg]` | |
| `getPath(moduleUrl, ...seg)` | `<root>/[...seg]` | General purpose |
| `getConfigPath(moduleUrl, root?)` | `src/sliceConfig.json` | Optional explicit root param |
| `getComponentsJsPath(moduleUrl, root?)` | `src/Components/components.js` | Optional explicit root param |
| `joinRoot(root, ...seg)` | `<root>/[...seg]` | No moduleUrl needed, pure path join |

### Critical Rules

1. **`import.meta.url` must be passed** as first argument to all PathHelper functions (except `joinRoot`).
2. **Explicit root parameter** (`getConfigPath`, `getComponentsJsPath`) is used by `types/types.js` when generating types for a non-cwd project. This keeps functions testable without global state.
3. **`INIT_CWD` is the primary mechanism** for project root resolution. It's set by npm lifecycle scripts and by `withTestProject`.
4. **`candidates()` fallback** only works when the CLI is installed inside a project that has `src/` or `api/`. This is intentionally limited.

## Code Quality Standards

### ES Modules Only
- `"type": "module"` in `package.json`
- Use `import`/`export` everywhere
- NO `require()`, NO `__dirname` at module scope (use `path.dirname(fileURLToPath(import.meta.url))` inline where needed)

### No eval()
- `eval()` has been fully replaced with `JSON.parse()` for reading `components.js` files
- Components are written via `JSON.stringify()`, so content is always valid JSON
- Use `JSON.parse()` or the AST-based `ComponentRegistry` for component registry parsing

### Error Messages
- Bare error messages (just the error message without context) must NOT be used
- Always wrap errors with context: `Print.error('Context:', error.message)`
- Use `Print.error()` / `Print.success()` / `Print.info()` / `Print.warning()` instead of raw `console.log`/`console.error`
- EXCEPTION: Formatted help/command listing output can use `console.log` directly (avoids `ℹ️ Info:` prefix pollution)

### Empty Catch Blocks
- Silent catches are acceptable ONLY for:
  - Non-critical operations (update checks, optional config reads)
  - Graceful degradation paths
- All silent catches MUST have a comment explaining why: `catch { /* intentional: non-critical */ }`

### Port Resolution (startServer)
Priority order:
1. `--port` CLI flag (if provided by user)
2. `config.server.port` from `sliceConfig.json`
3. Hardcoded `3000` fallback

Commander `.option()` defaults must NOT override config values. Pass `undefined` when flag is not provided:
```js
port: options.port ? parseInt(options.port) : undefined
```

### Dependency Injection for Testability
- Functions that need a project root accept it as a parameter (`projectRoot`, `root`)
- PathHelper functions that accept an explicit root param enable testing without INIT_CWD gymnastics
- Avoid reading `process.env.INIT_CWD` or `process.cwd()` directly inside business logic; use PathHelper

## CLI Architecture (client.js)

### Command Registration Pattern
```js
sliceClient
  .command("mycommand")
  .description("...")
  .option("-x, --flag <value>", "...")
  .action(async (options) => {
    // 1. Handle --yes / non-interactive flags before prompts
    // 2. Prompt for missing required values
    // 3. Delegate to command implementation
    await runWithVersionCheck(async () => {
      await myCommandImplementation(options);
    });
  });
```

### `runWithVersionCheck(commandFunction)`
- Wraps every command action
- Responsibilities:
  1. Fire-and-forget update notification (`notifyAvailableUpdates().catch(() => {})`)
  2. Execute the command
  3. Background version check (`checkForUpdates(false)` after 100ms delay)
- Does NOT block or prompt the user (pre-flight checks were removed)
- Errors are caught and logged via `Print.error()`

### Init Command (`slice init`)
- Default project name: `my-slice-app`
- `-y`/`--yes [name]` flag skips interactive prompts
- Creates project directory, `chdir`s into it, sets `INIT_CWD`
- Calls `initializeProject()` from `commands/init/init.js`
- Name normalization: trim → lowercase → spaces to hyphens → strip non-alphanumeric → collapse hyphens → trim hyphens

### Local CLI Delegation
- `maybeDelegateToLocalCli()` runs at module level before command parsing
- If a local `node_modules/slicejs-cli/` exists, spawns it instead of running the global CLI
- Controlled by `SLICE_NO_LOCAL_DELEGATION` env var

## Visual Component Registry
- Components downloaded from GitHub: `https://raw.githubusercontent.com/VKneider/slice.js_visual_library/master/src/Components/{category}/{Name}/{file}`
- Registry URL: same base + `src/Components/components.js`
- Starter visual components on init: Button, Link, Loading, MultiRoute, Navbar, NotFound, Route
- Components are registered by writing to `src/Components/components.js`

### File Download Rules (in `getAvailableComponents`)
- **Routing/navigation components** (`Route`, `MultiRoute`, `Link`): only `.js` file
- **Other Visual components** (Button, Loading, Navbar, etc.): `.js`, `.html`, `.css`
- **Service components** (FetchManager, etc.): only `.js` file
- File list is determined by hardcoded rules, NOT by checking the remote server
- If `.js` download fails → component install fails (fatal)
- If `.html`/`.css` fails → component install succeeds with warning

## Changelog & Versioning

Follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

### Changelog format
- Single `CHANGELOG.md` at project root
- `[Unreleased]` section at top for in-progress changes
- Categories: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`
- Entries describe user-facing impact, not internal implementation details
- Each version linkable to GitHub compare/release URL at bottom of file

### Release process
1. Bump version in `package.json` (semver: major.minor.patch)
2. Move `[Unreleased]` content into a new `[X.Y.Z] - YYYY-MM-DD` section below
3. Add compare link at bottom: `[X.Y.Z]: https://github.com/VKneider/slicejs-cli/releases/tag/vX.Y.Z`
4. Update `[Unreleased]` compare link: `[Unreleased]: https://github.com/VKneider/slicejs-cli/compare/vX.Y.Z...HEAD`
5. Commit: `git commit -m "chore: bump vX.Y.Z"`
6. Tag: `git tag vX.Y.Z`
7. Push: `git push && git push --tags`
8. GitHub Release: `gh release create vX.Y.Z --title "vX.Y.Z" --notes-file CHANGELOG.md`
