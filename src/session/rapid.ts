import type { CountryIndex } from '../data/load'
import type { StoredCard } from '../srs/model'
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
 * Which cards deserve a slot in the round: due cards first (oldest debt
 * first), then the weakest recall. This priority decides membership only —
 * presentation order is shuffled separately, below.
 */
export function selectRapidCards(
  index: CountryIndex,
  cards: Record<string, StoredCard>,
  now: Date,
  cap = RAPID_ROUND_SIZE,
): RapidItem[] {
  const seen = Object.values(cards).filter(
    (c): c is StoredCard => c.type === 'locate' && c.reps > 0,
  )

  const ts = now.getTime()
  const due = seen.filter((c) => c.due <= ts).sort((a, b) => a.due - b.due)
  // The rest, weakest recall first — the countries most worth a fast refresher.
  const rest = seen
    .filter((c) => c.due > ts)
    .sort((a, b) => retrievability(a, now) - retrievability(b, now))

  const out: RapidItem[] = []
  for (const card of [...due, ...rest]) {
    if (out.length >= cap) break
    const country = index.byIso3.get(card.iso3)
    if (country) out.push({ card, country })
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
): RapidItem[] {
  return shuffled(selectRapidCards(index, cards, now, cap), rng)
}
