#!/usr/bin/env node
import { program } from "commander";
import inquirer from "inquirer";
import initializeProject from "./commands/init/init.js";
import createComponent from "./commands/createComponent/createComponent.js";
import listComponents from "./commands/listComponents/listComponents.js";
import deleteComponent from "./commands/deleteComponent/deleteComponent.js";
import getComponent, { listComponents as listRemoteComponents, syncComponents } from "./commands/getComponent/getComponent.js";
import startServer from "./commands/startServer/startServer.js";
import runDiagnostics from "./commands/doctor/doctor.js";
import versionChecker from "./commands/utils/VersionChecker.js";
import updateManager from "./commands/utils/updateManager.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getProjectRoot, getSrcPath, getPath } from "./commands/utils/PathHelper.js";
import { loadConfigSync as sharedLoadConfigSync } from "./commands/utils/loadConfig.js";
import { spawnSync } from "node:child_process";
import validations from "./commands/Validations.js";
import Print from "./commands/Print.js";
import build from './commands/build/build.js';
import { runGenerateTypes } from './commands/types/types.js';
import { cleanBundles, bundleInfo } from './commands/bundle/bundle.js';
import {
  isLocalDelegationDisabled,
  findNearestLocalCliEntry,
  resolveLocalCliCandidate,
  shouldDelegateToLocalCli
} from './commands/utils/LocalCliDelegation.js';
import {
  detectPackageManager,
  getAvailablePackageManagers,
  isPackageManagerAvailable,
  resolvePackageManager,
  runScriptCommand,
  SUPPORTED_PACKAGE_MANAGERS
} from './commands/utils/PackageManager.js';
import { SLICE_SCRIPTS } from './commands/utils/sliceScripts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const getCategories = () => {
  const config = sharedLoadConfigSync(import.meta.url);
  return config && config.paths?.components ? Object.keys(config.paths.components) : [];
};

// Function to run version check for all commands
async function runWithVersionCheck(commandFunction, ...args) {
  try {
    updateManager.notifyAvailableUpdates().catch(() => {});

    const result = await commandFunction(...args);

    setTimeout(() => {
      versionChecker.checkForUpdates(false);
    }, 100);

    return result;
  } catch (error) {
    Print.error(`Command execution: ${error.message}`);
    return false;
  }
}

function maybeDelegateToLocalCli() {
  if (isLocalDelegationDisabled(process.env)) {
    return;
  }

  const currentEntryPath = fileURLToPath(import.meta.url);
  const localEntryPath = findNearestLocalCliEntry(process.cwd(), resolveLocalCliCandidate);

  if (!shouldDelegateToLocalCli(currentEntryPath, localEntryPath)) {
    return;
  }

  const child = spawnSync(
    process.execPath,
    [localEntryPath, ...process.argv.slice(2)],
    {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: process.env
    }
  );

  process.exit(child.status ?? 1);
}

maybeDelegateToLocalCli();

const sliceClient = program;

try {
  const pkgPath = path.join(__dirname, "./package.json");
  const pkgRaw = fs.readFileSync(pkgPath, "utf-8");
  const pkg = JSON.parse(pkgRaw);
  sliceClient.version(pkg.version).description("CLI for managing Slice.js framework components");
} catch {
  sliceClient.version("0.0.0").description("CLI for managing Slice.js framework components");
}

// INIT COMMAND
sliceClient
  .command("init")
  .description("Initialize a new Slice.js project")
  .option("-y, --yes [name]", "Skip prompts and initialize with project name")
  .option("--pm <packageManager>", "Package manager to use (pnpm or npm). Auto-detected when omitted")
  .action(async (options) => {
    let projectName = 'my-slice-app';
    if (options.yes) {
      projectName = typeof options.yes === 'string' ? options.yes : projectName;
    } else {
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'projectName',
          message: 'What is the name of your project?',
          default: projectName,
          filter: (input) => input.trim()
            .toLowerCase()
            .replace(/\s+/g, '-')
            .replace(/[^a-z0-9-]/g, '')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, ''),
          validate: (input) => {
            if (!input || !input.trim()) return 'Project name cannot be empty';
            if (input.includes('/') || input.includes('\\')) return 'Use a simple name, not a path';
            return true;
          }
        }
      ]);
      projectName = answers.projectName;
    }

    // Resolve the package manager: --pm flag → detection → interactive prompt.
    // Detection here has no project root yet (the folder is new), so it relies on
    // npm_config_user_agent (npx / pnpm dlx / PM scripts) or a single available binary.
    let packageManager = options.pm;
    if (packageManager && !SUPPORTED_PACKAGE_MANAGERS.includes(packageManager)) {
      Print.error(`Unsupported package manager "${packageManager}". Use one of: ${SUPPORTED_PACKAGE_MANAGERS.join(', ')}`);
      return;
    }
    if (packageManager && !isPackageManagerAvailable(packageManager)) {
      Print.error(`Package manager "${packageManager}" is not available on this system`);
      return;
    }
    if (!packageManager) {
      const detected = detectPackageManager(null);
      if (detected) {
        packageManager = detected.name;
      } else if (!options.yes) {
        const available = getAvailablePackageManagers();
        if (available.length === 0) {
          Print.error('No package manager found (pnpm or npm). Install one and retry.');
          return;
        }
        const { pm } = await inquirer.prompt([
          {
            type: 'list',
            name: 'pm',
            message: 'Which package manager do you want to use?',
            choices: available,
            default: available.includes('pnpm') ? 'pnpm' : available[0]
          }
        ]);
        packageManager = pm;
      } else {
        const available = getAvailablePackageManagers();
        packageManager = available.includes('pnpm') ? 'pnpm' : available[0];
        if (!packageManager) {
          Print.error('No package manager found (pnpm or npm). Install one and retry.');
          return;
        }
      }
    }

    const projectDir = path.resolve(projectName);

    if (fs.existsSync(projectDir)) {
      const contents = fs.readdirSync(projectDir);
      if (contents.length > 0) {
        if (options.yes) {
          Print.error(`Directory "${projectName}" already exists and is not empty. Aborting.`);
          return;
        }
        const { overwrite } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'overwrite',
            message: `Directory "${projectName}" already exists and is not empty. Continue?`,
            default: false
          }
        ]);
        if (!overwrite) {
          Print.info('Initialization cancelled.');
          return;
        }
      }
    } else {
      fs.mkdirSync(projectDir, { recursive: true });
    }

    process.chdir(projectDir);
    process.env.INIT_CWD = projectDir;

    await runWithVersionCheck(async () => {
      await initializeProject({ packageManager });
    });
  });

// VERSION COMMAND
sliceClient
  .command("version")
  .alias("v")
  .description("Show version information and check for updates")
  .action(async () => {
    await versionChecker.showVersionInfo();
  });

// BUILD COMMAND
const buildCommand = sliceClient.command("build")
  .description("Build Slice.js project for production")
  .action(async (options) => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await runWithVersionCheck(async () => {
        await build(options);
      });
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });

buildCommand
  .command("clean")
  .description("Remove all generated bundles")
  .action(async () => {
    await cleanBundles();
  });

buildCommand
  .command("info")
  .description("Show information about generated bundles")
  .action(async () => {
    await bundleInfo();
  });

buildCommand
  .option("-a, --analyze", "Analyze project dependencies without bundling")
  .option("-v, --verbose", "Show detailed output")
  .option("--no-minify", "Disable minification (enabled by default)")
  .option("--no-obfuscate", "Disable obfuscation (enabled by default, no prop mangling)")
  .option("--preview", "Start preview server after build")
  .option("--serve", "Start preview server without building")
  .option("--skip-clean", "Skip cleaning dist before build");

// DEV COMMAND (DEVELOPMENT)
sliceClient
  .command("dev")
  .description("Start development server with hot reload enabled by default")
  .option("-p, --port <port>", "Port for development server")
  .option("--no-hmr", "Disable hot module reload (enabled by default)")
  .action(async (options) => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      await runWithVersionCheck(async () => {
        await startServer({
          mode: 'development',
          port: options.port ? parseInt(options.port) : undefined,
          watch: options.hmr
        });
      });
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });

// START COMMAND - PRODUCTION MODE
sliceClient
  .command("start")
  .description("Serve production files from dist/ (requires prior slice build)")
  .option("-p, --port <port>", "Port for server")
  .action(async (options) => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await runWithVersionCheck(async () => {
        await startServer({
          mode: 'production',
          port: options.port ? parseInt(options.port) : undefined
        });
      });
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });

// COMPONENT COMMAND GROUP - For local component management
const componentCommand = sliceClient.command("component").alias("comp").description("Manage local project components");

// CREATE LOCAL COMPONENT
componentCommand
  .command("create [name]")
  .alias("new")
  .description("Create a new component in your local project")
  .option("-c, --category <category>", "Component category (e.g. Visual, Service, AppComponents). Skips the prompt when provided.")
  .action(async (name, options) => {
    await runWithVersionCheck(async () => {
      const categories = getCategories();
      if (categories.length === 0) {
        Print.error("No categories found in your project configuration");
        Print.info("Run 'slice init' to initialize your project first");
        Print.commandExample("Initialize project", "slice init");
        return;
      }

      let componentName = name;
      let category = options.category;

      // Prompt only for the values not supplied on the command line. Passing both
      // a name and --category runs fully non-interactively (handy for scripts/agents).
      const prompts = [];
      if (!componentName) {
        prompts.push({
          type: "input",
          name: "componentName",
          message: "Enter the component name:",
          validate: (input) => {
            if (!input) return "Component name cannot be empty";
            if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(input)) {
              return "Component name must start with a letter and contain only alphanumeric characters";
            }
            return true;
          },
        });
      }
      if (!category) {
        prompts.push({
          type: "list",
          name: "category",
          message: "Select the component category:",
          choices: categories,
        });
      }

      if (prompts.length > 0) {
        const answers = await inquirer.prompt(prompts);
        componentName = componentName ?? answers.componentName;
        category = category ?? answers.category;
      }

      // createComponent validates the name and the category (and reports a clear
      // error listing valid categories if --category is wrong).
      const result = createComponent(componentName, category);
      if (result) {
        Print.success(`Component '${componentName}' created successfully in category '${category}'`);
        Print.info("Listing updated components:");
        listComponents();
      }
    });
  });

// LIST LOCAL COMPONENTS
componentCommand
  .command("list")
  .alias("ls")
  .description("List all components in your local project")
  .action(async () => {
    await runWithVersionCheck(() => {
      listComponents();
      return Promise.resolve();
    });
  });

// DELETE LOCAL COMPONENT
componentCommand
  .command("delete [name]")
  .alias("remove")
  .description("Delete a component from your local project")
  .option("-c, --category <category>", "Component category. Skips the category prompt when provided.")
  .option("-y, --yes", "Skip the confirmation prompt (for non-interactive use)")
  .action(async (name, options) => {
    await runWithVersionCheck(async () => {
      const categories = getCategories();
      if (categories.length === 0) {
        Print.error("No categories available. Check your configuration");
        Print.info("Run 'slice init' to initialize your project");
        return;
      }

      try {
        let category = options.category;
        let componentName = name;

        // Resolve category (prompt only if not provided)
        if (!category) {
          const categoryAnswer = await inquirer.prompt([
            {
              type: "list",
              name: "category",
              message: "Select the component category:",
              choices: categories,
            }
          ]);
          category = categoryAnswer.category;
        }

        const config = sharedLoadConfigSync(import.meta.url);
        if (!config) {
          Print.error("Could not load configuration");
          return;
        }

        if (!config.paths.components[category]) {
          Print.error(`Invalid category: '${category}'`);
          Print.info(`Available categories: ${categories.join(", ")}`);
          return;
        }

        const categoryPath = config.paths.components[category].path;
        const fullPath = getSrcPath(import.meta.url, categoryPath);

        if (!fs.existsSync(fullPath)) {
          Print.error(`Category path does not exist: ${categoryPath}`);
          return;
        }

        // Resolve component name (prompt with a list only if not provided)
        if (!componentName) {
          const components = fs.readdirSync(fullPath).filter(item => {
            const itemPath = path.join(fullPath, item);
            return fs.statSync(itemPath).isDirectory();
          });

          if (components.length === 0) {
            Print.info(`No components found in category '${category}'`);
            return;
          }

          const componentAnswer = await inquirer.prompt([
            {
              type: "list",
              name: "componentName",
              message: "Select the component to delete:",
              choices: components,
            }
          ]);
          componentName = componentAnswer.componentName;
        }

        // Confirm unless --yes was passed (passing name + --category + --yes is fully non-interactive)
        if (!options.yes) {
          const { confirm } = await inquirer.prompt([
            {
              type: "confirm",
              name: "confirm",
              message: `Are you sure you want to delete '${componentName}' from '${category}'?`,
              default: false,
            }
          ]);
          if (!confirm) {
            Print.info("Delete operation cancelled");
            return;
          }
        }

        // deleteComponent validates the name/category and that the component exists.
        if (deleteComponent(componentName, category)) {
          Print.success(`Component ${componentName} deleted successfully`);
          Print.info("Listing updated components:");
          listComponents();
        }
      } catch (error) {
        Print.error(`Deleting component: ${error.message}`);
      }
    });
  });

// REGISTRY COMMAND GROUP - For component registry operations
const registryCommand = sliceClient.command("registry").alias("reg").description("Manage components from official Slice.js repository");

// TYPES COMMAND GROUP - TypeScript declarations from static props
const typesCommand = sliceClient.command("types").description("Generate TypeScript declarations from component static props");

typesCommand
  .command("generate")
  .description("Generate src/slice-build.generated.d.ts for slice.build autocomplete")
  .option("-o, --output <path>", "Custom output path", "src/slice-build.generated.d.ts")
  .action(async (options) => {
    await runWithVersionCheck(async () => {
      const projectRoot = getProjectRoot(import.meta.url);
      const outputPath = path.isAbsolute(options.output)
        ? options.output
        : path.join(projectRoot, options.output);

      await runGenerateTypes({
        projectRoot,
        outputPath
      });
    });
  });

// GET COMPONENTS FROM REGISTRY
registryCommand
  .command("get [components...]")
  .description("Download and install components from official repository")
  .option("-f, --force", "Force overwrite existing components")
  .option("-s, --service", "Install Service components instead of Visual")
  .action(async (components, options) => {
    await runWithVersionCheck(async () => {
      await getComponent(components, {
        force: options.force,
        service: options.service
      });
    });
  });

// LIST REGISTRY COMPONENTS
registryCommand
  .command("list")
  .alias("ls")
  .description("List all available components in the official repository")
  .action(async () => {
    await runWithVersionCheck(async () => {
      await listRemoteComponents();
    });
  });

// SYNC COMPONENTS FROM REGISTRY
registryCommand
  .command("sync")
  .description("Update all local components to latest versions from repository")
  .option("-f, --force", "Force update without confirmation")
  .action(async (options) => {
    await runWithVersionCheck(async () => {
      await syncComponents({
        force: options.force
      });
    });
  });

// SHORTCUTS - Top-level convenient commands
sliceClient
  .command("get [components...]")
  .description("Quick install components from registry")
  .option("-f, --force", "Force overwrite existing components")
  .option("-s, --service", "Install Service components instead of Visual")
  .action(async (components, options) => {
    await runWithVersionCheck(async () => {
      if (!components || components.length === 0) {
        Print.info("Use 'slice registry list' to see available components");
        Print.commandExample("Get multiple components", "slice get Button Card Input");
        Print.commandExample("Get service component", "slice get FetchManager --service");
        Print.commandExample("Browse components", "slice browse");
        return;
      }

      await getComponent(components, {
        force: options.force,
        service: options.service
      });
    });
  });

sliceClient
  .command("browse")
  .description("Quick browse available components")
  .action(async () => {
    await runWithVersionCheck(async () => {
      await listRemoteComponents();
    });
  });

sliceClient
  .command("sync")
  .description("Quick sync local components to latest versions")
  .option("-f, --force", "Force update without confirmation")
  .action(async (options) => {
    await runWithVersionCheck(async () => {
      await syncComponents({
        force: options.force
      });
    });
  });

// LIST COMMAND - Quick shortcut for listing local components
sliceClient
  .command("list")
  .description("Quick list all local components (alias for component list)")
  .action(async () => {
    await runWithVersionCheck(() => {
      listComponents();
      return Promise.resolve();
    });
  });

// UPDATE COMMAND
sliceClient
  .command("update")
  .alias("upgrade")
  .description("Update CLI and framework to latest versions")
  .option("-y, --yes", "Skip confirmation and update all packages automatically")
  .option("--cli", "Update only the Slice.js CLI")
  .option("-f, --framework", "Update only the Slice.js Framework")
  .option("--update-api", "Also overwrite api/index.js with the framework version (never done by default; creates a .bak backup)")
  .action(async (options) => {
    await updateManager.checkAndPromptUpdates(options);
  });

// DOCTOR COMMAND - Diagnose project issues
sliceClient
  .command("doctor")
  .alias("diagnose")
  .description("Run diagnostics to check project health")
  .action(async () => {
    await runWithVersionCheck(async () => {
      await runDiagnostics();
    });
  });

// POSTINSTALL COMMAND - Manual alternative to postinstall
sliceClient
  .command("postinstall")
  .description("Configure npm scripts in package.json (alternative to postinstall for --ignore-scripts users)")
  .action(() => {
    // npm sets npm_config_global; pnpm global installs are detected via PNPM_HOME.
    const pnpmHome = process.env.PNPM_HOME;
    const cliEntryPath = fileURLToPath(import.meta.url);
    const isGlobal = process.env.npm_config_global === 'true'
      || (pnpmHome && cliEntryPath.startsWith(pnpmHome));
    if (isGlobal) {
      console.log('⚠️  Global installation of slicejs-cli detected.');
      console.log('   We strongly recommend using a local installation to avoid version mismatches.');
      console.log(`   Uninstall global: ${pnpmHome ? 'pnpm remove -g slicejs-cli' : 'npm uninstall -g slicejs-cli'}`);
      return;
    }

    const projectRoot = getProjectRoot(import.meta.url);
    const pkgPath = path.join(projectRoot, 'package.json');
    const packageManager = resolvePackageManager(projectRoot).name;

    // Shared with post.js and slice init — see commands/utils/sliceScripts.js
    const sliceScripts = SLICE_SCRIPTS;

    try {
      let pkg = {};
      if (fs.existsSync(pkgPath)) {
        pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      } else {
        pkg = {
          name: path.basename(projectRoot),
          version: '1.0.0',
          description: 'Slice.js project',
          scripts: {}
        };
      }

      pkg.scripts = pkg.scripts || {};
      let addedCount = 0;
      for (const [script, command] of Object.entries(sliceScripts)) {
        if (!pkg.scripts[script]) {
          pkg.scripts[script] = command;
          addedCount++;
        }
      }

      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf-8');
      console.log(`✅  slicejs-cli installed successfully. Added ${addedCount} package scripts to package.json.`);
      console.log(`   Run: ${runScriptCommand(packageManager, 'slice:dev')}`);
    } catch (err) {
      console.log('✅  slicejs-cli installed successfully.');
      console.log('   Could not auto-configure scripts:', err.message);
      console.log(`   Configure scripts manually and run: ${runScriptCommand(packageManager, 'slice:dev')}`);
    }
  });

// Enhanced help
sliceClient
  .option("--no-version-check", "Skip version check for this command")
  .configureHelp({
    sortSubcommands: true,
    subcommandTerm: (cmd) => cmd.name() + ' ' + cmd.usage()
  });


// Custom help - SIMPLIFIED for development only
sliceClient.addHelpText('after', `
Common Usage Examples:
  slice init                     - Initialize new Slice.js project
  slice dev                      - Start development server
  slice build                    - Build production output (bundles + dist)
  slice start                    - Start production server
  slice get Button Card Input    - Install Visual components from registry
  slice get FetchManager -s      - Install Service component from registry
  slice browse                   - Browse all available components
  slice sync                     - Update local components to latest versions
  slice component create         - Create new local component
  slice list                     - List all local components
  slice doctor                   - Run project diagnostics
  slice types generate           - Generate TypeScript typings for slice.build
  slice postinstall              - Show post-install setup guide

Command Categories:
  • init, dev, start             - Project lifecycle (development only)
  • get, browse, sync, list      - Quick shortcuts  
  • component <cmd>              - Local component management
  • registry <cmd>               - Official repository operations
  • types generate               - Type declarations from static props
  • version, update, doctor, setup - Maintenance commands

Development Workflow:
  • slice init          - Initialize project
  • slice dev           - Start development server (serves from /src)
  • slice build         - Build production output to /dist (includes bundles)
  • slice start         - Serve production build from /dist

More info: https://slice-js-docs.vercel.app/
`);

// Default action with better messaging
if (!process.argv.slice(2).length) {
  Print.newLine();
  Print.info("Start with: slice init");
  Print.commandExample("Development", "slice dev");
  Print.commandExample("View available components", "slice browse");
  Print.info("Use 'slice --help' for full help");
}

// Error handling for unknown commands
program.on('command:*', () => {
  Print.error('Invalid command. See available commands above');
  Print.info("Use 'slice --help' for help");
  process.exit(1);
});

// HELP Command
const helpCommand = sliceClient.command("help").description("Display help information for Slice.js CLI").action(() => {
  sliceClient.outputHelp();
});

program.parse();
