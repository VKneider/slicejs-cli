import path from 'path'
import fs from 'fs-extra'
import { fileURLToPath } from 'url'

const sanitize = (s) => (s || '').replace(/^[/\\]+/, '')
const dirOf = (url) => path.dirname(fileURLToPath(url))

function candidates(moduleUrl) {
  const dir = dirOf(moduleUrl)
  return [
    path.join(dir, '../../'),
    path.join(dir, '../../../../')
  ]
}

function resolveProjectRoot(moduleUrl) {
  const initCwd = process.env.INIT_CWD
  if (initCwd && fs.pathExistsSync(initCwd)) {
    return initCwd
  }

  const cwd = process.cwd()
  if (cwd && fs.pathExistsSync(cwd)) {
    return cwd
  }

  const dirs = candidates(moduleUrl)
  for (const root of dirs) {
    const hasSrc = fs.pathExistsSync(path.join(root, 'src'))
    const hasApi = fs.pathExistsSync(path.join(root, 'api'))
    if (hasSrc || hasApi) return root
  }
  return dirs[1]
}

function joinProject(moduleUrl, ...segments) {
  const root = resolveProjectRoot(moduleUrl)
  const clean = segments.map(sanitize)
  return path.join(root, ...clean)
}

export function getProjectRoot(moduleUrl) {
  return resolveProjectRoot(moduleUrl)
}

export function getPath(moduleUrl, folder, ...segments) {
  return joinProject(moduleUrl, folder, ...segments)
}

export function getSrcPath(moduleUrl, ...segments) {
  return joinProject(moduleUrl, 'src', ...segments)
}

export function getApiPath(moduleUrl, ...segments) {
  return joinProject(moduleUrl, 'api', ...segments)
}

export function getDistPath(moduleUrl, ...segments) {
  return joinProject(moduleUrl, 'dist', ...segments)
}

export function getConfigPath(moduleUrl, root) {
  if (root) return path.join(root, 'src', 'sliceConfig.json')
  return joinProject(moduleUrl, 'src', 'sliceConfig.json')
}

export function getComponentsJsPath(moduleUrl, root) {
  if (root) return path.join(root, 'src', 'Components', 'components.js')
  return joinProject(moduleUrl, 'src', 'Components', 'components.js')
}

export function joinRoot(root, ...segments) {
  const clean = segments.map(sanitize)
  return path.join(root, ...clean)
}
