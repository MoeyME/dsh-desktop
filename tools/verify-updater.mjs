// E2E verification of the self-updater in the packaged app, driven through
// the main-process Node inspector (--inspect) + renderer CDP. No playwright.
//
// Scenarios:
//   1. Feed reports a newer version -> app downloads it, verifies sha256,
//      shows the progress window, and offers to install (prompt handler says
//      "Later" so nothing is executed).
//   2. Prompt handler says "Skip this version" -> updater-state.json records
//      the skipped version.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, rmSync, existsSync, mkdtempSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import os from 'node:os'
import http from 'node:http'

const here = dirname(fileURLToPath(import.meta.url))
const project = join(here, '..')
const exe = join(project, 'release', 'win-unpacked', 'DeepSeek Harness.exe')
const userData = join(os.homedir(), 'AppData', 'Roaming', 'DeepSeek Harness')
const configPath = join(userData, 'config.json')
const statePath = join(userData, 'updater-state.json')
const INSPECT_PORT = 9229
const CDP_PORT = 9333
const FEED_PORT = 8123
const FAKE_VERSION = '9.9.9'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---- fake feed server ------------------------------------------------------
const fakeDir = mkdtempSync(join(os.tmpdir(), 'dsh-fake-feed-'))
const fakeInstaller = join(fakeDir, `DeepSeek-Harness-Setup-${FAKE_VERSION}.exe`)
// 1 MB of deterministic junk stands in for the real installer; served slowly
// so the progress window stays observable.
const junk = Buffer.alloc(1024 * 1024)
for (let i = 0; i < junk.length; i++) junk[i] = (i * 31 + 7) & 0xff
writeFileSync(fakeInstaller, junk)
const fakeSha256 = createHash('sha256').update(junk).digest('hex')

const feedServer = http.createServer((req, res) => {
  if (req.url === '/update.json') {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({
      version: FAKE_VERSION,
      url: `http://127.0.0.1:${FEED_PORT}/installer.exe`,
      sha256: fakeSha256,
      notes: 'E2E test feed — fake version.',
    }))
  } else if (req.url === '/installer.exe') {
    res.setHeader('Content-Length', junk.length)
    const chunkSize = 64 * 1024
    let offset = 0
    const sendNext = () => {
      if (offset >= junk.length) { res.end(); return }
      res.write(junk.subarray(offset, Math.min(offset + chunkSize, junk.length)))
      offset += chunkSize
      setTimeout(sendNext, 120) // ~2 s total, long enough to observe the window
    }
    sendNext()
  } else {
    res.statusCode = 404
    res.end()
  }
})
await new Promise((resolve) => feedServer.listen(FEED_PORT, '127.0.0.1', resolve))

// ---- config -----------------------------------------------------------------
const savedConfig = existsSync(configPath) ? readFileSync(configPath, 'utf8') : null
const savedState = existsSync(statePath) ? readFileSync(statePath, 'utf8') : null
function writeConfig(updateUrl) {
  writeFileSync(configPath, JSON.stringify({
    url: 'http://127.0.0.1:3080',
    updateUrl,
    updateCheckIntervalMs: 21600000,
    pollIntervalMs: 1500,
  }))
}
const restore = () => {
  if (savedConfig === null) rmSync(configPath, { force: true })
  else writeFileSync(configPath, savedConfig)
  if (savedState === null) rmSync(statePath, { force: true })
  else writeFileSync(statePath, savedState)
}

let app = null
const appLog = join(os.tmpdir(), 'dsh-updater-e2e.log')
async function launch() {
  rmSync(appLog, { force: true })
  app = spawn(exe, [`--inspect=${INSPECT_PORT}`, `--remote-debugging-port=${CDP_PORT}`], {
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  await sleep(2500)
}
async function killApp() {
  if (app !== null && app.exitCode === null) app.kill('SIGKILL')
  app = null
  await sleep(1500)
}

// ---- node inspector (main process) ------------------------------------------
async function inspectorEval(expression) {
  const list = await (await fetch(`http://127.0.0.1:${INSPECT_PORT}/json`)).json()
  const target = list.find((t) => t.type === 'node' || t.webSocketDebuggerUrl)
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  const result = await new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9)
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id === id) resolve(message)
    }
    ws.onerror = reject
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })
  ws.close()
  if (result.result?.exceptionDetails) {
    throw new Error(`inspector evaluate failed: ${JSON.stringify(result.result.exceptionDetails.exception?.description ?? result.result.exceptionDetails)}`)
  }
  return result.result?.result?.value
}

// ---- renderer CDP -------------------------------------------------------------
async function cdpTargets() {
  return (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json())
}

// ---- the test -----------------------------------------------------------------
const results = []
let passed = 0
writeConfig(`http://127.0.0.1:${FEED_PORT}/update.json`)
const downloaded = join(os.tmpdir(), 'dsh-update', `DeepSeek-Harness-Setup-${FAKE_VERSION}.exe`)

try {
  await launch()
  // Wait for the inspector to be reachable.
  let inspectorUp = false
  for (let i = 0; i < 30; i++) {
    try { await inspectorEval('1 + 1'); inspectorUp = true; break } catch { await sleep(1000) }
  }
  if (!inspectorUp) {
    throw new Error(`app inspector never came up (exitCode=${app?.exitCode}); stderr above`)
  }
  const version = await inspectorEval("process.mainModule.require('electron').app.getVersion()")
  results.push(`app version: ${version}`)

  // Scenario 1: download the update, then decline the final install.
  await inspectorEval(`globalThis.__dshTest.setPromptHandler((opts) => opts.kind === 'update' ? 0 : 1); 'handler set'`)
  // Fire without awaiting so the progress window stays observable while it runs.
  await inspectorEval('globalThis.__dshTest.checkForUpdates(); "started"')

  let updateWindowSeen = false
  let updateShot = null
  for (let i = 0; i < 40; i++) {
    if (existsSync(downloaded) && createHash('sha256').update(readFileSync(downloaded)).digest('hex') === fakeSha256) {
      break // download finished; window may already be closed
    }
    const targets = await cdpTargets().catch(() => [])
    const updateTarget = targets.find((t) => t.type === 'page' && t.url.includes('update.html'))
    if (updateTarget) {
      updateWindowSeen = true
      if (updateShot === null) {
        const ws = new WebSocket(updateTarget.webSocketDebuggerUrl)
        await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
        updateShot = await new Promise((resolve) => {
          const id = Math.floor(Math.random() * 1e9)
          ws.onmessage = (event) => {
            const message = JSON.parse(event.data)
            if (message.id === id) resolve(message.result?.data ?? null)
          }
          ws.send(JSON.stringify({ id, method: 'Page.captureScreenshot', params: { format: 'png' } }))
        })
        ws.close()
        if (updateShot) {
          const { mkdirSync, writeFileSync } = await import('node:fs')
          mkdirSync(join(project, 'verify'), { recursive: true })
          writeFileSync(join(project, 'verify', 'update-progress.png'), Buffer.from(updateShot, 'base64'))
        }
      }
    }
    await sleep(200)
  }

  const downloadedOk = existsSync(downloaded)
    && createHash('sha256').update(readFileSync(downloaded)).digest('hex') === fakeSha256

  if (updateWindowSeen && downloadedOk) {
    passed++; results.push('1. Update download flow OK (progress window shown, sha256 verified, install deferred)')
  } else {
    results.push(`1. FAILED: updateWindow=${updateWindowSeen} downloadedOk=${downloadedOk}`)
  }
  rmSync(downloaded, { force: true })

  // Scenario 2: skip this version -> persisted.
  await inspectorEval(`globalThis.__dshTest.setPromptHandler(() => 2); 'skip set'`)
  await inspectorEval('globalThis.__dshTest.checkForUpdates()')
  await sleep(1200)
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null
  if (state?.skippedVersion === FAKE_VERSION) {
    passed++; results.push('2. Skip persisted in updater-state.json')
  } else {
    results.push(`2. FAILED: state=${JSON.stringify(state)}`)
  }
} finally {
  await killApp()
  feedServer.close()
  restore()
}

console.log(results.join('\n'))
console.log(`${passed}/2 scenarios passed`)
process.exit(passed === 2 ? 0 : 1)
