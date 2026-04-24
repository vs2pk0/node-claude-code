import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const currentFile = fileURLToPath(import.meta.url)
const scriptsDir = path.dirname(currentFile)
const projectRoot = path.resolve(scriptsDir, '..')
const resourcesDir = path.join(projectRoot, 'src-tauri', 'resources')
const runtimeRoot = path.join(resourcesDir, 'app')
const runtimeNodeModules = path.join(runtimeRoot, 'node_modules')
const runtimeBinDir = path.join(resourcesDir, 'bin')
const serverEntry = path.join(runtimeRoot, 'server.cjs')
const nodeTarget = path.join(runtimeBinDir, process.platform === 'win32' ? 'node.exe' : 'node')

await fs.promises.rm(resourcesDir, { recursive: true, force: true })
await fs.promises.mkdir(runtimeNodeModules, { recursive: true })
await fs.promises.mkdir(runtimeBinDir, { recursive: true })

await build({
  entryPoints: [path.join(projectRoot, 'server', 'index.ts')],
  outfile: serverEntry,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['better-sqlite3', 'vite'],
  define: {
    'process.env.NODE_ENV': '"production"',
    'process.env.SERVE_UI': '"false"',
  },
})

copyPackage('better-sqlite3', ['package.json', 'LICENSE', 'lib', 'build'])
copyPackage('bindings')
copyPackage('file-uri-to-path')

await fs.promises.copyFile(process.execPath, nodeTarget)

if (process.platform !== 'win32') {
  await fs.promises.chmod(nodeTarget, 0o755)
}

function copyPackage(packageName, items) {
  const sourceDir = path.join(projectRoot, 'node_modules', packageName)
  const destinationDir = path.join(runtimeNodeModules, packageName)

  fs.mkdirSync(destinationDir, { recursive: true })

  if (!items) {
    fs.cpSync(sourceDir, destinationDir, { recursive: true })
    return
  }

  for (const item of items) {
    fs.cpSync(path.join(sourceDir, item), path.join(destinationDir, item), { recursive: true })
  }
}
