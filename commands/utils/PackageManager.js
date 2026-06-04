// commands/utils/PackageManager.js
//
// Package manager detection and command building (pnpm / npm).
// Resolution priority for an existing project:
//   1. "packageManager" field in the project package.json (corepack convention)
//   2. Lockfile present at the project root
//   3. npm_config_user_agent (set when the CLI runs via `npx` / `pnpm dlx` / a PM script)
//   4. The only PM binary available on PATH (if exactly one)
// When everything is ambiguous, detectPackageManager() returns null so callers
// can prompt the user (interactive init) or fall back to pnpm (non-interactive).

import fs from 'fs-extra'
import path from 'path'
import { spawnSync } from 'node:child_process'

export const SUPPORTED_PACKAGE_MANAGERS = ['pnpm', 'npm']

const LOCKFILES = {
  'pnpm-lock.yaml': 'pnpm',
  'package-lock.json': 'npm'
}

export function parseUserAgent(userAgent = process.env.npm_config_user_agent) {
  if (!userAgent) return null
  const match = userAgent.match(/^(npm|pnpm)\/(\S+)/)
  if (!match) return null
  return { name: match[1], version: match[2], source: 'user-agent' }
}

export function fromPackageManagerField(projectRoot) {
  try {
    const pkgPath = path.join(projectRoot, 'package.json')
    if (!fs.pathExistsSync(pkgPath)) return null
    const pkg = fs.readJsonSync(pkgPath)
    if (typeof pkg.packageManager !== 'string') return null
    const match = pkg.packageManager.match(/^(npm|pnpm)@(\S+)/)
    if (!match) return null
    return { name: match[1], version: match[2], source: 'package-manager-field' }
  } catch {
    return null
  }
}

export function fromLockfile(projectRoot) {
  for (const [lockfile, name] of Object.entries(LOCKFILES)) {
    if (fs.pathExistsSync(path.join(projectRoot, lockfile))) {
      return { name, version: null, source: `lockfile (${lockfile})` }
    }
  }
  return null
}

function runPmBinary(name, args) {
  // On Windows the PM entry points are .cmd shims, which require shell resolution.
  const isWindows = process.platform === 'win32'
  return spawnSync(name, args, {
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: isWindows,
    encoding: 'utf-8'
  })
}

export function isPackageManagerAvailable(name) {
  try {
    const result = runPmBinary(name, ['--version'])
    return result.status === 0
  } catch {
    return false
  }
}

export function getPackageManagerVersion(name) {
  try {
    const result = runPmBinary(name, ['--version'])
    if (result.status !== 0) return null
    return (result.stdout || '').toString().trim() || null
  } catch {
    return null
  }
}

export function getAvailablePackageManagers() {
  return SUPPORTED_PACKAGE_MANAGERS.filter(isPackageManagerAvailable)
}

/**
 * Detect the package manager for a project.
 * Returns { name, version, source } or null when genuinely ambiguous.
 */
export function detectPackageManager(projectRoot, { userAgent = process.env.npm_config_user_agent } = {}) {
  if (projectRoot) {
    const fromField = fromPackageManagerField(projectRoot)
    if (fromField) return fromField

    const fromLock = fromLockfile(projectRoot)
    if (fromLock) return fromLock
  }

  const fromUa = parseUserAgent(userAgent)
  if (fromUa) return fromUa

  const available = getAvailablePackageManagers()
  if (available.length === 1) {
    return { name: available[0], version: null, source: 'only available binary' }
  }

  return null
}

/**
 * Non-interactive resolution: detection first, then pnpm if available,
 * then whatever binary exists. Never returns null so update/doctor flows
 * always have a usable PM name (commands fail later with a clear error
 * if no PM is actually installed).
 */
export function resolvePackageManager(projectRoot, options = {}) {
  const detected = detectPackageManager(projectRoot, options)
  if (detected) return detected

  const available = getAvailablePackageManagers()
  if (available.includes('pnpm')) return { name: 'pnpm', version: null, source: 'fallback' }
  if (available.includes('npm')) return { name: 'npm', version: null, source: 'fallback' }
  if (available.length > 0) return { name: available[0], version: null, source: 'fallback' }
  return { name: 'pnpm', version: null, source: 'fallback (none detected)' }
}

export function installCommand(pmName, packages, { dev = false, global: isGlobal = false } = {}) {
  const pkgs = Array.isArray(packages) ? packages.join(' ') : packages
  const flags = [isGlobal ? '-g' : '', dev ? '-D' : ''].filter(Boolean).join(' ')
  const flagSuffix = flags ? ` ${flags}` : ''
  if (pmName === 'pnpm') {
    return `${pmName} add${flagSuffix} ${pkgs}`
  }
  return `npm install${flagSuffix} ${pkgs}`
}

export function uninstallCommand(pmName, packages, { global: isGlobal = false } = {}) {
  const pkgs = Array.isArray(packages) ? packages.join(' ') : packages
  const flagSuffix = isGlobal ? ' -g' : ''
  if (pmName === 'pnpm') {
    return `${pmName} remove${flagSuffix} ${pkgs}`
  }
  return `npm uninstall${flagSuffix} ${pkgs}`
}

export function runScriptCommand(pmName, script) {
  return `${pmName} run ${script}`
}
