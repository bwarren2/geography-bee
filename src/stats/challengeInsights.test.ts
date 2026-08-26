import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildCityIndex } from '../data/load'
import type { CountryIndex } from '../data/load'
import type { DataBundle } from '../types'
import type { ChallengeAnswer, ChallengeRun } from '../session/challenge'
import { missAxisTicks, missDotplot, regionBreakdown, timeHistogram } from './challengeInsights'

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

const answer = (over: Partial<ChallengeAnswer> = {}): ChallengeAnswer => ({
  iso3: 'PER',
  chosen: 'PER',
  correct: true,
  ms: 3000,
  tap: [-75, -10],
  missKm: 0,
  ...over,
})

describe('regionBreakdown', () => {
  it('counts errors per region, worst rate first, clean regions included', () => {
    const run: ChallengeRun = {
      at: 1,
      mode: 'borders',
      answers: [
        // South America: 1 of 2 wrong. Western Europe: 1 of 1 wrong.
        answer(),
        answer({ iso3: 'BOL', chosen: 'PRY', correct: false, missKm: 400 }),
        answer({ iso3: 'FRA', chosen: 'DEU', correct: false, missKm: 300 }),
      ],
    }
    const rows = regionBreakdown(run, index)
    expect(rows).toHaveLength(bundle.regions.length)
    expect(rows[0]).toMatchObject({ slug: 'western-europe', total: 1, wrong: 1 })
    expect(rows[1]).toMatchObject({ slug: 'south-america', total: 2, wrong: 1 })
    // Regions the run never touched still report, at zero.
    expect(rows.at(-1)!.wrong).toBe(0)
  })
})

describe('timeHistogram', () => {
  it('buckets by whole seconds with an overflow bucket', () => {
    const answers = [
      answer({ ms: 400 }),
      answer({ ms: 900 }),
      answer({ ms: 1500 }),
      answer({ ms: 9999 }),
      answer({ ms: 25_000 }),
    ]
    const buckets = timeHistogram(answers)
    expect(buckets).toHaveLength(11)
    expect(buckets[0]).toMatchObject({ label: '0–1', count: 2 })
    expect(buckets[1]).toMatchObject({ label: '1–2', count: 1 })
    expect(buckets[9]).toMatchObject({ label: '9–10', count: 1 })
    expect(buckets[10]).toMatchObject({ label: '10+', count: 1 })
    expect(buckets.reduce((sum, b) => sum + b.count, 0)).toBe(answers.length)
  })
})

describe('missDotplot', () => {
  it('places only misses, on a sqrt scale, stacking overlaps into rows', () => {
    const answers = [
      answer(), // correct: no dot
      answer({ iso3: 'BOL', correct: false, missKm: 100 }),
      answer({ iso3: 'PRY', correct: false, missKm: 101 }), // overlaps the first
      answer({ iso3: 'FRA', correct: false, missKm: 6400 }),
    ]
    const dots = missDotplot(answers)
    expect(dots).toHaveLength(3)
    // Farthest miss anchors the axis end; sqrt scale puts 100km of 6400 at 1/8.
    expect(dots.at(-1)!.x).toBeCloseTo(1)
    expect(dots[0]!.x).toBeCloseTo(Math.sqrt(100 / 6400), 2)
    // The two near-identical distances cannot share a row.
    expect(dots[0]!.row).not.toBe(dots[1]!.row)
  })

  it('offers only ticks inside the run range', () => {
    expect(missAxisTicks(1200)).toEqual([100, 500, 1000])
    expect(missAxisTicks(80)).toEqual([])
  })
})
