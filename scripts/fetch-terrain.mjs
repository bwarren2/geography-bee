/**
 * Re-vendors public/data/terrain.jpg — NASA's Blue Marble: Next Generation
 * composite (public domain), 4096×2048 equirectangular — from the pinned
 * three-globe npm tarball that mirrors it. Registry tarball URLs are
 * immutable, so this is reproducible without adding a 25MB devDependency
 * for one image. See ATTRIBUTION-DATA.md.
 *
 * Run rarely and deliberately; the output is committed like all other data.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TARBALL = 'https://registry.npmjs.org/three-globe/-/three-globe-2.45.2.tgz'
const INSIDE = 'package/example/img/earth-blue-marble.jpg'
const OUT = new URL('../public/data/terrain.jpg', import.meta.url).pathname

const dir = mkdtempSync(join(tmpdir(), 'terrain-'))
try {
  const tgz = join(dir, 'pkg.tgz')
  execFileSync('curl', ['-sSL', '-o', tgz, TARBALL], { stdio: 'inherit' })
  execFileSync('tar', ['-xzf', tgz, '-C', dir, INSIDE], { stdio: 'inherit' })
  copyFileSync(join(dir, INSIDE), OUT)
  console.log(`terrain.jpg updated (${(statSync(OUT).size / 1024).toFixed(0)} KB)`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
