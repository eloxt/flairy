#!/usr/bin/env node
// Release helper: bumps the version in root + desktop package.json, commits,
// tags `v<version>`, and pushes — which triggers .github/workflows/release.yml.
//
// The desktop package.json version is the source of truth electron-builder
// uses to locate the GitHub Release, so it MUST match the pushed tag. This
// script keeps them in lockstep.
//
// Usage:
//   pnpm release patch        # 0.1.0 -> 0.1.1
//   pnpm release minor        # 0.1.0 -> 0.2.0
//   pnpm release major        # 0.1.0 -> 1.0.0
//   pnpm release 1.2.3        # explicit version
//   pnpm release patch --dry  # show what would happen, change nothing

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DRY = process.argv.includes('--dry')
const arg = process.argv.slice(2).find((a) => !a.startsWith('-'))

if (!arg) {
  console.error('Usage: pnpm release <patch|minor|major|x.y.z> [--dry]')
  process.exit(1)
}

const run = (cmd) => {
  console.log(`$ ${cmd}`)
  if (!DRY) execSync(cmd, { stdio: 'inherit', cwd: ROOT })
}

// Refuse to release from a dirty tree — a stray edit would ride along in the
// release commit. Skipped for --dry since a preview changes nothing.
if (!DRY) {
  const status = execSync('git status --porcelain', { cwd: ROOT }).toString().trim()
  if (status) {
    console.error('Working tree is not clean. Commit or stash changes first:\n' + status)
    process.exit(1)
  }
}

const DESKTOP_PKG = join(ROOT, 'apps/desktop/package.json')
const ROOT_PKG = join(ROOT, 'package.json')

const readPkg = (p) => JSON.parse(readFileSync(p, 'utf8'))
const current = readPkg(DESKTOP_PKG).version

function nextVersion(cur, bump) {
  if (/^\d+\.\d+\.\d+$/.test(bump)) return bump
  const [maj, min, pat] = cur.split('.').map(Number)
  if (bump === 'major') return `${maj + 1}.0.0`
  if (bump === 'minor') return `${maj}.${min + 1}.0`
  if (bump === 'patch') return `${maj}.${min}.${pat + 1}`
  console.error(`Invalid version/bump: ${bump}`)
  process.exit(1)
}

const version = nextVersion(current, arg)
const tag = `v${version}`

// Ensure the tag doesn't already exist.
const tags = execSync('git tag', { cwd: ROOT }).toString().split('\n')
if (tags.includes(tag)) {
  console.error(`Tag ${tag} already exists.`)
  process.exit(1)
}

console.log(`Releasing ${current} -> ${version}${DRY ? ' (dry run)' : ''}\n`)

for (const p of [ROOT_PKG, DESKTOP_PKG]) {
  const pkg = readPkg(p)
  pkg.version = version
  console.log(`update ${p.replace(ROOT + '/', '')} -> ${version}`)
  if (!DRY) writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n')
}

run(`git add ${ROOT_PKG} ${DESKTOP_PKG}`)
run(`git commit -m "chore(release): ${tag}"`)
run(`git tag ${tag}`)
run('git push')
run(`git push origin ${tag}`)

console.log(`\nDone. Pushed ${tag} — GitHub Actions will build and create the draft release.`)
