// commands/utils/updateManager.js

import { exec } from "child_process";
import { promisify } from "util";
import inquirer from "inquirer";
import ora from "ora";
import Print from "../Print.js";
import versionChecker from "./VersionChecker.js";
import { getProjectRoot, getApiPath, getPath } from "../utils/PathHelper.js";
import { resolvePackageManager, installCommand } from "../utils/PackageManager.js";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs-extra";

const execAsync = promisify(exec);

export class UpdateManager {
    constructor() {
        this.packagesToUpdate = [];
    }

    getPackageManager() {
        if (!this._packageManager) {
            this._packageManager = resolvePackageManager(getProjectRoot(import.meta.url)).name;
        }
        return this._packageManager;
    }

    async detectCliInstall() {
        try {
            const moduleDir = path.dirname(fileURLToPath(import.meta.url));
            const cliRoot = path.join(moduleDir, '../../');
            const projectRoot = getProjectRoot(import.meta.url);
            const packageManager = this.getPackageManager();
            const localNodeModules = path.join(projectRoot, 'node_modules');

            if (cliRoot.startsWith(localNodeModules)) {
                return { type: 'local', cliRoot, projectRoot, packageManager };
            }

            // Global pnpm installs live under PNPM_HOME — `npm config get prefix`
            // knows nothing about them (and npm may not even exist on the machine).
            const pnpmHome = process.env.PNPM_HOME;
            if (pnpmHome && cliRoot.startsWith(pnpmHome)) {
                return { type: 'global', cliRoot, projectRoot, packageManager: 'pnpm' };
            }

            let globalPrefix = '';
            try {
                const { stdout } = await execAsync('npm config get prefix');
                globalPrefix = stdout.toString().trim();
            } catch {}
            const globalNodeModules = globalPrefix ? path.join(globalPrefix, 'node_modules') : '';
            if (globalNodeModules && cliRoot.startsWith(globalNodeModules)) {
                return { type: 'global', cliRoot, projectRoot, packageManager: 'npm' };
            }

            return { type: 'unknown', cliRoot, projectRoot, packageManager };
        } catch (error) {
            return { type: 'unknown', packageManager: this.getPackageManager() };
        }
    }

    /**
     * Check for available updates and return structured info
     */
    async checkForUpdates(options = {}) {
        const { silentErrors = false } = options;

        try {
            const updateInfo = await versionChecker.checkForUpdates(true); // Silent mode

            if (!updateInfo) {
                return null;
            }

            const updates = [];

            if (updateInfo.cli.status === 'outdated') {
                updates.push({
                    name: 'slicejs-cli',
                    displayName: 'Slice.js CLI',
                    current: updateInfo.cli.current,
                    latest: updateInfo.cli.latest,
                    type: 'cli'
                });
            }

            if (updateInfo.framework.status === 'outdated') {
                updates.push({
                    name: 'slicejs-web-framework',
                    displayName: 'Slice.js Framework',
                    current: updateInfo.framework.current,
                    latest: updateInfo.framework.latest,
                    type: 'framework'
                });
            }

            return {
                hasUpdates: updates.length > 0,
                updates,
                allCurrent: updateInfo.cli.status === 'current' && updateInfo.framework.status === 'current'
            };
        } catch (error) {
            if (!silentErrors) {
                Print.error(`Checking for updates: ${error.message}`);
            }
            return null;
        }
    }

    async notifyAvailableUpdates() {
        const updateInfo = await this.checkForUpdates({ silentErrors: true });

        if (!updateInfo || !updateInfo.hasUpdates) {
            return false;
        }

        this.displayUpdates(updateInfo);
        Print.info("Run 'slice update' to install updates when convenient.");
        return true;
    }

    /**
     * Display available updates in a formatted way
     */
    displayUpdates(updateInfo) {
        if (!updateInfo || !updateInfo.hasUpdates) {
            return;
        }

        console.log('');
        Print.warning('📦 Available Updates:');
        console.log('');

        updateInfo.updates.forEach(pkg => {
            console.log(`   ${pkg.type === 'cli' ? '🔧' : '⚡'} ${pkg.displayName}`);
            console.log(`      ${pkg.current} → ${pkg.latest}`);
        });

        console.log('');
        console.log('   📚 Changelog: https://github.com/VKneider/slice.js/releases');
        console.log('');
    }

    /**
     * Prompt user to select which packages to update
     */
    async promptForUpdates(updateInfo, options = {}) {
        if (!updateInfo || !updateInfo.hasUpdates) {
            return [];
        }

        // If --yes flag is set, return all updates
        if (options.yes) {
            return updateInfo.updates.map(pkg => pkg.name);
        }

        // If specific package flags are set
        if (options.cli || options.framework) {
            const selected = [];
            if (options.cli) {
                const cliUpdate = updateInfo.updates.find(pkg => pkg.type === 'cli');
                if (cliUpdate) selected.push(cliUpdate.name);
            }
            if (options.framework) {
                const frameworkUpdate = updateInfo.updates.find(pkg => pkg.type === 'framework');
                if (frameworkUpdate) selected.push(frameworkUpdate.name);
            }
            return selected;
        }

        // Interactive selection
        const choices = updateInfo.updates.map(pkg => ({
            name: `${pkg.displayName} (${pkg.current} → ${pkg.latest})`,
            value: pkg.name,
            checked: true
        }));

        const answers = await inquirer.prompt([
            {
                type: 'checkbox',
                name: 'packages',
                message: 'Which packages do you want to update?',
                choices,
                validate: (answer) => {
                    if (answer.length === 0) {
                        return 'You must select at least one package';
                    }
                    return true;
                }
            }
        ]);

        return answers.packages;
    }

    async buildUpdatePlan(packages) {
        const plan = [];
        const info = await this.detectCliInstall();
        const pm = info.packageManager || this.getPackageManager();
        for (const pkg of packages) {
            if (pkg === 'slicejs-cli' && info.type === 'global') {
                plan.push({ package: pkg, target: 'global', command: installCommand(pm, 'slicejs-cli@latest', { global: true }) });
            } else {
                plan.push({ package: pkg, target: 'project', command: installCommand(pm, `${pkg}@latest`) });
            }
        }
        return plan;
    }

    /**
     * Execute npm update command for a specific package
     */
    async updatePackage(packageName) {
        try {
            const pm = this.getPackageManager();
            let installCmd = installCommand(pm, `${packageName}@latest`);
            let options = {};

            if (packageName === 'slicejs-cli') {
                const info = await this.detectCliInstall();
                if (info.type === 'global') {
                    const globalPm = info.packageManager || pm;
                    installCmd = installCommand(globalPm, 'slicejs-cli@latest', { global: true });
                } else {
                    options.cwd = info.projectRoot || getProjectRoot(import.meta.url);
                }
            } else {
                options.cwd = getProjectRoot(import.meta.url);
            }

            // Install directly — npm/pnpm upgrade in place. (We used to uninstall
            // first, which left the project without the package whenever the
            // subsequent install failed, e.g. offline or under a release-age policy.)
            const { stdout, stderr } = await execAsync(installCmd, options);

            return {
                success: true,
                packageName,
                stdout,
                stderr
            };
        } catch (error) {
            return {
                success: false,
                packageName,
                error: error.message
            };
        }
    }

    /**
     * Update multiple packages with progress indication
     */
    async installUpdates(packages) {
        const results = [];

        for (const packageName of packages) {
            const spinner = ora(`Updating ${packageName}...`).start();

            try {
                const result = await this.updatePackage(packageName);

                if (result.success) {
                    spinner.succeed(`${packageName} updated successfully`);
                    results.push({ packageName, success: true });
                } else {
                    spinner.fail(`Error updating ${packageName}`);
                    Print.error(`Details: ${result.error}`);
                    results.push({ packageName, success: false, error: result.error });
                }
            } catch (error) {
                spinner.fail(`Error updating ${packageName}`);
                Print.error(`Details: ${error.message}`);
                results.push({ packageName, success: false, error: error.message });
            }
        }

        return results;
    }

    /**
     * Main method to check and prompt for updates
     */
    async checkAndPromptUpdates(options = {}) {
        const spinner = ora('Checking for updates...').start();

        try {
            const updateInfo = await this.checkForUpdates();
            spinner.stop();

            if (!updateInfo) {
                Print.error('Could not check for updates. Verify your internet connection.');
                return false;
            }

            if (updateInfo.allCurrent || !updateInfo.hasUpdates) {
                Print.success('✅ All components are up to date!');
                // --update-api works even when no package update runs.
                if (options.updateApi) {
                    await this.updateApiIndexIfNeeded(options);
                }
                return true;
            }

            // Display available updates
            this.displayUpdates(updateInfo);

        // Get packages to update
        const packagesToUpdate = await this.promptForUpdates(updateInfo, options);

            if (!packagesToUpdate || packagesToUpdate.length === 0) {
                Print.info('No packages selected for update.');
                return false;
            }

        // Show plan and confirm installation if not auto-confirmed
        let plan = await this.buildUpdatePlan(packagesToUpdate);
        console.log('');
        Print.info('🧭 Update plan:');
        plan.forEach(item => {
            const where = item.target === 'global' ? 'GLOBAL' : 'PROJECT';
            console.log(`   • ${item.package} → ${where}`);
            console.log(`     ${item.command}`);
        });
        console.log('');

        const cliInfo = await this.detectCliInstall();
        if (cliInfo.type === 'global' && !packagesToUpdate.includes('slicejs-cli')) {
            if (!options.yes && !options.cli) {
                const { addCli } = await inquirer.prompt([
                    {
                        type: 'confirm',
                        name: 'addCli',
                    message: 'Global CLI detected. Add the global CLI update to the plan?',
                    default: true
                }
            ]);
                if (addCli) {
                    packagesToUpdate.push('slicejs-cli');
                    plan = await this.buildUpdatePlan(packagesToUpdate);
                    console.log('');
                    Print.info('🧭 Updated plan:');
                    plan.forEach(item => {
                        const where = item.target === 'global' ? 'GLOBAL' : 'PROJECT';
                        console.log(`   • ${item.package} → ${where}`);
                        console.log(`     ${item.command}`);
                    });
                    console.log('');
                }
            } else {
                Print.warning('Global CLI detected. It is recommended to update slicejs-cli globally to keep aligned with the framework.');
                console.log(`   Suggestion: ${installCommand(cliInfo.packageManager || this.getPackageManager(), 'slicejs-cli@latest', { global: true })}`);
                console.log('');
            }
        }

        if (!options.yes && !options.cli && !options.framework) {
            const { confirm } = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'confirm',
                    message: 'Do you want to proceed with the update according to the plan shown?',
                    default: true
                }
            ]);

                if (!confirm) {
                    Print.info('Update cancelled.');
                    return false;
                }
            }

            console.log(''); // Line break
            Print.info('📥 Installing updates...');
            console.log('');

            // Install updates
            const results = await this.installUpdates(packagesToUpdate);

            // Summary
            console.log('');
            const successCount = results.filter(r => r.success).length;
            const failCount = results.filter(r => !r.success).length;

            if (failCount === 0) {
                Print.success(`✅ ${successCount} package(s) updated successfully!`);
            } else {
                Print.warning(`⚠️  ${successCount} successful, ${failCount} failed`);
            }

            if (successCount > 0) {
                console.log('');
                Print.info('💡 It is recommended to restart the development server if it is running.');
            }

            const frameworkUpdated = results.find(r => r.packageName === 'slicejs-web-framework' && r.success);
            if (frameworkUpdated || options.updateApi) {
                await this.updateApiIndexIfNeeded(options);
            }

            return failCount === 0;

        } catch (error) {
            spinner.stop();
            Print.error(`Error during update: ${error.message}`);
            return false;
        }
    }

    async updateApiIndexIfNeeded(options = {}) {
        try {
            const projectApiPath = getApiPath(import.meta.url, 'index.js');
            const frameworkApiPath = getPath(import.meta.url, 'node_modules', 'slicejs-web-framework', 'api', 'index.js');

            if (!await fs.pathExists(projectApiPath) || !await fs.pathExists(frameworkApiPath)) {
                return;
            }

            const projectContent = await fs.readFile(projectApiPath, 'utf-8');
            const frameworkContent = await fs.readFile(frameworkApiPath, 'utf-8');

            if (projectContent === frameworkContent) {
                return;
            }

            Print.warning('⚠️ Detected changes in framework api/index.js.');

            // Overwriting api/index.js is opt-in: `--update-api` is the only way
            // to auto-confirm. `-y/--yes` deliberately does NOT imply it — the
            // project file may carry local changes, so a blanket "yes to updates"
            // must not silently replace it.
            let confirmUpdate = options.updateApi === true;
            if (!confirmUpdate && options.yes === true) {
                Print.info('Skipping api/index.js update (not updated by default).');
                Print.info('Run "slice update --update-api" to update it (a .bak backup is created).');
                return;
            }
            if (!confirmUpdate) {
                const answers = await inquirer.prompt([
                    {
                        type: 'confirm',
                        name: 'confirm',
                        message: 'Update your project api/index.js to the latest framework version?',
                        default: false
                    }
                ]);
                confirmUpdate = answers.confirm;
            }

            if (!confirmUpdate) {
                Print.info('Skipping api/index.js update.');
                return;
            }

            const backupPath = `${projectApiPath}.bak`;
            await fs.copy(projectApiPath, backupPath);
            await fs.writeFile(projectApiPath, frameworkContent, 'utf-8');
            Print.success('✅ api/index.js updated from framework template.');
            Print.info(`Backup created at ${backupPath}`);
        } catch (error) {
            Print.error(`Failed to update api/index.js: ${error.message}`);
        }
    }
}

// Singleton instance
const updateManager = new UpdateManager();

export default updateManager;
