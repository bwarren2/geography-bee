import { Rating, type Grade } from 'ts-fsrs'

/**
 * A country is one note; each card type is a separately scheduled way of
 * recalling it. `locate` and `identify` are deliberately distinct — being shown
 * a shape and naming it is a different skill from being given a name and
 * pointing at the world, and the second is the one worth building.
 */
export type CardType =
  | 'locate'
  | 'identify'
  | 'capital'
  | 'flag'
  | 'neighbors'
  | 'city-locate'
  | 'city-identify'

/** Card types available from day one. The rest unlock per country. */
export const STARTING_TYPES: CardType[] = ['locate', 'identify']
export const ALL_TYPES: CardType[] = [
  'locate',
  'identify',
  'capital',
  'flag',
  'neighbors',
  'city-locate',
  'city-identify',
]

/** The city mirror of the two starting types: name → place and place → name,
 *  per the same philosophy that keeps locate and identify separate. */
export const CITY_TYPES: CardType[] = ['city-locate', 'city-identify']
export const isCityType = (type: CardType) => type === 'city-locate' || type === 'city-identify'

export type CardId = `${string}:${CardType}`
export const cardId = (iso3: string, type: CardType): CardId => `${iso3}:${type}`
/** City cards key off the city id (`MEX-mexico-city:city-locate`); the stored
 *  card still carries the country's iso3 for framing and grouping. */
export const cityCardId = (cityId: string, type: CardType): CardId => `${cityId}:${type}`
/** The entity a card id points at: a country iso3, or a city id. */
export const subjectOf = (id: string): string => id.split(':')[0]!

export function parseCardId(id: string): { iso3: string; type: CardType } {
  const [iso3, type] = id.split(':')
  return { iso3: iso3!, type: type as CardType }
}

/**
 * FSRS state, stored with epoch-millisecond dates rather than Date objects or
 * ISO strings to keep the serialised card near 200 bytes. At 195 countries and
 * five card types the whole collection stays around 200KB, which is what makes
 * localStorage viable.
 */
export interface StoredCard {
  id: CardId
  iso3: string
  type: CardType
  due: number
  stability: number
  difficulty: number
  elapsed_days: number
  scheduled_days: number
  learning_steps: number
  reps: number
  lapses: number
  /** ts-fsrs State: 0 New, 1 Learning, 2 Review, 3 Relearning. */
  state: 0 | 1 | 2 | 3
  last_review: number | null
}

/** What the interaction observed, before it becomes an FSRS grade. */
export interface AnswerOutcome {
  correct: boolean
  latencyMs: number
  /** For `locate`: the country actually clicked. The most valuable signal in
   *  the app — it is what makes confusion pairs detectable. */
  chosen?: string
  /** Whether a wrong answer preceded the correct one on this card. */
  hadWrongAttempt: boolean
  /** True when answered from a multiple-choice list rather than free recall. */
  assisted: boolean
}

/**
 * Latency thresholds per card type, in milliseconds. These differ because the
 * interactions do: scanning a map for a country is legitimately slower than
 * recognising a flag, and grading them on one scale would systematically
 * over-punish `locate`.
 */
const TIMING: Record<CardType, { fast: number; slow: number }> = {
  locate: { fast: 2500, slow: 8000 },
  identify: { fast: 2000, slow: 6500 },
  capital: { fast: 2500, slow: 7000 },
  flag: { fast: 1800, slow: 5500 },
  neighbors: { fast: 6000, slow: 18000 },
  // Pinpointing a city inside a known country is a tighter scan than finding
  // the country itself; naming a marked city parallels identify.
  'city-locate': { fast: 3000, slow: 9000 },
  'city-identify': { fast: 2000, slow: 6500 },
}

/**
 * Turn observed behaviour into an FSRS grade.
 *
 * Self-grading ("how well did you know that?") is the largest source of noise
 * in spaced repetition, and this interaction hands us the answer for free:
 * correctness is objective, hesitation is measurable, and a near miss is
 * visible. Nothing is ever asked of the user.
 */
export function deriveRating(type: CardType, outcome: AnswerOutcome): Grade {
  if (!outcome.correct) return Rating.Again

  const { fast, slow } = TIMING[type]

  // Recovering after a wrong guess is recall, but weak recall.
  if (outcome.hadWrongAttempt) return Rating.Hard
  // Hesitation is evidence too: a correct answer that took eight seconds is not
  // the same memory as one that took two.
  if (outcome.latencyMs > slow) return Rating.Hard
  // Recognition from a list never earns the longest interval — picking the
  // right option out of four is materially easier than producing it cold.
  if (outcome.latencyMs < fast && !outcome.assisted) return Rating.Easy

  return Rating.Good
}
