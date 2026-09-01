import { copyFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const desktopDir = fileURLToPath(new URL('..', import.meta.url))
const targets = {
  'aarch64-apple-darwin': { resourceDir: 'darwin-arm64', executable: 'flairy-doc' },
  'x86_64-pc-windows-msvc': { resourceDir: 'win32-x64', executable: 'flairy-doc.exe' }
}
const hostTarget =
  process.platform === 'darwin' && process.arch === 'arm64'
    ? 'aarch64-apple-darwin'
    : process.platform === 'win32' && process.arch === 'x64'
      ? 'x86_64-pc-windows-msvc'
      : undefined
const target = process.env.FLAIRY_NATIVE_TARGET || hostTarget
const config = targets[target]

if (!config) {
  throw new Error(
    `Unsupported flairy-doc target: ${target || `${process.platform}-${process.arch}`}. ` +
      `Supported targets: ${Object.keys(targets).join(', ')}`
  )
}

const manifest = path.join(desktopDir, 'native', 'flairy-doc', 'Cargo.toml')
const result = spawnSync('cargo', ['build', '--release', '--locked', '--manifest-path', manifest, '--target', target], {
  cwd: desktopDir,
  stdio: 'inherit'
})
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)

const source = path.join(desktopDir, 'native', 'flairy-doc', 'target', target, 'release', config.executable)
const destinationDir = path.join(desktopDir, 'resources', 'bin', config.resourceDir)
mkdirSync(destinationDir, { recursive: true })
copyFileSync(source, path.join(destinationDir, config.executable))
