import type { CountryIndex } from '../data/load'
import { cardId, type StoredCard } from '../srs/model'
import { retrievability } from '../srs/scheduler'
import type { CountryRecord } from '../types'

/**
 * Rapid review: a fast tap-only run over countries already met. No teach
 * screen — a country that has never been shown cannot be rapidly recalled, so
 * unseen countries are simply out of scope — and no reveal between cards.
 * Answers are recorded through the exact same scheduling path as a normal
 * session; only the ceremony is removed.
 */
export interface RapidItem {
  card: StoredCard
  country: CountryRecord
}

/** A round is a sprint, not a slog. */
export const RAPID_ROUND_SIZE = 20
/** Below this many seen countries a rapid round is not worth offering. */
export const RAPID_MIN_SEEN = 5

/**
 * Whole-world rounds only take cards whose recall has actually slipped below
 * this. Without the cutoff, thin rounds padded themselves with whatever was
 * least fresh, and the region round-robin then guaranteed a seat to every
 * region — including ones whose only card is a declared-cold country at
 * 99.9% recall. "Know it cold" means exactly that the sprint leaves it
 * alone until its recall genuinely decays (months, for a mastered card).
 * Focused region rounds skip the cutoff: deliberately drilling a chosen
 * area over fresh cards is a request, not filler.
 */
export const RAPID_FRESH_CUTOFF = 0.92

/**
 * Which cards deserve a slot in the round: due cards first (oldest debt
 * first), then the weakest recall — dealt round-robin across regions.
 *
 * Pure priority once let a single cohort capture whole rounds: a batch of
 * declared countries, all due for their confirming pass at once, served
 * nothing but the Americas for days while Europe and Asia never surfaced.
 * Dealing one card per region per pass keeps the priority order *within*
 * each region (debts still surface, oldest first) while every studied
 * region gets seats in every round. Presentation order is shuffled
 * separately, below.
 */
export function selectRapidCards(
  index: CountryIndex,
  cards: Record<string, StoredCard>,
  now: Date,
  cap = RAPID_ROUND_SIZE,
  regionSlug?: string,
): RapidItem[] {
  const seen = Object.values(cards).filter(
    (c): c is StoredCard =>
      c.type === 'locate' &&
      c.reps > 0 &&
      (!regionSlug || index.byIso3.get(c.iso3)?.region === regionSlug),
  )

  const ts = now.getTime()
  const due = seen.filter((c) => c.due <= ts).sort((a, b) => a.due - b.due)
  // The rest, weakest recall first — the countries most worth a fast
  // refresher. World rounds drop anything still fresh; see RAPID_FRESH_CUTOFF.
  const rest = seen
    .filter((c) => c.due > ts && (regionSlug ? true : retrievability(c, now) < RAPID_FRESH_CUTOFF))
    .sort((a, b) => retrievability(a, now) - retrievability(b, now))

  // Per-region queues in global priority order; regions take turns in the
  // order of their most urgent card, so the region holding the oldest debt
  // still leads the deal.
  const queues = new Map<string, RapidItem[]>()
  for (const card of [...due, ...rest]) {
    const country = index.byIso3.get(card.iso3)
    if (!country) continue
    if (!queues.has(country.region)) queues.set(country.region, [])
    queues.get(country.region)!.push({ card, country })
  }

  const out: RapidItem[] = []
  const order = [...queues.values()]
  while (out.length < cap) {
    let dealt = false
    for (const queue of order) {
      if (out.length >= cap) break
      const item = queue.shift()
      if (item) {
        out.push(item)
        dealt = true
      }
    }
    if (!dealt) break
  }
  return out
}

/** Fisher–Yates with an injectable source of randomness, for testability. */
function shuffled<T>(items: T[], rng: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

/**
 * The round as presented: priority-selected, then shuffled. Selection order
 * would otherwise also be presentation order, and a deterministic sequence
 * becomes a crutch — the third card is recalled as "the one after Bolivia"
 * rather than from the map. Membership stays earned; order carries nothing.
 */
export function buildRapidQueue(
  index: CountryIndex,
  cards: Record<string, StoredCard>,
  now: Date,
  cap = RAPID_ROUND_SIZE,
  rng: () => number = Math.random,
  regionSlug?: string,
): RapidItem[] {
  return shuffled(selectRapidCards(index, cards, now, cap, regionSlug), rng)
}

/**
 * A sprint over an explicit set of countries — the dashboard's "sprint these"
 * on its trouble list. No due-ness or freshness filtering at all: like a
 * focused region round, drilling a named list is a request, not filler. Only
 * the usual floor holds — a country never met cannot be rapidly recalled.
 */
export function buildTargetedQueue(
  index: CountryIndex,
  cards: Record<string, StoredCard>,
  isos: string[],
  rng: () => number = Math.random,
): RapidItem[] {
  const items: RapidItem[] = []
  for (const iso3 of isos) {
    const card = cards[cardId(iso3, 'locate')]
    const country = index.byIso3.get(iso3)
    if (card && card.reps > 0 && country) items.push({ card, country })
  }
  return shuffled(items, rng)
}

/** A region can host a focused round once this many of its countries have
 *  reviewed locate cards. Small on purpose: Japan & the Koreas has three
 *  members, and a focused sprint over four cards is still a sprint. */
export const RAPID_REGION_MIN_SEEN = 2

/** How many reviewed locate cards each region holds — the picker's
 *  eligibility and its "where am I weak" glance both read from this. */
export function rapidSeenByRegion(index: CountryIndex, cards: Record<string, StoredCard>): Map<string, number> {
  const out = new Map<string, number>()
  for (const c of Object.values(cards)) {
    if (c.type !== 'locate' || c.reps === 0) continue
    const region = index.byIso3.get(c.iso3)?.region
    if (region) out.set(region, (out.get(region) ?? 0) + 1)
  }
  return out
}
