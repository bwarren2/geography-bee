/**
 * Build-time data pipeline.
 *
 * Run locally with `npm run build:data`, never at deploy time. Everything this
 * emits is committed to the repo, so the app has zero network dependencies at
 * build or runtime and every data change shows up as a reviewable diff.
 *
 * Sources (see data/ATTRIBUTION.md):
 *   world-atlas     — Natural Earth geometry, public domain
 *   world-countries — codes/capitals/borders/area, ODbL
 *   country-json    — population and context facts, MIT
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { geoCentroid, geoBounds, geoArea } from 'd3-geo'
import { feature } from 'topojson-client'
import type { Topology, GeometryCollection } from 'topojson-specification'
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson'
import type { CountryRecord, QuizRegion, DataBundle } from '../src/types'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const OUT = join(ROOT, 'data')
const GEO_OUT = join(OUT, 'geo')

const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'))
const nm = (p: string) => join(ROOT, 'node_modules', p)

/** world-countries marks Vatican as a UN member and Palestine as not one. The
 *  set we want is the 193 members plus both permanent observers, so we take the
 *  package's flag as-is and add Palestine. That lands on exactly 195. */
const isTargetCountry = (c: RawCountry) => c.unMember || c.cca3 === 'PSE'

interface RawCountry {
  name: { common: string; official: string }
  cca2: string
  cca3: string
  ccn3: string
  unMember: boolean
  capital?: string[]
  altSpellings: string[]
  region: string
  subregion: string
  languages: Record<string, string>
  currencies: Record<string, { name: string; symbol?: string }>
  latlng: [number, number]
  landlocked: boolean
  borders: string[]
  area: number
  flag: string
}

/**
 * Quiz regions, coarser than world-countries' 24 subregions where those split
 * too finely to make a sensible map view (the four Oceania subregions in
 * particular). `order` is the curriculum sequence: home turf first, then
 * outward by familiarity, so early pegs exist before obscure countries need
 * somewhere to hang.
 */
const REGION_DEFS: { slug: string; name: string; order: number; from: string[] }[] = [
  { slug: 'north-central-america', name: 'North & Central America', order: 1, from: ['North America', 'Central America'] },
  { slug: 'south-america', name: 'South America', order: 2, from: ['South America'] },
  { slug: 'western-europe', name: 'Western & Central Europe', order: 3, from: ['Western Europe', 'Central Europe'] },
  { slug: 'northern-europe', name: 'Northern Europe', order: 4, from: ['Northern Europe'] },
  { slug: 'southern-europe', name: 'Southern & Southeast Europe', order: 5, from: ['Southern Europe', 'Southeast Europe'] },
  { slug: 'eastern-europe', name: 'Eastern Europe', order: 6, from: ['Eastern Europe'] },
  { slug: 'eastern-asia', name: 'East Asia', order: 7, from: ['Eastern Asia'] },
  { slug: 'southeast-asia', name: 'Southeast Asia', order: 8, from: ['South-Eastern Asia'] },
  { slug: 'southern-asia', name: 'South Asia', order: 9, from: ['Southern Asia'] },
  { slug: 'middle-east', name: 'Middle East', order: 10, from: ['Western Asia'] },
  { slug: 'central-asia', name: 'Central Asia', order: 11, from: ['Central Asia'] },
  { slug: 'northern-africa', name: 'North Africa', order: 12, from: ['Northern Africa'] },
  { slug: 'western-africa', name: 'West Africa', order: 13, from: ['Western Africa'] },
  { slug: 'eastern-africa', name: 'East Africa', order: 14, from: ['Eastern Africa'] },
  { slug: 'central-africa', name: 'Central Africa', order: 15, from: ['Middle Africa'] },
  { slug: 'southern-africa', name: 'Southern Africa', order: 16, from: ['Southern Africa'] },
  { slug: 'caribbean', name: 'Caribbean', order: 17, from: ['Caribbean'] },
  { slug: 'oceania', name: 'Oceania', order: 18, from: ['Australia and New Zealand', 'Melanesia', 'Micronesia', 'Polynesia'] },
]

const subregionToRegion = new Map<string, string>()
for (const r of REGION_DEFS) for (const s of r.from) subregionToRegion.set(s, r.slug)

// ---------------------------------------------------------------------------
// Load sources
// ---------------------------------------------------------------------------

const raw: RawCountry[] = read(nm('world-countries/countries.json'))
const countries = raw.filter(isTargetCountry)
if (countries.length !== 195) {
  throw new Error(`Expected 195 countries, got ${countries.length}`)
}

/**
 * country-json keys everything by country name. Its iso-numeric table is the
 * cleanest bridge to our ISO-keyed records, but that table has ~20 gaps
 * (Russia and Kazakhstan among them), so we fall back through progressively
 * looser name matching and finally an explicit alias table. Anything still
 * unmatched is reported at the end rather than silently becoming null.
 */
const cjDir = nm('country-json/src')

const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Word-order-insensitive key, so "Micronesia, Federated States of" and
 *  "Federated States of Micronesia" collapse to the same thing. */
const tokenKey = (s: string) =>
  normalize(s)
    .split(' ')
    .filter((t) => t && t !== 'the')
    .sort()
    .join(' ')

/** Names country-json uses that no amount of normalization reconciles. */
const NAME_ALIASES: Record<string, string> = {
  'Fiji Islands': 'FJI',
  'Holy See (Vatican City State)': 'VAT',
  Congo: 'COG',
  'Republic of Korea': 'KOR',
  'Democratic People\'s Republic of Korea': 'PRK',
}

const targetIsoNums = new Set(countries.map((c) => c.ccn3.padStart(3, '0')))
const byIso3 = new Map(countries.map((c) => [c.cca3, c.ccn3.padStart(3, '0')]))

/** country-json's iso-numeric table is advisory only: it has ~20 gaps and at
 *  least one outright wrong code (Montenegro as 382, which is unassigned), so
 *  entries are kept only when they name a country actually in our set. */
const isoByName = new Map<string, string>()
for (const row of read(join(cjDir, 'country-by-iso-numeric.json')) as { country: string; iso: number | string | null }[]) {
  if (row.iso == null) continue
  const padded = String(row.iso).padStart(3, '0')
  if (targetIsoNums.has(padded)) isoByName.set(row.country, padded)
}

/** Index builder that drops any key claimed by more than one country, so an
 *  ambiguous alias (e.g. "Congo") falls through to the explicit table rather
 *  than silently binding to whichever country was seen first. */
function buildIndex(keysFor: (c: RawCountry) => string[]): Map<string, string> {
  const seen = new Map<string, Set<string>>()
  for (const c of countries) {
    for (const k of keysFor(c)) {
      if (!k) continue
      if (!seen.has(k)) seen.set(k, new Set())
      seen.get(k)!.add(c.ccn3.padStart(3, '0'))
    }
  }
  const out = new Map<string, string>()
  for (const [k, isos] of seen) if (isos.size === 1) out.set(k, [...isos][0]!)
  return out
}

const byOfficialName = buildIndex((c) => [normalize(c.name.common), normalize(c.name.official)])
const byOfficialTokens = buildIndex((c) => [tokenKey(c.name.common), tokenKey(c.name.official)])
const byAltName = buildIndex((c) => c.altSpellings.map(normalize))

const unresolvedNames = new Set<string>()

/** Ordered most to least trustworthy: world-countries carries authoritative ISO
 *  assignments, so its own names beat the third-party bridge table. */
function resolveIso(name: string): string | undefined {
  const hit =
    byOfficialName.get(normalize(name)) ??
    byOfficialTokens.get(tokenKey(name)) ??
    byAltName.get(normalize(name)) ??
    isoByName.get(name) ??
    (NAME_ALIASES[name] ? byIso3.get(NAME_ALIASES[name]!) : undefined)
  if (!hit) unresolvedNames.add(name)
  return hit
}

function cjLookup<T>(file: string, key: string): Map<string, T> {
  const out = new Map<string, T>()
  for (const row of read(join(cjDir, file)) as Record<string, unknown>[]) {
    const iso = resolveIso(row.country as string)
    const value = row[key]
    if (iso && value != null && value !== '') out.set(iso, value as T)
  }
  return out
}

const populations = cjLookup<number>('country-by-population.json', 'population')
const elevations = cjLookup<number>('country-by-elevation.json', 'elevation')
const coastlines = cjLookup<number>('country-by-costline.json', 'costline')
const dishes = cjLookup<string>('country-by-national-dish.json', 'dish')

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

type WorldTopo = Topology<{ countries: GeometryCollection<{ name: string }> }>

function featuresByIso(res: '110m' | '50m' | '10m'): Map<string, Feature<Polygon | MultiPolygon>> {
  const topo: WorldTopo = read(nm(`world-atlas/countries-${res}.json`))
  const fc = feature(topo, topo.objects.countries) as unknown as FeatureCollection<Polygon | MultiPolygon>
  const map = new Map<string, Feature<Polygon | MultiPolygon>>()
  for (const f of fc.features) {
    if (f.id == null) continue
    map.set(String(Number(f.id)).padStart(3, '0'), f)
  }
  return map
}

const geo110 = featuresByIso('110m')
const geo50 = featuresByIso('50m')
const geo10 = featuresByIso('10m')

/** Tuvalu is the one UN member absent from the 50m topology, so we carry it (and
 *  anything else that goes missing if the upstream data shifts) as standalone
 *  GeoJSON pulled from 10m and merged at runtime. */
const extraFeatures: Feature[] = []

// ---------------------------------------------------------------------------
// Assemble records
// ---------------------------------------------------------------------------

const records: CountryRecord[] = []

for (const c of countries) {
  const isoNum = c.ccn3.padStart(3, '0')
  const detail = geo50.get(isoNum) ?? geo10.get(isoNum)
  if (!detail) throw new Error(`No geometry at any resolution for ${c.cca3}`)

  if (!geo50.has(isoNum)) {
    const f = geo10.get(isoNum)!
    extraFeatures.push({ ...f, id: isoNum, properties: { iso3: c.cca3, name: c.name.common } })
  }

  const centroid = geoCentroid(detail)
  const bounds = geoBounds(detail)

  // Typed answers should accept the names people actually use. altSpellings
  // carries the ISO code and official name too; those are harmless as accepted
  // answers but useless as prompts, so we keep them out of the display name.
  const altNames = [...new Set([c.name.official, ...c.altSpellings])]
    .filter((n) => n !== c.name.common && n.length > 2)

  records.push({
    iso3: c.cca3,
    iso2: c.cca2,
    isoNum,
    name: c.name.common,
    official: c.name.official,
    altNames,
    capital: c.capital ?? [],
    region: subregionToRegion.get(c.subregion) ?? 'other',
    subregion: c.subregion,
    continent: c.region,
    borders: c.borders ?? [],
    landlocked: c.landlocked,
    areaKm2: c.area,
    population: populations.get(isoNum) ?? null,
    flag: c.flag,
    currencies: Object.entries(c.currencies ?? {}).map(([code, v]) => ({
      code,
      name: v.name,
      symbol: v.symbol ?? null,
    })),
    languages: Object.values(c.languages ?? {}),
    labelPoint: [c.latlng[1], c.latlng[0]], // world-countries stores [lat, lng]
    centroid: [centroid[0], centroid[1]],
    bbox: [bounds[0][0], bounds[0][1], bounds[1][0], bounds[1][1]],
    solidAngle: geoArea(detail),
    elevationM: elevations.get(isoNum) ?? null,
    coastlineKm: coastlines.get(isoNum) != null ? coastlines.get(isoNum)! * 1000 : null,
    nationalDish: dishes.get(isoNum) ?? null,
    inWorldGeometry: geo110.has(isoNum),
    salience: 0, // filled below
    introOrder: 0, // filled below
  })
}

// ---------------------------------------------------------------------------
// Salience: approximates "how likely have you heard of this", used to order
// card introduction so well-known anchors land before obscure neighbours.
// ---------------------------------------------------------------------------

const logArea = (r: CountryRecord) => Math.log10(Math.max(r.areaKm2, 1))
const logPop = (r: CountryRecord) => Math.log10(Math.max(r.population ?? 1e4, 1e4))

function zScorer(values: number[]) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length) || 1
  return (v: number) => (v - mean) / sd
}

const zArea = zScorer(records.map(logArea))
const zPop = zScorer(records.map(logPop))
for (const r of records) r.salience = Number((0.5 * zArea(logArea(r)) + 0.5 * zPop(logPop(r))).toFixed(4))

// Introduction order: region curriculum order first, then salience within region.
const regionOrder = new Map(REGION_DEFS.map((r) => [r.slug, r.order]))
const sorted = [...records].sort((a, b) => {
  const ra = regionOrder.get(a.region) ?? 99
  const rb = regionOrder.get(b.region) ?? 99
  return ra !== rb ? ra - rb : b.salience - a.salience
})
sorted.forEach((r, i) => (r.introOrder = i))

// ---------------------------------------------------------------------------
// Regions, with a bbox covering their members so map views can frame themselves
// ---------------------------------------------------------------------------

const regions: QuizRegion[] = REGION_DEFS.map((def) => {
  const members = records.filter((r) => r.region === def.slug)
  if (!members.length) throw new Error(`Region ${def.slug} has no members`)
  // Longitudes are unwrapped around the region's median before taking extremes
  // so antimeridian-spanning regions (Oceania) don't frame the entire globe.
  const lons = members.map((m) => m.centroid[0]).sort((a, b) => a - b)
  const pivot = lons[Math.floor(lons.length / 2)]!
  const unwrap = (lon: number) => (lon - pivot > 180 ? lon - 360 : lon - pivot < -180 ? lon + 360 : lon)

  let w = Infinity, e = -Infinity, s = Infinity, n = -Infinity
  for (const m of members) {
    w = Math.min(w, unwrap(m.bbox[0]))
    e = Math.max(e, unwrap(m.bbox[2]))
    s = Math.min(s, m.bbox[1])
    n = Math.max(n, m.bbox[3])
  }
  return {
    slug: def.slug,
    name: def.name,
    order: def.order,
    countries: members.sort((a, b) => a.introOrder - b.introOrder).map((m) => m.iso3),
    bbox: [w + pivot, s, e + pivot, n],
  }
})

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

mkdirSync(GEO_OUT, { recursive: true })

const bundle: DataBundle = {
  version: 1,
  generatedFrom: {
    'world-atlas': read(nm('world-atlas/package.json')).version,
    'world-countries': read(nm('world-countries/package.json')).version,
    'country-json': read(nm('country-json/package.json')).version,
  },
  regions,
  countries: records.sort((a, b) => a.iso3.localeCompare(b.iso3)),
}

const write = (path: string, value: unknown) => {
  writeFileSync(path, JSON.stringify(value))
  return (Buffer.byteLength(JSON.stringify(value)) / 1024).toFixed(0)
}

// Geometry ships as two resolutions: 110m frames the whole-world view (the 29
// microstates it omits are sub-pixel there anyway and render as markers), 50m
// backs every region view. Both are immutable and service-worker cached.
const topo110: WorldTopo = read(nm('world-atlas/countries-110m.json'))
const topo50: WorldTopo = read(nm('world-atlas/countries-50m.json'))

const sizes = {
  countries: write(join(OUT, 'countries.json'), bundle),
  world: write(join(GEO_OUT, 'world-110m.json'), topo110),
  detail: write(join(GEO_OUT, 'world-50m.json'), topo50),
  extra: write(join(GEO_OUT, 'extra-features.json'), {
    type: 'FeatureCollection',
    features: extraFeatures,
  }),
}

console.log(`${records.length} countries, ${regions.length} regions`)
console.log(
  `sizes(KB): countries=${sizes.countries} world110=${sizes.world} world50=${sizes.detail} extra=${sizes.extra}`,
)
console.log(`patched from 10m: ${extraFeatures.map((f) => (f.properties as any).iso3).join(', ') || 'none'}`)

// Fields the app cannot function without: fail the build rather than ship holes.
const noCapital = records.filter((r) => !r.capital.length)
if (noCapital.length) throw new Error(`Missing capital: ${noCapital.map((r) => r.iso3).join(', ')}`)

// Optional context: report so gaps are visible in the build log and can be
// backfilled by hand in the hooks file if they ever matter.
const report = (label: string, missing: CountryRecord[]) =>
  console.log(`${label}: ${missing.length}${missing.length ? ' — ' + missing.map((r) => r.iso3).join(', ') : ''}`)

report('no population', records.filter((r) => r.population == null))
report('no elevation', records.filter((r) => r.elevationM == null))
report('no national dish', records.filter((r) => r.nationalDish == null))
console.log(`country-json names not matched to our set: ${unresolvedNames.size} (expected — non-UN territories)`)
