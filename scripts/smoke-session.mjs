import { chromium } from 'playwright'

const OUT = process.env.SMOKE_OUT ?? '/tmp'
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
const page = await browser.newPage({ viewport: { width: 390, height: 780 } })

const errors = []
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
page.on('pageerror', (e) => errors.push(String(e)))

const shot = (n) => page.screenshot({ path: `${OUT}/session-${n}.png` })

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await page.waitForSelector('.home', { timeout: 15000 })
console.log('home:', (await page.locator('.stats').innerText()).replace(/\n/g, ' '))
await shot('1-home')

await page.locator('button.primary').click()
await page.waitForSelector('.study', { timeout: 10000 })

/** Answer whatever is on screen, correctly when we can work out the answer. */
async function answerOne(i) {
  if (await page.locator('.teach').count()) {
    const name = (await page.locator('.teach h2').innerText()).trim()
    if (i < 3) await shot(`2-teach-${i}`)
    await page.locator('.teach button.primary').click()
    await page.waitForTimeout(120)
    return `teach ${name}`
  }

  const prompt = (await page.locator('.prompt').innerText()).trim()

  // locate: click the country named in the prompt.
  const m = prompt.match(/^Where is (.+)\?$/)
  if (m) {
    const iso = await page.evaluate(async (name) => {
      const b = await (await fetch('/data/countries.json')).json()
      return b.countries.find((c) => c.name === name)?.iso3
    }, m[1])
    const pt = await page.evaluate((iso) => {
      const p = document.querySelector(`path[data-iso3="${iso}"]`)
      if (!p) return null
      const svg = p.ownerSVGElement.getBoundingClientRect()
      for (let y = 4; y < svg.height; y += 4)
        for (let x = 4; x < svg.width; x += 4)
          if (document.elementFromPoint(svg.left + x, svg.top + y) === p) return { x, y }
      return null
    }, iso)
    const box = await page.locator('.map-panel svg').boundingBox()
    if (pt) await page.mouse.click(box.x + pt.x, box.y + pt.y)
    else await page.locator('.ask-foot button.ghost').click()
    if (i < 4) await shot(`3-locate-${i}`)
  } else if (await page.locator('.options button').count()) {
    // identify / flag: pick the highlighted country by reading the map marks.
    const iso = await page.evaluate(() => {
      const t = document.querySelector('path[fill="#f59e0b"]')
      return t?.getAttribute('data-iso3') ?? null
    })
    const names = await page.locator('.options button').allInnerTexts()
    let picked = false
    if (iso) {
      const b = await page.evaluate(async () => (await (await fetch('/data/countries.json')).json()).countries)
      const want = b.find((c) => c.iso3 === iso)?.name
      const idx = names.findIndex((n) => n.trim() === want)
      if (idx >= 0) {
        await page.locator('.options button').nth(idx).click()
        picked = true
      }
    }
    if (!picked) await page.locator('.options button').first().click()
    if (i < 6) await shot(`4-identify-${i}`)
  } else if (await page.locator('.typed input').count()) {
    await page.locator('.typed input').fill('Peru')
    await page.locator('.typed button').click()
  } else {
    await page.locator('.ask-foot button.ghost').click()
  }

  await page.waitForTimeout(150)
  return prompt
}

let steps = 0
for (let i = 0; i < 40; i++) {
  if (await page.locator('.home').count()) break
  if (await page.locator('.reveal').count()) {
    if (steps < 3) await shot(`5-reveal-${steps}`)
    await page.locator('.reveal button.primary').click()
    await page.waitForTimeout(150)
    continue
  }
  const what = await answerOne(steps)
  if (steps < 12) console.log(`  ${steps}: ${what}`)
  steps++
}

await page.waitForTimeout(400)
if (await page.locator('.home h1').count()) {
  console.log('ended at:', await page.locator('.home h1').innerText())
  console.log('summary:', (await page.locator('.stats').innerText()).replace(/\n/g, ' '))
  await shot('6-summary')
}

// Progress must survive a reload — this is the whole point of the store.
const stored = await page.evaluate(() => ({
  cards: Object.keys(JSON.parse(localStorage.getItem('gb:v1:cards') ?? '{}')).length,
  log: JSON.parse(localStorage.getItem('gb:v1:log:' + new Date().toISOString().slice(0, 7)) ?? '[]').length,
  index: localStorage.getItem('gb:v1:logindex'),
}))
console.log('persisted:', JSON.stringify(stored))

await page.reload({ waitUntil: 'networkidle' })
await page.waitForSelector('.home', { timeout: 10000 })
console.log('after reload:', (await page.locator('.stats').innerText()).replace(/\n/g, ' '))

console.log(errors.length ? `CONSOLE ERRORS:\n${errors.join('\n')}` : 'no console errors')
await browser.close()
