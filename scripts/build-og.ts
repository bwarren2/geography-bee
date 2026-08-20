/**
 * Renders public/og.png (1200×630) — the static rich-embed card that link
 * previews show when the app's URL is shared. Link crawlers fetch the page
 * anonymously, so this card is necessarily generic; per-user progress ships
 * as an image through the in-app share button instead.
 *
 * Committed output, like all other data: `npm run build:og` after changing
 * the card design or the geometry.
 */
import { chromium } from 'playwright'
import { buildShareCardSvg, worldPaths } from '../src/share/shareCard'
import { loadCommittedBundle, loadCommittedGeometry } from './geo-node'

const bundle = loadCommittedBundle()
const geo = loadCommittedGeometry(bundle)

const svg = buildShareCardSvg({
  ...worldPaths(geo, {}),
  headline: 'Learn where every country is',
  subline: `Free spaced-repetition atlas — locate, name, and remember all ${bundle.countries.length} UN members.`,
  legend: null,
})

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } })
await page.setContent(`<style>*{margin:0}</style>${svg}`)
await page.screenshot({ path: 'public/og.png' })
await browser.close()
console.log('public/og.png rendered')
