import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import ora from 'ora';
import Print from '../Print.js';
import { getProjectRoot, getApiPath, getSrcPath, getPath } from '../utils/PathHelper.js';
import { execSync } from 'child_process';
import {
    resolvePackageManager,
    getPackageManagerVersion,
    installCommand
} from '../utils/PackageManager.js';
import { SLICE_SCRIPTS } from '../utils/sliceScripts.js';

// Import ComponentRegistry class from getComponent
import { ComponentRegistry } from '../getComponent/getComponent.js';

// Fetch the latest published version straight from the npm registry. This is
// informational only (we never pin installs to it): it avoids depending on
// `npm view` (absent on pnpm-only machines) and plays nice with pnpm's
// minimumReleaseAge quarantine, which may legitimately resolve an older version.
async function fetchLatestVersion(packageName) {
    try {
        const response = await fetch(`https://registry.npmjs.org/${packageName}/latest`, {
            headers: { 'Accept': 'application/json' }
        });
        if (!response.ok) return null;
        const data = await response.json();
        return data.version || null;
    } catch {
        return null;
    }
}

function getRunningCliVersion() {
    try {
        const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
        const cliPkg = fs.readJsonSync(path.join(cliRoot, 'package.json'));
        return typeof cliPkg.version === 'string' ? cliPkg.version : null;
    } catch {
        return null;
    }
}

async function ensurePnpmAllowBuilds(projectRoot) {
    const workspacePath = path.join(projectRoot, 'pnpm-workspace.yaml');
    const allowBuildLine = '  slicejs-cli: true';

    if (!(await fs.pathExists(workspacePath))) {
        await fs.writeFile(workspacePath, `allowBuilds:\n${allowBuildLine}\n`, 'utf8');
        return;
    }

    const raw = await fs.readFile(workspacePath, 'utf8');
    const lines = raw.split(/\r?\n/);
    const allowIdx = lines.findIndex((line) => /^allowBuilds:\s*$/.test(line));

    if (allowIdx === -1) {
        const suffix = raw.endsWith('\n') ? '' : '\n';
        await fs.writeFile(workspacePath, `${raw}${suffix}allowBuilds:\n${allowBuildLine}\n`, 'utf8');
        return;
    }

    let blockEnd = lines.length;
    for (let i = allowIdx + 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        if (!/^\s/.test(line)) {
            blockEnd = i;
            break;
        }
    }

    let found = false;
    for (let i = allowIdx + 1; i < blockEnd; i++) {
        if (/^\s+slicejs-cli\s*:/.test(lines[i])) {
            lines[i] = allowBuildLine;
            found = true;
            break;
        }
    }

    if (!found) {
        lines.splice(blockEnd, 0, allowBuildLine);
    }

    await fs.writeFile(workspacePath, `${lines.join('\n').replace(/\n*$/, '\n')}`, 'utf8');
}

// Create the project manifest BEFORE any install runs. Without a package.json in
// the project folder, npm/pnpm walk up the directory tree looking for the nearest
// manifest and anchor node_modules (and the dependency entry) OUTSIDE the project.
// Exported for tests (init-project-isolation.test.js).
export async function ensureProjectManifest(projectRoot, packageManager) {
    const pkgPath = path.join(projectRoot, 'package.json');
    if (await fs.pathExists(pkgPath)) return pkgPath;

    const pkg = {
        name: path.basename(projectRoot),
        version: '1.0.0',
        description: 'Slice.js project',
        main: 'api/index.js',
        type: 'module',
        engines: { node: '>=20.0.0' },
        scripts: {}
    };

    // Persist the chosen package manager (corepack convention) so every later
    // command — slice update, slice doctor — detects it deterministically.
    const pmVersion = getPackageManagerVersion(packageManager);
    if (pmVersion) {
        pkg.packageManager = `${packageManager}@${pmVersion}`;
    }

    await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2), 'utf8');
    return pkgPath;
}

// Visual components used by the App Shell + MultiRoute starter project.
// We install only these on init; newcomers add more on demand with `slice get <Name>`.
const STARTER_VISUAL_COMPONENTS = [
   'Button',
   'Link',
   'Loading',
   'MultiRoute',
   'Navbar',
   'NotFound',
   'Route'
];

// Service components are now also pulled from the registry on init (instead of
// being vendored in the framework package), so Visual and Service share a single
// source of truth. Newcomers add more on demand with `slice get <Name>`.
const STARTER_SERVICE_COMPONENTS = [
   'FetchManager',
   'IndexedDbManager',
   'LocalStorageManager'
];

export default async function initializeProject(options = {}) {
    try {
        const projectRoot = getProjectRoot(import.meta.url);
        const destinationApi = getApiPath(import.meta.url);
        const destinationSrc = getSrcPath(import.meta.url);

        // Resolve the package manager chosen in `slice init` (or detect it when
        // initializeProject is invoked directly, e.g. inside an existing folder).
        const packageManager = options.packageManager
            || resolvePackageManager(projectRoot).name;

        if (packageManager === 'pnpm') {
            await ensurePnpmAllowBuilds(projectRoot);
        }

        // 0. CREATE PROJECT MANIFEST FIRST — must exist before any install so the
        // package manager anchors node_modules inside the project folder.
        await ensureProjectManifest(projectRoot, packageManager);

        const fwSpinner = ora('Ensuring latest Slice framework...').start();
        let latestVersion = null;
        let installedVersion = null;
        let sliceBaseDir;
        try {
            latestVersion = await fetchLatestVersion('slicejs-web-framework');
            const frameworkPackage = latestVersion
                ? `slicejs-web-framework@${latestVersion}`
                : 'slicejs-web-framework';
            const installedPkgPath = getPath(import.meta.url, 'node_modules', 'slicejs-web-framework', 'package.json');
            let installed = null;
            if (await fs.pathExists(installedPkgPath)) {
                const pkg = await fs.readJson(installedPkgPath);
                installed = pkg.version;
            }
            if (!installed || (latestVersion && installed !== latestVersion)) {
                execSync(installCommand(packageManager, frameworkPackage), { cwd: projectRoot, stdio: 'inherit' });
            }
            if (await fs.pathExists(installedPkgPath)) {
                const pkg = await fs.readJson(installedPkgPath);
                installedVersion = pkg.version;
            }
            sliceBaseDir = getPath(import.meta.url, 'node_modules', 'slicejs-web-framework');
            fwSpinner.succeed(`slicejs-web-framework@${installedVersion || 'unknown'} ready`);
            if (latestVersion && installedVersion && installedVersion !== latestVersion) {
                Print.info(`Latest published is ${latestVersion}; your package manager resolved ${installedVersion} (release-age policy or cached registry).`);
            }
        } catch (err) {
            // Fallback uses __dirname-style path because it looks for a local development copy,
            // not a project-relative path — the install failed, so we fall back to monorepo sibling.
            const fallback = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../slicejs-web-framework');
            if (await fs.pathExists(fallback)) {
                sliceBaseDir = fallback;
                fwSpinner.warn('Using local slicejs-web-framework fallback');
            } else {
                fwSpinner.fail('Failed to ensure latest slicejs-web-framework');
                Print.error(err.message);
                return;
            }
        }

        // 0b. INSTALL THE CLI LOCALLY (devDependency) so the generated scripts
        // (`npm run dev` → `slice dev`) resolve via local delegation to a version
        // pinned per project, as the docs recommend.
        const cliSpinner = ora('Installing slicejs-cli as devDependency...').start();
        try {
            const cliPkgPath = getPath(import.meta.url, 'node_modules', 'slicejs-cli', 'package.json');
            const currentCliVersion = getRunningCliVersion();
            const cliPackage = currentCliVersion
                ? `slicejs-cli@${currentCliVersion}`
                : 'slicejs-cli';

            let installedCliVersion = null;
            if (await fs.pathExists(cliPkgPath)) {
                const pkg = await fs.readJson(cliPkgPath);
                installedCliVersion = pkg.version;
            }

            if (!installedCliVersion || (currentCliVersion && installedCliVersion !== currentCliVersion)) {
                execSync(installCommand(packageManager, cliPackage, { dev: true }), { cwd: projectRoot, stdio: 'inherit' });
            }
            cliSpinner.succeed('slicejs-cli installed locally');
        } catch (err) {
            cliSpinner.warn('Could not install slicejs-cli locally — scripts will use the global CLI');
            Print.info(`You can add it later with: ${installCommand(packageManager, `slicejs-cli@${getRunningCliVersion() || 'latest'}`, { dev: true })}`);
        }

        // These derive from sliceBaseDir (which comes from npm install or fallback),
        // so they're already dynamic — no PathHelper needed.
        const apiDir = path.join(sliceBaseDir, 'api');
        const srcDir = path.join(sliceBaseDir, 'src');

        try {
            if (fs.existsSync(destinationApi)) throw new Error(`The "api" directory already exists: ${destinationApi}`);
            if (fs.existsSync(destinationSrc)) throw new Error(`The "src" directory already exists: ${destinationSrc}`);
        } catch (error) {
            Print.error('Validating destination directories:', error.message);
            return;
        }

        // 1. COPY API FOLDER (keep original logic)
        const apiSpinner = ora('Copying API structure...').start();
        try {
            if (!fs.existsSync(apiDir)) throw new Error(`API folder not found: ${apiDir}`);
            await fs.copy(apiDir, destinationApi, { recursive: true });
            apiSpinner.succeed('API structure created successfully');
        } catch (error) {
            apiSpinner.fail('Error copying API structure');
            Print.error(error.message);
            return;
        }

        // 2. CREATE BASIC SRC STRUCTURE (without copying Visual components)
        const srcSpinner = ora('Creating src structure...').start();
        try {
            if (!fs.existsSync(srcDir)) throw new Error(`src folder not found: ${srcDir}`);

            // Copy only base src files, excluding Components/Visual
            await fs.ensureDir(destinationSrc);

            // Copy src files and folders except Components/Visual
            const srcItems = await fs.readdir(srcDir);

            for (const item of srcItems) {
                const srcItemPath = path.join(srcDir, item);
                const destItemPath = path.join(destinationSrc, item);
                const stat = await fs.stat(srcItemPath);

                if (stat.isDirectory()) {
                    if (item === 'Components') {
                        // Create Components structure but without copying Visual or Service
                        await fs.ensureDir(destItemPath);

                        const componentItems = await fs.readdir(srcItemPath);
                        for (const componentItem of componentItems) {
                            const componentItemPath = path.join(srcItemPath, componentItem);
                            const destComponentItemPath = path.join(destItemPath, componentItem);

                            if (componentItem !== 'Visual' && componentItem !== 'Service') {
                                // Copy AppComponents and other template types from the framework
                                await fs.copy(componentItemPath, destComponentItemPath, { recursive: true });
                            } else {
                                // Visual and Service are installed from the registry below
                                await fs.ensureDir(destComponentItemPath);
                            }
                        }
                    } else {
                        // Copy other folders normally
                        await fs.copy(srcItemPath, destItemPath, { recursive: true });
                    }
                } else {
                    // Copy files normally
                    await fs.copy(srcItemPath, destItemPath);
                }
            }

            srcSpinner.succeed('Source structure created successfully');
        } catch (error) {
            srcSpinner.fail('Error creating source structure');
            Print.error(error.message);
            return;
        }

        // 3. DOWNLOAD ALL VISUAL COMPONENTS FROM OFFICIAL REPOSITORY
        const componentsSpinner = ora('Loading component registry...').start();
        try {
            const registry = new ComponentRegistry();
            await registry.loadRegistry();

            // Install only the Visual components the starter project uses.
            const allVisualComponents = STARTER_VISUAL_COMPONENTS;
            Print.info(`Installing ${allVisualComponents.length} starter Visual components: ${allVisualComponents.join(', ')}`);

            if (allVisualComponents.length > 0) {
                componentsSpinner.text = `Installing ${allVisualComponents.length} starter Visual components...`;

                const results = await registry.installMultipleComponents(
                    allVisualComponents,
                    'Visual',
                    true // force = true for initial installation
                );

                const successful = results.filter(r => r.success).length;
                const failed = results.filter(r => !r.success).length;

                if (successful > 0 && failed === 0) {
                    componentsSpinner.succeed(`All ${successful} Visual components installed successfully`);
                } else if (successful > 0) {
                componentsSpinner.warn(`${successful} components installed, ${failed} failed`);
                Print.info(`You can install failed components later using "${packageManager} run get -- <component-name>"`);
            } else {
                componentsSpinner.fail('Failed to install Visual components');
            }
        } else {
            componentsSpinner.warn('No Visual components found in registry');
            Print.info(`You can add components later using "${packageManager} run get -- <component-name>"`);
        }

        } catch (error) {
            componentsSpinner.fail('Could not download Visual components from official repository');
            Print.error(`Repository error: ${error.message}`);
            Print.info('Project initialized without Visual components');
            Print.info(`You can add them later using "${packageManager} run get -- <component-name>"`);
        }

        // 3b. DOWNLOAD STARTER SERVICE COMPONENTS FROM OFFICIAL REPOSITORY
        const serviceSpinner = ora('Installing starter Service components...').start();
        try {
            const registry = new ComponentRegistry();
            await registry.loadRegistry();

            if (STARTER_SERVICE_COMPONENTS.length > 0) {
                Print.info(`Installing ${STARTER_SERVICE_COMPONENTS.length} starter Service components: ${STARTER_SERVICE_COMPONENTS.join(', ')}`);
                serviceSpinner.text = `Installing ${STARTER_SERVICE_COMPONENTS.length} starter Service components...`;

                const results = await registry.installMultipleComponents(
                    STARTER_SERVICE_COMPONENTS,
                    'Service',
                    true // force = true for initial installation
                );

                const successful = results.filter(r => r.success).length;
                const failed = results.filter(r => !r.success).length;

                if (successful > 0 && failed === 0) {
                    serviceSpinner.succeed(`All ${successful} Service components installed successfully`);
                } else if (successful > 0) {
                    serviceSpinner.warn(`${successful} Service components installed, ${failed} failed`);
                    Print.info(`You can install failed components later using "${packageManager} run get -- <component-name>"`);
                } else {
                    serviceSpinner.fail('Failed to install Service components');
                }
            } else {
                serviceSpinner.succeed('No starter Service components to install');
            }
        } catch (error) {
            serviceSpinner.fail('Could not download Service components from official repository');
            Print.error(`Repository error: ${error.message}`);
            Print.info(`You can add them later using "${packageManager} run get -- <component-name>"`);
        }

        // 4. CONFIGURE SCRIPTS IN PROJECT package.json
        const pkgSpinner = ora('Configuring npm scripts...').start();
        try {
            const projectRoot = getProjectRoot(import.meta.url);
            const pkgPath = getPath(import.meta.url, 'package.json');

            let pkg;
            if (await fs.pathExists(pkgPath)) {
                pkg = await fs.readJson(pkgPath);
            } else {
                pkg = {
                    name: path.basename(projectRoot),
                    version: '1.0.0',
                    description: 'Slice.js project',
                    main: 'api/index.js',
                    scripts: {}
                };
            }

            pkg.scripts = pkg.scripts || {};
            pkg.dependencies = pkg.dependencies || {};

            // Main scripts (local CLI path, no global launcher dependency)
            pkg.scripts['dev'] = SLICE_SCRIPTS['slice:dev'];
            pkg.scripts['build'] = SLICE_SCRIPTS['slice:build'];
            pkg.scripts['start'] = SLICE_SCRIPTS['slice:start'];

            // Component management
            pkg.scripts['component:create'] = SLICE_SCRIPTS['slice:create'];
            pkg.scripts['component:list'] = SLICE_SCRIPTS['slice:list'];
            pkg.scripts['component:delete'] = SLICE_SCRIPTS['slice:delete'];

            // Registry shortcuts
            pkg.scripts['get'] = SLICE_SCRIPTS['slice:get'];
            pkg.scripts['browse'] = SLICE_SCRIPTS['slice:browse'];
            pkg.scripts['sync'] = SLICE_SCRIPTS['slice:sync'];

            // slice:* namespaced set — shared with post.js and `slice postinstall`
            // (commands/utils/sliceScripts.js) so the three never drift apart.
            Object.assign(pkg.scripts, SLICE_SCRIPTS);
            pkg.scripts['run'] = SLICE_SCRIPTS['slice:dev'];

            // Module configuration
            pkg.type = 'module';
            pkg.engines = pkg.engines || { node: '>=20.0.0' };

            // Ensure framework dependency is present (the install above normally
            // already wrote it; this is a fallback for the monorepo-sibling path).
            if (!pkg.dependencies['slicejs-web-framework']) {
                pkg.dependencies['slicejs-web-framework'] = installedVersion ? `^${installedVersion}` : 'latest';
            }

            await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2), 'utf8');
            pkgSpinner.succeed('Package scripts configured successfully');

            Print.title('New recommended commands:');
            console.log(`  ${packageManager} run dev            - Start development server`);
            console.log(`  ${packageManager} run get            - Install components`);
            console.log(`  ${packageManager} run browse         - Browse components`);
        } catch (error) {
        pkgSpinner.fail('Failed to configure npm scripts');
        Print.error(error.message);
        }

        const projectName = path.basename(process.cwd());
        Print.success(`Project initialized successfully in "${projectName}/"`);
        Print.newLine();
        Print.title('Next steps:');
        console.log(`  cd ${projectName}`);
        console.log(`  ${packageManager} run dev     - Start development server`);
        console.log(`  ${packageManager} run browse  - View available components`);
        console.log(`  ${packageManager} run get -- Button - Install specific components`);
        console.log(`  ${packageManager} run sync    - Update all components to latest versions`);

    } catch (error) {
        Print.error('Unexpected error initializing project:', error.message);
    }
}

// NOTE: `slice init` installs only STARTER_VISUAL_COMPONENTS and
// STARTER_SERVICE_COMPONENTS (see top of file); both Visual and Service are pulled
// from the registry rather than vendored in the framework package.
// To install every registry component instead, iterate
// `Object.keys(registry.getAvailableComponents('Visual'))` (and likewise 'Service').
