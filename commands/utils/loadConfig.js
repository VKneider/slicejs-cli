import fs from 'fs-extra';
import { getConfigPath } from './PathHelper.js';
import Print from '../Print.js';

export async function loadConfig(moduleUrl) {
  try {
    const configPath = getConfigPath(moduleUrl);
    if (!await fs.pathExists(configPath)) {
      return null;
    }
    const rawData = await fs.readFile(configPath, 'utf-8');
    return JSON.parse(rawData);
  } catch (error) {
    Print.error(`Error loading configuration: ${error.message}`);
    return null;
  }
}

export function loadConfigSync(moduleUrl) {
  try {
    const configPath = getConfigPath(moduleUrl);
    if (!fs.existsSync(configPath)) {
      return null;
    }
    const rawData = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(rawData);
  } catch (error) {
    Print.error(`Error loading configuration: ${error.message}`);
    return null;
  }
}
