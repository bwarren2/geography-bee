import { describe, expect, it } from 'vitest'
import { Rating } from 'ts-fsrs'
import { deriveRating, type AnswerOutcome } from './model'
import { createCard, hasEarnedExtraTypes, retrievability, schedule } from './scheduler'

const outcome = (o: Partial<AnswerOutcome>): AnswerOutcome => ({
  correct: true,
  latencyMs: 3000,
  hadWrongAttempt: false,
  assisted: false,
  ...o,
})

describe('deriveRating', () => {
  it('grades a wrong answer as Again regardless of speed', () => {
    expect(deriveRating('locate', outcome({ correct: false, latencyMs: 300 }))).toBe(Rating.Again)
  })

  it('grades recovery after a wrong guess as Hard', () => {
    expect(deriveRating('locate', outcome({ latencyMs: 500, hadWrongAttempt: true }))).toBe(Rating.Hard)
  })

  it('treats hesitation as weak recall', () => {
    expect(deriveRating('identify', outcome({ latencyMs: 9000 }))).toBe(Rating.Hard)
  })

  it('grades fast unassisted recall as Easy', () => {
    expect(deriveRating('identify', outcome({ latencyMs: 1200 }))).toBe(Rating.Easy)
  })

  it('caps multiple-choice at Good however fast it was', () => {
    expect(deriveRating('identify', outcome({ latencyMs: 400, assisted: true }))).toBe(Rating.Good)
  })

  it('scales thresholds per card type so map scanning is not over-punished', () => {
    // 3s is hesitant for a flag but brisk for locating a country on a map.
    expect(deriveRating('flag', outcome({ latencyMs: 3000 }))).toBe(Rating.Good)
    expect(deriveRating('locate', outcome({ latencyMs: 2000 }))).toBe(Rating.Easy)
    expect(deriveRating('flag', outcome({ latencyMs: 2000 }))).toBe(Rating.Good)
  })
})

describe('schedule', () => {
  const now = new Date('2026-01-01T00:00:00Z')

  it('starts a new card as due immediately', () => {
    const c = createCard('PER', 'locate', now)
    expect(c.state).toBe(0)
    expect(c.reps).toBe(0)
    expect(c.due).toBe(now.getTime())
  })

  it('pushes the due date further for Easy than for Hard', () => {
    const base = createCard('PER', 'locate', now)
    const easy = schedule(base, Rating.Easy, now)
    const hard = schedule(base, Rating.Hard, now)
    expect(easy.due).toBeGreaterThan(hard.due)
  })

  it('counts a lapse when a review card is failed', () => {
    let c = createCard('PER', 'locate', now)
    for (let i = 0; i < 4; i++) {
      c = schedule(c, Rating.Easy, new Date(c.due))
    }
    expect(c.state).toBe(2)
    const failed = schedule(c, Rating.Again, new Date(c.due))
    expect(failed.lapses).toBe(c.lapses + 1)
  })

  it('reports decaying retrievability as time passes', () => {
    let c = createCard('PER', 'locate', now)
    c = schedule(c, Rating.Good, now)
    c = schedule(c, Rating.Good, new Date(c.due))
    const atDue = retrievability(c, new Date(c.due))
    const muchLater = retrievability(c, new Date(c.due + 400 * 86_400_000))
    expect(atDue).toBeGreaterThan(muchLater)
    expect(muchLater).toBeGreaterThanOrEqual(0)
  })
})

describe('hasEarnedExtraTypes', () => {
  const now = new Date('2026-01-01T00:00:00Z')

  const mature = (iso: string, type: 'locate' | 'identify') => {
    let c = createCard(iso, type, now)
    // Repeated easy reviews at the due date are what carry a card into Review
    // state with enough stability to count as established.
    for (let i = 0; i < 8; i++) c = schedule(c, Rating.Easy, new Date(c.due))
    return c
  }

  it('stays locked while a country is still new', () => {
    expect(hasEarnedExtraTypes(createCard('PER', 'locate', now), createCard('PER', 'identify', now))).toBe(false)
  })

  it('stays locked when only one of the two starting cards is established', () => {
    expect(hasEarnedExtraTypes(mature('PER', 'locate'), createCard('PER', 'identify', now))).toBe(false)
  })

  it('unlocks once both starting cards are established', () => {
    expect(hasEarnedExtraTypes(mature('PER', 'locate'), mature('PER', 'identify'))).toBe(true)
  })
})
