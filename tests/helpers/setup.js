import fs from 'fs-extra'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Prefer the sibling framework dev repo when present (local monorepo checkout);
// otherwise fall back to the installed framework package (e.g. CI, where only
// this repo is checked out). Both ship the same src/ + api/ starter structure.
const SIBLING_FW = path.resolve(__dirname, '../../../slice.js')
const PACKAGE_FW = path.resolve(__dirname, '../../node_modules/slicejs-web-framework')
const FW_DIR = fs.pathExistsSync(SIBLING_FW) ? SIBLING_FW : PACKAGE_FW
const FIXTURES_DIR = path.resolve(__dirname, '../fixtures')

let counter = 0

export async function createTestProject(options = {}) {
  const {
    visualComponents = [],
    frameworkDir = FW_DIR,
  } = options

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `slice-test-${process.pid}-${counter++}-`))

  const fwExists = await fs.pathExists(frameworkDir)
  const srcDir = path.join(dir, 'src')

  if (fwExists) {
    const fwSrc = path.join(frameworkDir, 'src')
    const fwApi = path.join(frameworkDir, 'api')

    if (await fs.pathExists(fwSrc)) {
      await fs.copy(fwSrc, srcDir)
    }
    if (await fs.pathExists(fwApi)) {
      await fs.copy(fwApi, path.join(dir, 'api'))
    }
  }

  if (!(await fs.pathExists(srcDir))) {
    await createMinimalScaffold(dir)
  }

  await fs.ensureDir(path.join(srcDir, 'Components', 'Visual'))

  if (visualComponents.length > 0) {
    const registryLines = visualComponents.map(n => `  "${n}": "Visual"`).join(',\n')
    await fs.writeFile(
      path.join(srcDir, 'Components', 'components.js'),
      `const components = {\n${registryLines}\n}; export default components;\n`
    )
    for (const name of visualComponents) {
      const compDir = path.join(srcDir, 'Components', 'Visual', name)
      await fs.ensureDir(compDir)
      await fs.writeFile(path.join(compDir, `${name}.js`), `export default class ${name} {}`)
    }
  }

  return dir
}

export async function cleanupTestProject(dir) {
  await fs.remove(dir)
}

export async function withTestProject(fn, options = {}) {
  const dir = await createTestProject(options)
  const origInitCwd = process.env.INIT_CWD
  try {
    process.env.INIT_CWD = dir
    return await fn(dir)
  } finally {
    if (origInitCwd === undefined) {
      delete process.env.INIT_CWD
    } else {
      process.env.INIT_CWD = origInitCwd
    }
    await cleanupTestProject(dir)
  }
}

async function createMinimalScaffold(dir) {
  const srcDir = path.join(dir, 'src')
  await fs.ensureDir(path.join(srcDir, 'App'))
  await fs.ensureDir(path.join(srcDir, 'Components', 'AppComponents', 'AppShell'))
  await fs.ensureDir(path.join(srcDir, 'Components', 'Service', 'FetchManager'))
  await fs.ensureDir(path.join(srcDir, 'Components', 'Visual'))
  await fs.ensureDir(path.join(srcDir, 'Styles'))
  await fs.ensureDir(path.join(srcDir, 'Themes'))
  await fs.ensureDir(path.join(dir, 'api', 'framework'))

  const fixtureConfig = path.join(FIXTURES_DIR, 'sliceConfig.json')
  if (await fs.pathExists(fixtureConfig)) {
    await fs.copy(fixtureConfig, path.join(srcDir, 'sliceConfig.json'))
  }

  const fixtureComponents = path.join(FIXTURES_DIR, 'components.js')
  if (await fs.pathExists(fixtureComponents)) {
    await fs.copy(fixtureComponents, path.join(srcDir, 'Components', 'components.js'))
  }
}
