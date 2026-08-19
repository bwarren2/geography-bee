/**
 * Re-vendors public/data/terrain.jpg — NASA's "The Blue Marble: Land
 * Surface, Ocean Color and Sea Ice" composite (Visible Earth #57730, public
 * domain), 8192×4096 equirectangular — from a pinned commit of a GitHub
 * repository that mirrors it, since visibleearth.nasa.gov itself is not
 * reachable from every build environment. See ATTRIBUTION-DATA.md.
 *
 * Run rarely and deliberately; the output is committed like all other data.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = 'https://github.com/franky-adl/threejs-earth'
const COMMIT = '9a98346b5d6a8575dd8837e16fea776f30f7784d'
const INSIDE = 'src/assets/Albedo.jpg'
const OUT = new URL('../public/data/terrain.jpg', import.meta.url).pathname

const dir = mkdtempSync(join(tmpdir(), 'terrain-'))
try {
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'inherit' })
  execFileSync('git', ['clone', '--filter=blob:none', '--no-checkout', REPO, dir], { stdio: 'inherit' })
  git('checkout', COMMIT, '--', INSIDE)
  copyFileSync(join(dir, INSIDE), OUT)
  console.log(`terrain.jpg updated (${(statSync(OUT).size / 1024).toFixed(0)} KB)`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
