import fs from 'fs';
import path from 'path';
import Table from 'cli-table3';
import chalk from 'chalk';
import Print from '../Print.js';
import { getSrcPath, getComponentsJsPath, getConfigPath } from '../utils/PathHelper.js';

/**
 * Loads configuration from sliceConfig.json
 * @returns {object} - Configuration object
 */
const loadConfig = () => {
    try {
        const configPath = getConfigPath(import.meta.url);
        if (!fs.existsSync(configPath)) {
            Print.error('sliceConfig.json not found');
            Print.info('Run "slice init" to initialize your project');
            return null;
        }
        const rawData = fs.readFileSync(configPath, 'utf-8');
        return JSON.parse(rawData);
    } catch (error) {
        Print.error(`Failed to load configuration: ${error.message}`);
        Print.info('Check that sliceConfig.json is valid JSON');
        return null;
    }
};

/**
 * Lists files in a given folder, filtering only .js files
 * @param {string} folderPath - Path of the folder to read
 * @returns {string[]} - List of found files
 */
const listComponents = (folderPath) => {
    try {
        if (!fs.existsSync(folderPath)) {
            return [];
        }
        const result = fs.readdirSync(folderPath);
        return result;
    } catch (error) {
        Print.error(`Failed to read directory ${folderPath}: ${error.message}`);
        return [];
    }
};

/**
 * Counts files in a component directory
 */
const countComponentFiles = (componentPath) => {
    try {
        if (!fs.existsSync(componentPath)) return 0;
        const files = fs.readdirSync(componentPath);
        return files.filter(f => fs.statSync(path.join(componentPath, f)).isFile()).length;
    } catch {
        return 0;
    }
};

/**
 * Gets components dynamically from sliceConfig.json
 * @returns {object} - Component mapping with their category
 */
const getComponents = () => {
    const config = loadConfig();
    if (!config) return {};

    const folderSuffix = 'src'; // Always use 'src' for development
    const componentPaths = config.paths?.components || {};
    let allComponents = new Map();

    Object.entries(componentPaths).forEach(([category, { path: folderPath }]) => {
        const cleanFolderPath = folderPath ? folderPath.replace(/^[/\\]+/, '') : '';
        const fullPath = getSrcPath(import.meta.url, cleanFolderPath);
        const files = listComponents(fullPath);

        files.forEach(file => {
            const componentPath = path.join(fullPath, file);
            if (fs.statSync(componentPath).isDirectory()) {
                const fileCount = countComponentFiles(componentPath);
                allComponents.set(file, { category, files: fileCount });
            }
        });
    });

    return Object.fromEntries(allComponents);
};

function listComponentsReal() {
    try {
        // Get components dynamically
        const components = getComponents();

        if (Object.keys(components).length === 0) {
            Print.warning('No components found in your project');
            Print.info('Create your first component with "slice component create"');
            return;
        }

        // Create table with cli-table3
        const table = new Table({
            head: [
                chalk.cyan.bold('Component'),
                chalk.cyan.bold('Category'),
                chalk.cyan.bold('Files')
            ],
            colWidths: [30, 20, 10],
            style: {
                head: [],
                border: ['gray']
            }
        });

        // Group by category for better visualization
        const byCategory = {};
        Object.entries(components).forEach(([name, data]) => {
            if (!byCategory[data.category]) {
                byCategory[data.category] = [];
            }
            byCategory[data.category].push({ name, files: data.files });
        });

        // Add rows to the table
        Object.entries(byCategory).forEach(([category, comps]) => {
            comps.forEach((comp, index) => {
                if (index === 0) {
                    // First row of the category
                    table.push([
                        chalk.bold(comp.name),
                        chalk.yellow(category),
                        comp.files.toString()
                    ]);
                } else {
                    // Rest of components in the category
                    table.push([
                        chalk.bold(comp.name),
                        chalk.gray('″'),  // Ditto mark
                        comp.files.toString()
                    ]);
                }
            });
        });

        Print.newLine();
        Print.title('📦 Local Components');
        Print.newLine();
        console.log(table.toString());
        Print.newLine();
        Print.info(`Total: ${Object.keys(components).length} component${Object.keys(components).length !== 1 ? 's' : ''} found`);

        // Path where components.js will be generated
        const outputPath = getComponentsJsPath(import.meta.url);

        // Ensure the directory exists
        const outputDir = path.dirname(outputPath);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        // Generate components.js file with detected components
        const componentsForExport = Object.fromEntries(
            Object.entries(components).map(([name, data]) => [name, data.category])
        );
        fs.writeFileSync(outputPath, `const components = ${JSON.stringify(componentsForExport, null, 2)};\n\nexport default components;\n`);

    } catch (error) {
        Print.error(`Failed to list components: ${error.message}`);
        Print.info('Make sure your project structure is correct');
    }
}

export default listComponentsReal;
