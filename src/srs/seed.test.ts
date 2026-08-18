import { describe, expect, it } from 'vitest'
import { State } from 'ts-fsrs'
import { MemoryDriver } from '../store/driver'
import { StudyStore } from '../store/store'
import { createCard } from './scheduler'
import { KNOWN_BY_DEFAULT, seedKnownCards } from './seed'

const now = new Date('2026-06-01T09:00:00Z')

describe('seedKnownCards', () => {
  it('seeds both starting cards for every known-by-default country', () => {
    const cards = seedKnownCards(now)
    expect(Object.keys(cards)).toHaveLength(KNOWN_BY_DEFAULT.length * 2)
    for (const iso of KNOWN_BY_DEFAULT) {
      expect(cards[`${iso}:locate`]).toBeTruthy()
      expect(cards[`${iso}:identify`]).toBeTruthy()
    }
  })

  it('seeds learned cards: Review state, past teaching, short of established', () => {
    for (const card of Object.values(seedKnownCards(now))) {
      expect(card.state).toBe(State.Review)
      expect(card.reps).toBeGreaterThan(0)
      // Learned but not yet established: mastery still has to be shown, so the
      // dashboard does not start inflated and borders are faded, not gone.
      expect(card.stability).toBeGreaterThan(5)
      expect(card.stability).toBeLessThan(21)
    }
  })

  it('makes every seeded card due immediately for a confirming review', () => {
    for (const card of Object.values(seedKnownCards(now))) {
      expect(card.due).toBeLessThanOrEqual(now.getTime())
      expect(card.last_review).toBeLessThan(now.getTime())
    }
  })
})

describe('seeding on load', () => {
  it('seeds virgin storage and persists the result', async () => {
    const driver = new MemoryDriver()
    const store = new StudyStore(driver)
    const snap = await store.load()
    expect(Object.keys(snap.cards)).toHaveLength(KNOWN_BY_DEFAULT.length * 2)
    await store.flush()

    // A second store sees the persisted cards, not a second seeding.
    const again = await new StudyStore(driver).load()
    expect(Object.keys(again.cards).sort()).toEqual(Object.keys(snap.cards).sort())
  })

  it('never seeds over an explicitly empty collection', async () => {
    const driver = new MemoryDriver()
    await driver.set('gb:v1:cards', {})
    const snap = await new StudyStore(driver).load()
    expect(Object.keys(snap.cards)).toHaveLength(0)
  })

  it('never seeds over existing progress', async () => {
    const driver = new MemoryDriver()
    const card = createCard('PER', 'locate', now)
    await driver.set('gb:v1:cards', { [card.id]: card })
    const snap = await new StudyStore(driver).load()
    expect(Object.keys(snap.cards)).toEqual([card.id])
  })

  it('does not spend the daily new-card budget', async () => {
    // Seeded countries are grandfathered, not introduced: a brand-new install
    // still gets its full budget of genuinely new material.
    const snap = await new StudyStore(new MemoryDriver()).load()
    expect(snap.stats.daily).toEqual({})
  })
})
