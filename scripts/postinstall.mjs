// npm doesn't run dependency install scripts by default anymore, so do the steps this
// app actually needs: fetch the Electron binary, make node-pty's prebuilt spawn-helper
// executable (it ships without the +x bit), and brand the development Electron.app.
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

execFileSync(process.execPath, ['node_modules/electron/install.js'], { stdio: 'inherit' })

const prebuilds = 'node_modules/node-pty/prebuilds'
if (existsSync(prebuilds)) {
  for (const dir of readdirSync(prebuilds)) {
    const helper = join(prebuilds, dir, 'spawn-helper')
    if (existsSync(helper)) chmodSync(helper, 0o755)
  }
}

// `npm run dev` runs inside Electron's own app bundle, so the Dock and menu bar show
// "Electron" and its icon. Rename the bundle and swap in our icon, then re-sign it
// (ad hoc), because editing a signed bundle otherwise stops macOS from launching it.
const bundle = 'node_modules/electron/dist/Electron.app'
if (process.platform === 'darwin' && existsSync(bundle)) {
  const plist = join(bundle, 'Contents/Info.plist')
  for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
    execFileSync('plutil', ['-replace', key, '-string', 'VibeCanvas', plist])
  }
  if (existsSync('build/icon.icns')) copyFileSync('build/icon.icns', join(bundle, 'Contents/Resources/electron.icns'))
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'ignore' })
  // Ask Launch Services to pick up the new name and icon.
  const lsregister =
    '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
  if (existsSync(lsregister)) execFileSync(lsregister, ['-f', bundle], { stdio: 'ignore' })
}
