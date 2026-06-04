import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getProjectRoot, getPath } from './commands/utils/PathHelper.js';
import { SLICE_SCRIPTS } from './commands/utils/sliceScripts.js';
import { resolvePackageManager, runScriptCommand } from './commands/utils/PackageManager.js';

const __filename = fileURLToPath(import.meta.url);

// npm sets npm_config_global; pnpm does not — for pnpm a global install lives
// under PNPM_HOME, so detect it by where this script is running from.
const pnpmHome = process.env.PNPM_HOME;
const isGlobal = process.env.npm_config_global === 'true'
    || (pnpmHome && __filename.startsWith(pnpmHome));

if (isGlobal) {
    console.log('⚠️  Global installation of slicejs-cli detected.');
    console.log('   We strongly recommend using a local installation to avoid version mismatches.');
    console.log(`   Uninstall global: ${pnpmHome ? 'pnpm remove -g slicejs-cli' : 'npm uninstall -g slicejs-cli'}`);
    process.exit(0);
}

const projectRoot = getProjectRoot(import.meta.url);
const pkgPath = getPath(import.meta.url, 'package.json');
const packageManager = resolvePackageManager(projectRoot).name;

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

process.exit(0);
