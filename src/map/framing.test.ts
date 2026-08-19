import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadCommittedBundle, loadCommittedGeometry } from '../../scripts/geo-node'
import { FRAME_SHARE_FLOOR, framingShares, MICRO_EXEMPT_KM2, MIN_FRAME_SHARE } from './framing'

/**
 * Guards the locate-framing contract (#3) against the committed data, so a
 * future region edit or upstream geometry update cannot quietly re-create a
 * Canada-eats-the-frame view. `npm run audit:framing` prints the full table.
 */

const bundle = loadCommittedBundle()
const geo = loadCommittedGeometry(bundle)
const areaOf = new Map(bundle.countries.map((c) => [c.iso3, c.areaKm2]))
const rows = framingShares(bundle.regions, geo, 390, 390)
const share = (iso3: string) => rows.find((r) => r.iso3 === iso3)!.share

describe('locate framing', () => {
  it('gives every non-micro country at least the degeneracy floor in its region view', () => {
    const failing = rows
      .filter((r) => (areaOf.get(r.iso3) ?? 0) >= MICRO_EXEMPT_KM2 && r.share < FRAME_SHARE_FLOOR)
      .map((r) => `${r.region}/${r.iso3} ${(r.share * 100).toFixed(2)}%`)
    expect(failing).toEqual([])
  })

  it('frames every non-micro Central America country at the cluster target', () => {
    // The complaint that started this: Honduras-vs-Nicaragua reviews began
    // with a frame that was mostly Canada.
    const ca = bundle.regions.find((r) => r.slug === 'central-america')!
    const failing = ca.countries
      .filter((iso3) => (areaOf.get(iso3) ?? 0) >= MICRO_EXEMPT_KM2 && share(iso3) < MIN_FRAME_SHARE)
      .map((iso3) => `${iso3} ${(share(iso3) * 100).toFixed(2)}%`)
    expect(failing).toEqual([])
    expect(share('HND')).toBeGreaterThan(0.05)
    expect(share('NIC')).toBeGreaterThan(0.05)
  })

  it('renders Australia as a continent, not Ashmore Reef', () => {
    // Natural Earth ships Ashmore & Cartier with Australia's ISO numeric id;
    // before the pipeline deduped ids, last-one-wins made every 50m view
    // (and the committed bbox) a 0.02° speck.
    expect(share('AUS')).toBeGreaterThan(0.2)
    const aus = bundle.countries.find((c) => c.iso3 === 'AUS')!
    expect(aus.bbox[2] - aus.bbox[0]).toBeGreaterThan(30)
  })

  it('ships no duplicate ISO ids in the committed topologies', () => {
    for (const res of ['110m', '50m'] as const) {
      const topo = JSON.parse(readFileSync(`public/data/geo/world-${res}.json`, 'utf8'))
      const ids = topo.objects.countries.geometries
        .filter((g: { id?: unknown }) => g.id != null)
        .map((g: { id: unknown }) => String(Number(g.id as string)).padStart(3, '0'))
      expect(new Set(ids).size).toBe(ids.length)
    }
  })
})
