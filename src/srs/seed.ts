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
/** Three Good reviews from empty put a card in Review state at ~11 days of
 *  stability — genuinely learned, past every teaching step, but short of the
 *  established threshold, so mastery still has to be demonstrated, borders are
 *  half-faded rather than gone, and the dashboard does not start inflated. */
const SEED_REVIEWS = 3

/**
 * FSRS state for the known-by-default countries, built by simulating real
 * reviews rather than hand-writing numbers — hand-crafted stability and
 * difficulty drift out of internal consistency the first time scheduler
 * parameters change. Cards come back due immediately: "known" still gets one
 * confirming review, and a learner who overclaimed just lapses normally.
 */
export function seedKnownCards(now: Date): Record<string, StoredCard> {
  const out: Record<string, StoredCard> = {}
  for (const iso3 of KNOWN_BY_DEFAULT) {
    for (const type of STARTING_TYPES) {
      let when = now.getTime() - 45 * DAY
      let card = createCard(iso3, type, new Date(when))
      for (let i = 0; i < SEED_REVIEWS; i++) {
        card = schedule(card, Rating.Good, new Date(when))
        // Follow the schedule, but keep every simulated review in the past.
        when = Math.min(card.due, now.getTime() - DAY)
      }
      out[card.id] = { ...card, due: now.getTime() }
    }
  }
  return out
}
