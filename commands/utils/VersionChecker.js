// commands/utils/VersionChecker.js

import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";
import Print from "../Print.js";
import { getProjectRoot, getPath } from "../utils/PathHelper.js";
import { resolvePackageManager } from "../utils/PackageManager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class VersionChecker {
  constructor() {
    this.currentCliVersion = null;
    this.currentFrameworkVersion = null;
    this.latestCliVersion = null;
    this.latestFrameworkVersion = null;
  }

  async getCurrentVersions() {
    try {
      // Get CLI version
      const cliPackagePath = path.join(__dirname, '../../package.json');
      const cliPackage = await fs.readJson(cliPackagePath);
      this.currentCliVersion = cliPackage.version;

      // Get Framework version from project node_modules
      const projectRoot = getProjectRoot(import.meta.url);
      const frameworkPackagePath = getPath(import.meta.url, 'node_modules', 'slicejs-web-framework', 'package.json');
      if (await fs.pathExists(frameworkPackagePath)) {
        const frameworkPackage = await fs.readJson(frameworkPackagePath);
        this.currentFrameworkVersion = frameworkPackage.version;
      }

      // Get Project's CLI version
      const projectPackagePath = getPath(import.meta.url, 'package.json');
      if (await fs.pathExists(projectPackagePath)) {
        const projectPackage = await fs.readJson(projectPackagePath);
        if (projectPackage.dependencies && projectPackage.dependencies['slicejs-cli']) {
          // This could be different from the currently running CLI version
        }
      }

      return {
        cli: this.currentCliVersion,
        framework: this.currentFrameworkVersion
      };
    } catch (error) {
      return null;
    }
  }

  async getLatestVersions() {
    try {
      // Check CLI version
      const cliResponse = await fetch('https://registry.npmjs.org/slicejs-cli/latest', {
        headers: { 'Accept': 'application/json' }
      });
      
      if (cliResponse.ok) {
        const cliData = await cliResponse.json();
        this.latestCliVersion = cliData.version;
      }

      // Check Framework version  
      const frameworkResponse = await fetch('https://registry.npmjs.org/slicejs-web-framework/latest', {
        headers: { 'Accept': 'application/json' }
      });
      
      if (frameworkResponse.ok) {
        const frameworkData = await frameworkResponse.json();
        this.latestFrameworkVersion = frameworkData.version;
      }

      return {
        cli: this.latestCliVersion,
        framework: this.latestFrameworkVersion
      };
    } catch (error) {
      // Silent fail - don't interrupt commands for version check failures
      return null;
    }
  }

  compareVersions(current, latest) {
    if (!current || !latest) return null;
    
    const currentParts = current.split('.').map(Number);
    const latestParts = latest.split('.').map(Number);
    
    for (let i = 0; i < Math.max(currentParts.length, latestParts.length); i++) {
      const currentPart = currentParts[i] || 0;
      const latestPart = latestParts[i] || 0;
      
      if (latestPart > currentPart) return 'outdated';
      if (currentPart > latestPart) return 'newer';
    }
    
    return 'current';
  }

  async checkForUpdates(silent = false) {
    try {
      const current = await this.getCurrentVersions();
      if (!current) return;

      const latest = await this.getLatestVersions();
      if (!latest) return;

      const cliStatus = this.compareVersions(current.cli, latest.cli);
      const frameworkStatus = this.compareVersions(current.framework, latest.framework);

      if (!silent && (cliStatus === 'outdated' || frameworkStatus === 'outdated')) {
        const pm = resolvePackageManager(getProjectRoot(import.meta.url)).name;
        console.log(''); // Line break
        Print.warning('📦 Available Updates:');

        if (cliStatus === 'outdated') {
          console.log(`   🔧 CLI: ${current.cli} → ${latest.cli}`);
          console.log(`       ${pm} update slicejs-cli`);
        }

        if (frameworkStatus === 'outdated') {
          console.log(`   ⚡ Framework: ${current.framework} → ${latest.framework}`);
          console.log(`       ${pm} update slicejs-web-framework`);
        }
        
        console.log('   📚 Changelog: https://github.com/VKneider/slice.js/releases');
        console.log(''); // Line break
      }

      return {
        cli: { current: current.cli, latest: latest.cli, status: cliStatus },
        framework: { current: current.framework, latest: latest.framework, status: frameworkStatus }
      };

    } catch (error) {
      // Silent fail - don't interrupt commands
      return null;
    }
  }

  async showVersionInfo() {
    const current = await this.getCurrentVersions();
    const latest = await this.getLatestVersions();
    
    console.log('\n📋 Version Information:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    if (current?.cli) {
      const cliStatus = this.compareVersions(current.cli, latest?.cli);
      const statusIcon = cliStatus === 'current' ? '✅' : cliStatus === 'outdated' ? '🔄' : '🆕';
      console.log(`${statusIcon} CLI: v${current.cli}${latest?.cli && latest.cli !== current.cli ? ` (latest: v${latest.cli})` : ''}`);
    }
    
    if (current?.framework) {
      const frameworkStatus = this.compareVersions(current.framework, latest?.framework);
      const statusIcon = frameworkStatus === 'current' ? '✅' : frameworkStatus === 'outdated' ? '🔄' : '🆕';
      console.log(`${statusIcon} Framework: v${current.framework}${latest?.framework && latest.framework !== current.framework ? ` (latest: v${latest.framework})` : ''}`);
    }
    
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  }
}

// Singleton instance
const versionChecker = new VersionChecker();

export default versionChecker;
