
import componentTemplates from './VisualComponentTemplate.js';
import fs from 'fs-extra';
import path from 'path';
import Validations from '../Validations.js';
import Print from '../Print.js';
import { getSrcPath } from '../utils/PathHelper.js';

function createComponent(componentName, category) {
    // Validation: Component name is required
    if (!componentName) {
        Print.error('Component name is required');
        Print.commandExample("Create a component", "slice component create");
        return false;
    }

    // Validation: Valid component name
    if (!Validations.isValidComponentName(componentName)) {
        Print.error(`Invalid component name: '${componentName}'`);
        Print.info('Component name must start with a letter and contain only alphanumeric characters');
        Print.commandExample("Valid names", "Button, UserCard, NavBar");
        Print.commandExample("Invalid names", "1Button, user-card, Nav_Bar");
        return false;
    }

    // Components follow a PascalCase convention: normalize the initial to
    // uppercase so the folder name, registry entry and existence checks agree.
    componentName = componentName.charAt(0).toUpperCase() + componentName.slice(1);

    // Validation: Component already exists
    if(Validations.componentExists(componentName)){
        Print.error(`Component '${componentName}' already exists in your project`);
        Print.info('Please use a different name or delete the existing component first');
        Print.commandExample("Delete component", "slice component delete");
        return false;
    }

    // Validation: Valid category
    let flagCategory = Validations.isValidCategory(category);

    if (!flagCategory.isValid) {
        Print.error(`Invalid category: '${category}'`);
        const availableCategories = Object.keys(Validations.getCategories()).join(', ');
        Print.info(`Available categories: ${availableCategories}`);
        return false;
    }
    category = flagCategory.category;

    // Create class name and file name (componentName is already PascalCase).
    const className = componentName;
    const fileName = `${className}.js`;
    let template;

    const type = Validations.getCategoryType(category);

    // Generate template based on type
    if(type === 'Visual'){
       template = componentTemplates.visual(className);
    } else if(type === 'Service'){
         template = componentTemplates.service(className);
    } else {
        Print.error(`Unsupported component type: '${type}'`);
        Print.info('Only Visual and Service components are currently supported');
        return false;
    }

    const categoryPath = Validations.getCategoryPath(category);
    const categoryPathClean = categoryPath ? categoryPath.replace(/^[/\\]+/, '') : '';
    const componentDir = getSrcPath(import.meta.url, categoryPathClean, className);
    
    try {
        // Create component directory
        fs.ensureDirSync(componentDir);
    } catch (error) {
        Print.error(`Failed to create component directory: '${componentDir}'`);
        Print.info(`Error details: ${error.message}`);
        return false;
    }

    // Determine the file path
    let componentPath = path.join(componentDir, fileName);

    // Verify if the file already exists (double check)
    if (fs.existsSync(componentPath)) {
        Print.error(`Component file already exists at: '${componentPath}'`);
        Print.info('This component may have been created outside the CLI');
        return false;
    }

    try {
        // Write component code to file
        fs.writeFileSync(componentPath, template);

        // If Visual, create additional files (CSS and HTML)
        if(type === 'Visual'){
            const cssPath = path.join(componentDir, `${className}.css`);
            const htmlPath = path.join(componentDir, `${className}.html`);
            
            fs.writeFileSync(cssPath, '/* Styles for ' + componentName + ' component */\n');
            fs.writeFileSync(htmlPath, `<div class="${componentName.toLowerCase()}">\n  ${componentName}\n</div>`);
            
            Print.info(`Created files: ${fileName}, ${className}.css, ${className}.html`);
        } else {
            Print.info(`Created file: ${fileName}`);
        }

        return true;
    } catch (error) {
        Print.error(`Failed to create component files`);
        Print.info(`Error details: ${error.message}`);
        
        // Try to clean up partially created files
        try {
            if (fs.existsSync(componentDir)) {
                fs.removeSync(componentDir);
                Print.info('Cleaned up partial files');
            }
        } catch (cleanupError) {
            Print.warning('Could not clean up partial files. You may need to delete them manually');
        }
        
        return false;
    }
}


export default createComponent;

