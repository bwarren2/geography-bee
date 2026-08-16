import { feature } from 'topojson-client'
import type { Topology, GeometryCollection } from 'topojson-specification'
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson'
import type { CountryRecord, DataBundle, QuizRegion } from '../types'

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

export interface CountryIndex {
  bundle: DataBundle
  byIso3: Map<string, CountryRecord>
  byIsoNum: Map<string, CountryRecord>
  regionBySlug: Map<string, QuizRegion>
  /** Curriculum order — the sequence new cards are introduced in. */
  ordered: CountryRecord[]
}

export const loadIndex = () =>
  once('index', async (): Promise<CountryIndex> => {
    const bundle = await loadBundle()
    return {
      bundle,
      byIso3: new Map(bundle.countries.map((c) => [c.iso3, c])),
      byIsoNum: new Map(bundle.countries.map((c) => [c.isoNum, c])),
      regionBySlug: new Map(bundle.regions.map((r) => [r.slug, r])),
      ordered: [...bundle.countries].sort((a, b) => a.introOrder - b.introOrder),
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
