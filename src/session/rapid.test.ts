import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { Rating } from 'ts-fsrs'
import { buildCityIndex } from '../data/load'
import type { CountryIndex } from '../data/load'
import type { DataBundle } from '../types'
import type { StoredCard } from '../srs/model'
import { createCard, schedule } from '../srs/scheduler'
import { buildRapidQueue, RAPID_ROUND_SIZE, selectRapidCards } from './rapid'

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

/** A locate card reviewed once at `reviewedAt`. */
const reviewed = (iso: string, reviewedAt: Date): StoredCard =>
  schedule(createCard(iso, 'locate', reviewedAt), Rating.Good, reviewedAt)

describe('buildRapidQueue', () => {
  it('includes only locate cards that have actually been reviewed', () => {
    const cards: Record<string, StoredCard> = {}
    const per = reviewed('PER', new Date('2026-05-01'))
    cards[per.id] = per
    // An identify card and an unreviewed locate card must both be ignored.
    const bra = schedule(createCard('BRA', 'identify', new Date('2026-05-01')), Rating.Good, new Date('2026-05-01'))
    cards[bra.id] = bra
    cards['CHL:locate'] = createCard('CHL', 'locate', now)

    const queue = buildRapidQueue(index, cards, now)
    expect(queue.map((i) => i.card.id)).toEqual(['PER:locate'])
  })

  it('selects a due card over a not-yet-due one when slots run out', () => {
    // Selection priority is exercised through the cap: one slot, two claimants.
    const cards: Record<string, StoredCard> = {}
    const overdue = { ...reviewed('PER', new Date('2026-05-01')), due: now.getTime() - 1000 }
    const future = { ...reviewed('BRA', new Date('2026-05-30')), due: now.getTime() + 86_400_000 }
    cards[overdue.id] = overdue
    cards[future.id] = future

    const queue = selectRapidCards(index, cards, now, 1)
    expect(queue.map((i) => i.card.iso3)).toEqual(['PER'])
  })

  it('gives spare slots to the weakest recall', () => {
    const cards: Record<string, StoredCard> = {}
    // Same stability, but ARG was reviewed a month ago and BRA yesterday, so
    // ARG's recall has decayed further and it claims the single slot.
    const stale = { ...reviewed('ARG', new Date('2026-05-01')), due: now.getTime() + 86_400_000 }
    const fresh = { ...reviewed('BRA', new Date('2026-05-31')), due: now.getTime() + 86_400_000 }
    cards[stale.id] = stale
    cards[fresh.id] = fresh

    const queue = selectRapidCards(index, cards, now, 1)
    expect(queue.map((i) => i.card.iso3)).toEqual(['ARG'])
  })

  it('spreads a round across regions instead of letting one cohort fill it', () => {
    // The field report behind this: a batch of declared Americas countries,
    // all due for their confirming pass, filled every round while Europe and
    // Asia never appeared. One card per region per pass fixes the capture.
    const cards: Record<string, StoredCard> = {}
    const southAmerica = index.bundle.regions.find((r) => r.slug === 'south-america')!.countries
    const japanKoreas = index.bundle.regions.find((r) => r.slug === 'japan-koreas')!.countries
    for (const iso of southAmerica) {
      const card = { ...reviewed(iso, new Date('2026-05-01')), due: now.getTime() - 5000 }
      cards[card.id] = card
    }
    for (const iso of japanKoreas) {
      const card = { ...reviewed(iso, new Date('2026-05-01')), due: now.getTime() - 1000 }
      cards[card.id] = card
    }

    const round = selectRapidCards(index, cards, now, 8).map((i) => i.country.region)
    // All three Japan & Koreas cards make the round despite twelve older
    // South American debts competing for eight slots.
    expect(round.filter((r) => r === 'japan-koreas')).toHaveLength(3)
    expect(round.filter((r) => r === 'south-america')).toHaveLength(5)
    // The oldest debt's region leads the deal.
    expect(round[0]).toBe('south-america')
  })

  it('caps the round', () => {
    const cards: Record<string, StoredCard> = {}
    for (const c of index.ordered.slice(0, RAPID_ROUND_SIZE + 10)) {
      const card = reviewed(c.iso3, new Date('2026-05-01'))
      cards[card.id] = card
    }
    expect(buildRapidQueue(index, cards, now)).toHaveLength(RAPID_ROUND_SIZE)
  })

  /** Deterministic LCG so shuffle tests are repeatable. */
  const lcg = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return seed / 4294967296
  }

  it('scrambles presentation order without changing membership', () => {
    // A deterministic order lets sequence memory stand in for recall — the
    // third card becomes "the one after Bolivia" instead of a map fact.
    const cards: Record<string, StoredCard> = {}
    for (const c of index.ordered.slice(0, RAPID_ROUND_SIZE)) {
      const card = reviewed(c.iso3, new Date('2026-05-01'))
      cards[card.id] = card
    }
    const selection = selectRapidCards(index, cards, now).map((i) => i.card.iso3)
    const round = buildRapidQueue(index, cards, now, RAPID_ROUND_SIZE, lcg(42)).map((i) => i.card.iso3)

    expect([...round].sort()).toEqual([...selection].sort())
    expect(round).not.toEqual(selection)
  })

  it('shuffles differently across rounds', () => {
    const cards: Record<string, StoredCard> = {}
    for (const c of index.ordered.slice(0, RAPID_ROUND_SIZE)) {
      const card = reviewed(c.iso3, new Date('2026-05-01'))
      cards[card.id] = card
    }
    const a = buildRapidQueue(index, cards, now, RAPID_ROUND_SIZE, lcg(1)).map((i) => i.card.iso3)
    const b = buildRapidQueue(index, cards, now, RAPID_ROUND_SIZE, lcg(2)).map((i) => i.card.iso3)
    expect(a).not.toEqual(b)
  })
})
