import type { CountryIndex } from '../data/load'
import { cardId, STARTING_TYPES, type CardType, type StoredCard } from '../srs/model'
import { createCard, ESTABLISHED_STABILITY_DAYS, hasEarnedExtraTypes } from '../srs/scheduler'
import { regionSlugOf, SKILL_PACK_TYPES, WORLD_PACK_ID } from './packs'
import { State } from 'ts-fsrs'
import type { Aggregates, Settings } from '../store/store'
import type { CountryRecord } from '../types'

/**
 * How a card is answered. Derived from the card type by an exhaustive switch
 * rather than by a chain of conditions in the view: the first version of this
 * lived as a ternary chain in the UI, where `locate` fell through to the final
 * branch and rendered a text box. "Where is Guatemala?" could then be answered
 * by typing "Guatemala" — the location card silently graded naming instead,
 * collapsing the two skills the whole app exists to keep apart.
 */
export type AnswerMode = 'map-single' | 'map-multi' | 'choice' | 'text'

/** What the learner is shown alongside the prompt. */
export type Stimulus = 'map-plain' | 'map-highlight' | 'flag'

/**
 * The switch is exhaustive over CardType with no default, so adding a card type
 * without deciding how it is answered is a type error rather than a card that
 * quietly renders the wrong control.
 */
export function answerModeFor(type: CardType, assisted: boolean): AnswerMode {
  switch (type) {
    case 'locate':
      return 'map-single'
    case 'neighbors':
      return 'map-multi'
    case 'flag':
      return 'choice'
    case 'identify':
      // Recognition while the card is young, free recall once it holds.
      return assisted ? 'choice' : 'text'
    case 'capital':
      return 'text'
  }
}

/**
 * How strongly a locate card's map draws its internal borders.
 *
 * Borders are training wheels: with them visible, a country can be found by
 * elimination — recognising the shapes around it — rather than by knowing
 * where it is. They fade with the card's stability and disappear exactly at
 * the established threshold, so the mature form of the question is a blank
 * map with only the coastline. The fade is continuous rather than a cliff:
 * each review is asked at the hardest presentation recent evidence says the
 * learner can bear. Wrong-pick feedback still shows (marks fill the country),
 * and the snap zones remain active, which is what makes micro-states
 * answerable by proximity when their outlines are gone.
 */
export function borderOpacityFor(card: StoredCard): number {
  return Math.min(1, Math.max(0, 1 - card.stability / ESTABLISHED_STABILITY_DAYS))
}

export function stimulusFor(type: CardType): Stimulus {
  switch (type) {
    case 'flag':
      return 'flag'
    // Never highlight the answer on a locate card — that is the question.
    case 'locate':
      return 'map-plain'
    case 'identify':
    case 'capital':
    case 'neighbors':
      return 'map-highlight'
  }
}

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

export const today = (now: Date) => now.toISOString().slice(0, 10)

/** How much one press of the boost button adds to today's new-card budget. */
export const BOOST_STEP = 5

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
    // Options exist only where something picks from them, so a mismatch cannot
    // arise between what is offered and how the card is answered.
    const mode = answerModeFor(card.type, assisted)
    return {
      card,
      country,
      isNew,
      introduce: isNew && card.type === STARTING_TYPES[0],
      assisted,
      options: mode === 'choice' ? pickOptions(country, index, confusion) : [],
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
  // A boost is day-stamped: yesterday's leftover grant must not apply today.
  const boost = settings.boost?.day === today(now) ? settings.boost.extra : 0
  let budget = Math.max(0, settings.newCardsPerDay + boost - introducedToday)

  const started = new Set(settings.packs)
  const fresh: SessionItem[] = []
  const queued = new Set<string>()

  const trySeed = (country: CountryRecord, type: CardType) => {
    const id = cardId(country.iso3, type)
    if (budget <= 0 || cards[id] || queued.has(id)) return
    if (type === 'neighbors' && country.borders.length === 0) return
    queued.add(id)
    fresh.push(item(createCard(country.iso3, type, now), country, true))
    budget -= 1
  }

  const startedSkillTypes = Object.entries(SKILL_PACK_TYPES)
    .filter(([packId]) => started.has(packId))
    .map(([, type]) => type)

  // Started skill packs come first: they only ever deepen countries whose
  // locate and identify are already established, and there are always more
  // unseen countries than budget — introduce those first and this branch
  // starves forever.
  if (startedSkillTypes.length) {
    for (const country of index.ordered) {
      if (budget <= 0) break
      const locate = cards[cardId(country.iso3, 'locate')]
      const identify = cards[cardId(country.iso3, 'identify')]
      if (!hasEarnedExtraTypes(locate, identify)) continue
      for (const type of startedSkillTypes) trySeed(country, type)
    }
  }

  // Region spotlights jump their countries ahead of the world curriculum, in
  // the order the packs were started. Within a region the roster is already in
  // curriculum (salience) order.
  for (const packId of settings.packs) {
    const slug = regionSlugOf(packId)
    if (!slug) continue
    for (const iso3 of index.regionBySlug.get(slug)?.countries ?? []) {
      if (budget <= 0) break
      const country = index.byIso3.get(iso3)
      if (!country) continue
      for (const type of STARTING_TYPES) trySeed(country, type)
    }
  }

  // The world curriculum fills whatever budget remains.
  if (started.has(WORLD_PACK_ID)) {
    for (const country of index.ordered) {
      if (budget <= 0) break
      for (const type of STARTING_TYPES) trySeed(country, type)
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

