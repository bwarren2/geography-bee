import { feature } from 'topojson-client'
import type { Topology, GeometryCollection } from 'topojson-specification'
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson'
import type { CityRecord, CountryRecord, DataBundle, QuizRegion } from '../types'

export type CountryFeature = Feature<Polygon | MultiPolygon, { iso3: string }>
export type Resolution = '110m' | '50m'

/** Parsed once per page load and shared; the files are immutable build output. */
const cache = new Map<string, Promise<unknown>>()

function once<T>(key: string, load: () => Promise<T>): Promise<T> {
  if (!cache.has(key)) cache.set(key, load())
  return cache.get(key) as Promise<T>
}

const json = async <T,>(url: string): Promise<T> => {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`)
  return res.json() as Promise<T>
}

export const loadBundle = () => once('bundle', () => json<DataBundle>('data/countries.json'))

export interface CountryHook {
  /** The one memorable thing about this country. */
  hook: string
  /** Anchors the country against its neighbours. */
  place: string
  /** Leading exports by value. */
  exports: string[]
  /** Why the border runs where it does — the treaty, river, war, or colonial
   *  pen behind the shape. For islands, why the state spans the islands it
   *  does. Optional so older cached hooks.json files still parse. */
  borders?: string
}

/** Hand-written context, keyed by ISO3. Absent for countries not yet written,
 *  so every consumer must treat a miss as normal rather than an error. */
export const loadHooks = () =>
  once('hooks', async (): Promise<Map<string, CountryHook>> => {
    try {
      const data = await json<{ hooks: Record<string, CountryHook> }>('data/hooks.json')
      return new Map(Object.entries(data.hooks ?? {}))
    } catch {
      return new Map()
    }
  })

/** One-line anchoring facts for cities, keyed by city id. Authored in
 *  hooks/cities.json; absence is normal — the reveal falls back to
 *  generated facts (capital-of, population). */
export const loadCityHooks = () =>
  once('cityHooks', async (): Promise<Map<string, string>> => {
    try {
      const data = await json<{ cityHooks?: Record<string, string> }>('data/hooks.json')
      return new Map(Object.entries(data.cityHooks ?? {}))
    } catch {
      return new Map()
    }
  })

export interface CityIndex {
  /** In introduction order (country curriculum order, capitals first). */
  ordered: CityRecord[]
  byId: Map<string, CityRecord>
  byCountry: Map<string, CityRecord[]>
}

/** Build the city lookups from the raw records; exported so tests can feed
 *  the committed JSON through the same construction the app uses. */
export function buildCityIndex(records: CityRecord[]): CityIndex {
  const ordered = [...records].sort((a, b) => a.rank - b.rank)
  const byCountry = new Map<string, CityRecord[]>()
  for (const city of ordered) {
    if (!byCountry.has(city.iso3)) byCountry.set(city.iso3, [])
    byCountry.get(city.iso3)!.push(city)
  }
  return { ordered, byId: new Map(ordered.map((c) => [c.id, c])), byCountry }
}

export interface CountryIndex {
  bundle: DataBundle
  byIso3: Map<string, CountryRecord>
  byIsoNum: Map<string, CountryRecord>
  regionBySlug: Map<string, QuizRegion>
  /** Curriculum order — the sequence new cards are introduced in. */
  ordered: CountryRecord[]
  cities: CityIndex
}

export const loadIndex = () =>
  once('index', async (): Promise<CountryIndex> => {
    const [bundle, cityData] = await Promise.all([
      loadBundle(),
      json<{ cities: CityRecord[] }>('data/cities.json'),
    ])
    return {
      bundle,
      byIso3: new Map(bundle.countries.map((c) => [c.iso3, c])),
      byIsoNum: new Map(bundle.countries.map((c) => [c.isoNum, c])),
      regionBySlug: new Map(bundle.regions.map((r) => [r.slug, r])),
      ordered: [...bundle.countries].sort((a, b) => a.introOrder - b.introOrder),
      cities: buildCityIndex(cityData.cities),
    }
  })

type WorldTopo = Topology<{ countries: GeometryCollection }>

/**
 * Country geometry keyed by ISO3. Natural Earth keys by ISO numeric, so this
 * translates through the bundle, and drops shapes for anything outside our 195
 * (dependencies, disputed areas) so they are never clickable answers.
 *
 * Tuvalu is absent from the 50m topology and arrives as standalone GeoJSON.
 */
export const loadGeometry = (res: Resolution) =>
  once(`geo:${res}`, async (): Promise<Map<string, CountryFeature>> => {
    const [topo, extras, index] = await Promise.all([
      json<WorldTopo>(`data/geo/world-${res}.json`),
      json<FeatureCollection>('data/geo/extra-features.json'),
      loadIndex(),
    ])

    const fc = feature(topo, topo.objects.countries) as unknown as FeatureCollection<Polygon | MultiPolygon>
    const out = new Map<string, CountryFeature>()

    for (const f of fc.features) {
      if (f.id == null) continue
      const record = index.byIsoNum.get(String(Number(f.id)).padStart(3, '0'))
      if (!record) continue
      out.set(record.iso3, { ...f, properties: { iso3: record.iso3 } } as CountryFeature)
    }

    for (const f of extras.features) {
      const iso3 = (f.properties as { iso3?: string } | null)?.iso3
      if (iso3 && !out.has(iso3)) {
        out.set(iso3, { ...f, properties: { iso3 } } as CountryFeature)
      }
    }

    return out
  })
