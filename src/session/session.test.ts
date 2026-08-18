import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { Rating } from 'ts-fsrs'
import type { CountryIndex } from '../data/load'
import type { DataBundle, CountryRecord } from '../types'
import { cardId, type StoredCard } from '../srs/model'
import { createCard, schedule } from '../srs/scheduler'
import { DEFAULT_SETTINGS, type Aggregates } from '../store/store'
import { answerModeFor, borderOpacityFor, buildSession, pickOptions, stimulusFor } from './builder'
import { matchAnswer, normalize } from './matching'
import { ALL_TYPES } from '../srs/model'

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

  it('keeps skill cards locked until the starting pair is established, even with the pack started', () => {
    const cards: Record<string, StoredCard> = {}
    const iso = index.ordered[0]!.iso3
    for (const t of ['locate', 'identify'] as const) {
      const c = createCard(iso, t, now)
      cards[c.id] = { ...c, due: now.getTime() + 86_400_000 }
    }
    const items = buildSession({
      ...base,
      cards,
      settings: { ...DEFAULT_SETTINGS, packs: ['world', 'capitals', 'flags', 'borders'] },
    })
    expect(items.some((i) => i.country.iso3 === iso && !['locate', 'identify'].includes(i.card.type))).toBe(false)
  })

  it('generates skill-pack cards for established countries once the pack is started', () => {
    const cards: Record<string, StoredCard> = {}
    const iso = index.ordered[0]!.iso3
    for (const t of ['locate', 'identify'] as const) {
      let c = createCard(iso, t, new Date('2026-01-01'))
      for (let i = 0; i < 8; i++) c = schedule(c, Rating.Easy, new Date(c.due))
      cards[cardId(iso, t)] = { ...c, due: now.getTime() + 86_400_000 }
    }
    const items = buildSession({
      ...base,
      cards,
      settings: { ...DEFAULT_SETTINGS, packs: ['world', 'capitals', 'flags'] },
    })
    const extra = items.filter((i) => i.country.iso3 === iso).map((i) => i.card.type)
    expect(extra).toContain('capital')
    expect(extra).toContain('flag')
    // Borders pack was not started, so no neighbours card appears.
    expect(extra).not.toContain('neighbors')
  })

  it('never generates skill cards while their pack is unstarted, however established', () => {
    const cards: Record<string, StoredCard> = {}
    const iso = index.ordered[0]!.iso3
    for (const t of ['locate', 'identify'] as const) {
      let c = createCard(iso, t, new Date('2026-01-01'))
      for (let i = 0; i < 8; i++) c = schedule(c, Rating.Easy, new Date(c.due))
      cards[cardId(iso, t)] = { ...c, due: now.getTime() + 86_400_000 }
    }
    const items = buildSession({ ...base, cards })
    expect(items.filter((i) => i.country.iso3 === iso)).toHaveLength(0)
  })

  it('never offers a neighbours card to a country with no land borders', () => {
    const island = bundle.countries.find((c) => c.borders.length === 0)!
    const cards: Record<string, StoredCard> = {}
    for (const t of ['locate', 'identify'] as const) {
      let c = createCard(island.iso3, t, new Date('2026-01-01'))
      for (let i = 0; i < 8; i++) c = schedule(c, Rating.Easy, new Date(c.due))
      cards[cardId(island.iso3, t)] = { ...c, due: now.getTime() + 86_400_000 }
    }
    const items = buildSession({
      ...base,
      cards,
      settings: { ...DEFAULT_SETTINGS, packs: ['world', 'borders'] },
    })
    expect(items.some((i) => i.country.iso3 === island.iso3 && i.card.type === 'neighbors')).toBe(false)
  })

  it('introduces only from started packs', () => {
    const items = buildSession({
      ...base,
      cards: {},
      settings: { ...DEFAULT_SETTINGS, packs: ['region:oceania'] },
    })
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((i) => i.country.region === 'oceania')).toBe(true)
  })

  it('lets a region spotlight jump the world curriculum', () => {
    const items = buildSession({
      ...base,
      cards: {},
      settings: { ...DEFAULT_SETTINGS, packs: ['world', 'region:oceania'] },
    })
    // Oceania is last in the world curriculum, so without the spotlight the
    // first session would be all North America.
    expect(items[0]!.country.region).toBe('oceania')
  })

  it('introduces nothing at all with every pack paused', () => {
    const items = buildSession({ ...base, cards: {}, settings: { ...DEFAULT_SETTINGS, packs: [] } })
    expect(items).toHaveLength(0)
  })

  it("a boost reopens today's budget after the cap is spent", () => {
    // The exact complaint this exists for: cap spent, pack freshly started,
    // and yet nothing enqueues.
    const stats = emptyStats()
    stats.daily['2026-03-01'] = { reviews: 40, correct: 30, introduced: 8 }
    const without = buildSession({ ...base, stats, cards: {} })
    expect(without).toHaveLength(0)

    const boosted = buildSession({
      ...base,
      stats,
      cards: {},
      settings: { ...DEFAULT_SETTINGS, boost: { day: '2026-03-01', extra: 5 } },
    })
    expect(boosted).toHaveLength(5)
    expect(boosted.every((i) => i.isNew)).toBe(true)
  })

  it("ignores a boost granted on a different day", () => {
    const stats = emptyStats()
    stats.daily['2026-03-01'] = { reviews: 40, correct: 30, introduced: 8 }
    const items = buildSession({
      ...base,
      stats,
      cards: {},
      settings: { ...DEFAULT_SETTINGS, boost: { day: '2026-02-28', extra: 50 } },
    })
    expect(items).toHaveLength(0)
  })

  it('a boost cannot conjure cards from unstarted packs', () => {
    const stats = emptyStats()
    stats.daily['2026-03-01'] = { reviews: 40, correct: 30, introduced: 8 }
    const items = buildSession({
      ...base,
      stats,
      cards: {},
      settings: { ...DEFAULT_SETTINGS, packs: [], boost: { day: '2026-03-01', extra: 50 } },
    })
    expect(items).toHaveLength(0)
  })
})


describe('borderOpacityFor', () => {
  it('shows full borders on a brand-new card', () => {
    expect(borderOpacityFor(createCard('PER', 'locate', now))).toBe(1)
  })

  it('reaches a fully blank map exactly at the established threshold', () => {
    const card = { ...createCard('PER', 'locate', now), stability: 21, state: 2 as const }
    expect(borderOpacityFor(card)).toBe(0)
  })

  it('fades continuously in between and never goes negative', () => {
    const mid = { ...createCard('PER', 'locate', now), stability: 10.5, state: 2 as const }
    expect(borderOpacityFor(mid)).toBeCloseTo(0.5, 5)
    const over = { ...createCard('PER', 'locate', now), stability: 60, state: 2 as const }
    expect(borderOpacityFor(over)).toBe(0)
  })

  it('fades monotonically as stability grows', () => {
    let c = createCard('PER', 'locate', new Date('2026-01-01'))
    let prev = borderOpacityFor(c)
    for (let i = 0; i < 6; i++) {
      c = schedule(c, Rating.Easy, new Date(c.due))
      const next = borderOpacityFor(c)
      expect(next).toBeLessThanOrEqual(prev)
      prev = next
    }
    // Eight easy reviews establish a card, so the training wheels are gone.
    expect(prev).toBeLessThan(0.3)
  })
})

describe('answer mode', () => {
  it('answers a locate card on the map, never by typing', () => {
    // The bug this guards: locate once fell through a ternary chain in the view
    // and rendered a text box, so "Where is Guatemala?" could be answered by
    // typing "Guatemala" — grading naming instead of location.
    expect(answerModeFor('locate', false)).toBe('map-single')
    expect(answerModeFor('locate', true)).toBe('map-single')
  })

  it('answers a neighbours card by selecting on the map', () => {
    expect(answerModeFor('neighbors', false)).toBe('map-multi')
  })

  it('moves identify from choice to typing as the card matures', () => {
    expect(answerModeFor('identify', true)).toBe('choice')
    expect(answerModeFor('identify', false)).toBe('text')
  })

  it('always offers a list for a flag, and a box for a capital', () => {
    expect(answerModeFor('flag', false)).toBe('choice')
    expect(answerModeFor('capital', false)).toBe('text')
  })

  it('never highlights the answer on a locate card', () => {
    expect(stimulusFor('locate')).toBe('map-plain')
  })

  it('shows the country for every card that asks about a known one', () => {
    for (const type of ['identify', 'capital', 'neighbors'] as const) {
      expect(stimulusFor(type)).toBe('map-highlight')
    }
    expect(stimulusFor('flag')).toBe('flag')
  })

  it('defines a mode and a stimulus for every card type', () => {
    for (const type of ALL_TYPES) {
      for (const assisted of [true, false]) {
        expect(answerModeFor(type, assisted)).toBeTruthy()
      }
      expect(stimulusFor(type)).toBeTruthy()
    }
  })

  it('supplies options exactly when something picks from them', () => {
    const items = buildSession({ now, index, stats: emptyStats(), settings: { ...DEFAULT_SETTINGS }, cards: {} })
    for (const it of items) {
      const mode = answerModeFor(it.card.type, it.assisted)
      // Offering choices a card cannot use is how question and control drift apart.
      expect(it.options.length > 0).toBe(mode === 'choice')
    }
  })
})
