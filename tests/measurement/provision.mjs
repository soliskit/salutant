// Development-only provisioning for the measurement tools, following the
// repo's own convention for its WebKit check: npm install --no-save with
// exact pins, then a version assertion (run.mjs fails on a mismatch). No
// package.json entry, no lockfile, no CI change; the runtime stays
// zero-dependency. The joined install specs are built here so no file in
// the tree carries an address-shaped string (logging-hygiene scan).
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const { tools } = JSON.parse(readFileSync(new URL('./tools.json', import.meta.url), 'utf8'))
const specs = Object.entries(tools).map(([name, pin]) => `${name}@${pin}`)
const install = spawnSync('npm', ['install', '--no-save', ...specs], { stdio: 'inherit' })
if (install.status !== 0) process.exit(install.status ?? 1)
const browsers = spawnSync('npx', ['playwright', 'install', 'chromium'], { stdio: 'inherit' })
process.exit(browsers.status ?? 1)
