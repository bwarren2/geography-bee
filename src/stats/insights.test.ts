import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildCityIndex } from '../data/load'
import type { CountryIndex } from '../data/load'
import type { DataBundle } from '../types'
import { cardId } from '../srs/model'
import type { CardStats } from '../store/store'
import { activityByDay, topConfusions, troubleSpots, TROUBLE_MIN_REPS, weakAreas } from './insights'

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

const now = new Date('2026-06-01T09:00:00Z')

const cs = (reps: number, lapses: number, totalMs = reps * 4000): CardStats => ({
  reps,
  lapses,
  ratings: [0, lapses, 0, reps - lapses, 0],
  totalMs,
})

const emptyStats = () => ({ perCard: {} as Record<string, CardStats>, daily: {}, confusion: {} })

describe('troubleSpots', () => {
  it('needs both evidence and an actual miss', () => {
    const stats = emptyStats()
    // Two reps: below the evidence floor even with a miss.
    stats.perCard[cardId('PER', 'locate')] = cs(TROUBLE_MIN_REPS - 1, 1)
    // Plenty of reps, never missed: clean countries are not trouble.
    stats.perCard[cardId('BRA', 'locate')] = cs(10, 0)
    // Enough reps and a miss: in.
    stats.perCard[cardId('ARG', 'locate')] = cs(5, 2)

    const spots = troubleSpots(index, {}, stats)
    expect(spots.map((s) => s.iso3)).toEqual(['ARG'])
  })

  it('pools both map cards and reports honest rates', () => {
    const stats = emptyStats()
    stats.perCard[cardId('PER', 'locate')] = cs(4, 1, 20_000)
    stats.perCard[cardId('PER', 'identify')] = cs(4, 1, 12_000)

    const [spot] = troubleSpots(index, {}, stats)
    expect(spot).toMatchObject({ iso3: 'PER', reps: 8, lapses: 2 })
    expect(spot!.missRate).toBeCloseTo(0.25)
    expect(spot!.avgSeconds).toBeCloseTo(4)
  })

  it('ranks the repeatedly missed above a single early miss', () => {
    const stats = emptyStats()
    // Same raw miss rate (1 in 3 vs 4 in 12) — shrinkage separates them.
    stats.perCard[cardId('PER', 'locate')] = cs(3, 1)
    stats.perCard[cardId('BRA', 'locate')] = cs(12, 4)

    const spots = troubleSpots(index, {}, stats)
    expect(spots.map((s) => s.iso3)).toEqual(['BRA', 'PER'])
  })

  it('lets FSRS difficulty break ties between equal miss records', () => {
    const stats = emptyStats()
    stats.perCard[cardId('PER', 'locate')] = cs(5, 2)
    stats.perCard[cardId('BRA', 'locate')] = cs(5, 2)
    const cards = {
      [cardId('PER', 'locate')]: { difficulty: 9 },
      [cardId('BRA', 'locate')]: { difficulty: 3 },
    } as never

    const spots = troubleSpots(index, cards, stats)
    expect(spots.map((s) => s.iso3)).toEqual(['PER', 'BRA'])
  })
})

describe('weakAreas', () => {
  it('surfaces regions with misses and skips clean or too-thin ones', () => {
    const stats = emptyStats()
    // South America: one shaky country among two seen.
    stats.perCard[cardId('PER', 'locate')] = cs(5, 3)
    stats.perCard[cardId('BRA', 'locate')] = cs(5, 0)
    // Western Europe: seen but never missed.
    stats.perCard[cardId('FRA', 'locate')] = cs(6, 0)
    stats.perCard[cardId('DEU', 'locate')] = cs(6, 0)
    // Japan & the Koreas: missed, but only one country seen — below the
    // focused-round floor the rapid picker applies.
    stats.perCard[cardId('JPN', 'locate')] = cs(5, 2)

    const areas = weakAreas(index, {}, stats)
    expect(areas.map((a) => a.slug)).toEqual(['south-america'])
    expect(areas[0]).toMatchObject({ seen: 2, spots: 1 })
  })

  it('ranks a concentrated weak region above one diluted wobble', () => {
    const stats = emptyStats()
    // South America: both seen countries missing often.
    stats.perCard[cardId('PER', 'locate')] = cs(5, 3)
    stats.perCard[cardId('BRA', 'locate')] = cs(5, 3)
    // Western Europe: one wobble among three clean countries.
    stats.perCard[cardId('FRA', 'locate')] = cs(5, 3)
    stats.perCard[cardId('DEU', 'locate')] = cs(5, 0)
    stats.perCard[cardId('NLD', 'locate')] = cs(5, 0)
    stats.perCard[cardId('BEL', 'locate')] = cs(5, 0)

    const areas = weakAreas(index, {}, stats)
    expect(areas.map((a) => a.slug)).toEqual(['south-america', 'western-europe'])
  })
})

describe('topConfusions', () => {
  it('pools directions, applies the threshold, and sorts by count', () => {
    const confusion = {
      'SVK>SVN': 2,
      'SVN>SVK': 3,
      'PER>ECU': 2,
      'FRA>DEU': 1, // below threshold
      'XXX>SVN': 5, // unknown iso ignored
    }
    const pairs = topConfusions(confusion, index, 2)
    expect(pairs).toEqual([
      { a: 'SVK', b: 'SVN', count: 5 },
      { a: 'ECU', b: 'PER', count: 2 },
    ])
  })
})

describe('activityByDay', () => {
  it('returns a zero-filled trailing window, oldest first', () => {
    const daily = {
      '2026-06-01': { reviews: 12, correct: 10, introduced: 2 },
      '2026-05-30': { reviews: 5, correct: 5, introduced: 0 },
      '2026-04-01': { reviews: 99, correct: 99, introduced: 0 }, // outside window
    }
    const days = activityByDay(daily, now, 28)
    expect(days).toHaveLength(28)
    expect(days[0]!.day).toBe('2026-05-05')
    expect(days.at(-1)).toMatchObject({ day: '2026-06-01', reviews: 12, correct: 10 })
    expect(days.find((d) => d.day === '2026-05-30')).toMatchObject({ reviews: 5 })
    expect(days.find((d) => d.day === '2026-05-31')).toMatchObject({ reviews: 0, correct: 0 })
    expect(days.some((d) => d.day === '2026-04-01')).toBe(false)
  })
})
