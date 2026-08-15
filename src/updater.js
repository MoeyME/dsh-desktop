'use strict'
/**
 * Self-updater for the DeepSeek Harness desktop shell.
 *
 * The shell itself rarely changes (the GUI it loads is served by the local
 * harness and always current), but when it does, this module finds out and
 * offers to install the new version — no manual rebuild needed.
 *
 * Feed contract (JSON, served over HTTPS):
 *   { "version": "0.2.0", "url": "https://…/Setup-0.2.0.exe", "sha256": "<hex>", "notes": "…" }
 *
 * The app compares feed.version against its own (semver), and when a newer
 * version exists asks the user to download it. The installer is streamed to a
 * temp file (progress window), verified against sha256 when provided, and
 * launched after the app quits — the NSIS per-user installer then upgrades in
 * place. Config: `updateUrl` (feed URL) and `updateCheckIntervalMs`; the first
 * automatic check happens 30s after launch, then every interval.
 */
const { app, BrowserWindow, dialog, shell } = require('electron')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const FIRST_CHECK_DELAY_MS = 30_000
const FETCH_TIMEOUT_MS = 10_000

/** State persisted under userData so a skipped version is not offered again. */
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'updater-state.json'), 'utf8'))
  } catch {
    return {}
  }
}

function saveState(state) {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
    fs.writeFileSync(path.join(app.getPath('userData'), 'updater-state.json'), JSON.stringify(state, null, 2))
  } catch { /* non-fatal */ }
}

/** Strict semver-ish compare: dotted numbers only. Returns -1/0/1. */
function compareVersions(a, b) {
  const parse = (v) => String(v).split('.').map((n) => parseInt(n, 10)).map((n) => (Number.isFinite(n) ? n : 0))
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  return 0
}

function isValidFeed(feed) {
  return typeof feed === 'object' && feed !== null
    && typeof feed.version === 'string' && /^\d+(\.\d+)*$/.test(feed.version)
    && typeof feed.url === 'string' && /^https?:/i.test(feed.url)
}

/** Test hook (gated on --inspect): lets an external driver choose prompt buttons. */
let promptHandler = null
function setPromptHandler(fn) {
  promptHandler = typeof fn === 'function' ? fn : null
}

/** Ask the user what to do with a pending update. Resolves 0=install, 1=later, 2=skip. */
async function promptForUpdate(feed) {
  if (promptHandler !== null) return promptHandler({ kind: 'update', feed })
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: 'Update available',
    message: `DeepSeek Harness Desktop v${feed.version} is available`,
    detail: `You are running v${app.getVersion()}.\n\n${feed.notes ?? ''}\n\nDownload and install it now?`,
    buttons: ['Download & Install', 'Later', 'Skip this version'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  return response
}

/** Ask whether to launch the freshly downloaded installer. */
async function promptInstallNow(installerPath) {
  if (promptHandler !== null) return promptHandler({ kind: 'install', installerPath })
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: 'Update downloaded',
    message: 'The update has been downloaded and verified.',
    detail: 'Install now? The app will close and the installer will start.',
    buttons: ['Install Now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  return response
}

/** Fetch and validate the feed. */
async function fetchFeed(updateUrl) {
  const response = await fetch(updateUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`feed returned HTTP ${response.status}`)
  const feed = await response.json()
  if (!isValidFeed(feed)) throw new Error('feed is malformed (need version + url)')
  return feed
}

let progressWindow = null

/** Small progress window shown while the installer downloads. */
function showProgressWindow() {
  if (progressWindow !== null && !progressWindow.isDestroyed()) {
    progressWindow.show()
    return
  }
  progressWindow = new BrowserWindow({
    width: 460,
    height: 190,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    backgroundColor: '#4d6bfe',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  progressWindow.setMenuBarVisibility(false)
  void progressWindow.loadFile(path.join(__dirname, '..', 'splash', 'update.html'))
  progressWindow.on('closed', () => { progressWindow = null })
}

function updateProgress(payload) {
  if (progressWindow !== null && !progressWindow.isDestroyed()) {
    progressWindow.webContents.send('dsh:update', payload)
  }
}

/** Stream the installer to a temp file; verify sha256 when the feed provides it. */
async function downloadInstaller(feed) {
  const dir = path.join(app.getPath('temp'), 'dsh-update')
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, `DeepSeek-Harness-Setup-${feed.version}.exe`)
  const response = await fetch(feed.url, { signal: AbortSignal.timeout(10 * 60_000) })
  if (!response.ok || response.body === null) throw new Error(`installer returned HTTP ${response.status}`)
  const total = Number(response.headers.get('content-length')) || 0
  const hash = createHash('sha256')
  let received = 0
  const reader = response.body.getReader()
  const out = fs.createWriteStream(target)
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      hash.update(value)
      out.write(value)
      updateProgress({ phase: 'downloading', pct: total > 0 ? Math.round((received / total) * 100) : 0, received, total })
    }
  } finally {
    out.end()
  }
  const digest = hash.digest('hex')
  if (feed.sha256 && !digest.startsWith(feed.sha256.toLowerCase())) {
    fs.rmSync(target, { force: true })
    throw new Error('downloaded installer failed the sha256 check')
  }
  return target
}

/** The main entry: check the feed and, if newer, walk the prompt/download flow. */
async function checkForUpdates({ manual } = {}) {
  const updateUrl = typeof updaterConfig === 'function' ? updaterConfig()?.updateUrl : updaterConfig?.updateUrl
  if (!updateUrl) {
    if (manual) void dialog.showMessageBox({ type: 'info', title: 'Check for updates', message: 'No update feed configured. Set updateUrl in config.json to enable updates.' })
    return 'no-feed'
  }
  let feed
  try {
    feed = await fetchFeed(updateUrl)
  } catch (error) {
    if (manual) void dialog.showMessageBox({ type: 'error', title: 'Check for updates', message: `Could not reach the update feed: ${error.message}` })
    return 'feed-error'
  }
  if (compareVersions(feed.version, app.getVersion()) <= 0) {
    if (manual) void dialog.showMessageBox({ type: 'info', title: 'Check for updates', message: `You're up to date (v${app.getVersion()}).` })
    return 'up-to-date'
  }
  const state = loadState()
  if (!manual && state.skippedVersion === feed.version) return 'skipped'

  const choice = await promptForUpdate(feed)
  if (choice === 2) {
    saveState({ ...state, skippedVersion: feed.version })
    return 'skipped'
  }
  if (choice !== 0) return 'later'

  showProgressWindow()
  updateProgress({ phase: 'downloading', pct: 0, text: `Downloading DeepSeek Harness v${feed.version}…` })
  let installerPath
  try {
    installerPath = await downloadInstaller(feed)
  } catch (error) {
    updateProgress({ phase: 'error', text: error.message })
    if (promptHandler === null) {
      void dialog.showMessageBox({ type: 'error', title: 'Update failed', message: error.message })
    }
    return 'download-error'
  }
  updateProgress({ phase: 'done', text: 'Download complete.' })
  const install = await promptInstallNow(installerPath)
  if (install !== 0) {
    if (progressWindow !== null && !progressWindow.isDestroyed()) progressWindow.close()
    return 'later'
  }
  // Quit before launching the installer so files are not locked; the installer
  // (NSIS per-user) upgrades the shell in place.
  const launchInstaller = () => { void shell.openPath(installerPath) }
  app.once('will-quit', launchInstaller)
  app.quit()
  return 'installing'
}

/** Wire the module into the app lifecycle. Called once from main.js. */
function setupUpdater(getConfig) {
  updaterConfig = getConfig
  // First automatic check after the app settles; then on the configured interval.
  setTimeout(() => { void checkForUpdates({ manual: false }) }, FIRST_CHECK_DELAY_MS)
  const intervalMs = Math.max(60_000, Number(updaterConfig.updateCheckIntervalMs) || 6 * 60 * 60 * 1000)
  setInterval(() => { void checkForUpdates({ manual: false }) }, intervalMs)
}

let updaterConfig = null

module.exports = {
  setupUpdater,
  checkForUpdates,
  compareVersions,
  setPromptHandler,
}
