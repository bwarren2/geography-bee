import type { CountryIndex } from '../data/load'
import type { CountryRecord } from '../types'

/**
 * The World Challenge: every one of the 195 countries, shuffled, one tap
 * each. A test, not practice — answers never touch the scheduler, the daily
 * aggregates, or the streak, so a run measures recall without changing what
 * it measures, and every run happens under identical conditions (full
 * borders, flat map, all 195 regardless of what has been studied). That is
 * what makes runs comparable: the only thing that differs between two
 * attempts is you.
 *
 * Each answer stores where the tap actually landed and how far it was from
 * the target country — so improvement shows up two ways: more countries
 * right, and the misses landing closer.
 */
export interface ChallengeAnswer {
  /** The country asked for. */
  iso3: string
  /** The country tapped. */
  chosen: string
  correct: boolean
  ms: number
  /** Where the tap landed, [lon, lat] to 0.01° (~1km). */
  tap: [number, number] | null
  /** Km from the tap to the target country's outline; 0 when correct. */
  missKm: number
}

/**
 * Two titles, one test: the bordered challenge is the standard run, the
 * blank one strips the internal borders away entirely — coastline only, the
 * absolute-position exam that mastered locate cards graduate to. A bordered
 * score and a blank score are different measurements, so each mode keeps its
 * own record and is only ever compared against itself.
 */
export type ChallengeMode = 'borders' | 'blank'

export const CHALLENGE_MODES: { mode: ChallengeMode; title: string; blurb: string }[] = [
  {
    mode: 'borders',
    title: 'World Challenge',
    blurb: 'All 195 countries, shuffled, one tap each — borders drawn, scored on its own record.',
  },
  {
    mode: 'blank',
    title: 'Blank World Challenge',
    blurb: 'The same 195, but coastline only — no internal borders, absolute position or nothing.',
  },
]

export const challengeTitle = (mode: ChallengeMode): string =>
  CHALLENGE_MODES.find((m) => m.mode === mode)!.title

export interface ChallengeRun {
  /** Epoch ms at completion. */
  at: number
  mode: ChallengeMode
  answers: ChallengeAnswer[]
}

/** The comparable record of one run — small enough to keep forever. */
export interface ChallengeSummary {
  at: number
  mode: ChallengeMode
  total: number
  correct: number
  /** Mean km-from-target across ALL answers (correct counts 0): the single
   *  "distance closing over time" number. */
  meanMissKm: number
  /** Median distance among the misses alone — how bad a typical miss is. */
  medianMissKm: number
  medianMs: number
}

/** Full per-answer detail is kept for this many recent runs; summaries are
 *  kept forever. Detail is what powers "which did I miss" and per-country
 *  comparison; the trend charts only need summaries. */
export const CHALLENGE_DETAIL_CAP = 12

/** All 195 countries, shuffled — a fresh order every run so sequence memory
 *  never stands in for knowing the map. */
export function buildChallengeOrder(index: CountryIndex, rng: () => number = Math.random): CountryRecord[] {
  const out = [...index.bundle.countries]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

export function summarizeRun(run: ChallengeRun): ChallengeSummary {
  const misses = run.answers.filter((a) => !a.correct)
  const totalKm = misses.reduce((sum, a) => sum + a.missKm, 0)
  return {
    at: run.at,
    mode: run.mode,
    total: run.answers.length,
    correct: run.answers.length - misses.length,
    meanMissKm: run.answers.length ? Math.round(totalKm / run.answers.length) : 0,
    medianMissKm: Math.round(median(misses.map((a) => a.missKm))),
    medianMs: Math.round(median(run.answers.map((a) => a.ms))),
  }
}
