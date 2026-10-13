// Render an SVG to a transparent PNG with Electron's Chromium (no extra tools needed).
//   npx electron scripts/render-svg.cjs resources/icon.svg resources/icon-source.png 1024
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')

const [svgPath, outPath, sizeArg = '1024'] = process.argv.slice(2)
const size = Number(sizeArg)

app.disableHardwareAcceleration()
app.dock?.hide()

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: size,
    height: size,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true }
  })
  const svg = fs.readFileSync(svgPath, 'utf8')
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  await new Promise((resolve) => setTimeout(resolve, 300))
  const image = await win.webContents.capturePage()
  fs.writeFileSync(outPath, image.resize({ width: size, height: size, quality: 'best' }).toPNG())
  console.log(`wrote ${outPath}`)
  app.quit()
})
