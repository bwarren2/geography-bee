import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { Rating } from 'ts-fsrs'
import type { CountryIndex } from '../data/load'
import type { DataBundle, CountryRecord } from '../types'
import { cardId, type StoredCard } from '../srs/model'
import { createCard, schedule } from '../srs/scheduler'
import { DEFAULT_SETTINGS, type Aggregates } from '../store/store'
import { buildSession, pickOptions } from './builder'
import { matchAnswer, normalize } from './matching'

const bundle: DataBundle = JSON.parse(readFileSync('public/data/countries.json', 'utf8'))

const index: CountryIndex = {
  bundle,
  byIso3: new Map(bundle.countries.map((c) => [c.iso3, c])),
  byIsoNum: new Map(bundle.countries.map((c) => [c.isoNum, c])),
  regionBySlug: new Map(bundle.regions.map((r) => [r.slug, r])),
  ordered: [...bundle.countries].sort((a, b) => a.introOrder - b.introOrder),
}

const get = (iso: string): CountryRecord => index.byIso3.get(iso)!
const emptyStats = (): Aggregates => ({ perCard: {}, daily: {}, confusion: {} })
const now = new Date('2026-03-01T09:00:00Z')

describe('matchAnswer', () => {
  const all = bundle.countries

  it('accepts the common name', () => {
    expect(matchAnswer('Peru', get('PER'), all).correct).toBe(true)
  })

  it('ignores case, accents and punctuation', () => {
    expect(matchAnswer('  côte d’ivoire ', get('CIV'), all).correct).toBe(true)
  })

  it('accepts the alternates people actually use', () => {
    expect(matchAnswer('Ivory Coast', get('CIV'), all).correct).toBe(true)
    expect(matchAnswer('Burma', get('MMR'), all).correct).toBe(true)
  })

  it('accepts a name with the formal scaffolding dropped', () => {
    expect(matchAnswer('Tanzania', get('TZA'), all).correct).toBe(true)
    expect(matchAnswer('United Kingdom', get('GBR'), all).correct).toBe(true)
  })

  it('forgives a typo in a long name', () => {
    expect(matchAnswer('Kazakhstn', get('KAZ'), all).correct).toBe(true)
    expect(matchAnswer('Phillipines', get('PHL'), all).correct).toBe(true)
  })

  it('never forgives a typo into a different real country', () => {
    // The whole point of typo tolerance is undone if it merges real answers.
    expect(matchAnswer('Niger', get('NGA'), all)).toMatchObject({ correct: false, matchedOther: 'NER' })
    expect(matchAnswer('Austria', get('AUS'), all)).toMatchObject({ correct: false, matchedOther: 'AUT' })
    expect(matchAnswer('Mali', get('MLT'), all)).toMatchObject({ correct: false, matchedOther: 'MLI' })
    expect(matchAnswer('Slovenia', get('SVK'), all)).toMatchObject({ correct: false, matchedOther: 'SVN' })
  })

  it('rejects an empty or unrelated answer', () => {
    expect(matchAnswer('', get('PER'), all).correct).toBe(false)
    expect(matchAnswer('qqqq', get('PER'), all).correct).toBe(false)
  })

  it('normalizes consistently', () => {
    expect(normalize('Côte d’Ivoire')).toBe('cote d ivoire')
  })
})

describe('pickOptions', () => {
  it('returns the target plus distractors, without duplicates', () => {
    const opts = pickOptions(get('PER'), index, {})
    expect(opts).toHaveLength(4)
    expect(opts[0]).toBe('PER')
    expect(new Set(opts).size).toBe(4)
  })

  it('prefers countries the user has actually confused with the target', () => {
    const opts = pickOptions(get('SVK'), index, { 'SVK>SVN': 5 })
    expect(opts).toContain('SVN')
  })

  it('draws remaining distractors from the same region', () => {
    const opts = pickOptions(get('PER'), index, {})
    const regions = opts.map((iso) => get(iso).region)
    expect(regions.filter((r) => r === 'south-america').length).toBeGreaterThan(2)
  })
})

describe('buildSession', () => {
  const base = { now, index, stats: emptyStats(), settings: { ...DEFAULT_SETTINGS } }

  it('introduces new countries in curriculum order on a first run', () => {
    const items = buildSession({ ...base, cards: {} })
    expect(items.length).toBe(DEFAULT_SETTINGS.newCardsPerDay)
    expect(items.every((i) => i.isNew)).toBe(true)
    // Curriculum starts with the most salient country of the first region.
    expect(items[0]!.country.iso3).toBe(index.ordered[0]!.iso3)
  })

  it('teaches a country before quizzing it', () => {
    const items = buildSession({ ...base, cards: {} })
    const first = items.find((i) => i.country.iso3 === index.ordered[0]!.iso3)!
    expect(first.introduce).toBe(true)
  })

  it('respects the daily budget already spent', () => {
    const stats = emptyStats()
    stats.daily['2026-03-01'] = { reviews: 20, correct: 18, introduced: 6 }
    const items = buildSession({ ...base, stats, cards: {} })
    expect(items.length).toBe(DEFAULT_SETTINGS.newCardsPerDay - 6)
  })

  it('introduces nothing more once the budget is spent', () => {
    const stats = emptyStats()
    stats.daily['2026-03-01'] = { reviews: 40, correct: 30, introduced: 8 }
    expect(buildSession({ ...base, stats, cards: {} })).toHaveLength(0)
  })

  it('includes due cards and excludes cards not yet due', () => {
    const cards: Record<string, StoredCard> = {}
    const overdue = schedule(createCard('PER', 'locate', new Date('2026-02-01')), Rating.Good, new Date('2026-02-01'))
    const future = { ...createCard('BRA', 'locate', now), due: now.getTime() + 86_400_000 }
    cards[overdue.id] = overdue
    cards[future.id] = future

    const items = buildSession({ ...base, cards, settings: { ...DEFAULT_SETTINGS, newCardsPerDay: 0 } })
    expect(items.map((i) => i.card.id)).toEqual([overdue.id])
  })

  it('spreads new cards through the due queue instead of stacking them', () => {
    const cards: Record<string, StoredCard> = {}
    for (const c of index.ordered.slice(0, 30)) {
      const card = createCard(c.iso3, 'locate', new Date('2026-02-01'))
      cards[card.id] = { ...card, due: now.getTime() - 1000 }
    }
    const items = buildSession({ ...base, cards })
    const newPositions = items.flatMap((it, i) => (it.isNew ? [i] : []))
    expect(newPositions.length).toBeGreaterThan(1)
    // Not all clustered at the very start.
    expect(Math.max(...newPositions)).toBeGreaterThan(6)
  })

  it('uses multiple choice for a fresh identify card and typing once mature', () => {
    const fresh = buildSession({ ...base, cards: {} }).find((i) => i.card.type === 'identify')!
    expect(fresh.assisted).toBe(true)
    expect(fresh.options.length).toBe(4)

    let mature = createCard('PER', 'identify', new Date('2026-01-01'))
    for (let i = 0; i < 8; i++) mature = schedule(mature, Rating.Easy, new Date(mature.due))
    const items = buildSession({
      ...base,
      cards: { [mature.id]: { ...mature, due: now.getTime() - 1000 } },
      settings: { ...DEFAULT_SETTINGS, newCardsPerDay: 0 },
    })
    expect(items[0]!.assisted).toBe(false)
  })

  it('keeps extra card types locked until the starting pair is established', () => {
    const cards: Record<string, StoredCard> = {}
    const iso = index.ordered[0]!.iso3
    for (const t of ['locate', 'identify'] as const) {
      const c = createCard(iso, t, now)
      cards[c.id] = { ...c, due: now.getTime() + 86_400_000 }
    }
    const items = buildSession({ ...base, cards })
    expect(items.some((i) => i.country.iso3 === iso && !['locate', 'identify'].includes(i.card.type))).toBe(false)
  })

  it('unlocks extra card types once the starting pair is established', () => {
    const cards: Record<string, StoredCard> = {}
    const iso = index.ordered[0]!.iso3
    for (const t of ['locate', 'identify'] as const) {
      let c = createCard(iso, t, new Date('2026-01-01'))
      for (let i = 0; i < 8; i++) c = schedule(c, Rating.Easy, new Date(c.due))
      cards[cardId(iso, t)] = { ...c, due: now.getTime() + 86_400_000 }
    }
    const items = buildSession({ ...base, cards })
    const extra = items.filter((i) => i.country.iso3 === iso).map((i) => i.card.type)
    expect(extra).toContain('capital')
    expect(extra).toContain('flag')
  })

  it('never offers a neighbours card to a country with no land borders', () => {
    const island = bundle.countries.find((c) => c.borders.length === 0)!
    const cards: Record<string, StoredCard> = {}
    for (const t of ['locate', 'identify'] as const) {
      let c = createCard(island.iso3, t, new Date('2026-01-01'))
      for (let i = 0; i < 8; i++) c = schedule(c, Rating.Easy, new Date(c.due))
      cards[cardId(island.iso3, t)] = { ...c, due: now.getTime() + 86_400_000 }
    }
    const items = buildSession({ ...base, cards })
    expect(items.some((i) => i.country.iso3 === island.iso3 && i.card.type === 'neighbors')).toBe(false)
  })

  it('limits introductions to enabled regions when set', () => {
    const items = buildSession({
      ...base,
      cards: {},
      settings: { ...DEFAULT_SETTINGS, enabledRegions: ['oceania'] },
    })
    expect(items.every((i) => i.country.region === 'oceania')).toBe(true)
  })
})
