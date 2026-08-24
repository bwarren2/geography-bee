/**
 * Fetches a freely-licensed photo for each country's national dish into
 * public/data/dishes/, with per-image license bookkeeping.
 *
 *   node scripts/build-dishes.mjs [--dry]
 *
 * Source: the lead image of each dish's English Wikipedia article, which is
 * almost always a Wikimedia Commons photo. Only images under free licenses
 * (CC0 / public domain / CC BY / CC BY-SA) are taken; anything else — or a
 * dish with no article or no image — is skipped and reported. Every accepted
 * image's author and license go into the committed manifest (the app shows
 * the credit line) and into ATTRIBUTION-IMAGES.md.
 *
 * Needs network access to en.wikipedia.org, commons.wikimedia.org and
 * upload.wikimedia.org — not part of this project's usual no-network build,
 * so it runs rarely and deliberately, and its output is committed.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'

const ROOT = new URL('..', import.meta.url).pathname
const OUT = join(ROOT, 'public/data/dishes')
const DRY = process.argv.includes('--dry')

const WIDTH = 480
const QUALITY = 72
const UA = 'GeographyBee/1.0 (personal spaced-repetition app; one-off asset build)'

const FREE = /^(cc0|public domain|pd|cc by(-sa)?( \d\.\d)?( [a-z]{2})?)$/i

const bundle = JSON.parse(readFileSync(join(ROOT, 'public/data/countries.json'), 'utf8'))
const withDish = bundle.countries.filter((c) => c.nationalDish)

const api = async (host, params) => {
  const url = `https://${host}/w/api.php?${new URLSearchParams({ format: 'json', ...params })}`
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`${host}: ${res.status}`)
  return res.json()
}

/** Lead image file name of the dish's Wikipedia article, if any. */
async function leadImage(dish) {
  const data = await api('en.wikipedia.org', {
    action: 'query',
    titles: dish,
    redirects: '1',
    prop: 'pageimages',
    piprop: 'name',
  })
  const page = Object.values(data.query?.pages ?? {})[0]
  return page?.pageimage ? `File:${page.pageimage}` : null
}

/** Download URL + license metadata for a Commons file, or null if unfree. */
async function fileInfo(file) {
  const data = await api('commons.wikimedia.org', {
    action: 'query',
    titles: file,
    prop: 'imageinfo',
    iiprop: 'url|extmetadata',
    iiurlwidth: String(WIDTH * 2),
  })
  const info = Object.values(data.query?.pages ?? {})[0]?.imageinfo?.[0]
  if (!info) return null
  const meta = info.extmetadata ?? {}
  const license = meta.LicenseShortName?.value ?? ''
  if (!FREE.test(license)) return null
  const author = (meta.Artist?.value ?? 'Unknown').replace(/<[^>]*>/g, '').trim().slice(0, 80)
  return { url: info.thumburl ?? info.url, author, license, page: info.descriptionurl }
}

mkdirSync(OUT, { recursive: true })
const manifest = {}
const attribution = []
const skipped = []

for (const c of withDish) {
  // Multi-dish entries ("Harissa, Dolma, Khorovats") photograph the first.
  const dish = c.nationalDish.split(',')[0].trim()
  try {
    const file = await leadImage(dish)
    const info = file ? await fileInfo(file) : null
    if (!info) {
      skipped.push(`${c.iso3} ${dish}: ${file ? 'not freely licensed' : 'no article image'}`)
      continue
    }
    if (!DRY) {
      const res = await fetch(info.url, { headers: { 'User-Agent': UA } })
      if (!res.ok) throw new Error(`image ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      await sharp(buf).resize(WIDTH).jpeg({ quality: QUALITY, mozjpeg: true }).toFile(join(OUT, `${c.iso3}.jpg`))
    }
    manifest[c.iso3] = { dish, credit: `${info.author} · ${info.license}` }
    attribution.push(`- **${c.iso3}** ${dish}: ${info.author}, ${info.license} — ${info.page}`)
    console.log(`ok   ${c.iso3} ${dish} (${info.license})`)
  } catch (e) {
    skipped.push(`${c.iso3} ${dish}: ${e.message}`)
  }
  await new Promise((r) => setTimeout(r, 250)) // politeness
}

if (!DRY) {
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({ version: 1, photos: manifest }) + '\n')
  writeFileSync(
    join(ROOT, 'ATTRIBUTION-IMAGES.md'),
    `# Dish photo attribution\n\nEach photo below is the lead image of the dish's English Wikipedia\narticle, hosted on Wikimedia Commons under the stated free license, fetched\nby \`scripts/build-dishes.mjs\` and resized to ${WIDTH}px. The in-app reveal\nshows the same credit line.\n\n${attribution.join('\n')}\n`,
  )
}
console.log(`\n${Object.keys(manifest).length} photos, ${skipped.length} skipped`)
for (const s of skipped) console.log('  skip', s)
