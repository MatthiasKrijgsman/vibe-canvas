// npm doesn't run dependency install scripts by default anymore, so do the two
// steps this app actually needs: fetch the Electron binary and make node-pty's
// prebuilt spawn-helper executable (it ships without the +x bit).
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

execFileSync(process.execPath, ['node_modules/electron/install.js'], { stdio: 'inherit' })

const prebuilds = 'node_modules/node-pty/prebuilds'
if (existsSync(prebuilds)) {
  for (const dir of readdirSync(prebuilds)) {
    const helper = join(prebuilds, dir, 'spawn-helper')
    if (existsSync(helper)) chmodSync(helper, 0o755)
  }
}
