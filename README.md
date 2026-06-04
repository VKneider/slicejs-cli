<div align="center">
  <img src="./assets/Slice.js-logo.png" alt="Slice.js logo" width="150" />
  <h1>Slice.js CLI</h1>
  <p>Command-line client for building web applications with the Slice.js framework</p>
  <p>
    <a href="https://slice-js-docs.vercel.app/Documentation/CLI"><strong>Explore the docs »</strong></a>
    <br />
    <a href="https://www.npmjs.com/package/slicejs-cli"><img src="https://img.shields.io/npm/v/slicejs-cli.svg?label=CLI" alt="npm version" /></a>
    <img src="https://img.shields.io/badge/Node-%E2%89%A5%2020.0.0-339933?logo=node.js" alt="node requirement" />
    <a href="#license"><img src="https://img.shields.io/badge/License-ISC-blue.svg" alt="license" /></a>
  </p>
</div>

## About this repository

This repository contains the Slice.js CLI (`slicejs-cli`), the command-line tool for developing applications with the Slice.js framework. It includes a development server, build system, component management, and more.

## Prerequisites

- Node.js >= 20
- npm or pnpm

## Local development

1. **Clone the repository**
   ```bash
   git clone https://github.com/VKneider/slicejs-cli.git
   cd slicejs-cli
   ```

2. **Install dependencies** (the repo pins pnpm via the `packageManager` field)
   ```bash
   pnpm install --frozen-lockfile
   ```

3. **Test changes locally**
   ```bash
   node client.js --help
   ```

   To bypass delegation to a global installation:
   ```bash
   SLICE_NO_LOCAL_DELEGATION=1 node client.js --help
   ```

4. **Run tests**
   ```bash
   npm test
   ```

## Installation (for users)

For a **new project** you don't install anything manually — `slice init` (see Quick
start below) installs the CLI locally in the project it creates.

### Local in an existing project (Recommended)

```bash
npm install slicejs-cli --save-dev    # or: pnpm add -D slicejs-cli
```

### Global launcher (optional)

```bash
npm install -g slicejs-cli            # or: pnpm add -g slicejs-cli
```

The launcher delegates to the nearest project-local `node_modules/slicejs-cli`,
so each project keeps its pinned CLI version.

## Main commands

Inside initialized projects, prefer package scripts (`pnpm run ...`, `npm run ...`)
over direct binary calls.

Common script workflow:

```bash
pnpm run dev
pnpm run build
pnpm run start
pnpm run browse
pnpm run get -- Button
pnpm run sync
```

Alternative with local devDependency resolution:

```bash
pnpm exec slice dev
```

If `slicejs-cli` is installed globally, `slice` can be executed directly from PATH.

For pnpm v10+, if build scripts are restricted, configure `allowBuilds` in
`pnpm-workspace.yaml`:

```yaml
allowBuilds:
  slicejs-cli: true
```

`slice init --pm pnpm` now writes this automatically.

| Command | Description |
|---------|-------------|
| `slice init` | Initialize a Slice.js project |
| `slice dev` | Development server with hot reload |
| `slice build` | Build for production |
| `slice start` | Serve production build |
| `slice get <component>` | Install components from the official registry |
| `slice browse` | Browse available components |
| `slice component create` | Create a local component |
| `slice doctor` | Run project diagnostics |
| `slice postinstall` | Configure npm scripts (alternative to postinstall) |

## Postinstall Scripts

When you install `slicejs-cli`, the `postinstall` script automatically configures `slice:*` npm scripts in your `package.json`:

```json
{
  "scripts": {
    "slice:init": "node ./node_modules/slicejs-cli/client.js init",
    "slice:dev": "node ./node_modules/slicejs-cli/client.js dev",
    "slice:build": "node ./node_modules/slicejs-cli/client.js build",
    "slice:start": "node ./node_modules/slicejs-cli/client.js start",
    "slice:create": "node ./node_modules/slicejs-cli/client.js component create",
    "slice:list": "node ./node_modules/slicejs-cli/client.js component list",
    "slice:delete": "node ./node_modules/slicejs-cli/client.js component delete",
    "slice:get": "node ./node_modules/slicejs-cli/client.js get",
    "slice:browse": "node ./node_modules/slicejs-cli/client.js browse",
    "slice:sync": "node ./node_modules/slicejs-cli/client.js sync",
    "slice:doctor": "node ./node_modules/slicejs-cli/client.js doctor",
    "slice:version": "node ./node_modules/slicejs-cli/client.js version",
    "slice:help": "node ./node_modules/slicejs-cli/client.js --help",
    "slice:update": "node ./node_modules/slicejs-cli/client.js update",
    "slice:types": "node ./node_modules/slicejs-cli/client.js types generate"
  }
}
```

If you installed with `--ignore-scripts`, run manually:

```bash
npx slicejs-cli postinstall
```

## Quick start

`slice init` creates the project folder itself — no `mkdir` or `npm init` needed.
Everything (package.json, node_modules, lockfile, src/, api/) lives inside the new folder.

```bash
# With npm
npx slicejs-cli init
cd my-app
npm run dev
```

```bash
# With pnpm
pnpm dlx slicejs-cli init
cd my-app
pnpm run dev
```

Non-interactive (for scripts/CI):

```bash
npx slicejs-cli init -y my-app --pm pnpm
```

init pins the chosen package manager in the `packageManager` field, installs
`slicejs-web-framework` as a dependency and `slicejs-cli` as a devDependency of
the new project. Versions are never hard-pinned at install time, so hardened pnpm
setups (`minimumReleaseAge` quarantine, `ignore-scripts`) work out of the box.

## Tests

The CLI uses Node.js native test runner:

```bash
# All tests
node --test

# Specific tests
node --test tests/postinstall-command.test.js
```

## Project structure

```
slicejs-cli/
├── client.js              # CLI entry point
├── commands/              # Command implementations
│   ├── init/              # slice init
│   ├── build/             # slice build
│   ├── startServer/       # slice dev / slice start
│   ├── createComponent/   # slice component create
│   └── utils/             # PathHelper, VersionChecker, etc.
├── tests/                 # Tests
└── post.js                # Postinstall hook
```

## Local delegation

When the `slice` command is globally available, it automatically delegates to the project-local CLI (`node_modules/slicejs-cli`). To disable:

```bash
SLICE_NO_LOCAL_DELEGATION=1 slice version
```

## Contributing

We welcome contributions. Please review the guidelines in [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) before submitting changes.

## License

Distributed under the ISC License. See `LICENSE` for more information.

## Links

- 📘 Documentation: https://slice-js-docs.vercel.app/Documentation/CLI
- 🐙 GitHub: https://github.com/VKneider/slicejs-cli
- 📦 npm: https://www.npmjs.com/package/slicejs-cli
