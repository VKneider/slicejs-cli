// commands/skill/skill.js
//
// Installs the Slice.js Claude Code skill (slice-js-developer) into a project's
// .claude/skills/ folder by fetching it from the docs repo. The docs repo is the
// single source of truth; a manifest.json there lists the version, the framework
// compatibility range, and the exact file list to copy — so nothing drifts.

import fs from "fs-extra";
import path from "path";
import inquirer from "inquirer";
import ora from "ora";
import Print from "../Print.js";
import { getProjectRoot } from "../utils/PathHelper.js";
import { fetchWithRetry, runConcurrent } from "../getComponent/getComponent.js";

// Canonical home: VKneider/slicejs_docs → /skill. The MCP already sources docs
// from this same repo, keeping the skill co-located with what it distills.
// Override with SLICE_SKILL_REPO_BASE_URL (a fork, a branch, or a local server for testing).
const SKILL_REPO_BASE_URL =
  process.env.SLICE_SKILL_REPO_BASE_URL ||
  "https://raw.githubusercontent.com/VKneider/slicejs_docs/master/skill";
const MANIFEST_URL = `${SKILL_REPO_BASE_URL}/manifest.json`;

async function fetchManifest() {
  const raw = await fetchWithRetry(MANIFEST_URL, 3, 500, false);
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    throw new Error("skill manifest is not valid JSON");
  }
  if (!manifest.name || !manifest.version || !Array.isArray(manifest.files) || !manifest.installPath) {
    throw new Error("skill manifest is missing required fields (name, version, installPath, files)");
  }
  // The manifest is fetched over the network and drives where files get written.
  // Never let it escape the install directory: reject absolute paths and any ".."
  // segment in installPath or in a file entry (path-traversal hardening).
  const unsafe = (p) =>
    typeof p !== "string" || p.length === 0 || path.isAbsolute(p) || p.split(/[\\/]+/).includes("..");
  if (unsafe(manifest.installPath)) {
    throw new Error(`unsafe installPath in manifest: "${manifest.installPath}"`);
  }
  const badFile = manifest.files.find(unsafe);
  if (badFile !== undefined) {
    throw new Error(`unsafe file path in manifest: "${badFile}"`);
  }
  return manifest;
}

// The skill's own VERSION file is the source of truth for what's installed.
function readLocalVersion(installDir) {
  const versionPath = path.join(installDir, "VERSION");
  if (!fs.pathExistsSync(versionPath)) return null;
  const raw = fs.readFileSync(versionPath, "utf8");
  const line = raw.split("\n").find((l) => l.trim().toLowerCase().startsWith("version:"));
  return line ? line.slice(line.indexOf(":") + 1).trim() : null;
}

// First integer in a version-ish string ("4.0.1" / "^4.0.x" → 4).
function majorOf(value) {
  const m = String(value || "").match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// Best-effort read of the installed framework version (real installed wins over
// a declared range). Returns null when it can't be determined.
function detectFrameworkVersion(projectRoot) {
  const installed = path.join(projectRoot, "node_modules", "slicejs-web-framework", "package.json");
  if (fs.pathExistsSync(installed)) {
    try {
      return JSON.parse(fs.readFileSync(installed, "utf8")).version;
    } catch {
      /* fall through */
    }
  }
  const projectPkg = path.join(projectRoot, "package.json");
  if (fs.pathExistsSync(projectPkg)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(projectPkg, "utf8"));
      return (pkg.dependencies && pkg.dependencies["slicejs-web-framework"]) ||
        (pkg.devDependencies && pkg.devDependencies["slicejs-web-framework"]) ||
        null;
    } catch {
      /* fall through */
    }
  }
  return null;
}

// Soft compatibility gate: warns on a major mismatch, never blocks.
function reportCompatibility(manifest, projectRoot) {
  const fw = detectFrameworkVersion(projectRoot);
  if (!fw) {
    Print.info("Could not detect slicejs-web-framework in this project — skipping compatibility check.");
    return;
  }
  const targetMajor = majorOf(manifest.targets);
  const fwMajor = majorOf(fw);
  if (targetMajor != null && fwMajor != null && targetMajor !== fwMajor) {
    Print.warning(
      `Skill v${manifest.version} targets ${manifest.targets}, but this project uses slicejs-web-framework@${fw}. ` +
      `Installing anyway — verify the guidance matches your framework version.`
    );
  } else {
    Print.info(`Compatible with slicejs-web-framework@${fw} (targets ${manifest.targets}).`);
  }
}

async function downloadSkillFiles(manifest, installDir) {
  const total = manifest.files.length;
  let done = 0;
  const failed = [];
  const spinner = ora(`Downloading skill 0/${total}`).start();
  const worker = async (file) => {
    const url = `${SKILL_REPO_BASE_URL}/${manifest.name}/${file}`;
    const dest = path.join(installDir, file);
    try {
      const content = await fetchWithRetry(url, 3, 500, false);
      await fs.ensureDir(path.dirname(dest));
      await fs.writeFile(dest, content, "utf8");
    } catch {
      failed.push(file);
    } finally {
      done += 1;
      spinner.text = `Downloading skill ${done}/${total}`;
    }
  };
  await runConcurrent(manifest.files, worker, 4);
  spinner.stop();
  return failed;
}

// Install (or reinstall) the skill. `force` skips the overwrite prompt.
async function addSkill(options = {}) {
  const projectRoot = getProjectRoot(import.meta.url);

  let manifest;
  try {
    manifest = await fetchManifest();
  } catch (error) {
    Print.error(`Could not load the skill manifest from the docs repository: ${error.message}`);
    Print.info("Check your internet connection and try again.");
    return false;
  }

  const installDir = path.join(projectRoot, manifest.installPath);
  const localVersion = readLocalVersion(installDir);

  if (await fs.pathExists(installDir) && !options.force) {
    if (localVersion === manifest.version) {
      Print.info(`Skill '${manifest.name}' v${manifest.version} is already installed and up to date.`);
      Print.commandExample("Reinstall anyway", "slice skill add --force");
      return true;
    }
    const { overwrite } = await inquirer.prompt([
      {
        type: "confirm",
        name: "overwrite",
        message: localVersion
          ? `Skill '${manifest.name}' v${localVersion} is installed; replace it with v${manifest.version}?`
          : `'${manifest.installPath}' already exists; overwrite it with skill v${manifest.version}?`,
        default: true,
      },
    ]);
    if (!overwrite) {
      Print.info("Installation cancelled.");
      return false;
    }
  }

  reportCompatibility(manifest, projectRoot);

  const failed = await downloadSkillFiles(manifest, installDir);
  if (failed.length === manifest.files.length) {
    Print.error("Failed to download the skill — no files were written.");
    return false;
  }
  if (failed.length > 0) {
    Print.warning(`Some files couldn't be downloaded: ${failed.join(", ")}`);
  }

  Print.success(`Skill '${manifest.name}' v${manifest.version} installed at ${manifest.installPath}/`);
  Print.info("Reload Claude Code (or restart the session) to pick up the skill.");
  return true;
}

// Update = install the latest, replacing an existing copy without prompting.
async function updateSkill(options = {}) {
  const projectRoot = getProjectRoot(import.meta.url);
  const installDir = (() => {
    // installPath comes from the manifest; peek at the default so we can report
    // the current version before fetching. Falls back gracefully if absent.
    return path.join(projectRoot, ".claude", "skills", "slice-js-developer");
  })();
  const before = readLocalVersion(installDir);
  if (before) Print.info(`Currently installed: v${before}`);
  return addSkill({ ...options, force: true });
}

// Show installed vs latest, and whether an update is available.
async function statusSkill() {
  const projectRoot = getProjectRoot(import.meta.url);

  let manifest;
  try {
    manifest = await fetchManifest();
  } catch (error) {
    Print.error(`Could not load the skill manifest from the docs repository: ${error.message}`);
    Print.info("Check your internet connection and try again.");
    return false;
  }

  const installDir = path.join(projectRoot, manifest.installPath);
  const localVersion = readLocalVersion(installDir);

  Print.title("Slice.js Claude Code skill");
  console.log(`  name:      ${manifest.name}`);
  console.log(`  latest:    v${manifest.version} (targets ${manifest.targets})`);
  console.log(`  installed: ${localVersion ? "v" + localVersion : "not installed"}`);
  console.log(`  files:     ${manifest.files.length}`);
  console.log(`  path:      ${manifest.installPath}/`);
  Print.newLine();

  if (!localVersion) {
    Print.commandExample("Install the skill", "slice skill add");
  } else if (localVersion !== manifest.version) {
    Print.info(`Update available: v${localVersion} → v${manifest.version}`);
    Print.commandExample("Update", "slice skill update");
  } else {
    Print.success("Installed skill is up to date.");
  }
  return true;
}

export default addSkill;
export { addSkill, updateSkill, statusSkill };
