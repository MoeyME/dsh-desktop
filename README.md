# dsh-desktop — DeepSeek Harness desktop shell

A thin [Electron](https://www.electronjs.org/) shell that opens the DeepSeek
Harness Web GUI served by your local harness (`dsh web`, default
`http://127.0.0.1:3080`).

## Why this is the right wrapper

- **It is a real app**: own `.exe`, DeepSeek icon, Start-menu and desktop
  shortcuts, taskbar pin — no Chrome icon anywhere.
- **Updates are automatic by design**: the shell never bundles the UI. Every
  launch loads whatever the local harness serves *right now*, so a `git pull`
  + `pnpm run build` of the harness is reflected immediately. There is nothing
  to reinstall and nothing to push — the only thing that would ever change is
  this tiny shell itself.
- **Survives restarts**: if the harness server is down, the window shows a
  branded status page, polls, and loads the GUI automatically the moment the
  server is back (e.g. after you start `dsh web`).

## Build & install

```sh
npm install        # downloads Electron once (~110 MB)
npm start          # run from source (dev)
npm run dist       # build the NSIS installer -> release/DeepSeek Harness Setup 0.1.0.exe
```

Install the setup exe — it creates the Start-menu and desktop shortcuts with
the DeepSeek icon.

### Verify a build

`tools/verify-cdp.mjs` drives the packaged app over the Chrome DevTools
Protocol and checks the three core behaviors (requires the harness server
running and the app packaged):

```sh
node tools/verify-cdp.mjs   # screenshots land in verify/
```

`tools/verify-updater.mjs` exercises the self-updater against a local fake
feed (download, sha256 check, skip-version persistence):

```sh
node tools/verify-updater.mjs
```

## Config

The shell reads `%APPDATA%\DeepSeek Harness\config.json`, created from
`config.example.json` on first run:

| Key            | Meaning                                                        |
| -------------- | -------------------------------------------------------------- |
| `url`          | Where the GUI is served (default `http://127.0.0.1:3080`).     |
| `startCommand` | Optional command to auto-start the server, e.g. `pnpm dsh web`. Empty = never spawn. |
| `startCwd`     | Working directory for `startCommand`.                          |
| `pollIntervalMs` | How often to probe the server while disconnected.            |
| `updateUrl`    | Self-update feed (JSON: `version` + installer `url` + optional `sha256`). Empty = updates off. |
| `updateCheckIntervalMs` | How often to re-check the feed (first check 30 s after launch; default 6 h). |

With `startCommand` set, launching the app starts the harness for you if it
isn't running (hidden; output goes to `server.log` next to the config). The
spawned server is stopped when the app quits — a server you started yourself
is never touched.

## Self-updates (the shell)

The shell self-updates from the feed at `updateUrl` (GitHub Releases by
default): on launch and every `updateCheckIntervalMs` it compares the feed
version to its own and offers to download a newer installer (progress window,
sha256-verified). **The GUI never needs this** — it is always served fresh by
your local harness.

### Publishing a new shell version

```sh
npm run dist                                  # build the installer
node tools/publish-update.mjs 0.2.0 --notes "what changed"
```

That uploads `release/DeepSeek Harness Setup 0.2.0.exe` to the
`moeymakes/dsh-desktop` GitHub release and publishes `update.json` as a
release asset, so the app's stable feed URL
(`https://github.com/moeymakes/dsh-desktop/releases/latest/download/update.json`)
starts pointing at the new version. Existing installs offer the update on
their next launch or within the check interval.

## Icons

`build/icon.png` and `splash/logo.png` are rasterized from the harness's
`apps/web/public/favicon.svg` by `tools/render-icons.mjs` (Playwright
Chromium, DeepSeek blue `#4d6bfe` background). Regenerate with:

```sh
node tools/render-icons.mjs   # needs the harness repo + its playwright install
```

## Security model

- `contextIsolation: true`, `sandbox: true`, no `nodeIntegration`.
- Only the configured local origin may navigate in-window; every other link
  opens in your system browser.
- Single-instance: launching again focuses the existing window.
