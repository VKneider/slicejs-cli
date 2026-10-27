import fs from 'fs-extra';
import path from 'path';
import { createServer } from 'net';
import chalk from 'chalk';
import Table from 'cli-table3';
import Print from '../Print.js';
import { getProjectRoot, getSrcPath, getApiPath, getConfigPath, getPath, getComponentsJsPath } from '../utils/PathHelper.js';
import { resolvePackageManager, installCommand } from '../utils/PackageManager.js';
import updateManager from '../utils/updateManager.js';
import { parseComponentsRegistry } from '../types/types.js';
import { validateConfigRules, validateProject, classifyValidation, describeIssue } from '../utils/ProjectValidation.js';
import { parse as parseModule } from '@babel/parser';
import traverse from '@babel/traverse';
import ExternalModuleBundler from '../utils/bundling/ExternalModuleBundler.js';
import { loadFrameworkSeo, loadManifest } from '../seo/support.js';
import { loadRoutes } from '../seo/check.js';

/**
 * SEO: is it configured, and is it safe to deploy?
 *
 * Warns rather than fails for an unconfigured project (SEO is opt-in), and
 * fails only for input the user has to fix. The rules are the framework's
 * validator, the same one `slice seo check` uses, so the two cannot disagree.
 */
async function checkSeoConfiguration() {
    const projectRoot = getProjectRoot(import.meta.url);

    if (!fs.existsSync(path.join(projectRoot, 'api', 'index.js'))) {
        return { pass: true, message: 'Not a server app (no api/index.js)' };
    }

    let loaded;
    try {
        loaded = loadManifest(projectRoot);
    } catch (error) {
        return {
            message: `seo.json is not valid JSON: ${error.message}`,
            suggestion: 'Fix the file: the server fails at startup on the same error'
        };
    }

    const { manifest } = loaded;
    if (!manifest) {
        return {
            warn: true,
            message: 'Not configured: every route shares one <head> and unknown paths answer 200',
            suggestion: 'Add seo.json and pass it to createSliceServer({ seo: { manifest: "seo.json" } })'
        };
    }

    let framework;
    try {
        framework = await loadFrameworkSeo(projectRoot);
    } catch (error) {
        return { warn: true, message: `seo.json exists, but the installed framework has no SEO module: ${error.message}` };
    }

    const routes = await loadRoutes(projectRoot).catch(() => []);
    const { errors, warnings } = framework.validateSeoManifest(manifest, {
        routes,
        publicDir: path.join(projectRoot, 'src', 'public')
    });

    // The sitemap is a committed artifact, so a stale one is a deploy problem.
    if (manifest.sitemap !== false) {
        const sitemapFile = path.join(projectRoot, 'src', 'public', 'sitemap.xml');
        const origin = framework.normalizeOrigin(manifest.origin);
        if (!fs.existsSync(sitemapFile)) {
            warnings.push('sitemap.xml is missing: run `slice seo sitemap`');
        } else if (origin && fs.readFileSync(sitemapFile, 'utf8') !== framework.buildSitemap({ manifest, origin })) {
            warnings.push('sitemap.xml is out of date: run `slice seo sitemap`');
        }
    }

    const routeCount = Object.keys(manifest.routes || {}).length;

    if (errors.length) {
        return {
            message: `${errors.length} problem(s) in seo.json: ${errors[0]}`,
            suggestion: errors.length > 1 ? `${errors[1]} (run \`slice seo check\` for the full list)` : 'Run `slice seo check`'
        };
    }

    if (warnings.length) {
        return {
            warn: true,
            message: `origin ${manifest.origin}, ${routeCount} routes — ${warnings.length} warning(s): ${warnings[0]}`,
            suggestion: warnings.length > 1 ? `${warnings[1]} (run \`slice seo check\` for the full list)` : undefined
        };
    }

    return {
        pass: true,
        message: `origin ${manifest.origin}, ${routeCount} routes, sitemap ${manifest.sitemap === false ? 'off' : 'ok'}`
    };
}

/**
 * Checks the Node.js version
 */
async function checkNodeVersion() {
    const currentVersion = process.version;
    const majorVersion = parseInt(currentVersion.slice(1).split('.')[0]);
    const required = 20;

    if (majorVersion >= required) {
        return {
            pass: true,
            message: `Node.js version: ${currentVersion} (required: >= v${required})`
        };
    } else {
        return {
            pass: false,
            message: `Node.js version: ${currentVersion} (required: >= v${required})`,
            suggestion: `Update Node.js to v${required} or higher`
        };
    }
}

/**
 * Checks the directory structure
 */
async function checkDirectoryStructure() {
    const srcPath = getSrcPath(import.meta.url);
    const apiPath = getApiPath(import.meta.url);

    const srcExists = await fs.pathExists(srcPath);
    const apiExists = await fs.pathExists(apiPath);

    if (srcExists && apiExists) {
        return {
            pass: true,
            message: 'Project structure (src/ and api/) exists'
        };
    } else {
        const missing = [];
        if (!srcExists) missing.push('src/');
        if (!apiExists) missing.push('api/');

        return {
            pass: false,
            message: `Missing directories: ${missing.join(', ')}`,
            suggestion: 'Run "slice init" to initialize your project'
        };
    }
}

/**
 * Checks sliceConfig.json
 */
async function checkConfig() {
    const configPath = getConfigPath(import.meta.url);

    if (!await fs.pathExists(configPath)) {
        return {
            pass: false,
            message: 'sliceConfig.json not found',
            suggestion: 'Run "slice init" to create configuration'
        };
    }

    try {
        const config = await fs.readJson(configPath);

        if (!config.paths || !config.paths.components) {
            return {
                pass: false,
                message: 'sliceConfig.json is invalid (missing paths.components)',
                suggestion: 'Check your configuration file'
            };
        }

        // Same rules `slice build` applies before bundling. A config that passes
        // here but blocks the build is worse than no check at all.
        const ruleProblems = validateConfigRules(config);
        if (ruleProblems.length > 0) {
            return {
                pass: false,
                message: `sliceConfig.json would build a broken bundle: ${ruleProblems[0].path}`,
                suggestion: ruleProblems.map((problem) => `${problem.path} ${problem.message}`).join('\n')
            };
        }

        return {
            pass: true,
            message: 'sliceConfig.json is valid'
        };
    } catch (error) {
        return {
            pass: false,
            message: `sliceConfig.json is invalid JSON: ${error.message}`,
            suggestion: 'Fix JSON syntax errors in sliceConfig.json'
        };
    }
}

/**
 * Checks port availability
 */
async function checkPort() {
    const configPath = getConfigPath(import.meta.url);
    let port = 3000;

    try {
        if (await fs.pathExists(configPath)) {
            const config = await fs.readJson(configPath);
            port = config.server?.port || 3000;
        }
    } catch { /* config missing or unreadable — use default port */ }

    return new Promise((resolve) => {
        const server = createServer();

        server.once('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                resolve({
                    warn: true,
                    message: `Port ${port} is already in use`,
                    suggestion: `Stop the process using port ${port} or use: slice dev -p <other-port>`
                });
            } else {
                resolve({
                    pass: true,
                    message: `Port ${port} is available`
                });
            }
        });

        server.once('listening', () => {
            server.close();
            resolve({
                pass: true,
                message: `Port ${port} is available`
            });
        });

        server.listen(port);
    });
}

/**
 * Checks the package manager setup: mixed lockfiles, packageManager field
 * consistency, and a project-local CLI install (required for local delegation).
 * Exported for tests.
 */
export async function checkPackageManagerSetup(projectRoot = getProjectRoot(import.meta.url)) {
    const issues = [];
    const suggestions = [];

    const LOCKFILE_PM = {
        'package-lock.json': 'npm',
        'pnpm-lock.yaml': 'pnpm'
    };
    const lockfiles = [];
    for (const lockfile of Object.keys(LOCKFILE_PM)) {
        if (await fs.pathExists(path.join(projectRoot, lockfile))) {
            lockfiles.push(lockfile);
        }
    }

    let pkg = null;
    const pkgPath = path.join(projectRoot, 'package.json');
    if (await fs.pathExists(pkgPath)) {
        try { pkg = await fs.readJson(pkgPath); } catch { /* reported by Dependencies check */ }
    }
    const pmField = typeof pkg?.packageManager === 'string' ? pkg.packageManager.split('@')[0] : null;
    const pm = resolvePackageManager(projectRoot).name;

    if (lockfiles.length > 1) {
        issues.push(`Mixed lockfiles found: ${lockfiles.join(', ')}`);
        const keep = pmField || pm;
        const keepLockfile = Object.entries(LOCKFILE_PM).find(([, name]) => name === keep)?.[0];
        suggestions.push(`Keep only ${keepLockfile ?? 'the lockfile of your package manager'} and delete the rest`);
    }

    if (pkg && !pmField) {
        issues.push('No "packageManager" field in package.json');
        suggestions.push(`Pin it (e.g. "packageManager": "${pm}@<version>") so every tool resolves the same package manager`);
    } else if (pmField && lockfiles.length === 1 && LOCKFILE_PM[lockfiles[0]] !== pmField) {
        issues.push(`packageManager is "${pmField}" but the lockfile is ${lockfiles[0]}`);
        suggestions.push(`Reinstall with ${pmField} (or update the packageManager field) so they agree`);
    }

    const localCliPath = path.join(projectRoot, 'node_modules', 'slicejs-cli', 'package.json');
    if (pkg && !(await fs.pathExists(localCliPath))) {
        issues.push('slicejs-cli is not installed locally');
        suggestions.push(`Run "${installCommand(pm, 'slicejs-cli', { dev: true })}" so the launcher delegates to a version pinned per project`);
    }

    if (issues.length === 0) {
        return {
            pass: true,
            message: `Package manager setup is consistent (${pmField || pm})`
        };
    }
    return {
        warn: true,
        message: issues.join(' | '),
        suggestion: suggestions.join(' | ')
    };
}

/**
 * Checks dependencies in package.json
 */
async function checkDependencies() {
    const projectRoot = getProjectRoot(import.meta.url);
    const packagePath = getPath(import.meta.url, 'package.json');

    if (!await fs.pathExists(packagePath)) {
        return {
            warn: true,
            message: 'package.json not found',
            suggestion: 'Run "npm init" to create package.json'
        };
    }

    try {
        const pkg = await fs.readJson(packagePath);
        const hasFrameworkDep = pkg.dependencies?.['slicejs-web-framework'] || pkg.devDependencies?.['slicejs-web-framework'];
        const frameworkNodePath = getPath(import.meta.url, 'node_modules', 'slicejs-web-framework', 'package.json');
        const hasFrameworkNode = await fs.pathExists(frameworkNodePath);
        const hasFramework = !!(hasFrameworkDep || hasFrameworkNode);

        if (hasFramework) {
            return {
                pass: true,
                message: 'Required framework dependency is installed'
            };
        } else {
            const missing = ['slicejs-web-framework'];

            return {
                warn: true,
                message: `Missing dependencies: ${missing.join(', ')}`,
                suggestion: missing.includes('slicejs-web-framework')
                    ? `Run "${installCommand(resolvePackageManager(getProjectRoot(import.meta.url)).name, 'slicejs-web-framework@latest')}" in your project`
                    : `Run "${installCommand(resolvePackageManager(getProjectRoot(import.meta.url)).name, 'slicejs-cli@latest', { dev: true })}" in your project`,
                missing
            };
        }
    } catch (error) {
        return {
            pass: false,
            message: `package.json is invalid: ${error.message}`,
            suggestion: 'Fix JSON syntax errors in package.json'
        };
    }
}

/**
 * Components and routes: one verdict for everything the build validates statically.
 *
 * The same pass `slice build` runs, classified by the same helper. It used to be
 * two rows that disagreed with each other and with the build: "Components"
 * scanned folders, "Component Props" read only prop definitions and dropped the
 * source errors the build blocks on, and routes were never checked at all.
 */
async function checkComponents() {
    const registryPath = getComponentsJsPath(import.meta.url);

    if (!await fs.pathExists(registryPath)) {
        return { pass: true, message: 'No components registered (components.js not found)' };
    }

    try {
        const validation = await validateProject({ projectRoot: getProjectRoot(import.meta.url) });
        const { blocking, advisory } = classifyValidation(validation);
        const summary = `${validation.registeredCount} components, ${validation.routeCount} routes`;

        if (blocking.length > 0) {
            const componentCount = new Set(blocking.map((issue) => issue.component)).size;
            return {
                message: `${blocking.length} issue(s) in ${componentCount} file(s) block "slice build"`,
                suggestion: blocking
                    .slice(0, 5)
                    .map(describeIssue)
                    .join('\n') + (blocking.length > 5 ? `\n… ${blocking.length - 5} more (run "slice build" for the full list)` : ''),
                issues: blocking
            };
        }

        if (advisory.length > 0) {
            return {
                warn: true,
                message: `${summary}, ${advisory.length} warning(s) — none block the build`,
                suggestion: advisory
                    .slice(0, 3)
                    .map(describeIssue)
                    .join('\n') + (advisory.length > 3 ? `\n… ${advisory.length - 3} more` : ''),
                issues: advisory
            };
        }

        return {
            pass: true,
            message: `${summary}, ${validation.checkedCount} with static props: all valid`
        };
    } catch (error) {
        return { warn: true, message: `Cannot check components: ${error.message}` };
    }
}

/** Package root of a bare specifier: 'lodash/fp' -> 'lodash', '@s/p/x' -> '@s/p'. */
function packageRootOf(spec) {
    const parts = spec.split('/');
    return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Collects bare (node_modules) import specifiers from a module's source. */
function extractBareImports(source) {
    const found = new Set();
    const add = (spec) => {
        if (typeof spec === 'string' && ExternalModuleBundler.isBareSpecifier(spec)) found.add(spec);
    };
    try {
        const ast = parseModule(source, { sourceType: 'module', plugins: ['jsx'] });
        traverse.default(ast, {
            ImportDeclaration(p) { add(p.node.source?.value); },
            ExportNamedDeclaration(p) { if (p.node.source) add(p.node.source.value); },
            ExportAllDeclaration(p) { add(p.node.source?.value); },
            CallExpression(p) {
                if (p.node.callee?.type === 'Import' && p.node.arguments?.[0]?.type === 'StringLiteral') {
                    add(p.node.arguments[0].value);
                }
            }
        });
    } catch { /* unparseable → skip */ }
    return found;
}

/**
 * Verifies that every node_modules package imported by a component is actually
 * installed. Bare imports are resolved from node_modules at build/dev time, so a
 * missing package would fail there — this surfaces it early.
 */
async function checkExternalDependencies() {
    const registryPath = getComponentsJsPath(import.meta.url);
    const configPath = getConfigPath(import.meta.url);
    const projectRoot = getProjectRoot(import.meta.url);

    if (!await fs.pathExists(registryPath)) {
        return { pass: true, message: 'No components to check' };
    }

    try {
        const content = await fs.readFile(registryPath, 'utf-8');
        const entries = Object.entries(parseComponentsRegistry(content, registryPath));

        const categoryPathCache = new Map();
        if (await fs.pathExists(configPath)) {
            try {
                const config = await fs.readJson(configPath);
                for (const [cat, catMeta] of Object.entries(config.paths?.components || {})) {
                    categoryPathCache.set(cat, catMeta.path?.replace(/^[/\\]+/, '') || '');
                }
            } catch { /* config issues reported elsewhere */ }
        }

        const usedBy = new Map(); // packageRoot -> Set(component names)
        for (const [compName, meta] of entries) {
            const category = typeof meta === 'string' ? meta : (meta.category || '');
            const relPath = categoryPathCache.get(category);
            if (!relPath) continue;
            const jsPath = getSrcPath(import.meta.url, relPath, compName, `${compName}.js`);
            if (!await fs.pathExists(jsPath)) continue;

            const source = await fs.readFile(jsPath, 'utf-8');
            for (const spec of extractBareImports(source)) {
                const root = packageRootOf(spec);
                if (!usedBy.has(root)) usedBy.set(root, new Set());
                usedBy.get(root).add(compName);
            }
        }

        if (usedBy.size === 0) {
            return { pass: true, message: 'No external (node_modules) imports' };
        }

        const missing = [];
        for (const root of usedBy.keys()) {
            const pkgJson = path.join(projectRoot, 'node_modules', root, 'package.json');
            if (!await fs.pathExists(pkgJson)) missing.push(root);
        }

        if (missing.length === 0) {
            return { pass: true, message: `${usedBy.size} external package(s) imported, all installed` };
        }

        return {
            warn: true,
            message: `${missing.length} imported package(s) not in node_modules: ${missing.sort().join(', ')}`,
            details: missing.sort().map((m) => `Install "${m}" — used by: ${Array.from(usedBy.get(m)).sort().join(', ')}`)
        };
    } catch (error) {
        return { warn: true, message: `Cannot check external dependencies: ${error.message}` };
    }
}

/**
 * Main diagnostic command
 */
export {
    checkNodeVersion,
    checkDirectoryStructure,
    checkConfig,
    checkSeoConfiguration,
    checkPort,
    checkDependencies,
    checkComponents,
    checkExternalDependencies
};

export default async function runDiagnostics() {
    Print.newLine();
    Print.title('🔍 Running Slice.js Diagnostics...');
    Print.newLine();

    const checks = [
        { name: 'Node.js Version', fn: checkNodeVersion },
        { name: 'Project Structure', fn: checkDirectoryStructure },
        { name: 'Configuration', fn: checkConfig },
        { name: 'SEO', fn: checkSeoConfiguration },
        { name: 'Port Availability', fn: checkPort },
        { name: 'Package Manager', fn: checkPackageManagerSetup },
        { name: 'Dependencies', fn: checkDependencies },
        { name: 'Components & Routes', fn: checkComponents },
        { name: 'External Dependencies', fn: checkExternalDependencies }
    ];

    const results = [];

    for (const check of checks) {
        const result = await check.fn();
        results.push({ ...result, name: check.name });
    }

    // Crear tabla de resultados
    const table = new Table({
        head: [chalk.cyan.bold('Check'), chalk.cyan.bold('Status'), chalk.cyan.bold('Details')],
        colWidths: [25, 10, 55],
        style: {
            head: [],
            border: ['gray']
        },
        wordWrap: true
    });

    results.forEach(result => {
        let status;
        if (result.pass) {
            status = chalk.green('✅ PASS');
        } else if (result.warn) {
            status = chalk.yellow('⚠️  WARN');
        } else {
            status = chalk.red('❌ FAIL');
        }

        const details = result.suggestion
            ? `${result.message}\n${chalk.gray('→ ' + result.suggestion)}`
            : result.message;

        table.push([result.name, status, details]);
    });

    console.log(table.toString());

    // Resumen
    const issues = results.filter(r => !r.pass && !r.warn).length;
    const warnings = results.filter(r => r.warn).length;
    const passed = results.filter(r => r.pass).length;

    Print.newLine();
    Print.separator();

    const depsResult = results.find(r => r.name === 'Dependencies');
    if (depsResult && depsResult.warn && Array.isArray(depsResult.missing) && depsResult.missing.length > 0) {
        const projectRoot = getProjectRoot(import.meta.url);
        const pm = resolvePackageManager(projectRoot).name;
        for (const pkg of depsResult.missing) {
            Print.info(`Missing: ${pkg}. Install with: ${installCommand(pm, `${pkg}@latest`)}`);
        }
    }

    if (issues === 0 && warnings === 0) {
        Print.success('All checks passed! 🎉');
        Print.info('Your Slice.js project is correctly configured');
    } else {
        console.log(chalk.bold('📊 Summary:'));
        console.log(chalk.green(`  ✅ Passed: ${passed}`));
        if (warnings > 0) console.log(chalk.yellow(`  ⚠️  Warnings: ${warnings}`));
        if (issues > 0) console.log(chalk.red(`  ❌ Issues: ${issues}`));

        Print.newLine();

        if (issues > 0) {
            Print.warning('Fix the issues above: they block "slice build" and would ship a broken project');
            // A diagnostic command that always exits 0 cannot gate a pipeline.
            process.exitCode = 1;
        } else {
            Print.info('Warnings are non-critical but should be addressed');
        }
    }

    Print.separator();
}
