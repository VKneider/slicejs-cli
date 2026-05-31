import fs from 'fs';
import path from 'path';
import Print from './Print.js';
import { getComponentsJsPath } from './utils/PathHelper.js';
import { loadConfigSync } from './utils/loadConfig.js';

class Validations {
    constructor() {
        this._config = null;
        this._categories = null;
    }

    _ensureConfig() {
        if (!this._config) {
            this._config = this.loadConfig();
            if (this._config) {
                this._categories = this._config.paths?.components;
            }
        }
    }

    get config() {
        this._ensureConfig();
        return this._config;
    }

    isValidComponentName(componentName) {
        // Regex to check if the name contains special characters
        const regex = /^[a-zA-Z][a-zA-Z0-9]*$/;
        return regex.test(componentName);
    }

    loadConfig() {
        return loadConfigSync(import.meta.url);
    }

    getCategories() {
        this._ensureConfig();
        return this._categories;
    }

    getCategoryPath(category) {
        this._ensureConfig();
        return this._categories && this._categories[category] ? this._categories[category].path : null;
    }

    getCategoryType(category) {
        this._ensureConfig();
        return this._categories && this._categories[category] ? this._categories[category].type : null;
    }

    isValidCategory(category) {
        this._ensureConfig();
        if (!this._categories) return { isValid: false, category: null };

        const availableCategories = Object.keys(this._categories).map(cat => cat.toLowerCase());

        if (availableCategories.includes(category.toLowerCase())) {
            return { isValid: true, category };
        } else {
            return { isValid: false, category: null };
        }
    }

    componentExists(componentName) {
        try {
            const componentFilePath = getComponentsJsPath(import.meta.url);

            if (!fs.existsSync(componentFilePath)) {
                Print.error('components.js not found in expected path');
                Print.info('Run "slice component list" to generate components.js');
                return false;
            }

            const fileContent = fs.readFileSync(componentFilePath, 'utf-8');
            const match = fileContent.match(/const components = ({[\s\S]*?});/);
            if (!match) return false;
            const components = JSON.parse(match[1]);

            return components.hasOwnProperty(componentName);

        } catch (error) {
            Print.error(`Error checking component existence: ${error.message}`);
            Print.info('The components.js file may be corrupted');
            return false;
        }
    }
}

const validations = new Validations();

export default validations;
