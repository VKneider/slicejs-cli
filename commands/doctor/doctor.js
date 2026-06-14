import fs from 'fs-extra';
import path from 'path';
import { createServer } from 'net';
import chalk from 'chalk';
import Table from 'cli-table3';
import Print from '../Print.js';
import { getProjectRoot, getSrcPath, getApiPath, getConfigPath, getPath, getComponentsJsPath } from '../utils/PathHelper.js';
import { resolvePackageManager, installCommand } from '../utils/PackageManager.js';
import updateManager from '../utils/updateManager.js';
import { parseComponentsRegistry, extractStaticPropsFromSource } from '../types/types.js';

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
 * Checks component integrity
 */
async function checkComponents() {
    const configPath = getConfigPath(import.meta.url);
        const projectRoot = getProjectRoot(import.meta.url);

    if (!await fs.pathExists(configPath)) {
        return {
            warn: true,
            message: 'Cannot check components (no config)',
            suggestion: 'Run "slice init" first'
        };
    }

    try {
        const config = await fs.readJson(configPath);
        const componentPaths = config.paths?.components || {};

        let totalComponents = 0;
        let componentIssues = 0;

        for (const [category, { path: compPath }] of Object.entries(componentPaths)) {
            const fullPath = getSrcPath(import.meta.url, compPath);

            if (await fs.pathExists(fullPath)) {
                const items = await fs.readdir(fullPath);

                for (const item of items) {
                    const itemPath = path.join(fullPath, item);
                    const stat = await fs.stat(itemPath);

                    if (stat.isDirectory()) {
                        totalComponents++;

                        // Check JS files
                        const jsFile = path.join(itemPath, `${item}.js`);
                        if (!await fs.pathExists(jsFile)) {
                            componentIssues++;
                        }
                    }
                }
            }
        }

        if (componentIssues === 0) {
            return {
                pass: true,
                message: `${totalComponents} components checked, all OK`
            };
        } else {
            return {
                warn: true,
                message: `${componentIssues} component(s) have missing files`,
                suggestion: 'Check your component directories'
            };
        }
    } catch (error) {
        return {
            warn: true,
            message: `Cannot check components: ${error.message}`,
            suggestion: 'Verify your project structure'
        };
    }
}

/**
 * Lints component static props for common issues.
 * Uses the same Babel parsing as slice types generate.
 */
async function checkComponentProps() {
  const issues = [];
  const registryPath = getComponentsJsPath(import.meta.url);
  const configPath = getConfigPath(import.meta.url);

  if (!await fs.pathExists(registryPath)) {
    return { pass: true, message: 'No components to check' };
  }

  try {
    const content = await fs.readFile(registryPath, 'utf-8');
    const registryMap = parseComponentsRegistry(content, registryPath);
    const entries = Object.entries(registryMap);

    if (entries.length === 0) {
      return { pass: true, message: 'No components registered' };
    }

    // Build a category-to-path map from sliceConfig.json
    const categoryPathCache = new Map();
    if (await fs.pathExists(configPath)) {
      try {
        const config = await fs.readJson(configPath);
        if (config.paths?.components) {
          for (const [cat, catMeta] of Object.entries(config.paths.components)) {
            categoryPathCache.set(cat, catMeta.path?.replace(/^[/\\]+/, '') || '');
          }
        }
      } catch {}
    }

    const VALID_TYPES = new Set(['string', 'number', 'boolean', 'object', 'array', 'function', 'any']);
    const checked = [];

    for (const [compName, meta] of entries) {
      const category = typeof meta === 'string' ? meta : (meta.category || '');
      const relPath = categoryPathCache.get(category);
      if (!relPath) continue;
      const jsPath = getSrcPath(import.meta.url, relPath, compName, `${compName}.js`);

      if (!await fs.pathExists(jsPath)) {
        continue;
      }

      const source = await fs.readFile(jsPath, 'utf-8');
      const props = extractStaticPropsFromSource(source, jsPath);
      if (!props) continue;

      checked.push(compName);

      for (const [propName, propMeta] of Object.entries(props)) {
        if (propMeta.type === 'any') {
          issues.push({ component: compName, prop: propName, message: `"${propName}" uses type "any" — specify a concrete type` });
        }
        if (propMeta.required && propMeta.type !== 'boolean') {
          issues.push({ component: compName, prop: propName, message: `"${propName}" is required but has no default value` });
        }
        if (propMeta.schema && propMeta.type !== 'object') {
          issues.push({ component: compName, prop: propName, message: `"${propName}" has "schema" but type is "${propMeta.type}" (should be "object")` });
        }
        if (propMeta.items && propMeta.type !== 'array') {
          issues.push({ component: compName, prop: propName, message: `"${propName}" has "items" but type is "${propMeta.type}" (should be "array")` });
        }
        if (!VALID_TYPES.has(propMeta.type)) {
          issues.push({ component: compName, prop: propName, message: `"${propName}" has unknown type "${propMeta.type}"` });
        }
        if (Array.isArray(propMeta.allowedValues) && propMeta.allowedValues.length > 0) {
          const typeMismatch = propMeta.allowedValues.some(v => typeof v !== propMeta.type);
          if (typeMismatch && propMeta.type !== 'any') {
            issues.push({ component: compName, prop: propName, message: `"${propName}" allowedValues type mismatch (expected ${propMeta.type})` });
          }
        }
      }
    }

    if (issues.length === 0) {
      return { pass: true, message: `${checked.length} components checked, props look good` };
    }

    return {
      warn: true,
      message: `${issues.length} prop issue(s) across ${new Set(issues.map(i => i.component)).size} component(s)`,
      suggestion: issues.map(i => `  ${i.component}.${i.prop}: ${i.message}`).join('\n'),
      issues
    };
  } catch (error) {
    return { warn: true, message: `Cannot check props: ${error.message}` };
  }
}

/**
 * Main diagnostic command
 */
export {
    checkNodeVersion,
    checkDirectoryStructure,
    checkConfig,
    checkPort,
    checkDependencies,
    checkComponents,
    checkComponentProps
};

export default async function runDiagnostics() {
    Print.newLine();
    Print.title('🔍 Running Slice.js Diagnostics...');
    Print.newLine();

    const checks = [
        { name: 'Node.js Version', fn: checkNodeVersion },
        { name: 'Project Structure', fn: checkDirectoryStructure },
        { name: 'Configuration', fn: checkConfig },
        { name: 'Port Availability', fn: checkPort },
        { name: 'Package Manager', fn: checkPackageManagerSetup },
        { name: 'Dependencies', fn: checkDependencies },
        { name: 'Components', fn: checkComponents },
        { name: 'Component Props', fn: checkComponentProps }
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
            Print.warning('Fix the issues above to ensure proper functionality');
        } else {
            Print.info('Warnings are non-critical but should be addressed');
        }
    }

    Print.separator();
}
