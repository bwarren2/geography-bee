import { describe, expect, it } from 'vitest'
import { State } from 'ts-fsrs'
import { MemoryDriver } from '../store/driver'
import { StudyStore } from '../store/store'
import { createCard, ESTABLISHED_STABILITY_DAYS, isEstablished } from './scheduler'
import { KNOWN_BY_DEFAULT, seedKnownCards, simulateKnownCard } from './seed'

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

describe('simulateKnownCard tiers', () => {
  const now = new Date('2026-03-10T12:00:00Z')

  it('learned lands past teaching but short of established', () => {
    const card = simulateKnownCard('JPN', 'locate', 'learned', now)
    expect(card.state).toBe(State.Review)
    expect(card.stability).toBeGreaterThan(5)
    expect(card.stability).toBeLessThan(ESTABLISHED_STABILITY_DAYS)
  })

  it('mastered crosses the established threshold', () => {
    const card = simulateKnownCard('JPN', 'locate', 'mastered', now)
    expect(card.stability).toBeGreaterThanOrEqual(ESTABLISHED_STABILITY_DAYS)
    expect(isEstablished(card)).toBe(true)
    // Still due immediately: declared knowledge gets one confirming pass.
    expect(card.due).toBe(now.getTime())
  })
})

describe('declareCountry', () => {
  const now = new Date('2026-03-10T12:00:00Z')

  it('creates both map cards at the claimed tier', async () => {
    const store = new StudyStore(new MemoryDriver())
    await store.load()
    await store.declareCountry('JPN', 'mastered', now)
    const snap = store.snapshot()
    for (const type of ['locate', 'identify'] as const) {
      const card = snap.cards[`JPN:${type}`]!
      expect(isEstablished(card)).toBe(true)
      expect(card.due).toBe(now.getTime())
    }
  })

  it('upgrades a weaker card but never downgrades a stronger one', async () => {
    const store = new StudyStore(new MemoryDriver())
    await store.load()
    // USA is seeded at the learned tier; mastering it must raise stability.
    const before = store.snapshot().cards['USA:locate']!.stability
    await store.declareCountry('USA', 'mastered', now)
    const mastered = store.snapshot().cards['USA:locate']!
    expect(mastered.stability).toBeGreaterThan(before)

    // Claiming a lower tier afterwards must change nothing.
    await store.declareCountry('USA', 'learned', now)
    expect(store.snapshot().cards['USA:locate']).toEqual(mastered)
  })

  it('persists declared cards across a reload', async () => {
    const driver = new MemoryDriver()
    const store = new StudyStore(driver)
    await store.load()
    await store.declareCountry('BRA', 'learned', now)
    await store.flush()
    const reopened = await new StudyStore(driver).load()
    expect(reopened.cards['BRA:identify']?.state).toBe(State.Review)
  })
})

describe('declareCity', () => {
  const now = new Date('2026-03-10T12:00:00Z')
  const dc = { id: 'USA-washington-d-c', iso3: 'USA' }

  it('creates both city cards at the claimed tier, due for a confirming pass', async () => {
    const store = new StudyStore(new MemoryDriver())
    await store.load()
    await store.declareCity(dc, 'mastered', now)
    const snap = store.snapshot()
    for (const type of ['city-locate', 'city-identify'] as const) {
      const card = snap.cards[`${dc.id}:${type}`]!
      expect(card.iso3).toBe('USA')
      expect(isEstablished(card)).toBe(true)
      expect(card.due).toBe(now.getTime())
    }
  })

  it('never downgrades a stronger city card', async () => {
    const store = new StudyStore(new MemoryDriver())
    await store.load()
    await store.declareCity(dc, 'mastered', now)
    const mastered = store.snapshot().cards[`${dc.id}:city-locate`]!
    await store.declareCity(dc, 'learned', now)
    expect(store.snapshot().cards[`${dc.id}:city-locate`]).toEqual(mastered)
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
