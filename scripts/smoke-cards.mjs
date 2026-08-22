/**
 * Asserts that every card type shows a control matching its question.
 *
 * This exists because "Where is Guatemala?" once rendered a text box: the view
 * picked its input with a ternary chain and `locate` fell through to the last
 * branch. Unit tests cover the mapping; this covers what is actually on screen.
 */
import { chromium } from 'playwright'

const BASE = process.env.SMOKE_URL ?? 'http://localhost:5173'
const OUT = process.env.SMOKE_OUT ?? '/tmp'

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))

const card = (iso3, type, over = {}) => ({
  id: `${iso3}:${type}`,
  iso3,
  type,
  due: Date.now() - 60_000,
  stability: 40,
  difficulty: 5,
  elapsed_days: 5,
  scheduled_days: 40,
  learning_steps: 0,
  reps: 9,
  lapses: 0,
  state: 2,
  last_review: Date.now() - 86_400_000,
  ...over,
})

// One card of every type, all due now. A young identify card is included
// separately so both of its answer modes are exercised.
const seeded = [
  card('PER', 'locate'),
  card('BRA', 'identify'),
  card('CHL', 'identify', { stability: 2, state: 1, reps: 1 }),
  card('ARG', 'capital'),
  card('COL', 'flag'),
  card('BOL', 'neighbors'),
  // City cards carry the city id in the card id; a young city-identify is
  // included so its choice mode is exercised alongside locate's point tap.
  card('MEX', 'city-locate', { id: 'MEX-mexico-city:city-locate' }),
  card('CAN', 'city-identify', { id: 'CAN-toronto:city-identify', stability: 2, state: 1, reps: 1 }),
]

// The fixture is planted before any page script runs. The previous pattern
// (goto, write localStorage, reload) raced the app's own first load: virgin
// storage triggers the known-by-default seeding, whose debounced flush could
// land after the test fixture was written and clobber it.
await page.addInitScript((cards) => {
  localStorage.setItem('gb:v1:cards', JSON.stringify(Object.fromEntries(cards.map((c) => [c.id, c]))))
  localStorage.setItem('gb:v1:settings', JSON.stringify({ newCardsPerDay: 0 }))
  localStorage.setItem('gb:v1:stats', JSON.stringify({ perCard: {}, daily: {}, confusion: {} }))
}, seeded)
await page.goto(BASE + '/', { waitUntil: 'networkidle' })
await page.waitForSelector('.home')
await page.locator('button.primary').click()
await page.waitForSelector('.study')

/** What each prompt shape is allowed to render. */
const EXPECTED = [
  { match: /^Where is (Mexico City|Toronto)\?/, control: 'map-only', label: 'city-locate' },
  { match: /^Where is /, control: 'map-only', label: 'locate' },
  { match: /^Which city is marked\?$/, control: 'choice-or-text', label: 'city-identify' },
  { match: /^Which country is highlighted\?$/, control: 'choice-or-text', label: 'identify' },
  { match: /^Capital of /, control: 'text', label: 'capital' },
  { match: /^Whose flag is this\?$/, control: 'choice', label: 'flag' },
  { match: /^Select every country bordering /, control: 'done-button', label: 'neighbors' },
]

const failures = []
const seen = new Set()

for (let i = 0; i < 16; i++) {
  if (await page.locator('.reveal').count()) {
    await page.locator('.reveal button.primary').click()
    await page.waitForTimeout(200)
    continue
  }
  if (!(await page.locator('.ask').count())) break

  const prompt = (await page.locator('.prompt').innerText()).trim()
  // The stimulus renders after the geometry file loads and parses; give it a
  // moment so the first card is not judged against a still-empty map panel.
  await page
    .waitForSelector('.map-panel svg, .big-flag', { timeout: 10_000 })
    .catch(() => {})
  const ui = await page.evaluate(() => ({
    map: !!document.querySelector('.map-panel svg'),
    flag: !!document.querySelector('.big-flag'),
    input: !!document.querySelector('.typed input'),
    options: document.querySelectorAll('.options button').length,
    done: !!Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.startsWith('Done (')),
  }))

  const rule = EXPECTED.find((e) => e.match.test(prompt))
  if (!rule) {
    failures.push(`unrecognised prompt: "${prompt}"`)
  } else {
    seen.add(rule.label)
    const bad = []
    if (rule.control === 'map-only') {
      if (!ui.map) bad.push('no map')
      if (ui.input) bad.push('has a text input')
      if (ui.options) bad.push(`has ${ui.options} choice buttons`)
    }
    if (rule.control === 'text' && !ui.input) bad.push('no text input')
    if (rule.control === 'choice' && ui.options === 0) bad.push('no choice buttons')
    if (rule.control === 'choice' && ui.input) bad.push('has a text input too')
    if (rule.control === 'choice-or-text' && !ui.input && ui.options === 0) bad.push('neither input nor choices')
    if (rule.control === 'done-button' && !ui.done) bad.push('no Done button')
    if (rule.label === 'flag' && !ui.flag) bad.push('no flag shown')

    console.log(`${bad.length ? 'FAIL' : ' ok '}  ${rule.label.padEnd(9)} "${prompt}"${bad.length ? ' — ' + bad.join(', ') : ''}`)
    if (bad.length) {
      failures.push(`${rule.label}: ${bad.join(', ')}`)
      await page.screenshot({ path: `${OUT}/mismatch-${rule.label}.png` })
    }
  }

  await page.locator('.ask-foot button.ghost').click()
  await page.waitForTimeout(250)
}

for (const e of EXPECTED) if (!seen.has(e.label)) failures.push(`${e.label} card never appeared`)
if (errors.length) failures.push(...errors)

console.log(failures.length ? `\nFAILURES:\n  ${failures.join('\n  ')}` : '\nall card types match their prompts')
await browser.close()
process.exit(failures.length ? 1 : 0)
