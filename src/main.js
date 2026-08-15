'use strict'
/**
 * DeepSeek Harness desktop shell.
 *
 * The shell is deliberately thin: it opens the harness Web GUI served by the
 * local `dsh web` process (http://127.0.0.1:3080 by default) and never bundles
 * the UI itself. Because the UI is always served fresh, harness updates show
 * up on the next launch with nothing to reinstall. The only thing that ever
 * changes is this shell.
 *
 * Behavior:
 *  - If the server is reachable, load it. Otherwise show a branded status page
 *    and poll until it appears (auto-reconnect when the harness restarts).
 *  - If config.startCommand is set and the server is not running, spawn it
 *    once (hidden, output to a log file) and connect when it comes up.
 *  - Only the configured local origin may navigate in-window; anything else
 *    opens in the system browser.
 *  - The shell self-updates from config.updateUrl (see src/updater.js) — the
 *    GUI itself never needs this, it is always served fresh by the harness.
 *
 * Config: %APPDATA%\DeepSeek Harness\config.json (copied from
 * config.example.json on first run). Relaunch the app after editing.
 */
const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const updater = require('./updater.js')

const DEFAULTS = {
  url: 'http://127.0.0.1:3080',
  // e.g. "pnpm dsh web" — spawned hidden with shell:true; empty disables auto-start.
  startCommand: '',
  startCwd: '',
  pollIntervalMs: 1500,
  // Update feed URL (JSON: version + installer url + optional sha256). Empty disables updates.
  updateUrl: 'https://github.com/moeymakes/dsh-desktop/releases/latest/download/update.json',
  updateCheckIntervalMs: 6 * 60 * 60 * 1000,
}
const CHECK_TIMEOUT_MS = 1200
const APP_NAME = 'DeepSeek Harness'
const APP_ID = 'com.deepseek.harness'

/** Path of the bundled status page shown while the server is unreachable. */
const SPLASH_FILE = path.join(__dirname, '..', 'splash', 'index.html')

let config = { ...DEFAULTS }
let mainWindow = null
let pollTimer = null
let checking = false
let serverUp = false
let showingSplash = false
let loadedGui = false
let spawnAttempted = false
let serverPid = null
let serverLog = null

/** Read config.json from userData, creating it from the bundled example on first run. */
function loadConfig() {
  const configPath = path.join(app.getPath('userData'), 'config.json')
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) }
  } catch {
    const examplePath = path.join(__dirname, '..', 'config.example.json')
    try {
      fs.mkdirSync(app.getPath('userData'), { recursive: true })
      fs.copyFileSync(examplePath, configPath)
      return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(examplePath, 'utf8')) }
    } catch {
      return { ...DEFAULTS }
    }
  }
}

/** Is this URL on the configured server origin (the only in-window origin)? */
function isLocalUrl(raw) {
  try {
    const target = new URL(raw)
    const local = new URL(config.url)
    return target.origin === local.origin
  } catch {
    return false
  }
}

/** Quick reachability probe against the configured server URL. */
async function isServerUp() {
  try {
    const response = await fetch(config.url, {
      method: 'GET',
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    })
    return response.ok || response.status >= 400 // any HTTP answer means a live server
  } catch {
    return false
  }
}

/** Spawn the configured server command once; logs output under userData. */
function startServer() {
  if (spawnAttempted) return
  spawnAttempted = true
  if (!config.startCommand) {
    sendStatus(`Server not running — start it with \`${'dsh web'}\` (or set startCommand in config.json)`)
    return
  }
  sendStatus(`Starting the harness: ${config.startCommand} …`)
  serverLog = fs.createWriteStream(path.join(app.getPath('userData'), 'server.log'), { flags: 'a' })
  const child = spawn(config.startCommand, {
    cwd: config.startCwd || undefined,
    shell: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  serverPid = child.pid ?? null
  child.stdout.on('data', chunk => serverLog.write(chunk))
  child.stderr.on('data', chunk => serverLog.write(chunk))
  child.on('error', error => sendStatus(`Failed to start the server: ${error.message}`))
  child.on('exit', (code, signal) => {
    serverPid = null
    if (code !== 0) sendStatus(`Server command exited (code ${code ?? signal}) — see server.log`)
  })
}

/** Poll the server and drive window state: splash while down, GUI when up. */
async function poll() {
  if (checking) return
  checking = true
  try {
    const up = await isServerUp()
    serverUp = up
    if (mainWindow === null || mainWindow.isDestroyed()) return
    if (serverUp) {
      if (!loadedGui) {
        loadedGui = true
        showingSplash = false
        sendStatus('Connected — loading the harness…')
        void mainWindow.loadURL(config.url)
      }
    } else {
      loadedGui = false
      if (serverPid === null && config.startCommand && !spawnAttempted) startServer()
      if (!showingSplash) {
        showingSplash = true
        sendStatus(`Waiting for the harness server on ${config.url} …`)
        void mainWindow.loadFile(SPLASH_FILE)
      }
    }
  } finally {
    checking = false
  }
}

/** Push a status line to the renderer (splash page) without waiting for it. */
function sendStatus(text) {
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('dsh:status', text)
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#151517',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    // show: true with a background color matching the GUI's boot surface:
    // the window renders immediately and can never be left invisible
    // (ready-to-show is not reliable in every environment).
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  // Any non-local navigation leaves the window; the local app may never be
  // replaced by an external page.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isLocalUrl(url)) return { action: 'allow' }
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isLocalUrl(url)) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })

  mainWindow.on('closed', () => { mainWindow = null })

  void poll()
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Open in Browser', click: () => { void shell.openExternal(config.url) } },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { id: 'dsh-check-updates', label: 'Check for Updates…', click: () => { void updater.checkForUpdates({ manual: true }) } },
        { type: 'separator' },
        { label: 'About DeepSeek Harness', click: () => {
          void dialog.showMessageBox({
            type: 'info',
            title: 'About DeepSeek Harness',
            message: `DeepSeek Harness Desktop v${app.getVersion()}`,
            detail: 'A thin shell that loads the DeepSeek Harness Web GUI from your local harness server. The GUI updates itself with every harness rebuild; this shell updates itself from the release feed.',
          })
        } },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.setName(APP_NAME)
  app.setAppUserModelId(APP_ID)

  app.on('second-instance', () => {
    if (mainWindow !== null) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    config = loadConfig()
    buildMenu()
    createWindow()
    pollTimer = setInterval(() => { void poll() }, config.pollIntervalMs)
    updater.setupUpdater(() => config)

    // Test/diagnostic hook, only when launched with --inspect: drive the
    // updater from an external Node inspector session (used by
    // tools/verify-updater.mjs).
    if (process.argv.some((arg) => arg.startsWith('--inspect'))) {
      globalThis.__dshTest = {
        checkForUpdates: () => updater.checkForUpdates({ manual: false }),
        setPromptHandler: updater.setPromptHandler,
      }
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  }).catch((error) => {
    console.error('dsh-desktop: whenReady failed', error)
  })

  ipcMain.on('dsh:retry', () => {
    spawnAttempted = false // allow one more auto-start attempt
    void poll()
  })

  // Stop only a server this shell started; never touch one the user runs.
  app.on('before-quit', () => {
    if (serverPid !== null) {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(serverPid), '/T', '/F'], { windowsHide: true })
      } else {
        try { process.kill(-serverPid, 'SIGTERM') } catch { /* already gone */ }
      }
      serverPid = null
    }
    if (pollTimer !== null) clearInterval(pollTimer)
    if (serverLog !== null) serverLog.end()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
