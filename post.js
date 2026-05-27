import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getProjectRoot } from './commands/utils/PathHelper.js';

const __filename = fileURLToPath(import.meta.url);

const isGlobal = process.env.npm_config_global === 'true';

if (isGlobal) {
    console.log('⚠️  Global installation of slicejs-cli detected.');
    console.log('   We strongly recommend using a local installation to avoid version mismatches.');
    console.log('   Uninstall global: npm uninstall -g slicejs-cli');
    process.exit(0);
}

const projectRoot = getProjectRoot(import.meta.url);
const pkgPath = path.join(projectRoot, 'package.json');

const sliceScripts = {
    'slice:dev': 'slice dev',
    'slice:start': 'slice start',
    'slice:create': 'slice component create',
    'slice:list': 'slice component list',
    'slice:delete': 'slice component delete',
    'slice:init': 'slice init',
    'slice:get': 'slice get',
    'slice:browse': 'slice browse',
    'slice:sync': 'slice sync',
    'slice:version': 'slice version',
    'slice:update': 'slice update',
};

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
    console.log(`✅  slicejs-cli installed successfully. Added ${addedCount} npm scripts to package.json.`);
    console.log('   Run: npm run slice:dev');
} catch (err) {
    console.log('✅  slicejs-cli installed successfully.');
    console.log('   Could not auto-configure scripts:', err.message);
    console.log('   Run: npx slice dev');
}

process.exit(0);
