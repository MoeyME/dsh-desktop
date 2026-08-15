'use strict'
/** Minimal bridge for the status/update pages: retry trigger + status lines. */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dsh', {
  retry: () => ipcRenderer.send('dsh:retry'),
  onStatus: (callback) => ipcRenderer.on('dsh:status', (_event, text) => callback(text)),
  onUpdate: (callback) => ipcRenderer.on('dsh:update', (_event, payload) => callback(payload)),
})
