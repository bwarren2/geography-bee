import { describe, expect, it } from 'vitest'
import type { CountryFeature } from '../data/load'
import {
  computeParcels,
  nearestParcel,
  PARCEL_REACH_PX,
  PARCEL_REGIONS,
  parcelReachPx,
  parcelSeeds,
} from './parcels'

/** Identity "projection": features authored directly in pixel space. */
const project = (p: [number, number]): [number, number] => p

const island = (iso3: string, cx: number, cy: number, r = 2): CountryFeature => ({
  type: 'Feature',
  properties: { iso3 },
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [cx - r, cy - r],
        [cx + r, cy - r],
        [cx + r, cy + r],
        [cx - r, cy + r],
        [cx - r, cy - r],
      ],
    ],
  },
})

describe('parcelSeeds', () => {
  it('seeds each island part at its centroid', () => {
    const seeds = parcelSeeds([island('AAA', 50, 50), island('BBB', 150, 50)], project, 200, 100)
    expect(seeds).toHaveLength(2)
    expect(seeds[0]).toMatchObject({ iso3: 'AAA' })
    expect(seeds[0]!.x).toBeCloseTo(50, 0)
    expect(seeds[0]!.y).toBeCloseTo(50, 0)
  })

  it('caps seeds per country at the largest parts and drops the far-offscreen', () => {
    const rings = []
    for (let i = 0; i < 15; i++) {
      const cx = 10 + i * 12
      // Growing sizes, so the cap must keep the later (larger) parts.
      const r = 1 + i * 0.3
      rings.push([
        [cx - r, 50 - r],
        [cx + r, 50 - r],
        [cx + r, 50 + r],
        [cx - r, 50 + r],
        [cx - r, 50 - r],
      ])
    }
    // One extra part far outside the viewport.
    rings.push([
      [900, 50],
      [905, 50],
      [905, 55],
      [900, 55],
      [900, 50],
    ])
    const feature: CountryFeature = {
      type: 'Feature',
      properties: { iso3: 'KIR' },
      geometry: { type: 'MultiPolygon', coordinates: rings.map((r) => [r]) },
    }
    const seeds = parcelSeeds([feature], project, 200, 100)
    expect(seeds.length).toBeLessThanOrEqual(8)
    expect(seeds.every((s) => s.x < 400)).toBe(true)
    // Largest part (the 15th, at x≈178) must have made the cut.
    expect(seeds.some((s) => Math.abs(s.x - 178) < 2)).toBe(true)
  })
})

describe('computeParcels', () => {
  it('draws boundaries only between different owners, never on the hull', () => {
    // Two owners side by side: exactly one dividing line, vertical at x=100.
    const seeds = parcelSeeds([island('AAA', 50, 50), island('BBB', 150, 50)], project, 200, 100)
    const parcels = computeParcels(seeds, 200, 100)!
    expect(parcels.cells).toHaveLength(2)
    // One M...L... segment; the viewport rectangle's own edges never draw.
    expect(parcels.boundaries.match(/M/g)).toHaveLength(1)
    expect(parcels.boundaries).toContain('M100.0')
  })

  it('merges a lobed country: no line between two cells of the same owner', () => {
    const seeds = parcelSeeds(
      [island('AAA', 40, 50), island('AAA', 100, 50), island('BBB', 170, 50)],
      project,
      200,
      100,
    )
    // AAA appears twice via two features; parcelSeeds keeps per-feature caps,
    // so simulate the merged-country case directly:
    const parcels = computeParcels(seeds, 200, 100)!
    // Two internal Voronoi edges exist (AAA|AAA at x=70, AAA|BBB at x=135);
    // only the cross-owner one may draw.
    expect(parcels.boundaries.match(/M/g)).toHaveLength(1)
    expect(parcels.boundaries).toContain('M135.0')
  })

  it('declines to partition around a single seed', () => {
    expect(computeParcels(parcelSeeds([island('AAA', 50, 50)], project, 200, 100), 200, 100)).toBeNull()
  })
})

describe('parcel picking', () => {
  it('resolves an ocean tap to the nearest island within reach', () => {
    const seeds = parcelSeeds([island('AAA', 50, 50), island('BBB', 150, 50)], project, 200, 100)
    expect(nearestParcel(seeds, 90, 80, 1, PARCEL_REACH_PX)).toBe('AAA')
    expect(nearestParcel(seeds, 110, 80, 1, PARCEL_REACH_PX)).toBe('BBB')
    // Respects pickable filtering.
    expect(nearestParcel(seeds, 90, 80, 1, PARCEL_REACH_PX, (i) => i !== 'AAA')).toBe('BBB')
  })

  it('forgiveness rides the fade dial down to nothing', () => {
    expect(parcelReachPx(1)).toBe(PARCEL_REACH_PX)
    expect(parcelReachPx(0.5)).toBe(PARCEL_REACH_PX / 2)
    expect(parcelReachPx(0)).toBe(0)
    const seeds = parcelSeeds([island('AAA', 50, 50), island('BBB', 150, 50)], project, 200, 100)
    // A tap 40px from AAA: picked while cells are half-faded…
    expect(nearestParcel(seeds, 50, 90, 1, parcelReachPx(0.5))).toBe('AAA')
    // …not once they are gone.
    expect(nearestParcel(seeds, 50, 90, 1, parcelReachPx(0))).toBeNull()
  })
})

describe('PARCEL_REGIONS', () => {
  it('covers exactly the two archipelago frames', () => {
    expect([...PARCEL_REGIONS].sort()).toEqual(['caribbean', 'pacific-islands'])
  })
})
