/**
 * Node-side loader for the committed geometry — the same translation
 * `src/data/load.ts` does with fetch, done with the filesystem so build
 * scripts and tests can audit exactly what the app will render.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { feature } from 'topojson-client'
import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson'
import type { CountryFeature } from '../src/data/load'
import type { DataBundle } from '../src/types'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export function loadCommittedBundle(): DataBundle {
  return JSON.parse(readFileSync(join(ROOT, 'public/data/countries.json'), 'utf8'))
}

export function loadCommittedGeometry(bundle: DataBundle): Map<string, CountryFeature> {
  const topo = JSON.parse(readFileSync(join(ROOT, 'public/data/geo/world-50m.json'), 'utf8'))
  const extras: FeatureCollection = JSON.parse(
    readFileSync(join(ROOT, 'public/data/geo/extra-features.json'), 'utf8'),
  )
  const byIsoNum = new Map(bundle.countries.map((c) => [c.isoNum, c]))

  const fc = feature(topo, topo.objects.countries) as unknown as FeatureCollection<Polygon | MultiPolygon>
  const out = new Map<string, CountryFeature>()
  for (const f of fc.features) {
    if (f.id == null) continue
    const record = byIsoNum.get(String(Number(f.id)).padStart(3, '0'))
    if (!record) continue
    out.set(record.iso3, { ...f, properties: { iso3: record.iso3 } } as CountryFeature)
  }
  for (const f of extras.features) {
    const iso3 = (f.properties as { iso3?: string } | null)?.iso3
    if (iso3 && !out.has(iso3)) out.set(iso3, { ...f, properties: { iso3 } } as CountryFeature)
  }
  return out
}
