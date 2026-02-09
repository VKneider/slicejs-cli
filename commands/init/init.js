import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import ora from 'ora';
import Print from '../Print.js';
import { getProjectRoot, getApiPath, getSrcPath } from '../utils/PathHelper.js';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Importar la clase ComponentRegistry del getComponent
import { ComponentRegistry } from '../getComponent/getComponent.js';

export default async function initializeProject(projectType) {
    try {
        const projectRoot = getProjectRoot(import.meta.url);
        const destinationApi = getApiPath(import.meta.url);
        const destinationSrc = getSrcPath(import.meta.url);

        const fwSpinner = ora('Ensuring latest Slice framework...').start();
        let latestVersion = null;
        let sliceBaseDir;
        try {
            const latest = execSync('npm view slicejs-web-framework version', { cwd: projectRoot }).toString().trim();
            latestVersion = latest;
            const installedPkgPath = path.join(projectRoot, 'node_modules', 'slicejs-web-framework', 'package.json');
            let installed = null;
            if (await fs.pathExists(installedPkgPath)) {
                const pkg = await fs.readJson(installedPkgPath);
                installed = pkg.version;
            }
            if (installed !== latest) {
                execSync(`npm install slicejs-web-framework@${latest} --save`, { cwd: projectRoot, stdio: 'inherit' });
            }
            sliceBaseDir = path.join(projectRoot, 'node_modules', 'slicejs-web-framework');
            fwSpinner.succeed(`slicejs-web-framework@${latest} ready`);
        } catch (err) {
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

        const apiDir = path.join(sliceBaseDir, 'api');
        const srcDir = path.join(sliceBaseDir, 'src');

        try {
            if (fs.existsSync(destinationApi)) throw new Error(`The "api" directory already exists: ${destinationApi}`);
            if (fs.existsSync(destinationSrc)) throw new Error(`The "src" directory already exists: ${destinationSrc}`);
        } catch (error) {
            Print.error('Validating destination directories:', error.message);
            return;
        }

        // 1. COPIAR LA CARPETA API (mantener lógica original)
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

        // 2. CREAR ESTRUCTURA SRC BÁSICA (sin copiar componentes Visual)
        const srcSpinner = ora('Creating src structure...').start();
        try {
            if (!fs.existsSync(srcDir)) throw new Error(`src folder not found: ${srcDir}`);

            // Copiar solo los archivos base de src, excluyendo Components/Visual
            await fs.ensureDir(destinationSrc);

            // Copiar archivos y carpetas de src excepto Components/Visual
            const srcItems = await fs.readdir(srcDir);

            for (const item of srcItems) {
                const srcItemPath = path.join(srcDir, item);
                const destItemPath = path.join(destinationSrc, item);
                const stat = await fs.stat(srcItemPath);

                if (stat.isDirectory()) {
                    if (item === 'Components') {
                        // Crear estructura de Components pero sin copiar Visual
                        await fs.ensureDir(destItemPath);

                        const componentItems = await fs.readdir(srcItemPath);
                        for (const componentItem of componentItems) {
                            const componentItemPath = path.join(srcItemPath, componentItem);
                            const destComponentItemPath = path.join(destItemPath, componentItem);

                            if (componentItem !== 'Visual') {
                                // Copy Service and other component types
                                await fs.copy(componentItemPath, destComponentItemPath, { recursive: true });
                            } else {
                                // Only create empty Visual directory
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

        // 3. DESCARGAR TODOS LOS COMPONENTES VISUAL DESDE EL REPOSITORIO OFICIAL
        const componentsSpinner = ora('Loading component registry...').start();
        try {
            const registry = new ComponentRegistry();
            await registry.loadRegistry();

            // Obtener TODOS los componentes Visual disponibles
            const allVisualComponents = await getAllVisualComponents(registry);

            if (allVisualComponents.length > 0) {
                componentsSpinner.text = `Installing ${allVisualComponents.length} Visual components...`;

                const results = await registry.installMultipleComponents(
                    allVisualComponents,
                    'Visual',
                    true // force = true para instalación inicial
                );

                const successful = results.filter(r => r.success).length;
                const failed = results.filter(r => !r.success).length;

                if (successful > 0 && failed === 0) {
                    componentsSpinner.succeed(`All ${successful} Visual components installed successfully`);
                } else if (successful > 0) {
                componentsSpinner.warn(`${successful} components installed, ${failed} failed`);
                Print.info('You can install failed components later using "slice get <component-name>"');
            } else {
                componentsSpinner.fail('Failed to install Visual components');
            }
        } else {
            componentsSpinner.warn('No Visual components found in registry');
            Print.info('You can add components later using "slice get <component-name>"');
        }

        } catch (error) {
            componentsSpinner.fail('Could not download Visual components from official repository');
            Print.error(`Repository error: ${error.message}`);
            Print.info('Project initialized without Visual components');
            Print.info('You can add them later using "slice get <component-name>"');
        }

        // 4. CONFIGURAR SCRIPTS EN package.json DEL PROYECTO
        const pkgSpinner = ora('Configuring npm scripts...').start();
        try {
            const projectRoot = getProjectRoot(import.meta.url);
            const pkgPath = path.join(projectRoot, 'package.json');

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

            // Comandos principales
            pkg.scripts['dev'] = 'slice dev';
            pkg.scripts['start'] = 'slice start';

            // Gestión de componentes
            pkg.scripts['component:create'] = 'slice component create';
            pkg.scripts['component:list'] = 'slice component list';
            pkg.scripts['component:delete'] = 'slice component delete';

            // Atajos de repositorio
            pkg.scripts['get'] = 'slice get';
            pkg.scripts['browse'] = 'slice browse';
            pkg.scripts['sync'] = 'slice sync';

            // Utilidades
            pkg.scripts['slice:version'] = 'slice version';
            pkg.scripts['slice:update'] = 'slice update';

            // Legacy (compatibilidad)
            pkg.scripts['slice:init'] = 'slice init';
            pkg.scripts['slice:start'] = 'slice start';
            pkg.scripts['slice:dev'] = 'slice dev';
            pkg.scripts['slice:create'] = 'slice component create';
            pkg.scripts['slice:list'] = 'slice component list';
            pkg.scripts['slice:delete'] = 'slice component delete';
            pkg.scripts['slice:get'] = 'slice get';
            pkg.scripts['slice:browse'] = 'slice browse';
            pkg.scripts['slice:sync'] = 'slice sync';
            pkg.scripts['run'] = 'slice dev';

            // Configuración de módulo
            pkg.type = pkg.type || 'module';
            pkg.engines = pkg.engines || { node: '>=20.0.0' };

            // Ensure framework dependency is present
            if (!pkg.dependencies['slicejs-web-framework']) {
                pkg.dependencies['slicejs-web-framework'] = latestVersion ? latestVersion : 'latest';
            }

            await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2), 'utf8');
            pkgSpinner.succeed('npm scripts configured successfully');

            console.log('\n🎯 New recommended commands:');
            console.log('  npm run dev            - Start development server');
            console.log('  npm run get            - Install components');
            console.log('  npm run browse         - Browse components');
        } catch (error) {
        pkgSpinner.fail('Failed to configure npm scripts');
        Print.error(error.message);
        }

        Print.success('Project initialized successfully.');
        Print.newLine();
        Print.info('Next steps:');
        console.log('  slice browse          - View available components');
        console.log('  slice get Button      - Install specific components');
        console.log('  slice sync            - Update all components to latest versions');

    } catch (error) {
        Print.error('Unexpected error initializing project:', error.message);
    }
}

/**
 * Obtiene TODOS los componentes Visual disponibles en el registry
 * @param {ComponentRegistry} registry - Instancia del registry cargado
 * @returns {Array} - Array con todos los nombres de componentes Visual
 */
async function getAllVisualComponents(registry) {
    const availableComponents = registry.getAvailableComponents('Visual');
    const allVisualComponents = Object.keys(availableComponents);

    Print.info(`Found ${allVisualComponents.length} Visual components in official repository`);

    return allVisualComponents;
}
