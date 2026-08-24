import type { CountryIndex } from '../data/load'
import { pooledConfusions } from '../session/drills'
import { RAPID_REGION_MIN_SEEN } from '../session/rapid'
import { cardId, STARTING_TYPES, type StoredCard } from '../srs/model'
import { retrievability } from '../srs/scheduler'
import type { Aggregates } from '../store/store'

/**
 * Diagnostics for the dashboard: where the misses actually are, which pairs
 * keep getting swapped, and what the recent habit looks like. Everything here
 * reads the permanent aggregates — per-card counters and daily totals that
 * survive raw-log pruning — so the picture never silently truncates as the
 * review log rolls over.
 */

export interface TroubleSpot {
  iso3: string
  /** Answers recorded across both map cards. */
  reps: number
  /** Wrong answers across both map cards. */
  lapses: number
  /** lapses / reps, the number shown to the user. */
  missRate: number
  /** Mean time per answer across both map cards, in seconds. */
  avgSeconds: number
  /** Ranking score — shrunken miss rate blended with FSRS difficulty. */
  score: number
}

export interface WeakArea {
  slug: string
  name: string
  /** Mean per-country trouble score over the region's studied countries. */
  score: number
  /** Studied countries in the region (rapid-sprint eligibility reads this). */
  seen: number
  /** How many of them have actually been missed at least once. */
  spots: number
}

/** Below this many recorded answers a miss is noise, not a pattern. */
export const TROUBLE_MIN_REPS = 3

/**
 * A country's trouble score, 0..1. Two signals, both per-country across its
 * two map cards:
 *
 * - Miss rate, shrunk toward zero (`lapses / (reps + 2)`) so one early miss
 *   on a young card cannot outrank a country missed again and again.
 * - FSRS difficulty of the harder card. Difficulty absorbs the softer
 *   struggles — Hard grades from slow answers and recoveries — that never
 *   show up as lapses, and it decays with clean answers, so an old rough
 *   patch stops counting once the country is genuinely down.
 *
 * Miss rate dominates because it is the signal the user can see and verify.
 */
function troubleScore(cards: Record<string, StoredCard>, reps: number, lapses: number, iso3: string): number {
  const shrunkMiss = lapses / (reps + 2)
  let difficulty = 0
  for (const type of STARTING_TYPES) {
    difficulty = Math.max(difficulty, cards[cardId(iso3, type)]?.difficulty ?? 0)
  }
  const diffNorm = Math.max(0, Math.min(1, (difficulty - 1) / 9))
  return 0.7 * shrunkMiss + 0.3 * diffNorm
}

/**
 * The countries most worth a targeted sprint: enough evidence to matter,
 * missed at least once, ranked by trouble score. Slow-but-clean countries do
 * not appear — a list titled "trouble" should only hold things the user has
 * actually gotten wrong.
 */
export function troubleSpots(
  index: CountryIndex,
  cards: Record<string, StoredCard>,
  stats: Aggregates,
  limit = 8,
): TroubleSpot[] {
  const out: TroubleSpot[] = []
  for (const c of index.bundle.countries) {
    let reps = 0
    let lapses = 0
    let totalMs = 0
    for (const type of STARTING_TYPES) {
      const s = stats.perCard[cardId(c.iso3, type)]
      if (!s) continue
      reps += s.reps
      lapses += s.lapses
      totalMs += s.totalMs
    }
    if (reps < TROUBLE_MIN_REPS || lapses === 0) continue
    out.push({
      iso3: c.iso3,
      reps,
      lapses,
      missRate: lapses / reps,
      avgSeconds: totalMs / reps / 1000,
      score: troubleScore(cards, reps, lapses, c.iso3),
    })
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit)
}

/**
 * Regions ranked by mean trouble score over their *studied* countries — the
 * "where should I sprint" answer one level up. Clean countries pull the mean
 * down on purpose: a region where one country wobbles and nine are solid is
 * healthier than one where three of four wobble. Regions without a single
 * miss are omitted (there is nothing to sprint at), as are regions too thin
 * to host a focused round — the same floor the rapid picker applies.
 */
export function weakAreas(
  index: CountryIndex,
  cards: Record<string, StoredCard>,
  stats: Aggregates,
  limit = 3,
): WeakArea[] {
  const out: WeakArea[] = []
  for (const region of index.bundle.regions) {
    let sum = 0
    let seen = 0
    let spots = 0
    for (const iso3 of region.countries) {
      let reps = 0
      let lapses = 0
      for (const type of STARTING_TYPES) {
        const s = stats.perCard[cardId(iso3, type)]
        if (!s) continue
        reps += s.reps
        lapses += s.lapses
      }
      if (reps === 0) continue
      seen += 1
      if (lapses > 0) spots += 1
      sum += troubleScore(cards, reps, lapses, iso3)
    }
    if (seen < RAPID_REGION_MIN_SEEN || spots === 0) continue
    out.push({ slug: region.slug, name: region.name, score: sum / seen, seen, spots })
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit)
}

export interface ConfusionPair {
  a: string
  b: string
  /** Swaps in both directions combined. */
  count: number
}

/** The pairs the drill generator is watching, for display: same pooling, same
 *  threshold, so the list and the "Drill mix-ups" button always agree. */
export function topConfusions(
  confusion: Record<string, number>,
  index: CountryIndex,
  minCount: number,
  limit = 6,
): ConfusionPair[] {
  return [...pooledConfusions(confusion, index).entries()]
    .filter(([, count]) => count >= minCount)
    .sort((x, y) => y[1] - x[1])
    .slice(0, limit)
    .map(([key, count]) => {
      const [a, b] = key.split('|') as [string, string]
      return { a, b, count }
    })
}

export interface DayActivity {
  /** YYYY-MM-DD, UTC — the same keying the daily aggregates use. */
  day: string
  reviews: number
  correct: number
  introduced: number
}

const DAY_MS = 86_400_000
const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10)

/** The trailing `days` days of activity, oldest first, zero-filled — chart
 *  input where a skipped day must render as a gap, not vanish. */
export function activityByDay(daily: Aggregates['daily'], now: Date, days = 28): DayActivity[] {
  const out: DayActivity[] = []
  for (let i = days - 1; i >= 0; i--) {
    const day = dayKey(now.getTime() - i * DAY_MS)
    const d = daily[day]
    out.push({ day, reviews: d?.reviews ?? 0, correct: d?.correct ?? 0, introduced: d?.introduced ?? 0 })
  }
  return out
}

/** Live recall of a country's locate card, for the trouble list's context
 *  column; 0 when unseen. */
export function locateRecall(cards: Record<string, StoredCard>, iso3: string, now: Date): number {
  const card = cards[cardId(iso3, 'locate')]
  return card ? retrievability(card, now) : 0
}
