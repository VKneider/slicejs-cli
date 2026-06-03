import fs from 'fs-extra';
import path from 'path';
import Validations from '../Validations.js';
import Print from '../Print.js';
import { fileURLToPath } from 'url';
import { getSrcPath } from '../utils/PathHelper.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function deleteComponent(componentName, category) {
    // Validation: Component name is required
    if (!componentName) {
        Print.error('Component name is required to delete');
        Print.commandExample("Delete a component", "slice component delete");
        return false;
    }

    // Validation: Valid component name
    if (!Validations.isValidComponentName(componentName)) {
        Print.error(`Invalid component name: '${componentName}'`);
        Print.info('Component name must start with a letter and contain only alphanumeric characters');
        return false;
    }

    // Components follow a PascalCase convention: normalize the initial so the
    // lookup matches the folder name created by `slice component create`.
    componentName = componentName.charAt(0).toUpperCase() + componentName.slice(1);

    // Validation: Valid category
    let flagCategory = Validations.isValidCategory(category);

    if (!flagCategory.isValid) {
        Print.error(`Invalid category: '${category}'`);
        const availableCategories = Object.keys(Validations.getCategories()).join(', ');
        Print.info(`Available categories: ${availableCategories}`);
        return false;
    }
    category = flagCategory.category;
    
    const categoryPath = Validations.getCategoryPath(category);
    const categoryPathClean = categoryPath ? categoryPath.replace(/^[/\\]+/, '') : '';
    const componentDir = getSrcPath(import.meta.url, categoryPathClean, componentName);

    // Check if component directory exists
    if (!fs.existsSync(componentDir)) {
        Print.error(`Component '${componentName}' does not exist in category '${category}'`);
        Print.info('Make sure you selected the correct category');
        Print.commandExample("List components", "slice component list");
        return false;
    }

    // Verify it's a directory
    try {
        const stats = fs.statSync(componentDir);
        if (!stats.isDirectory()) {
            Print.error(`'${componentName}' is not a valid component directory`);
            Print.info('Components must be stored in directories');
            return false;
        }
    } catch (error) {
        Print.error(`Failed to access component directory: '${componentDir}'`);
        Print.info(`Error details: ${error.message}`);
        return false;
    }

    // Try to delete the component directory and its contents
    try {
        const files = fs.readdirSync(componentDir);
        Print.info(`Deleting ${files.length} file(s) from component directory...`);
        
        fs.removeSync(componentDir);
        return true;
    } catch (error) {
        Print.error(`Failed to delete component '${componentName}'`);
        Print.info(`Error details: ${error.message}`);
        Print.warning('You may need to delete the component files manually');
        Print.info(`Component location: ${componentDir}`);
        return false;
    }
}

export default deleteComponent;
