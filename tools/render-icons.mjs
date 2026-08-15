// Rasterize the harness favicon.svg (white DeepSeek mark) onto the brand-blue
// background at the PWA/app sizes the harness and this desktop shell need.
// Usage: node tools/render-icons.mjs [harnessRoot] [outDir]
//   harnessRoot - deepseek-harness checkout (default: Dev/repos/deepseek-harness)
//   outDir      - where the PNGs go (default: harnessRoot/apps/web/public)
// Playwright must be resolvable from the harness checkout (apps/web has it).
import { chromium } from 'playwright'
import { readFile, copyFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const harnessRoot = resolve(process.argv[2] ?? join(here, '..', '..', 'repos', 'deepseek-harness'))
const outDir = resolve(process.argv[3] ?? join(harnessRoot, 'apps', 'web', 'public'))

const svg = await readFile(join(harnessRoot, 'apps', 'web', 'public', 'favicon.svg'), 'utf8')
const inner = svg.slice(svg.indexOf('>') + 1, svg.lastIndexOf('</svg>'))

const BLUE = '#4d6bfe'

async function render(size, logoPct, out) {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 })
    const html = `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:${BLUE}}</style></head>
<body><div style="width:${size}px;height:${size}px;background:${BLUE};display:flex;align-items:center;justify-content:center">
<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(size * logoPct)}" height="${Math.round(size * logoPct)}" viewBox="0 0 50 50">
<style>path{fill:#fff!important}</style>${inner}</svg></div></body></html>`
    await page.setContent(html)
    await page.screenshot({ path: out, type: 'png' })
  } finally {
    await browser.close()
  }
}

await mkdir(outDir, { recursive: true })
await render(192, 0.72, join(outDir, 'icon-192.png'))
await render(512, 0.72, join(outDir, 'icon-512.png'))
await render(512, 0.62, join(outDir, 'icon-maskable-512.png'))

// This shell's own copies.
const desktop = join(here, '..')
await mkdir(join(desktop, 'build'), { recursive: true })
await mkdir(join(desktop, 'splash'), { recursive: true })
await copyFile(join(outDir, 'icon-512.png'), join(desktop, 'build', 'icon.png'))
await copyFile(join(outDir, 'icon-512.png'), join(desktop, 'splash', 'logo.png'))

console.log(`icons written to ${outDir} and ${desktop}`)
