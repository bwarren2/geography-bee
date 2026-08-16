import type { CountryIndex } from '../data/load'
import { ALL_TYPES, cardId, STARTING_TYPES, type CardType, type StoredCard } from '../srs/model'
import { createCard, hasEarnedExtraTypes } from '../srs/scheduler'
import { State } from 'ts-fsrs'
import type { Aggregates, Settings } from '../store/store'
import type { CountryRecord } from '../types'

export interface SessionItem {
  card: StoredCard
  country: CountryRecord
  /** First time this card has ever been shown. */
  isNew: boolean
  /** Show the country before asking about it — nobody can recall what they have
   *  never seen, and a guaranteed miss teaches nothing. */
  introduce: boolean
  /** Answer from a list rather than free recall. */
  assisted: boolean
  /** ISO3 options for assisted answering, including the correct one. */
  options: string[]
}

/** Stability, in days, past which `identify` graduates from multiple choice to
 *  typing. Recognition is a gentler on-ramp; recall is the real target. */
const TYPING_STABILITY = 14

/** How many due cards to place between consecutive new ones, so a session does
 *  not front-load everything unfamiliar. */
const NEW_CARD_SPACING = 4

const today = (now: Date) => now.toISOString().slice(0, 10)

/**
 * Distractors for a multiple-choice prompt.
 *
 * Countries the user has actually confused with this one come first — those
 * are the discriminations worth drilling — then same-region neighbours, which
 * are hard for the right reason. Random countries from another continent make
 * the question trivially easy and teach nothing.
 */
export function pickOptions(
  target: CountryRecord,
  index: CountryIndex,
  confusion: Record<string, number>,
  count = 4,
): string[] {
  const chosen: string[] = [target.iso3]

  const confused = Object.entries(confusion)
    .filter(([k]) => k.startsWith(`${target.iso3}>`))
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k.split('>')[1]!)

  const sameRegion = index.bundle.countries
    .filter((c) => c.region === target.region && c.iso3 !== target.iso3)
    .sort((a, b) => Math.abs(a.salience - target.salience) - Math.abs(b.salience - target.salience))
    .map((c) => c.iso3)

  const neighbours = target.borders

  for (const pool of [confused, neighbours, sameRegion]) {
    for (const iso of pool) {
      if (chosen.length >= count) break
      if (!chosen.includes(iso) && index.byIso3.has(iso)) chosen.push(iso)
    }
  }

  // Only if a region is too small to fill the list.
  for (const c of index.ordered) {
    if (chosen.length >= count) break
    if (!chosen.includes(c.iso3)) chosen.push(c.iso3)
  }

  return chosen
}

export interface BuildOptions {
  now: Date
  index: CountryIndex
  cards: Record<string, StoredCard>
  stats: Aggregates
  settings: Settings
  /** Cap on session length; omit for everything due. */
  limit?: number
}

/**
 * Compose a study session: everything due, plus new material up to the daily
 * budget, interleaved so unfamiliar cards are spread through the session.
 */
export function buildSession({ now, index, cards, stats, settings, limit }: BuildOptions): SessionItem[] {
  const ts = now.getTime()
  const confusion = stats.confusion ?? {}

  const item = (card: StoredCard, country: CountryRecord, isNew: boolean): SessionItem => {
    // Typing is the goal, but only once the card is established; before that a
    // blank box mostly produces blanks.
    const assisted =
      card.type === 'identify' && (card.state !== State.Review || card.stability < TYPING_STABILITY)
    return {
      card,
      country,
      isNew,
      introduce: isNew && card.type === STARTING_TYPES[0],
      assisted,
      options: assisted || card.type === 'flag' ? pickOptions(country, index, confusion) : [],
    }
  }

  const due: SessionItem[] = []
  for (const card of Object.values(cards)) {
    if (card.due > ts) continue
    const country = index.byIso3.get(card.iso3)
    if (country) due.push(item(card, country, false))
  }
  due.sort((a, b) => a.card.due - b.card.due)

  // ---------------------------------------------------------------------
  // New material, budgeted against what has already been introduced today
  // ---------------------------------------------------------------------
  const introducedToday = stats.daily?.[today(now)]?.introduced ?? 0
  let budget = Math.max(0, settings.newCardsPerDay - introducedToday)

  const enabled = new Set(settings.enabledRegions)
  const inScope = (c: CountryRecord) => enabled.size === 0 || enabled.has(c.region)

  const fresh: SessionItem[] = []

  // Unlocked card types for countries already established come first. There are
  // always more unseen countries than budget, so putting them first would starve
  // this branch forever — and deepening a country you already place on the map
  // is both cheaper and more valuable than adding another unfamiliar name.
  for (const country of index.ordered) {
    if (budget <= 0) break
    if (!inScope(country)) continue
    const locate = cards[cardId(country.iso3, 'locate')]
    const identify = cards[cardId(country.iso3, 'identify')]
    if (!hasEarnedExtraTypes(locate, identify)) continue

    for (const type of ALL_TYPES) {
      if (budget <= 0) break
      if (STARTING_TYPES.includes(type)) continue
      if (cards[cardId(country.iso3, type)]) continue
      if (type === 'neighbors' && country.borders.length === 0) continue
      fresh.push(item(createCard(country.iso3, type, now), country, true))
      budget -= 1
    }
  }

  for (const country of index.ordered) {
    if (budget <= 0) break
    if (!inScope(country)) continue

    for (const type of STARTING_TYPES) {
      if (budget <= 0) break
      if (cards[cardId(country.iso3, type)]) continue
      fresh.push(item(createCard(country.iso3, type, now), country, true))
      budget -= 1
    }
  }

  return interleave(due, fresh, limit)
}

/** Spread new cards through the due queue rather than stacking them at either
 *  end: a wall of unfamiliar countries up front is discouraging, and one at the
 *  end arrives when attention is lowest. */
function interleave(due: SessionItem[], fresh: SessionItem[], limit?: number): SessionItem[] {
  const out: SessionItem[] = []
  let d = 0
  let f = 0

  while (d < due.length || f < fresh.length) {
    for (let i = 0; i < NEW_CARD_SPACING && d < due.length; i++) out.push(due[d++]!)
    if (f < fresh.length) out.push(fresh[f++]!)
    if (d >= due.length && f >= fresh.length) break
  }

  return limit ? out.slice(0, limit) : out
}

/** Cards of a country that a later question may safely reference. */
export function cardTypesFor(country: CountryRecord): CardType[] {
  return ALL_TYPES.filter((t) => t !== 'neighbors' || country.borders.length > 0)
}
