import { chromium } from 'playwright'

const OUT = process.env.SMOKE_OUT ?? '/tmp'
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
const page = await browser.newPage({ viewport: { width: 390, height: 780 } })

const errors = []
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
page.on('pageerror', (e) => errors.push(String(e)))

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await page.waitForSelector('svg path[data-iso3]', { timeout: 15000 })

const label = () => page.locator('span').last().textContent()

/**
 * A bounding-box centre is not reliably inside a country — Indonesia's lands in
 * the Java Sea and Russia's bbox wraps the dateline — so scan for a pixel the
 * browser actually hit-tests to this path.
 */
async function pointInside(iso3) {
  return page.evaluate((iso) => {
    const p = document.querySelector(`path[data-iso3="${iso}"]`)
    if (!p) return null
    // Sweep the visible map rather than the path's bounding box: France's box
    // spans its overseas departments, so box-relative samples miss the mainland
    // entirely. This also answers the question that actually matters — is the
    // country reachable by a click anywhere on screen?
    const svg = p.ownerSVGElement.getBoundingClientRect()
    for (let y = 4; y < svg.height; y += 5) {
      for (let x = 4; x < svg.width; x += 5) {
        if (document.elementFromPoint(svg.left + x, svg.top + y) === p) return { x, y }
      }
    }
    return null
  }, iso3)
}

/** Click a point genuinely inside the country's rendered shape. */
async function clickCountry(iso3) {
  const box = await page.locator('svg').boundingBox()
  const pt = await pointInside(iso3)
  if (!pt) return `${iso3}: no interior pixel found`
  await page.mouse.click(box.x + pt.x, box.y + pt.y)
  await page.waitForTimeout(200)
  return `${iso3} -> ${(await label()).trim()}`
}

/** Click exactly at the rendered centre, which is how snapping gets exercised
 *  for countries too small to have an interior pixel of their own. */
async function clickCentroid(iso3) {
  const box = await page.locator('svg').boundingBox()
  const pt = await page.evaluate((iso) => {
    const p = document.querySelector(`path[data-iso3="${iso}"]`)
    if (!p) return null
    const b = p.getBBox()
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  }, iso3)
  if (!pt) return `${iso3}: NOT RENDERED`
  await page.mouse.click(box.x + pt.x, box.y + pt.y)
  await page.waitForTimeout(200)
  return `${iso3} @centre -> ${(await label()).trim()}`
}

console.log('--- world view ---')
for (const iso of ['BRA', 'RUS', 'AUS', 'FRA']) console.log(' ', await clickCountry(iso))

// Per view: countries clicked in their interior, then micro-states clicked at
// their centre to exercise snap resolution.
const views = {
  'south-america': { big: ['PER', 'URY', 'BRA'], tiny: ['SUR', 'GUY'] },
  'western-europe': { big: ['FRA', 'DEU', 'CHE'], tiny: ['LUX', 'MCO', 'LIE', 'AND'] },
  caribbean: { big: ['CUB', 'HTI'], tiny: ['BRB', 'KNA', 'DMA', 'ATG', 'GRD'] },
  oceania: { big: ['AUS', 'PNG'], tiny: ['NRU', 'TUV', 'FJI', 'MHL'] },
  'southeast-asia': { big: ['IDN', 'THA', 'VNM'], tiny: ['SGP', 'BRN'] },
}

for (const [slug, { big, tiny }] of Object.entries(views)) {
  await page.selectOption('select', slug)
  await page.waitForTimeout(700)
  console.log(`--- ${slug} ---`)
  for (const iso of big) console.log(' ', await clickCountry(iso))
  for (const iso of tiny) console.log(' ', await clickCentroid(iso))
  await page.screenshot({ path: `${OUT}/map-${slug}.png` })
}

// The crowding guard: France must stay clickable with Monaco beside it.
await page.selectOption('select', 'western-europe')
await page.waitForTimeout(700)
console.log('--- crowding ---')
console.log(' ', await clickCountry('FRA'), '(must be France, not Monaco)')
console.log(' ', await clickCentroid('MCO'), '(must be Monaco, not France)')

console.log(errors.length ? `CONSOLE ERRORS:\n${errors.join('\n')}` : 'no console errors')
await browser.close()
