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

2. **Install dependencies**
   ```bash
   npm install
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

### Local (Recommended)

```bash
npm install slicejs-cli --save-dev
```

### Global (Not recommended)

```bash
npm install -g slicejs-cli
```

## Main commands

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
    "slice:dev": "slice dev",
    "slice:start": "slice start",
    "slice:create": "slice component create",
    "slice:list": "slice component list",
    "slice:delete": "slice component delete",
    "slice:init": "slice init",
    "slice:get": "slice get",
    "slice:browse": "slice browse",
    "slice:sync": "slice sync",
    "slice:version": "slice version",
    "slice:update": "slice update"
  }
}
```

If you installed with `--ignore-scripts`, run manually:

```bash
npx slicejs-cli postinstall
```

## Quick start

```bash
# 1. Create project
mkdir my-project && cd my-project
npm init -y

# 2. Install CLI
npm install slicejs-cli --save-dev

# 3. Initialize
npx slicejs-cli init

# 4. Development
npx slicejs-cli dev
```

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
