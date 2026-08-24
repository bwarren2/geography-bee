import type { CountryIndex } from '../data/load'

/**
 * Discrimination drills, generated from the confusion matrix.
 *
 * When the same two countries keep getting swapped, more plain repetition of
 * each one separately is the slow fix — the fast fix is forced discrimination:
 * both candidates on screen, "tap Slovakia", then the mirror question. Drills
 * run after the card session and live outside FSRS entirely; their lifecycle
 * is the pair count itself. A correct pick decays the count, a wrong pick
 * feeds it, so a pair is drilled exactly until it stops being confused.
 */
export interface Drill {
  /** The country to tap. */
  target: string
  /** The confusable it must be told apart from. */
  other: string
}

/** A pair enters drilling once its confusions (both directions) reach this. */
export const DRILL_MIN_CONFUSIONS = 2
/** At most this many pairs per session — a drill round is a coda, not a second
 *  session. */
export const DRILL_MAX_PAIRS = 4

/**
 * Confusion is directional ("SVK>SVN": clicked Slovenia when asked for
 * Slovakia) but the *relationship* is symmetric, so both directions pool
 * into one pair — keyed `A|B` with the isos sorted. Shared with the
 * dashboard's mix-up list so what it shows is exactly what gets drilled.
 */
export function pooledConfusions(
  confusion: Record<string, number>,
  index: CountryIndex,
): Map<string, number> {
  const pairs = new Map<string, number>()
  for (const [key, count] of Object.entries(confusion)) {
    if (count <= 0) continue
    const [a, b] = key.split('>')
    if (!a || !b || a === b) continue
    if (!index.byIso3.has(a) || !index.byIso3.has(b)) continue
    const pairKey = [a, b].sort().join('|')
    pairs.set(pairKey, (pairs.get(pairKey) ?? 0) + count)
  }
  return pairs
}

export function buildDrills(
  confusion: Record<string, number>,
  index: CountryIndex,
  maxPairs = DRILL_MAX_PAIRS,
): Drill[] {
  const selected = [...pooledConfusions(confusion, index).entries()]
    .filter(([, count]) => count >= DRILL_MIN_CONFUSIONS)
    .sort((x, y) => y[1] - x[1])
    .slice(0, maxPairs)

  // Both directions of every pair, interleaved so the same target never runs
  // back-to-back: A-then-B for each pair, mirrors afterwards.
  const forward: Drill[] = []
  const mirror: Drill[] = []
  for (const [pairKey] of selected) {
    const [a, b] = pairKey.split('|') as [string, string]
    forward.push({ target: a, other: b })
    mirror.push({ target: b, other: a })
  }
  return [...forward, ...mirror]
}
