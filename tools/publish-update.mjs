// Publish a release: builds nothing — it takes the built installer from
// release/, uploads it to the GitHub repo's release, and publishes the
// update feed (update.json) as a release asset so the app's stable feed URL
// (releases/latest/download/update.json) always points at the newest version.
//
// Usage: node tools/publish-update.mjs <version> [--repo owner/name] [--notes "..."]
//   version - e.g. 0.2.0 (must match release/DeepSeek Harness Setup <version>.exe)
// Requires: gh CLI authenticated, npm run dist already done.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, copyFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import os from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const project = join(here, '..')
const repo = process.argv.find((a) => a.startsWith('--repo='))?.slice(7) ?? 'MoeyME/dsh-desktop'
const version = process.argv.find((a) => /^\d+(\.\d+)*$/.test(a) && !a.startsWith('--'))
const notes = process.argv.find((a) => a.startsWith('--notes='))?.slice(8) ?? ''

if (!version) throw new Error('usage: node tools/publish-update.mjs <version> [--repo owner/name] [--notes "..."]')

const installer = join(project, 'release', `DeepSeek Harness Setup ${version}.exe`)
readFileSync(installer) // fail fast if the build is missing

// Upload under a URL-friendly asset name (no spaces).
const tmp = mkdtempSync(join(os.tmpdir(), 'dsh-publish-'))
const asset = join(tmp, `DeepSeek-Harness-Setup-${version}.exe`)
copyFileSync(installer, asset)

const sha256 = createHash('sha256').update(readFileSync(installer)).digest('hex')
const tag = `v${version}`
const assetUrl = `https://github.com/${repo}/releases/download/${tag}/DeepSeek-Harness-Setup-${version}.exe`
const feedPath = join(tmp, 'update.json')
writeFileSync(feedPath, JSON.stringify({ version, url: assetUrl, sha256, notes }, null, 2))

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' })

console.log(`publishing ${tag} to ${repo} …`)
run('gh', ['release', 'create', tag, asset, '--repo', repo, '--title', `DeepSeek Harness Desktop v${version}`, '--notes', notes || `DeepSeek Harness Desktop v${version}`])
run('gh', ['release', 'upload', tag, feedPath, '--repo', repo, '--clobber'])
copyFileSync(feedPath, join(project, 'release', 'update.json'))

console.log(`published: ${assetUrl}`)
console.log(`feed: https://github.com/${repo}/releases/latest/download/update.json`)
console.log(`sha256: ${sha256}`)
