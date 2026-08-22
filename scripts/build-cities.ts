/**
 * Builds public/data/cities.json for the Cities pack (#4 follow-on): every
 * country's capital plus the world's major non-capital cities, with
 * coordinates for placement quizzing.
 *
 * Source: Natural Earth 10m populated places (public domain), sparse-cloned
 * from github.com/nvkelso/natural-earth-vector — the same family as all our
 * geometry, and not on npm at usable size. Pass a local geojson path to skip
 * the clone. Output is committed, like everything under public/data/.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CityRecord, DataBundle } from '../src/types'

const NE_REPO = 'https://github.com/nvkelso/natural-earth-vector'
const NE_FILE = 'geojson/ne_10m_populated_places_simple.geojson'

/** A major (non-capital) city must be at least this populous… */
const MAJOR_MIN_POP = 3_000_000
/** …and no country contributes more than this many majors, so China and
 *  India do not turn the pack into their own metro tour. */
const MAJORS_PER_COUNTRY = 4

/** NE data quirks: misspellings and metro-area double counting. */
const RENAME: Record<string, string> = {
  Shenyeng: 'Shenyang',
  'St.  Petersburg': 'Saint Petersburg',
  Ōsaka: 'Osaka',
  Xian: "Xi'an",
}
const DROP = new Set([
  'Haora', // Howrah: the west bank of Kolkata, not a separate answer
  'Amaravati', // planned capital, population figure is aspirational
  'Delhi', // the metro around the capital; two dots kilometres apart cannot
  // be told apart at country zoom, so New Delhi answers for both
])

/** Accepted typed answers beyond the display name (historic and colloquial). */
const ALT_NAMES: Record<string, string[]> = {
  'New York': ['NYC', 'New York City'],
  'Ho Chi Minh City': ['Saigon'],
  Mumbai: ['Bombay'],
  Kolkata: ['Calcutta'],
  Chennai: ['Madras'],
  Bengaluru: ['Bangalore'],
  Yangon: ['Rangoon'],
  Chattogram: ['Chittagong'],
  'Washington, D.C.': ['Washington', 'Washington DC', 'DC'],
  'Saint Petersburg': ['St Petersburg'],
  "Xi'an": ['Xian'],
  Osaka: ['Ōsaka'],
  'Mexico City': ['CDMX', 'Ciudad de México'],
  Guangzhou: ['Canton'],
  'New Delhi': ['Delhi'],
}

interface NEPlace {
  name: string
  adm0_a3: string
  adm0cap: number
  pop_max: number
  latitude: number
  longitude: number
}

/** NE files disputed territories under their own codes; bridge the ones that
 *  are our countries — the geometry pipeline crosses the same gap. */
const CODE_BRIDGE: Record<string, string> = { PSX: 'PSE' }

/** Places NE 10m omits entirely. Nauru has no formal capital; Yaren is the
 *  de facto seat of government and the universal quiz answer. */
const EXTRA_PLACES: NEPlace[] = [
  { name: 'Yaren', adm0_a3: 'NRU', adm0cap: 1, pop_max: 1100, latitude: -0.5477, longitude: 166.9209 },
]

function loadPlaces(localPath?: string): NEPlace[] {
  let path = localPath
  let cleanup: string | null = null
  if (!path) {
    const dir = mkdtempSync(join(tmpdir(), 'ne-places-'))
    cleanup = dir
    execFileSync('git', ['clone', '--filter=blob:none', '--no-checkout', '--depth', '1', NE_REPO, dir], { stdio: 'inherit' })
    execFileSync('git', ['-C', dir, 'checkout', 'HEAD', '--', NE_FILE], { stdio: 'inherit' })
    path = join(dir, NE_FILE)
  }
  const fc = JSON.parse(readFileSync(path, 'utf8'))
  const out = (fc.features as { properties: NEPlace }[]).map((f) => f.properties)
  if (cleanup) rmSync(cleanup, { recursive: true, force: true })
  return out
}

const ROOT = new URL('..', import.meta.url).pathname
const bundle: DataBundle = JSON.parse(readFileSync(join(ROOT, 'public/data/countries.json'), 'utf8'))
const countries = new Map(bundle.countries.map((c) => [c.iso3, c]))

const norm = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

const places = [...loadPlaces(process.argv[2]), ...EXTRA_PLACES]
  .map((p) => ({ ...p, adm0_a3: CODE_BRIDGE[p.adm0_a3] ?? p.adm0_a3 }))
  .filter((p) => countries.has(p.adm0_a3))

const cities: CityRecord[] = []
const problems: string[] = []

for (const c of bundle.countries) {
  const inCountry = places.filter((p) => p.adm0_a3 === c.iso3)

  // The capital: NE's adm0cap flag, disambiguated (South Africa lists three)
  // by world-countries' primary capital name, else by population. Countries
  // NE leaves unflagged (Nauru has no formal capital) fall back to a name
  // match, then to the biggest listed place.
  const flagged = inCountry.filter((p) => p.adm0cap === 1)
  const wcName = norm(c.capital[0] ?? '')
  const capital =
    flagged.find((p) => norm(p.name) === wcName) ??
    flagged.sort((a, b) => b.pop_max - a.pop_max)[0] ??
    inCountry.find((p) => norm(p.name) === wcName) ??
    inCountry.sort((a, b) => b.pop_max - a.pop_max)[0]
  if (!capital) {
    problems.push(`${c.iso3}: no populated place at all`)
    continue
  }

  const majors = inCountry
    .filter((p) => p !== capital && p.adm0cap !== 1 && p.pop_max >= MAJOR_MIN_POP && !DROP.has(p.name))
    .sort((a, b) => b.pop_max - a.pop_max)
    .slice(0, MAJORS_PER_COUNTRY)

  for (const p of [capital, ...majors]) {
    // NE occasionally double-spaces ("Washington,  D.C."); collapse first.
    const raw = p.name.replace(/\s+/g, ' ')
    const name = RENAME[raw] ?? raw
    cities.push({
      id: `${c.iso3}-${norm(name).replace(/ /g, '-')}`,
      name,
      altNames: ALT_NAMES[name] ?? ALT_NAMES[p.name] ?? [],
      iso3: c.iso3,
      lonlat: [Number(p.longitude.toFixed(4)), Number(p.latitude.toFixed(4))],
      popM: p.pop_max > 0 ? Number((p.pop_max / 1e6).toFixed(1)) : null,
      capital: p === capital,
      rank: 0, // filled below
    })
  }
}

if (problems.length) throw new Error(`City build failed:\n  ${problems.join('\n  ')}`)

// Introduction order mirrors the country curriculum: a country's capital
// first, then its majors by size, sequenced by the country's own introOrder.
const introOf = new Map(bundle.countries.map((c) => [c.iso3, c.introOrder]))
cities.sort((a, b) => {
  const d = introOf.get(a.iso3)! - introOf.get(b.iso3)!
  if (d !== 0) return d
  if (a.capital !== b.capital) return a.capital ? -1 : 1
  return (b.popM ?? 0) - (a.popM ?? 0)
})
cities.forEach((city, i) => (city.rank = i))

const dupes = cities.length - new Set(cities.map((c) => c.id)).size
if (dupes) throw new Error(`${dupes} duplicate city ids`)

writeFileSync(
  join(ROOT, 'public/data/cities.json'),
  JSON.stringify({ version: 1, cities }) + '\n',
)
const capCount = cities.filter((c) => c.capital).length
console.log(`${cities.length} cities (${capCount} capitals, ${cities.length - capCount} majors)`)
