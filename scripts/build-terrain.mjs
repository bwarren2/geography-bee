/**
 * Tiles an equirectangular earth image into `public/data/terrain/` so the
 * app can fetch only the pieces a view needs (#5).
 *
 * Full-resolution Blue Marble is 21600×10800 — 233 megapixels. No phone can
 * decode that (Safari caps image dimensions well below 21600, and the pixel
 * buffer alone would be ~930MB), so resolution has to arrive in pieces:
 * a grid of small tiles plus a low-res overview for wide views, described by
 * a manifest. The app's terrain layer stitches the tiles that intersect the
 * current view's geographic window.
 *
 *   node scripts/build-terrain.mjs <source.jpg>
 *
 * The source is NOT committed (the intended one is ~90MB); the tiles are,
 * like all other data. Provenance for the intended source lives in
 * ATTRIBUTION-DATA.md.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'

const src = process.argv[2]
if (!src) {
  console.error('usage: node scripts/build-terrain.mjs <equirectangular.jpg>')
  process.exit(1)
}

const OUT = new URL('../public/data/terrain/', import.meta.url).pathname

/** ≤2048 on a side: comfortably inside every browser's decode limits, and
 *  small enough that one region view costs a few hundred KB, not the world. */
const TILE = 1800
const OVERVIEW_W = 2048
const QUALITY = 78

const image = sharp(src, { limitInputPixels: 24_000 * 12_000 })
const meta = await image.metadata()
if (!meta.width || !meta.height || Math.abs(meta.width / meta.height - 2) > 0.01) {
  throw new Error(`Source must be 2:1 equirectangular; got ${meta.width}x${meta.height}`)
}

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const cols = Math.ceil(meta.width / TILE)
const rows = Math.ceil(meta.height / TILE)

let total = 0
for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    const left = c * TILE
    const top = r * TILE
    const buf = await sharp(src, { limitInputPixels: 24_000 * 12_000 })
      .extract({
        left,
        top,
        width: Math.min(TILE, meta.width - left),
        height: Math.min(TILE, meta.height - top),
      })
      .jpeg({ quality: QUALITY, mozjpeg: true })
      .toBuffer()
    writeFileSync(join(OUT, `tile-${c}-${r}.jpg`), buf)
    total += buf.length
  }
}

const overview = await sharp(src, { limitInputPixels: 24_000 * 12_000 })
  .resize(OVERVIEW_W, OVERVIEW_W / 2)
  .jpeg({ quality: QUALITY, mozjpeg: true })
  .toBuffer()
writeFileSync(join(OUT, 'overview.jpg'), overview)

writeFileSync(
  join(OUT, 'manifest.json'),
  JSON.stringify({
    version: 1,
    width: meta.width,
    height: meta.height,
    tileSize: TILE,
    cols,
    rows,
    overviewWidth: OVERVIEW_W,
  }) + '\n',
)

console.log(
  `${cols}x${rows} tiles (${(total / 1024 / 1024).toFixed(1)}MB) + overview (${(overview.length / 1024).toFixed(0)}KB) from ${meta.width}x${meta.height}`,
)
console.log(`files: ${readdirSync(OUT).length} in public/data/terrain/`)
