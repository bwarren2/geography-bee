import type { CountryIndex } from '../data/load'
import type { ChallengeAnswer, ChallengeRun } from '../session/challenge'

/**
 * Per-run diagnostics for a World Challenge: where in the world the errors
 * cluster, how far the misses landed, how long the answers took. Everything
 * here reads one stored run's per-answer detail — no other state — so the
 * breakdown of an old run never drifts as studying continues.
 */

export interface RegionRate {
  slug: string
  name: string
  total: number
  wrong: number
}

/** Error rate by world area: every quiz region with its miss count, worst
 *  first, clean regions included (a zero is information too). */
export function regionBreakdown(run: ChallengeRun, index: CountryIndex): RegionRate[] {
  const bySlug = new Map<string, RegionRate>()
  for (const region of index.bundle.regions) {
    bySlug.set(region.slug, { slug: region.slug, name: region.name, total: 0, wrong: 0 })
  }
  for (const a of run.answers) {
    const slug = index.byIso3.get(a.iso3)?.region
    const row = slug ? bySlug.get(slug) : undefined
    if (!row) continue
    row.total += 1
    if (!a.correct) row.wrong += 1
  }
  return [...bySlug.values()].sort(
    (x, y) => y.wrong / Math.max(1, y.total) - x.wrong / Math.max(1, x.total) || y.wrong - x.wrong,
  )
}

export interface TimeBucket {
  /** Inclusive lower bound in seconds. */
  fromS: number
  /** Label like "0–1" or "10+". */
  label: string
  count: number
}

/** Histogram of answer time in one-second buckets, everything past the last
 *  edge pooled into an overflow bucket so one slow straggler cannot stretch
 *  the axis. */
export function timeHistogram(answers: ChallengeAnswer[], maxBucketS = 10): TimeBucket[] {
  const buckets: TimeBucket[] = []
  for (let s = 0; s < maxBucketS; s++) {
    buckets.push({ fromS: s, label: `${s}–${s + 1}`, count: 0 })
  }
  buckets.push({ fromS: maxBucketS, label: `${maxBucketS}+`, count: 0 })
  for (const a of answers) {
    const s = Math.floor(a.ms / 1000)
    buckets[Math.min(s, maxBucketS)]!.count += 1
  }
  return buckets
}

export interface MissDot {
  iso3: string
  missKm: number
  /** 0-1 position along the axis (square-root scale, so the dense near-miss
   *  end gets room and one hemisphere-wide miss cannot crush it). */
  x: number
  /** Stacking row: 0 on the axis, ±1, ±2… when dots would overlap. */
  row: number
}

/**
 * Dot positions for the miss-distance strip plot. Dots that would overlap
 * within `minGap` (as a fraction of the axis) stack into alternating rows
 * above and below the strip — a poor man's beeswarm that keeps every miss
 * individually visible without a physics simulation.
 */
export function missDotplot(answers: ChallengeAnswer[], maxKm?: number, minGap = 0.022): MissDot[] {
  const misses = answers.filter((a) => !a.correct && a.missKm > 0).sort((a, b) => a.missKm - b.missKm)
  const top = maxKm ?? Math.max(1, ...misses.map((a) => a.missKm))
  const scale = (km: number) => Math.sqrt(km / top)

  const placed: MissDot[] = []
  for (const a of misses) {
    const x = scale(a.missKm)
    let row = 0
    let step = 0
    // Alternate 0, +1, -1, +2, -2… until a free row at this x is found.
    for (;;) {
      const clash = placed.some((p) => p.row === row && Math.abs(p.x - x) < minGap)
      if (!clash) break
      step += 1
      row = step % 2 ? Math.ceil(step / 2) : -Math.ceil(step / 2)
    }
    placed.push({ iso3: a.iso3, missKm: a.missKm, x, row })
  }
  return placed
}

/** Tick values for the sqrt km axis, kept to ones that fit the run's range. */
export function missAxisTicks(maxKm: number): number[] {
  return [100, 500, 1000, 2500, 5000, 10000].filter((t) => t <= maxKm * 1.05)
}
