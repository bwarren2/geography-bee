import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildCityIndex } from '../data/load'
import type { CountryFeature, CountryIndex } from '../data/load'
import type { DataBundle } from '../types'
import { distanceToFeatureKm, haversineKm } from '../map/distance'
import {
  buildChallengeOrder,
  summarizeRun,
  type ChallengeAnswer,
  type ChallengeRun,
} from './challenge'

const bundle: DataBundle = JSON.parse(readFileSync('public/data/countries.json', 'utf8'))
const cityRecords = JSON.parse(readFileSync('public/data/cities.json', 'utf8')).cities
const index: CountryIndex = {
  bundle,
  byIso3: new Map(bundle.countries.map((c) => [c.iso3, c])),
  byIsoNum: new Map(bundle.countries.map((c) => [c.isoNum, c])),
  regionBySlug: new Map(bundle.regions.map((r) => [r.slug, r])),
  ordered: [...bundle.countries].sort((a, b) => a.introOrder - b.introOrder),
  cities: buildCityIndex(cityRecords),
}

/** Deterministic rng for order tests. */
const lcg = (seed: number) => {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) % 2 ** 31
    return s / 2 ** 31
  }
}

const answer = (over: Partial<ChallengeAnswer> = {}): ChallengeAnswer => ({
  iso3: 'PER',
  chosen: 'PER',
  correct: true,
  ms: 3000,
  tap: [-75, -10],
  missKm: 0,
  ...over,
})

describe('buildChallengeOrder', () => {
  it('covers every country exactly once', () => {
    const order = buildChallengeOrder(index, lcg(7))
    expect(order).toHaveLength(bundle.countries.length)
    expect(new Set(order.map((c) => c.iso3)).size).toBe(bundle.countries.length)
  })

  it('shuffles — different seeds give different sequences', () => {
    const a = buildChallengeOrder(index, lcg(1)).map((c) => c.iso3)
    const b = buildChallengeOrder(index, lcg(2)).map((c) => c.iso3)
    expect(a).not.toEqual(b)
  })
})

describe('summarizeRun', () => {
  it('scores, and averages miss distance over all answers with corrects at zero', () => {
    const run: ChallengeRun = {
      at: 1000,
      mode: 'borders',
      answers: [
        answer({ ms: 2000 }),
        answer({ iso3: 'BOL', ms: 4000 }),
        // Two misses at 100km and 300km; over four answers the mean is 100.
        answer({ iso3: 'ECU', chosen: 'COL', correct: false, missKm: 100, ms: 6000 }),
        answer({ iso3: 'PRY', chosen: 'URY', correct: false, missKm: 300, ms: 3000 }),
      ],
    }
    const s = summarizeRun(run)
    expect(s).toMatchObject({
      at: 1000,
      mode: 'borders',
      total: 4,
      correct: 2,
      meanMissKm: 100,
      medianMissKm: 200,
    })
    expect(s.medianMs).toBe(3500)
  })

  it('carries the mode through — a blank run summarizes as a blank record', () => {
    const s = summarizeRun({ at: 1, mode: 'blank', answers: [answer()] })
    expect(s.mode).toBe('blank')
  })

  it('handles a perfect run without dividing by zero misses', () => {
    const s = summarizeRun({ at: 1, mode: 'borders', answers: [answer(), answer({ iso3: 'BOL' })] })
    expect(s).toMatchObject({ correct: 2, meanMissKm: 0, medianMissKm: 0 })
  })
})

describe('distance', () => {
  it('haversine matches the textbook degree of longitude at the equator', () => {
    // One degree of longitude on the equator is ~111.19km.
    expect(haversineKm([0, 0], [1, 0])).toBeCloseTo(111.19, 0)
  })

  it('measures km from a tap to the nearest outline vertex', () => {
    const square: CountryFeature = {
      type: 'Feature',
      properties: { iso3: 'TST' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
            [0, 0],
          ],
        ],
      },
    }
    // Two degrees due east of the square's nearest corner: ~1 degree past
    // the [1, 0] vertex.
    expect(distanceToFeatureKm(square, [2, 0])).toBeCloseTo(111.19, 0)
    // On a vertex: zero.
    expect(distanceToFeatureKm(square, [0, 0])).toBe(0)
  })
})
