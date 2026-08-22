import { Rating } from 'ts-fsrs'
import { STARTING_TYPES, type StoredCard } from './model'
import { createCard, schedule } from './scheduler'

/**
 * Countries the learner declared already known: seeded as learned on a fresh
 * install instead of queued for teaching. North and Central America, per the
 * owner of this app — a personal default for a personal app.
 */
export const KNOWN_BY_DEFAULT = [
  'USA',
  'CAN',
  'MEX',
  'GTM',
  'HND',
  'SLV',
  'NIC',
  'CRI',
  'PAN',
] as const

const DAY = 86_400_000

/**
 * Declared knowledge comes in two tiers, expressed as how many simulated
 * Good reviews back the claim:
 * - `learned` (3 reviews, ~11 days of stability): past every teaching step
 *   but short of the established threshold — borders half-faded, mastery
 *   still to be demonstrated. The tier used for fresh-install seeding.
 * - `mastered` (6 reviews): past the established threshold, for knowledge
 *   like the country you live in — border fade complete, skill packs
 *   unlocked, no graduation grind for what was never in question.
 */
export const DECLARE_REVIEWS = { learned: 3, mastered: 6 } as const
export type DeclareLevel = keyof typeof DECLARE_REVIEWS

/**
 * FSRS state for a card the learner declares known, built by simulating real
 * reviews rather than hand-writing numbers — hand-crafted stability and
 * difficulty drift out of internal consistency the first time scheduler
 * parameters change. The card comes back due immediately: "known" still gets
 * one confirming review, and an overclaim just lapses normally.
 */
export function simulateKnownCard(
  iso3: string,
  type: (typeof STARTING_TYPES)[number],
  level: DeclareLevel,
  now: Date,
): StoredCard {
  let when = now.getTime() - 180 * DAY
  let card = createCard(iso3, type, new Date(when))
  for (let i = 0; i < DECLARE_REVIEWS[level]; i++) {
    card = schedule(card, Rating.Good, new Date(when))
    // Follow the schedule, but keep every simulated review in the past.
    when = Math.min(card.due, now.getTime() - DAY)
  }
  return { ...card, due: now.getTime() }
}

/** The known-by-default countries a fresh install starts with, at the
 *  `learned` tier. Seeding touches only virgin storage. */
export function seedKnownCards(now: Date): Record<string, StoredCard> {
  const out: Record<string, StoredCard> = {}
  for (const iso3 of KNOWN_BY_DEFAULT) {
    for (const type of STARTING_TYPES) {
      const card = simulateKnownCard(iso3, type, 'learned', now)
      out[card.id] = card
    }
  }
  return out
}
