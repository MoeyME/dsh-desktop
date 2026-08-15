// E2E verification of the packaged DeepSeek Harness desktop shell, driven
// over Chrome DevTools Protocol (no playwright needed).
// Scenarios:
//   1. Server up   -> window loads the harness GUI   (verify/gui.png)
//   2. Server down -> window shows the status page   (verify/splash.png)
//   3. Server back -> window auto-reconnects to GUI  (verify/reconnect.png)
import { spawn } from 'node:child_process'
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import os from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const project = join(here, '..')
const exe = join(project, 'release', 'win-unpacked', 'DeepSeek Harness.exe')
const outDir = join(project, 'verify')
const userData = join(os.homedir(), 'AppData', 'Roaming', 'DeepSeek Harness')
const configPath = join(userData, 'config.json')
const CDP_PORT = 9333
const GUI_URL = 'http://127.0.0.1:3080'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

await mkdir(outDir, { recursive: true })

const savedConfig = await readFile(configPath, 'utf8').catch(() => null)
const restoreConfig = async () => {
  if (savedConfig === null) await rm(configPath, { force: true })
  else await writeFile(configPath, savedConfig)
}

let app = null
async function launchApp() {
  app = spawn(exe, [`--remote-debugging-port=${CDP_PORT}`], { stdio: 'ignore' })
  await sleep(2500)
}

async function killApp() {
  if (app !== null && app.exitCode === null) app.kill('SIGKILL')
  app = null
  await sleep(1500)
}

async function cdpTargets() {
  const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
  return response.json()
}

async function waitForTarget(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const targets = await cdpTargets()
      const found = targets.find((t) => t.type === 'page' && predicate(t.url))
      if (found) return found
    } catch { /* CDP not up yet */ }
    await sleep(1000)
  }
  throw new Error(`no matching CDP target within ${timeoutMs}ms`)
}

/** One CDP round trip over a temporary websocket. */
async function cdpCall(wsUrl, method, params = {}) {
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  const result = await new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9)
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id === id) resolve(message)
    }
    ws.onerror = reject
    ws.send(JSON.stringify({ id, method, params }))
  })
  ws.close()
  return result
}

async function screenshot(target, file) {
  const shot = await cdpCall(target.webSocketDebuggerUrl, 'Page.captureScreenshot', { format: 'png' })
  if (shot.error) throw new Error(`screenshot failed: ${JSON.stringify(shot.error)}`)
  await writeFile(file, Buffer.from(shot.result.data, 'base64'))
}

async function evaluate(target, expression) {
  const result = await cdpCall(target.webSocketDebuggerUrl, 'Runtime.evaluate', { expression, returnByValue: true })
  return result.result?.result?.value
}

const results = []
let passed = 0

try {
  // Scenario 1: GUI loads (harness server is the user's live one).
  await launchApp()
  const gui = await waitForTarget((url) => url.startsWith(GUI_URL), 60000)
  await sleep(6000) // let the heavy renderer paint
  await screenshot(gui, join(outDir, 'gui.png'))
  const title = await evaluate(gui, 'document.title')
  if (typeof title === 'string' && title.includes('DeepSeek Harness')) {
    passed++; results.push(`1. GUI loaded in the app window (title: ${title})`)
  } else {
    results.push(`1. GUI target found but unexpected title: ${title}`)
  }
  await killApp()

  // Scenario 2: server down -> status page.
  await writeFile(configPath, JSON.stringify({ url: 'http://127.0.0.1:3999', pollIntervalMs: 1000 }))
  await launchApp()
  const splash = await waitForTarget((url) => url.startsWith('file:'), 30000)
  await sleep(1500)
  await screenshot(splash, join(outDir, 'splash.png'))
  const status = await evaluate(splash, 'document.querySelector("#status")?.textContent ?? ""')
  const h1 = await evaluate(splash, 'document.querySelector("h1")?.textContent ?? ""')
  if (h1.includes('DeepSeek Harness')) {
    passed++; results.push(`2. Status page shown while server is down (${status.trim()})`)
  } else {
    results.push(`2. Status page target found but unexpected content: ${h1}`)
  }
  await killApp()

  // Scenario 3: server back -> auto-reconnect to the GUI.
  await writeFile(configPath, JSON.stringify({ url: GUI_URL, pollIntervalMs: 1000 }))
  await launchApp()
  const reconnected = await waitForTarget((url) => url.startsWith(GUI_URL), 60000)
  await sleep(6000)
  await screenshot(reconnected, join(outDir, 'reconnect.png'))
  passed++; results.push('3. Auto-reconnected to the GUI once the server came back')
  await killApp()
} finally {
  await killApp()
  await restoreConfig()
}

console.log(results.join('\n'))
console.log(`${passed}/3 scenarios passed`)
process.exit(passed === 3 ? 0 : 1)
