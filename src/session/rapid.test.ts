import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { Rating } from 'ts-fsrs'
import type { CountryIndex } from '../data/load'
import type { DataBundle } from '../types'
import type { StoredCard } from '../srs/model'
import { createCard, schedule } from '../srs/scheduler'
import { buildRapidQueue, RAPID_ROUND_SIZE } from './rapid'

const bundle: DataBundle = JSON.parse(readFileSync('public/data/countries.json', 'utf8'))
const index: CountryIndex = {
  bundle,
  byIso3: new Map(bundle.countries.map((c) => [c.iso3, c])),
  byIsoNum: new Map(bundle.countries.map((c) => [c.isoNum, c])),
  regionBySlug: new Map(bundle.regions.map((r) => [r.slug, r])),
  ordered: [...bundle.countries].sort((a, b) => a.introOrder - b.introOrder),
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

  it('puts due cards before not-yet-due ones', () => {
    const cards: Record<string, StoredCard> = {}
    const overdue = { ...reviewed('PER', new Date('2026-05-01')), due: now.getTime() - 1000 }
    const future = { ...reviewed('BRA', new Date('2026-05-30')), due: now.getTime() + 86_400_000 }
    cards[overdue.id] = overdue
    cards[future.id] = future

    const queue = buildRapidQueue(index, cards, now)
    expect(queue[0]!.card.iso3).toBe('PER')
    expect(queue[1]!.card.iso3).toBe('BRA')
  })

  it('fills the rest weakest-recall first', () => {
    const cards: Record<string, StoredCard> = {}
    // Same stability, but ARG was reviewed a month ago and BRA yesterday, so
    // ARG's recall has decayed further and it should come first.
    const stale = { ...reviewed('ARG', new Date('2026-05-01')), due: now.getTime() + 86_400_000 }
    const fresh = { ...reviewed('BRA', new Date('2026-05-31')), due: now.getTime() + 86_400_000 }
    cards[stale.id] = stale
    cards[fresh.id] = fresh

    const queue = buildRapidQueue(index, cards, now)
    expect(queue.map((i) => i.card.iso3)).toEqual(['ARG', 'BRA'])
  })

  it('caps the round', () => {
    const cards: Record<string, StoredCard> = {}
    for (const c of index.ordered.slice(0, RAPID_ROUND_SIZE + 10)) {
      const card = reviewed(c.iso3, new Date('2026-05-01'))
      cards[card.id] = card
    }
    expect(buildRapidQueue(index, cards, now)).toHaveLength(RAPID_ROUND_SIZE)
  })
})
