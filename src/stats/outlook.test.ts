import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { Rating } from 'ts-fsrs'
import { buildCityIndex } from '../data/load'
import type { CountryIndex } from '../data/load'
import type { DataBundle } from '../types'
import { cardId, type StoredCard } from '../srs/model'
import { createCard, schedule } from '../srs/scheduler'
import { DEFAULT_SETTINGS, type StudySnapshot } from '../store/store'
import { buildOutlook, cityMastery, countryMastery, daysToEstablish, formatEta, freshCardLagDays, streakFrom } from './outlook'

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

const snap = (over: Partial<StudySnapshot> = {}): StudySnapshot => ({
  cards: {},
  stats: { perCard: {}, daily: {}, confusion: {} },
  settings: { ...DEFAULT_SETTINGS },
  meta: { schema: 1, lastBackupAt: null, createdAt: now.getTime() },
  challenges: { summaries: [], runs: [] },
  ...over,
})

const establishedPair = (iso: string): Record<string, StoredCard> => {
  const out: Record<string, StoredCard> = {}
  for (const t of ['locate', 'identify'] as const) {
    let c = createCard(iso, t, new Date('2026-01-01'))
    for (let i = 0; i < 8; i++) c = schedule(c, Rating.Easy, new Date(c.due))
    out[cardId(iso, t)] = c
  }
  return out
}

describe('cityMastery', () => {
  it('tracks the weaker city card against the established threshold', () => {
    expect(cityMastery({}, 'USA-washington-d-c')).toBe(0)
    const half = { ...createCard('USA', 'city-locate', now, 'USA-washington-d-c:city-locate'), stability: 10.5 }
    const full = { ...createCard('USA', 'city-identify', now, 'USA-washington-d-c:city-identify'), stability: 50 }
    expect(cityMastery({ [half.id]: half, [full.id]: full }, 'USA-washington-d-c')).toBeCloseTo(0.5)
    expect(cityMastery({ [full.id]: full }, 'USA-washington-d-c')).toBe(0)
  })
})

describe('countryMastery', () => {
  it('is 0 unseen, tracks the weaker card, and caps at 1', () => {
    expect(countryMastery({}, 'PER')).toBe(0)
    const half = { ...createCard('PER', 'locate', now), stability: 10.5 }
    const full = { ...createCard('PER', 'identify', now), stability: 80 }
    // Only one card: the missing identify card holds mastery at zero.
    expect(countryMastery({ 'PER:locate': full }, 'PER')).toBe(0)
    expect(countryMastery({ 'PER:locate': half, 'PER:identify': full }, 'PER')).toBeCloseTo(0.5)
    expect(countryMastery({ 'PER:locate': full, 'PER:identify': full }, 'PER')).toBe(1)
  })
})

describe('daysToEstablish', () => {
  it('is zero for an established card', () => {
    const c = Object.values(establishedPair('PER'))[0]!
    expect(daysToEstablish(c, now)).toBe(0)
  })

  it('projects a plausible maturation for a fresh card', () => {
    const lag = freshCardLagDays(now)
    // Sanity bounds, not an exact pin: the FSRS default parameters put a
    // Good-graded card past 21 days of stability within weeks, not days or years.
    expect(lag).toBeGreaterThan(7)
    expect(lag).toBeLessThan(120)
  })

  it('projects the same establishment date however far along the path you ask', () => {
    // Reviewing Good three times right now and then asking is the same
    // trajectory the fresh simulation already assumed — the answer must agree.
    let c = createCard('PER', 'locate', now)
    const freshDays = daysToEstablish(c, now)
    for (let i = 0; i < 3; i++) c = schedule(c, Rating.Good, new Date(Math.max(c.due, now.getTime())))
    expect(daysToEstablish(c, now)).toBeCloseTo(freshDays, 1)
  })

  it('shrinks as real time passes along the path', () => {
    let c = createCard('PER', 'locate', now)
    const freshDays = daysToEstablish(c, now)
    for (let i = 0; i < 3; i++) c = schedule(c, Rating.Good, new Date(Math.max(c.due, now.getTime())))
    // Ask again from the card's next due date: the elapsed days are gone.
    const later = new Date(c.due)
    expect(daysToEstablish(c, later)).toBeLessThan(freshDays)
  })
})

describe('streakFrom', () => {
  const day = (offset: number) => new Date(now.getTime() - offset * 86_400_000).toISOString().slice(0, 10)

  it('counts consecutive active days ending today', () => {
    const daily = { [day(0)]: { reviews: 5 }, [day(1)]: { reviews: 3 }, [day(2)]: { reviews: 1 } }
    expect(streakFrom(daily, now)).toBe(3)
  })

  it('keeps the streak alive when today has no reviews yet', () => {
    const daily = { [day(1)]: { reviews: 3 }, [day(2)]: { reviews: 1 } }
    expect(streakFrom(daily, now)).toBe(2)
  })

  it('breaks on a missed day', () => {
    const daily = { [day(0)]: { reviews: 5 }, [day(2)]: { reviews: 9 } }
    expect(streakFrom(daily, now)).toBe(1)
  })

  it('is zero with no history', () => {
    expect(streakFrom({}, now)).toBe(0)
  })
})

describe('buildOutlook', () => {
  it('marks mastery only when both starting cards are established', () => {
    const cards = { ...establishedPair('PER') }
    // BRA has only locate established.
    let bra = createCard('BRA', 'locate', new Date('2026-01-01'))
    for (let i = 0; i < 8; i++) bra = schedule(bra, Rating.Easy, new Date(bra.due))
    cards[bra.id] = bra

    const outlook = buildOutlook(index, snap({ cards }), now)
    expect(outlook.countries.get('PER')!.mastered).toBe(true)
    expect(outlook.countries.get('BRA')!.mastered).toBe(false)
    expect(outlook.countries.get('BRA')!.seen).toBe(true)
    expect(outlook.countries.get('CHL')!.seen).toBe(false)
  })

  it('reports done for a region whose countries are all mastered', () => {
    const cards: Record<string, StoredCard> = {}
    for (const iso of index.regionBySlug.get('eastern-europe')!.countries) {
      Object.assign(cards, establishedPair(iso))
    }
    const outlook = buildOutlook(index, snap({ cards }), now)
    const region = outlook.regions.find((r) => r.slug === 'eastern-europe')!
    expect(region.mastered).toBe(region.total)
    expect(region.etaDays).toBe(0)
  })

  it('gives unseen countries an ETA of queue wait plus maturation', () => {
    const outlook = buildOutlook(index, snap(), now)
    // Everything unseen at 8 cards/day: 390 cards of introductions plus the
    // maturation tail. The overall ETA must exceed the pure intro time.
    const introDays = (195 * 2) / DEFAULT_SETTINGS.newCardsPerDay
    expect(outlook.overall.etaDays).toBeGreaterThan(introDays)
    expect(outlook.overall.etaDays).toBeLessThan(introDays + 120)
  })

  it('orders region ETAs by their position in the world curriculum', () => {
    const outlook = buildOutlook(index, snap(), now)
    const first = outlook.regions.find((r) => r.slug === 'north-america')!
    const last = outlook.regions.find((r) => r.slug === 'pacific-islands')!
    expect(first.etaDays!).toBeLessThan(last.etaDays!)
  })

  it('reports null ETA when nothing will ever introduce a region', () => {
    const settings = { ...DEFAULT_SETTINGS, packs: ['region:pacific-islands'] }
    const outlook = buildOutlook(index, snap({ settings }), now)
    expect(outlook.regions.find((r) => r.slug === 'pacific-islands')!.etaDays).not.toBeNull()
    expect(outlook.regions.find((r) => r.slug === 'caribbean')!.etaDays).toBeNull()
    expect(outlook.overall.etaDays).toBeNull()
  })

  it('a started spotlight pulls its region far ahead of the world queue', () => {
    const base = buildOutlook(index, snap(), now)
    const spot = buildOutlook(
      index,
      snap({ settings: { ...DEFAULT_SETTINGS, packs: ['world', 'region:pacific-islands'] } }),
      now,
    )
    const before = base.regions.find((r) => r.slug === 'pacific-islands')!.etaDays!
    const after = spot.regions.find((r) => r.slug === 'pacific-islands')!.etaDays!
    expect(after).toBeLessThan(before / 2)
  })

  it('derives pace from recent history rather than the configured budget', () => {
    const daily: Record<string, { reviews: number; correct: number; introduced: number }> = {}
    for (let i = 0; i < 10; i++) {
      const key = new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10)
      daily[key] = { reviews: 30, correct: 25, introduced: 4 }
    }
    const outlook = buildOutlook(index, snap({ stats: { perCard: {}, daily, confusion: {} } }), now)
    expect(outlook.introPerDay).toBeCloseTo(4, 0)
    expect(outlook.reviewsPerDay).toBeCloseTo(30, 0)
    expect(outlook.streakDays).toBe(10)
  })
})

describe('formatEta', () => {
  it('renders the scale-appropriate unit', () => {
    expect(formatEta(null)).toBe('—')
    expect(formatEta(0)).toBe('done')
    expect(formatEta(5)).toBe('~5 days')
    expect(formatEta(30)).toBe('~4 wk')
    expect(formatEta(200)).toBe('~7 mo')
    expect(formatEta(1000)).toBe('~2.7 yr')
  })
})
