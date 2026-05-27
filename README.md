<div align="center">

# Slice.js CLI
<img src="./assets/Slice.js-logo.png" alt="Slice.js logo" width="200" />
<br/>

<div style="display: flex; justify-content: center; align-items: center; gap: 10px; align-content: center;">
<a href="https://www.npmjs.com/package/slicejs-cli"><img src="https://img.shields.io/npm/v/slicejs-cli.svg?label=CLI" alt="npm version" /></a>
<img src="https://img.shields.io/badge/Node-%E2%89%A5%2020.0.0-339933?logo=node.js" alt="node requirement" />
<a href="#license"><img src="https://img.shields.io/badge/License-ISC-blue.svg" alt="license" /></a>
</div>


<p>CLI for building web applications with the Slice.js framework</p>

</div>

## Installation

### Local (Recommended)

1. Install as a development dependency:

```bash
npm install slicejs-cli --save-dev
```

2. Add to your `package.json` scripts:

```json
{
  "scripts": {
    "dev": "slice dev",
    "build": "slice build",
    "slice": "slice"
  }
}
```

3. usage:

```bash
npm run dev
# or pass arguments
npm run slice -- get Button
```

4. Use `slice` directly when the launcher command is available on your system
   (commonly after a global install that puts `slice` in your PATH).
   The launcher delegates to your nearest project-local `node_modules/slicejs-cli`
   so project-pinned behavior is used from the project root and subdirectories.

```bash
slice dev
slice build
slice version
```

If `slice` is not available in your shell, use:

```bash
npx slicejs-cli dev
```

You can disable launcher delegation for a command when needed:

```bash
SLICE_NO_LOCAL_DELEGATION=1 slice version
```

### Postinstall Scripts

When you install `slicejs-cli`, the `postinstall` script automatically configures `slice:*` npm scripts in your project's `package.json`.

If you install with `--ignore-scripts` (e.g. `npm install slicejs-cli --save-dev --ignore-scripts`), the postinstall hook is skipped. Run the following command to configure the scripts manually:

```bash
npx slicejs-cli postinstall
```

Or if `slice` is available in your PATH:

```bash
slice postinstall
```

This adds the following npm scripts to your `package.json`:

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

Then run your project with:

```bash
npm run slice:dev
```

### Global (Not Recommended)

Global installations can lead to version mismatches and "works on my machine" issues.

```bash
npm install -g slicejs-cli
```

## Usage

After installation, prefer your project-local CLI. When the `slice` launcher command is
available, it automatically delegates to the nearest local `slicejs-cli` install.

Use the `slice` command directly:

```bash
slice [command] [options]
```

Or with npx (without global install):

```bash
npx slicejs-cli [command]
```

Use `npx slicejs-cli [command]` as a fallback when the `slice` launcher command is unavailable.

## Essential Commands

### Initialize a project

```bash
slice init
```

Initializes a Slice.js project with the full structure (`src/` and `api/`), installs initial Visual components, and configures npm scripts.

### Development server

```bash
# Default port (3000)
slice dev

# Custom port
slice dev -p 8080
```

### Production build + server

```bash
# Build production output (minified + obfuscated by default)
slice build

# Disable minification or obfuscation
slice build --no-minify
slice build --no-obfuscate

# Start production server (serves /dist)
slice start
slice start -p 8080
```

### Component management (local)

```bash
# Create a component (interactive)
slice component create

# List local components
slice component list

# Delete a component (interactive)
slice component delete
```

Shortcuts:
```bash
slice comp create
slice comp ls
slice comp remove
```

### Official component registry

```bash
# Install Visual components
slice get Button Card Input

# Install a Service component
slice get FetchManager --service

# Force overwrite
slice get Button --force

# Browse available components
slice browse

# Update all local components
slice sync
slice sync --force
```

Shortcuts:
```bash
slice get Button
slice browse
slice sync
```

### Utilities

```bash
# Version info
slice version
slice v

# Updates (CLI and Framework)
slice update              # Check and prompt to update
slice update --yes        # Update everything automatically
slice update --cli        # CLI only
slice update --framework  # Framework only

# Help
slice --help
slice [command] --help
```

## npm Scripts

`slice init` automatically configures the recommended scripts in your `package.json`:

```json
{
  "scripts": {
    "dev": "slice dev",
    "start": "slice start",
    "get": "slice get",
    "browse": "slice browse",
    "sync": "slice sync",
    "component:create": "slice component create",
    "component:list": "slice component list",
    "component:delete": "slice component delete"
  }
}
```

Usage:
```bash
npm run dev
npm run get
npm run browse
```

## Quick Start

```bash
# 1. Create a new project directory
mkdir my-slice-project
cd my-slice-project

# 2. Initialize npm and install Slice CLI
npm init -y
npm install slicejs-cli --save-dev

# 3. Initialize Slice.js project
slice init

# 4. Start development server
slice dev

# 5. Open browser at http://localhost:3000
```

## Common Workflows

### Starting a New Project

```bash
slice init
slice dev
```

### Production Build + Start

```bash
slice build
slice start
```

### Adding Components

```bash
# Browse available components
slice browse

# Install specific components
slice get Button Card Input

# Create custom component
slice component create
```

### Keeping Components Updated

```bash
# Check what needs updating
slice browse

# Update all components
slice sync
```

## Development Mode

The development server (`slice dev`) provides:

- ✅ Hot reload
- ✅ Serves directly from `/src`
- ✅ No build step
- ✅ Port validation
- ✅ Clear error messages

## Production Mode

The production workflow uses `slice build` + `slice start`:

- ✅ Builds to `/dist`
- ✅ Generates bundles into `/dist/bundles`
- ✅ Generates a dedicated framework bundle for Structural components (`slice-bundle.framework.js`)
- ✅ Minifies + obfuscates by default
- ✅ Serves production assets only

## Requirements

- Node.js >= 20.0.0
- npm or yarn

## Configuration

Project configuration is stored in `src/sliceConfig.json` and is created automatically by `slice init`.

In production, `publicFolders` defines **public asset folders** served by the server (defaults to
`/Themes`, `/Styles`, `/assets`). This keeps source-only folders private while exposing the assets
your app needs.

## Features

- 🚀 Development server with hot reload
- 📦 Official component registry
- 🎨 Visual and Service component types
- ✨ Interactive component creation
- 🔄 Automatic component synchronization
- 🛠️ Built-in validation and error handling

### Smart Updates

- Detects whether the CLI in use is global or local
- Shows an update plan (GLOBAL/PROJECT) before execution
- Offers to include global CLI update interactively
- Applies `uninstall` + `install @latest` to ensure latest versions

### Cross-platform Paths

- Centralized path helper avoids `../../..`
- Windows/Linux/Mac compatibility using `import.meta.url` and `fileURLToPath`

## Troubleshooting

### Port already in use

```bash
# Use a different port
slice dev -p 8080
```

### Project not initialized

```bash
# Make sure to run init first
slice init
```

### Command not found

```bash
# If the launcher command is unavailable, run the local CLI via npx
npx slicejs-cli dev

# Optional: install globally to expose the slice launcher command
npm install -g slicejs-cli
```

## Links

- 📘 CLI Documentation: https://slice-js-docs.vercel.app/Documentation/CLI
- 🐙 GitHub: https://github.com/VKneider/slice-cli
- 📦 npm: https://www.npmjs.com/package/slicejs-cli

## License

ISC

## Author

vkneider
