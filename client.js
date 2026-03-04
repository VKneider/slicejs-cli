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
import { getConfigPath, getProjectRoot } from "./commands/utils/PathHelper.js";
import { exec } from "child_process";
import { promisify } from "util";
import validations from "./commands/Validations.js";
import Print from "./commands/Print.js";
import build from './commands/build/build.js';
import { cleanBundles, bundleInfo } from './commands/bundle/bundle.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const loadConfig = () => {
  try {
    const configPath = getConfigPath(import.meta.url);
    const rawData = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(rawData);
  } catch {
    return null;
  }
};

const getCategories = () => {
  const config = loadConfig();
  return config && config.paths?.components ? Object.keys(config.paths.components) : [];
};

// Function to run version check for all commands
async function runWithVersionCheck(commandFunction, ...args) {
  try {
    const execAsync = promisify(exec);
    await (async () => {
      try {
        const info = await updateManager.detectCliInstall();
        if (info && info.type === 'global') {
          const projectRoot = getProjectRoot(import.meta.url);
          const pkgPath = path.join(projectRoot, 'package.json');
          let hasPkg = fs.existsSync(pkgPath);
          if (!hasPkg) {
            const { confirmInit } = await inquirer.prompt([
              {
                type: 'confirm',
                name: 'confirmInit',
                message: 'No package.json found. Initialize npm in this project now?',
                default: true
              }
            ]);
            if (confirmInit) {
              await execAsync('npm init -y', { cwd: projectRoot });
              hasPkg = true;
            }
          }
          if (hasPkg) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
            const hasFramework = pkg.dependencies?.['slicejs-web-framework'];
            if (!hasFramework) {
              const { confirm } = await inquirer.prompt([
                {
                  type: 'confirm',
                  name: 'confirm',
                  message: 'slicejs-web-framework is not installed in this project. Install it now?',
                  default: true
                }
              ]);
              if (confirm) {
                await updateManager.updatePackage('slicejs-web-framework');
              }
            }
          }
        }
      } catch {}
    })();

    const updateInfo = await updateManager.checkForUpdates();
    if (updateInfo && updateInfo.hasUpdates) {
      await updateManager.checkAndPromptUpdates({});
    }

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
  .action(async () => {
    await runWithVersionCheck(() => {
      initializeProject();
      return Promise.resolve();
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
    await runWithVersionCheck(async () => {
      await build(options);
    });
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
  .description("Start development server")
  .option("-p, --port <port>", "Port for development server", 3000)
  .option("-w, --watch", "Enable watch mode for file changes")
  .action(async (options) => {
    await runWithVersionCheck(async () => {
      await startServer({
        mode: 'development',
        port: parseInt(options.port),
        watch: options.watch,
        bundled: false
      });
    });
  });

// START COMMAND - PRODUCTION MODE
sliceClient
  .command("start")
  .description("Start production server")
  .option("-p, --port <port>", "Port for server", 3000)
  .option("-w, --watch", "Enable watch mode for file changes")
  .action(async (options) => {
    await runWithVersionCheck(async () => {
      await startServer({
        mode: 'production',
        port: parseInt(options.port),
        watch: options.watch,
        bundled: false
      });
    });
  });

// COMPONENT COMMAND GROUP - For local component management
const componentCommand = sliceClient.command("component").alias("comp").description("Manage local project components");

// CREATE LOCAL COMPONENT
componentCommand
  .command("create")
  .alias("new")
  .description("Create a new component in your local project")
  .action(async () => {
    await runWithVersionCheck(async () => {
      const categories = getCategories();
      if (categories.length === 0) {
        Print.error("No categories found in your project configuration");
        Print.info("Run 'slice init' to initialize your project first");
        Print.commandExample("Initialize project", "slice init");
        return;
      }

      const answers = await inquirer.prompt([
        {
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
        },
        {
          type: "list",
          name: "category",
          message: "Select the component category:",
          choices: categories,
        }
      ]);

      const result = createComponent(answers.componentName, answers.category);
      if (result) {
        Print.success(`Component '${answers.componentName}' created successfully in category '${answers.category}'`);
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
  .command("delete")
  .alias("remove")
  .description("Delete a component from your local project")
  .action(async () => {
    await runWithVersionCheck(async () => {
      const categories = getCategories();
      if (categories.length === 0) {
        Print.error("No categories available. Check your configuration");
        Print.info("Run 'slice init' to initialize your project");
        return;
      }

      try {
        // Paso 1: Seleccionar categoría
        const categoryAnswer = await inquirer.prompt([
          {
            type: "list",
            name: "category",
            message: "Select the component category:",
            choices: categories,
          }
        ]);

        // Paso 2: Listar componentes de esa categoría
        const config = loadConfig();
        if (!config) {
          Print.error("Could not load configuration");
          return;
        }

        const categoryPath = config.paths.components[categoryAnswer.category].path;
        const fullPath = path.join(__dirname, "../../src", categoryPath);

        if (!fs.existsSync(fullPath)) {
          Print.error(`Category path does not exist: ${categoryPath}`);
          return;
        }

        const components = fs.readdirSync(fullPath).filter(item => {
          const itemPath = path.join(fullPath, item);
          return fs.statSync(itemPath).isDirectory();
        });

        if (components.length === 0) {
          Print.info(`No components found in category '${categoryAnswer.category}'`);
          return;
        }

        // Paso 3: Seleccionar componente a eliminar
        const componentAnswer = await inquirer.prompt([
          {
            type: "list",
            name: "componentName",
            message: "Select the component to delete:",
            choices: components,
          },
          {
            type: "confirm",
            name: "confirm",
            message: (answers) => `Are you sure you want to delete '${answers.componentName}'?`,
            default: false,
          }
        ]);

        if (!componentAnswer.confirm) {
          Print.info("Delete operation cancelled");
          return;
        }

        // Paso 4: Eliminar el componente
        if (deleteComponent(componentAnswer.componentName, categoryAnswer.category)) {
          Print.success(`Component ${componentAnswer.componentName} deleted successfully`);
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

// Enhanced help
sliceClient
  .option("--no-version-check", "Skip version check for this command")
  .configureHelp({
    sortSubcommands: true,
    subcommandTerm: (cmd) => cmd.name() + ' ' + cmd.usage()
  });


// Custom help - SIMPLIFICADO para development only
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

Command Categories:
  • init, dev, start             - Project lifecycle (development only)
  • get, browse, sync, list      - Quick shortcuts  
  • component <cmd>              - Local component management
  • registry <cmd>               - Official repository operations
  • version, update, doctor      - Maintenance commands

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
