import { chromium } from 'playwright'

// Issue #2: the browser back gesture must navigate inside the app, never
// strand the user on a blank page. Each sub-screen consumes exactly one
// history entry, so back always lands on home and the stack never grows.

const OUT = process.env.SMOKE_OUT ?? '/tmp'
const BASE = process.env.SMOKE_URL ?? 'http://localhost:5173'
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
const page = await browser.newPage({ viewport: { width: 390, height: 780 } })

const errors = []
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
page.on('pageerror', (e) => errors.push(String(e)))

let failures = 0
async function expectHome(label) {
  await page.waitForSelector('.home', { timeout: 5000 }).catch(() => {})
  const h1 = await page
    .locator('h1')
    .first()
    .innerText()
    .catch(() => '(no h1 — blank page)')
  const ok = h1.trim() === 'Geography Bee'
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} → "${h1.trim()}"`)
  if (!ok) {
    failures++
    await page.screenshot({ path: `${OUT}/back-fail-${label.replace(/\W+/g, '-')}.png` })
  }
}

await page.goto(BASE + '/', { waitUntil: 'networkidle' })
await page.waitForSelector('.home', { timeout: 15000 })
const depth0 = await page.evaluate(() => history.length)

// Browser-back out of each browsable screen lands on home.
await page.locator('button', { hasText: 'Progress' }).click()
await page.waitForSelector('.dashboard', { timeout: 5000 })
await page.goBack()
await expectHome('back from dashboard')

await page.locator('button', { hasText: /^Packs/ }).click()
await page.waitForSelector('.packs-head', { timeout: 5000 })
await page.goBack()
await expectHome('back from packs')

// Forward onto a stale sub-screen entry must not blank either — it resolves
// to home (study/rapid queues are memory-only and cannot be restored).
await page.goForward()
await expectHome('forward after back')
await page.goBack().catch(() => {})
await expectHome('settle after forward probe')

// Backing out of a live study session is a quit, back to home.
await page.locator('button.primary.big').click()
await page.waitForSelector('.study', { timeout: 5000 })
await page.goBack()
await expectHome('back from mid-study')

// In-app Back buttons run through history too, so entries are consumed
// rather than stacked.
await page.locator('button', { hasText: 'Progress' }).click()
await page.waitForSelector('.dashboard', { timeout: 5000 })
await page.locator('.packs-head button.ghost').click()
await expectHome('in-app back button from dashboard')

// After all that churn the stack holds at most one entry beyond where we
// started; unbounded growth here is the "swipe several times" bug reborn.
const depthN = await page.evaluate(() => history.length)
const bounded = depthN <= depth0 + 1
console.log(`${bounded ? 'ok  ' : 'FAIL'} history depth bounded (${depth0} → ${depthN})`)
if (!bounded) failures++

console.log(errors.length ? `CONSOLE ERRORS:\n${errors.join('\n')}` : 'no console errors')
await browser.close()
if (failures || errors.length) process.exit(1)
