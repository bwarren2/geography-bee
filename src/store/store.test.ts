import { beforeEach, describe, expect, it } from 'vitest'
import { createCard, schedule } from '../srs/scheduler'
import { Rating } from 'ts-fsrs'
import { MemoryDriver, QuotaError, type KeyValueDriver } from './driver'
import { StudyStore, type ReviewEntry } from './store'

const at = (iso: string) => new Date(iso).getTime()

function entry(over: Partial<ReviewEntry> = {}): ReviewEntry {
  return { c: 'PER:locate', t: at('2026-01-15T10:00:00Z'), r: 3, ms: 2000, ...over }
}

describe('StudyStore', () => {
  let store: StudyStore
  let driver: MemoryDriver

  beforeEach(() => {
    driver = new MemoryDriver()
    store = new StudyStore(driver)
  })

  it('starts a fresh install with the known-by-default countries and default settings', async () => {
    const snap = await store.load()
    // 9 known countries x locate + identify. The seed's own contract lives in
    // seed.test.ts; here we only pin that a virgin store is not empty.
    expect(Object.keys(snap.cards)).toHaveLength(18)
    expect(snap.settings.newCardsPerDay).toBe(8)
  })

  it('persists card state across a reload', async () => {
    await store.load()
    const card = schedule(createCard('PER', 'locate', new Date()), Rating.Good, new Date())
    await store.recordAnswer(card, entry())
    await store.flush()

    const reopened = new StudyStore(driver)
    const snap = await reopened.load()
    expect(snap.cards['PER:locate']?.reps).toBe(card.reps)
  })

  it('accumulates per-card and daily aggregates', async () => {
    await store.load()
    const card = createCard('PER', 'locate', new Date())
    await store.recordAnswer(card, entry({ r: 1, ms: 5000 }), { introduced: true })
    await store.recordAnswer(card, entry({ r: 3, ms: 1500 }))

    const { stats } = store.snapshot()
    expect(stats.perCard['PER:locate']).toMatchObject({ reps: 2, lapses: 1, totalMs: 6500 })
    expect(stats.daily['2026-01-15']).toMatchObject({ reviews: 2, correct: 1, introduced: 1 })
  })

  it('builds a confusion matrix from what was actually clicked', async () => {
    await store.load()
    const card = createCard('SVK', 'locate', new Date())
    await store.recordAnswer(card, entry({ c: 'SVK:locate', r: 1, w: 'SVN' }))
    await store.recordAnswer(card, entry({ c: 'SVK:locate', r: 1, w: 'SVN' }))
    await store.recordAnswer(card, entry({ c: 'SVK:locate', r: 1, w: 'CZE' }))

    expect(store.snapshot().stats.confusion).toEqual({ 'SVK>SVN': 2, 'SVK>CZE': 1 })
  })

  it('splits the raw log into month chunks', async () => {
    await store.load()
    const card = createCard('PER', 'locate', new Date())
    await store.recordAnswer(card, entry({ t: at('2026-01-15T10:00:00Z') }))
    await store.recordAnswer(card, entry({ t: at('2026-02-03T10:00:00Z') }))
    // The current month is held in memory until the debounce fires.
    await store.flush()

    const keys = await driver.keys('gb:v1:log:')
    expect(keys.sort()).toEqual(['gb:v1:log:2026-01', 'gb:v1:log:2026-02'])
  })

  it('prunes old raw reviews but keeps aggregates intact', async () => {
    await store.load()
    const card = createCard('PER', 'locate', new Date())

    // Two full months well past the rolling window.
    for (let i = 0; i < 4000; i++) {
      await store.recordAnswer(card, entry({ t: at('2026-01-15T10:00:00Z') + i }))
    }
    for (let i = 0; i < 3000; i++) {
      await store.recordAnswer(card, entry({ t: at('2026-02-15T10:00:00Z') + i }))
    }

    const log = await store.getRawLog()
    expect(log.length).toBeLessThanOrEqual(5000)
    // The count that matters long-term survives the prune.
    expect(store.snapshot().stats.perCard['PER:locate']!.reps).toBe(7000)
  })

  it('never prunes the only remaining chunk', async () => {
    await store.load()
    const card = createCard('PER', 'locate', new Date())
    for (let i = 0; i < 6000; i++) {
      await store.recordAnswer(card, entry({ t: at('2026-01-15T10:00:00Z') + i }))
    }
    expect((await store.getRawLog()).length).toBe(6000)
  })

  it('round-trips through export and import', async () => {
    await store.load()
    const card = schedule(createCard('PER', 'locate', new Date()), Rating.Good, new Date())
    await store.recordAnswer(card, entry({ w: 'BOL', r: 1 }))
    await store.setSettings({ newCardsPerDay: 15 })

    const backup = await store.exportAll()

    const fresh = new StudyStore(new MemoryDriver())
    await fresh.load()
    await fresh.importAll(backup)

    const snap = fresh.snapshot()
    expect(snap.cards['PER:locate']?.reps).toBe(card.reps)
    expect(snap.settings.newCardsPerDay).toBe(15)
    expect(snap.stats.confusion['PER>BOL']).toBe(1)
    expect(await fresh.getRawLog()).toHaveLength(1)
  })

  it('stacks boosts within a day and replaces a stale one', async () => {
    await store.load()
    await store.grantBoost(5, '2026-03-01')
    await store.grantBoost(5, '2026-03-01')
    expect(store.snapshot().settings.boost).toEqual({ day: '2026-03-01', extra: 10 })
    // A new day starts fresh rather than inheriting yesterday's grant.
    await store.grantBoost(5, '2026-03-02')
    expect(store.snapshot().settings.boost).toEqual({ day: '2026-03-02', extra: 5 })
  })

  it('maps pack ids from before the region re-cut, exactly once', async () => {
    await driver.set('gb:v1:settings', {
      newCardsPerDay: 8,
      packs: ['world', 'region:north-central-america', 'region:south-america'],
      boost: { day: '', extra: 0 },
      // No regionsVersion stamp: written before stamping existed.
    })
    const snap = await store.load()
    expect(snap.settings.packs).toEqual([
      'world',
      'region:north-america',
      'region:central-america',
      'region:south-america',
    ])
    expect(snap.settings.regionsVersion).toBe(2)

    // Dropping one half of a split must survive later loads — the migration
    // is a one-shot rename, not a standing subscription.
    await store.setSettings({ packs: ['world', 'region:north-america', 'region:south-america'] })
    await store.flush()
    const again = await new StudyStore(driver).load()
    expect(again.settings.packs).not.toContain('region:central-america')
  })

  it('migrates pack ids inside imported backups too', async () => {
    await store.load()
    await store.importAll(
      JSON.stringify({
        format: 'geography-bee/v1',
        cards: {},
        stats: { perCard: {}, daily: {}, confusion: {} },
        settings: { newCardsPerDay: 8, packs: ['region:eastern-asia'], boost: { day: '', extra: 0 } },
        log: [],
      }),
    )
    expect(store.snapshot().settings.packs).toEqual([
      'region:japan-koreas',
      'region:china-mongolia',
    ])
  })

  it('rejects a file that is not one of our backups', async () => {
    await store.load()
    await expect(store.importAll('{"format":"anki/apkg"}')).rejects.toThrow(/not a geography bee backup/i)
  })

  it('sacrifices old log chunks rather than card state when storage fills', async () => {
    // Fails writes to the cards key once, as a full disk would.
    let failNextCardWrite = true
    const flaky: KeyValueDriver = {
      get: (k) => driver.get(k),
      set: (k, v) => {
        if (k === 'gb:v1:cards' && failNextCardWrite) {
          failNextCardWrite = false
          return Promise.reject(new QuotaError(k))
        }
        return driver.set(k, v)
      },
      remove: (k) => driver.remove(k),
      keys: (p) => driver.keys(p),
    }

    const s = new StudyStore(flaky)
    await s.load()
    const card = createCard('PER', 'locate', new Date())
    await s.recordAnswer(card, entry({ t: at('2026-01-15T10:00:00Z') }))
    await s.recordAnswer(card, entry({ t: at('2026-02-15T10:00:00Z') }))
    await s.flush()

    // The retry succeeded after freeing a log chunk, so cards persisted.
    expect(s.quotaExhausted).toBe(false)
    expect(await driver.get('gb:v1:cards')).toBeTruthy()
    expect(await driver.keys('gb:v1:log:')).not.toContain('gb:v1:log:2026-01')
  })
})

describe('World Challenge record', () => {
  let store: StudyStore
  let driver: MemoryDriver

  beforeEach(() => {
    driver = new MemoryDriver()
    store = new StudyStore(driver)
  })

  const run = (at: number, missKm = 500) => ({
    at,
    mode: 'borders' as const,
    answers: [
      { iso3: 'PER', chosen: 'PER', correct: true, ms: 2000, tap: [-75, -10] as [number, number], missKm: 0 },
      { iso3: 'ECU', chosen: 'COL', correct: false, ms: 4000, tap: [-74, 4] as [number, number], missKm },
    ],
  })
  const summary = (at: number) => ({
    at,
    mode: 'borders' as const,
    total: 2,
    correct: 1,
    meanMissKm: 250,
    medianMissKm: 500,
    medianMs: 3000,
  })

  it('stays fully separable from study analytics except the confusion matrix', async () => {
    const before = await store.load()
    const perCardBefore = JSON.stringify(before.stats.perCard)
    const dailyBefore = JSON.stringify(before.stats.daily)
    const cardsBefore = JSON.stringify(before.cards)

    await store.recordChallenge(run(1000), summary(1000))
    const snap = store.snapshot()

    // A challenge is a test: nothing it does may move the scheduler, the
    // per-card stats, or the daily counts that feed streaks and pacing.
    expect(JSON.stringify(snap.stats.perCard)).toBe(perCardBefore)
    expect(JSON.stringify(snap.stats.daily)).toBe(dailyBefore)
    expect(JSON.stringify(snap.cards)).toBe(cardsBefore)
    // The one shared write: a wrong tap is a confusion wherever it happens.
    expect(snap.stats.confusion['ECU>COL']).toBe(1)

    expect(snap.challenges.summaries).toHaveLength(1)
    expect(snap.challenges.runs).toHaveLength(1)
  })

  it('persists across reload and caps run detail while keeping every summary', async () => {
    await store.load()
    for (let i = 0; i < 15; i++) await store.recordChallenge(run(i), summary(i))
    await store.flush()

    const reopened = new StudyStore(driver)
    const snap = await reopened.load()
    expect(snap.challenges.summaries).toHaveLength(15)
    expect(snap.challenges.runs).toHaveLength(12)
    // Oldest detail dropped first; summaries keep the full record.
    expect(snap.challenges.runs[0]!.at).toBe(3)
    expect(snap.challenges.summaries[0]!.at).toBe(0)
  })

  it('hydrates pre-mode records as bordered runs instead of losing them', async () => {
    // Challenge records written before the blank variant existed carry no
    // mode field; they were all bordered runs.
    const { mode: _rm, ...bareRun } = run(7)
    const { mode: _sm, ...bareSummary } = summary(7)
    await driver.set('gb:v1:challenges', { summaries: [bareSummary], runs: [bareRun] })
    const snap = await store.load()
    expect(snap.challenges.summaries[0]!.mode).toBe('borders')
    expect(snap.challenges.runs[0]!.mode).toBe('borders')
  })
})
