import {
  createEmptyCard,
  fsrs,
  generatorParameters,
  Rating,
  State,
  type Card as FsrsCard,
  type Grade,
} from 'ts-fsrs'
import { cardId, type CardId, type CardType, type StoredCard } from './model'

/**
 * Fuzz is on so cards introduced together do not stay clumped forever, and
 * retention is the FSRS default of 0.9 — the point where review load and recall
 * probability trade off sensibly for a self-paced learner.
 */
const params = generatorParameters({ enable_fuzz: true, request_retention: 0.9 })
const engine = fsrs(params)

const toFsrs = (c: StoredCard): FsrsCard => ({
  due: new Date(c.due),
  stability: c.stability,
  difficulty: c.difficulty,
  elapsed_days: c.elapsed_days,
  scheduled_days: c.scheduled_days,
  learning_steps: c.learning_steps,
  reps: c.reps,
  lapses: c.lapses,
  state: c.state as State,
  last_review: c.last_review ? new Date(c.last_review) : undefined,
})

const fromFsrs = (id: CardId, iso3: string, type: CardType, c: FsrsCard): StoredCard => ({
  id,
  iso3,
  type,
  due: c.due.getTime(),
  stability: c.stability,
  difficulty: c.difficulty,
  elapsed_days: c.elapsed_days,
  scheduled_days: c.scheduled_days,
  learning_steps: c.learning_steps,
  reps: c.reps,
  lapses: c.lapses,
  state: c.state as 0 | 1 | 2 | 3,
  last_review: c.last_review ? c.last_review.getTime() : null,
})

export function createCard(iso3: string, type: CardType, now: Date): StoredCard {
  return fromFsrs(cardId(iso3, type), iso3, type, createEmptyCard(now))
}

/** `Grade` rather than `Rating`: Rating.Manual is not a review outcome, and
 *  every grade we produce comes from observed behaviour. */
export function schedule(card: StoredCard, rating: Grade, now: Date): StoredCard {
  const { card: next } = engine.next(toFsrs(card), now, rating)
  return fromFsrs(card.id, card.iso3, card.type, next)
}

/** Probability the card is still recalled right now, per the forgetting curve.
 *  Drives the mastery map rather than any scheduling decision. */
export function retrievability(card: StoredCard, now: Date): number {
  if (card.state === State.New || !card.last_review) return 0
  return engine.get_retrievability(toFsrs(card), now, false) as number
}

/**
 * A country's extra card types unlock only once its first two are genuinely
 * established. Introducing five cards per country at once buries you by day
 * three — the whole point of the curriculum order is that pegs land before
 * detail hangs off them.
 */
const UNLOCK_STABILITY_DAYS = 21

export function hasEarnedExtraTypes(locate: StoredCard | undefined, identify: StoredCard | undefined): boolean {
  const mature = (c: StoredCard | undefined) =>
    !!c && c.state === State.Review && c.stability >= UNLOCK_STABILITY_DAYS
  return mature(locate) && mature(identify)
}

export { Rating, State }
