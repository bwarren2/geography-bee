import type { CardId, StoredCard } from '../srs/model'
import { seedKnownCards } from '../srs/seed'
import { defaultDriver, QuotaError, type KeyValueDriver } from './driver'

const NS = 'gb:v1'
const K = {
  cards: `${NS}:cards`,
  stats: `${NS}:stats`,
  settings: `${NS}:settings`,
  meta: `${NS}:meta`,
  /** Row counts per month, so pruning never has to parse the chunks. */
  logIndex: `${NS}:logindex`,
  logPrefix: `${NS}:log:`,
  log: (month: string) => `${NS}:log:${month}`,
}

/**
 * Raw reviews are the only unbounded thing in storage — roughly 4MB a year at a
 * steady pace, which is exactly what would break localStorage. They are capped
 * at a rolling window because the sole consumer that needs row-level history is
 * FSRS parameter optimisation, which wants on the order of a thousand reviews
 * and gains nothing from fifty thousand. Everything else reads the permanent
 * aggregates below, so no long-term insight is lost to pruning.
 */
const RAW_REVIEW_CAP = 5000

/** Prompt for a backup after this many days without one. Clearing site data —
 *  or iOS evicting an uninstalled PWA after 7 idle days — takes everything. */
export const BACKUP_NAG_DAYS = 30

export interface ReviewEntry {
  /** Card id. */
  c: CardId
  /** Epoch ms. */
  t: number
  /** FSRS rating 1-4. */
  r: number
  /** Latency in ms. */
  ms: number
  /** For `locate` misses: the country actually clicked. */
  w?: string
}

export interface CardStats {
  reps: number
  lapses: number
  /** Counts by FSRS rating, index 0 unused. */
  ratings: [number, number, number, number, number]
  totalMs: number
}

export interface DayStats {
  reviews: number
  correct: number
  introduced: number
}

export interface Aggregates {
  /** Permanent per-card counters, unaffected by raw-log pruning. */
  perCard: Record<string, CardStats>
  /** Keyed YYYY-MM-DD. */
  daily: Record<string, DayStats>
  /** `${correctIso3}>${clickedIso3}` → count. The confusion matrix that makes
   *  targeted discrimination drills possible. */
  confusion: Record<string, number>
}

export interface Settings {
  newCardsPerDay: number
  /** Pack ids in the rotation, in the order they were started. New cards are
   *  only ever introduced from started packs; pausing a pack stops future
   *  introductions but never touches the review schedule of existing cards. */
  packs: string[]
  /** Extra new-card budget granted for one specific day (UTC date key). Lets
   *  the learner force material into today's queue — after starting a pack,
   *  say — without touching the standing daily cap. A stale day is ignored,
   *  so a boost can never silently leak into tomorrow. */
  boost: { day: string; extra: number }
}

export interface Meta {
  schema: number
  lastBackupAt: number | null
  createdAt: number
}

export const DEFAULT_SETTINGS: Settings = {
  newCardsPerDay: 8,
  packs: ['world'],
  boost: { day: '', extra: 0 },
}

const emptyAggregates = (): Aggregates => ({ perCard: {}, daily: {}, confusion: {} })
const emptyCardStats = (): CardStats => ({ reps: 0, lapses: 0, ratings: [0, 0, 0, 0, 0], totalMs: 0 })

const monthOf = (t: number) => new Date(t).toISOString().slice(0, 7)
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10)

export interface StudySnapshot {
  cards: Record<string, StoredCard>
  stats: Aggregates
  settings: Settings
  meta: Meta
}

/**
 * The study database.
 *
 * Keys are chunked rather than kept as one blob: appending a review rewrites
 * only the current month's log (tens of KB), not the entire collection. Since
 * localStorage writes are synchronous and block the main thread, that is the
 * difference between an imperceptible write and a visible hitch on every
 * answer. Card and aggregate writes are additionally debounced and flushed on
 * page hide.
 */
export class StudyStore {
  private cards: Record<string, StoredCard> = {}
  private stats: Aggregates = emptyAggregates()
  private settings: Settings = { ...DEFAULT_SETTINGS }
  private meta: Meta = { schema: 1, lastBackupAt: null, createdAt: Date.now() }
  private loaded = false

  private dirty = new Set<'cards' | 'stats' | 'settings' | 'meta' | 'log'>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private pending: Promise<void> | null = null
  /** Set when a write failed for lack of space, so the UI can say so plainly. */
  quotaExhausted = false

  /**
   * The current month's reviews are held in memory and written on the same
   * debounce as everything else. Reading, parsing and re-serialising the chunk
   * on every single answer is quadratic in the month's review count, and by
   * late in a month that lands squarely on the hot path between answering a
   * card and seeing the next one.
   */
  private logMonth: string | null = null
  private logChunk: ReviewEntry[] = []
  /** month -> row count, kept so pruning is arithmetic rather than parsing. */
  private logCounts: Record<string, number> = {}

  constructor(private readonly driver: KeyValueDriver = defaultDriver()) {}

  async load(): Promise<StudySnapshot> {
    if (!this.loaded) {
      const [cards, stats, settings, meta, logIndex] = await Promise.all([
        this.driver.get<Record<string, StoredCard>>(K.cards),
        this.driver.get<Aggregates>(K.stats),
        this.driver.get<Settings>(K.settings),
        this.driver.get<Meta>(K.meta),
        this.driver.get<Record<string, number>>(K.logIndex),
      ])
      // Virgin storage — no cards key was ever written, not even an empty
      // one — starts with the known-by-default countries already learned.
      // Anything less than virgin is someone's real progress (or a backup
      // restore) and is never touched.
      const virgin = cards === null && stats === null
      this.cards = cards ?? (virgin ? seedKnownCards(new Date()) : {})
      if (virgin && Object.keys(this.cards).length) {
        this.dirty.add('cards')
        this.scheduleFlush()
      }
      this.stats = { ...emptyAggregates(), ...(stats ?? {}) }
      this.settings = { ...DEFAULT_SETTINGS, ...(settings ?? {}) }
      this.meta = meta ?? this.meta
      this.logCounts = logIndex ?? (await this.rebuildLogIndex())
      this.loaded = true
    }
    return this.snapshot()
  }

  snapshot(): StudySnapshot {
    return { cards: this.cards, stats: this.stats, settings: this.settings, meta: this.meta }
  }

  getCard(id: CardId): StoredCard | undefined {
    return this.cards[id]
  }

  /**
   * Persist one answered card: its new FSRS state, a raw log row, and the
   * permanent aggregates. Aggregates are updated here rather than derived from
   * the log later precisely because the log gets pruned.
   */
  async recordAnswer(card: StoredCard, entry: ReviewEntry, opts: { introduced?: boolean } = {}): Promise<void> {
    this.cards[card.id] = card

    const perCard = (this.stats.perCard[card.id] ??= emptyCardStats())
    perCard.reps += 1
    perCard.totalMs += entry.ms
    perCard.ratings[entry.r] = (perCard.ratings[entry.r] ?? 0) + 1
    if (entry.r === 1) perCard.lapses += 1

    const day = (this.stats.daily[dayOf(entry.t)] ??= { reviews: 0, correct: 0, introduced: 0 })
    day.reviews += 1
    if (entry.r > 1) day.correct += 1
    if (opts.introduced) day.introduced += 1

    if (entry.w) {
      const key = `${card.iso3}>${entry.w}`
      this.stats.confusion[key] = (this.stats.confusion[key] ?? 0) + 1
    }

    this.dirty.add('cards')
    this.dirty.add('stats')
    this.scheduleFlush()

    await this.appendLog(entry)
  }

  /** One-off recovery if the count index is missing (an older install, or a
   *  backup restored by hand). */
  private async rebuildLogIndex(): Promise<Record<string, number>> {
    const out: Record<string, number> = {}
    for (const key of await this.driver.keys(K.logPrefix)) {
      out[key.slice(K.logPrefix.length)] = ((await this.driver.get<ReviewEntry[]>(key)) ?? []).length
    }
    return out
  }

  private async appendLog(entry: ReviewEntry): Promise<void> {
    const month = monthOf(entry.t)

    if (this.logMonth !== month) {
      // Reviews arrive in time order in practice, but a restored backup or a
      // clock change can jump months, so the outgoing chunk is written before
      // the incoming one is read.
      await this.flushLogChunk()
      this.logMonth = month
      this.logChunk = (await this.driver.get<ReviewEntry[]>(K.log(month))) ?? []
    }

    this.logChunk.push(entry)
    this.logCounts[month] = this.logChunk.length
    this.dirty.add('log')
    this.scheduleFlush()

    await this.pruneLog()
  }

  private async flushLogChunk(): Promise<void> {
    if (this.logMonth && this.logChunk.length) {
      await this.writeGuarded(K.log(this.logMonth), this.logChunk)
      await this.writeGuarded(K.logIndex, this.logCounts)
    }
    this.logChunk = []
    this.logMonth = null
  }

  /**
   * Drop whole oldest months once the rolling window is exceeded. Counts come
   * from the index, so this is arithmetic over a handful of numbers rather than
   * a parse of every stored review.
   */
  private async pruneLog(): Promise<void> {
    const months = Object.keys(this.logCounts).sort()
    if (months.length <= 1) return

    let total = months.reduce((sum, m) => sum + (this.logCounts[m] ?? 0), 0)
    // Never drop the newest chunk: a rolling window is worthless if it can
    // discard the reviews it just recorded.
    for (let i = 0; i < months.length - 1 && total > RAW_REVIEW_CAP; i++) {
      const month = months[i]!
      await this.driver.remove(K.log(month))
      total -= this.logCounts[month] ?? 0
      delete this.logCounts[month]
      if (this.logMonth === month) {
        this.logChunk = []
        this.logMonth = null
      }
      this.dirty.add('log')
    }
  }

  async getRawLog(): Promise<ReviewEntry[]> {
    await this.flush()
    const keys = (await this.driver.keys(K.logPrefix)).sort()
    const chunks = await Promise.all(keys.map((k) => this.driver.get<ReviewEntry[]>(k)))
    return chunks.flatMap((c) => c ?? [])
  }

  /**
   * Nudge one confusion pair up or down. Drills call this: a correct
   * discrimination decays the count that keeps the pair in rotation, a wrong
   * one feeds it — so drilling is self-limiting without any extra state.
   */
  async adjustConfusion(key: string, delta: number): Promise<void> {
    const next = (this.stats.confusion[key] ?? 0) + delta
    if (next <= 0) delete this.stats.confusion[key]
    else this.stats.confusion[key] = next
    this.dirty.add('stats')
    this.scheduleFlush()
  }

  /** Grant extra new-card budget for the given day, stacking with any boost
   *  already granted today and replacing one left over from another day. */
  async grantBoost(extra: number, day: string): Promise<void> {
    const cur = this.settings.boost
    const next = cur.day === day ? { day, extra: cur.extra + extra } : { day, extra }
    return this.setSettings({ boost: next })
  }

  async setSettings(patch: Partial<Settings>): Promise<void> {
    this.settings = { ...this.settings, ...patch }
    this.dirty.add('settings')
    return this.flush()
  }

  daysSinceBackup(now = Date.now()): number | null {
    const last = this.meta.lastBackupAt ?? this.meta.createdAt
    return Math.floor((now - last) / 86_400_000)
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => void this.flush(), 400)
  }

  /** Write everything dirty. Safe to call repeatedly; concurrent calls share
   *  the same in-flight write. */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.pending) return this.pending

    const KEYS = { cards: K.cards, stats: K.stats, settings: K.settings, meta: K.meta } as const

    const work = (async () => {
      const targets = [...this.dirty]
      this.dirty.clear()
      for (const t of targets) {
        if (t === 'log') {
          // Written but kept in memory, so the next append does not re-read it.
          if (this.logMonth && this.logChunk.length) {
            await this.writeGuarded(K.log(this.logMonth), this.logChunk)
          }
          await this.writeGuarded(K.logIndex, this.logCounts)
          continue
        }
        const value =
          t === 'cards' ? this.cards : t === 'stats' ? this.stats : t === 'settings' ? this.settings : this.meta
        await this.writeGuarded(KEYS[t], value)
      }
    })()

    this.pending = work.finally(() => (this.pending = null))
    return this.pending
  }

  /** Write, and on a quota failure make room by dropping the oldest raw log
   *  chunk before retrying once. Card state and aggregates matter far more than
   *  old review rows, so those are what gets sacrificed. */
  private async writeGuarded(key: string, value: unknown): Promise<void> {
    try {
      await this.driver.set(key, value)
    } catch (e) {
      if (!(e instanceof QuotaError)) throw e

      const logs = (await this.driver.keys(K.logPrefix)).sort()
      if (logs.length && logs[0] !== key) {
        await this.driver.remove(logs[0]!)
        try {
          await this.driver.set(key, value)
          return
        } catch {
          /* fall through */
        }
      }
      this.quotaExhausted = true
      console.error(`Storage full; ${key} was not saved`)
    }
  }

  // -------------------------------------------------------------------------
  // Backup
  // -------------------------------------------------------------------------

  async exportAll(): Promise<string> {
    await this.flush()
    return JSON.stringify({
      format: 'geography-bee/v1',
      exportedAt: new Date().toISOString(),
      cards: this.cards,
      stats: this.stats,
      settings: this.settings,
      meta: this.meta,
      log: await this.getRawLog(),
    })
  }

  async markBackedUp(): Promise<void> {
    this.meta = { ...this.meta, lastBackupAt: Date.now() }
    this.dirty.add('meta')
    return this.flush()
  }

  async importAll(json: string): Promise<void> {
    const data = JSON.parse(json)
    if (data?.format !== 'geography-bee/v1') {
      throw new Error('Not a Geography Bee backup file')
    }

    this.cards = data.cards ?? {}
    this.stats = { ...emptyAggregates(), ...(data.stats ?? {}) }
    this.settings = { ...DEFAULT_SETTINGS, ...(data.settings ?? {}) }
    this.meta = data.meta ?? this.meta
    this.loaded = true

    for (const k of await this.driver.keys(K.logPrefix)) await this.driver.remove(k)
    this.logChunk = []
    this.logMonth = null
    this.logCounts = {}

    const log: ReviewEntry[] = data.log ?? []
    const byMonth = new Map<string, ReviewEntry[]>()
    for (const e of log) {
      const m = monthOf(e.t)
      if (!byMonth.has(m)) byMonth.set(m, [])
      byMonth.get(m)!.push(e)
    }
    for (const [m, entries] of byMonth) {
      await this.writeGuarded(K.log(m), entries)
      this.logCounts[m] = entries.length
    }
    await this.writeGuarded(K.logIndex, this.logCounts)

    this.dirty.add('cards')
    this.dirty.add('stats')
    this.dirty.add('settings')
    this.dirty.add('meta')
    return this.flush()
  }
}
