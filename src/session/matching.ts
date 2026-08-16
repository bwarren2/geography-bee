import type { CountryRecord } from '../types'

/** Lowercase, strip accents and punctuation, collapse whitespace. */
export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Formal scaffolding at the head of an official name: "United Republic of
 * Tanzania" should accept "Tanzania".
 *
 * This strips a *prefix* rather than deleting words anywhere in the name. An
 * earlier version dropped words like "kingdom" and "states" wherever they
 * appeared, which collapsed both "United Kingdom" and "United States" to
 * "united" — deleting the single word that tells them apart.
 */
const FORMAL_PREFIX =
  /^(?:the\s+)?(?:(?:united|federal|democratic|socialist|islamic|bolivarian|plurinational|cooperative|oriental|arab|hashemite|grand|independent)\s+)*(?:republic|kingdom|state|states|union|commonwealth|principality|sultanate|emirates?|federation|duchy)\s+of\s+/

/** The forms of a name we are willing to accept, always including the name
 *  itself so nothing is lost by stripping. */
function variants(name: string): string[] {
  const full = normalize(name)
  const stripped = full.replace(FORMAL_PREFIX, '')
  return stripped && stripped !== full ? [full, stripped] : [full]
}

/** Levenshtein distance, bailing out once it exceeds `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const v = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost)
      row.push(v)
      best = Math.min(best, v)
    }
    if (best > max) return max + 1
    prev = row
  }
  return prev[b.length]!
}

/**
 * Typo tolerance scaled to name length. Zero for very short names, where a
 * single edit is the difference between real countries — Chad and Chile are
 * three apart, but Niger and Nigeria differ by two, and Mali and Malta by one.
 */
function tolerance(name: string): number {
  if (name.length <= 5) return 0
  if (name.length <= 9) return 1
  return 2
}

export interface MatchResult {
  correct: boolean
  /** Set when the typed answer names a different real country. */
  matchedOther?: string
}

/**
 * Judge a typed country name.
 *
 * Accepts official names and the alternates people actually use (Ivory Coast,
 * Burma, Holland) plus small typos, but never at the cost of confusing two real
 * countries: an exact match against any other country always wins, so typing
 * "Niger" when the answer is Nigeria is marked wrong rather than forgiven.
 */
export function matchAnswer(input: string, target: CountryRecord, all: CountryRecord[]): MatchResult {
  if (!normalize(input)) return { correct: false }

  const typed = new Set(variants(input))
  const formsOf = (c: CountryRecord) => [c.name, c.official, ...c.altNames].flatMap(variants)
  const hits = (forms: string[]) => forms.some((f) => typed.has(f))

  // An exact hit on some other country is decisive and is checked first, so
  // typo tolerance can never quietly merge two real answers.
  for (const c of all) {
    if (c.iso3 !== target.iso3 && hits(formsOf(c))) return { correct: false, matchedOther: c.iso3 }
  }

  const targetForms = formsOf(target)
  if (hits(targetForms)) return { correct: true }

  for (const form of targetForms) {
    const allowance = tolerance(form)
    if (!allowance) continue
    for (const t of typed) {
      if (editDistance(t, form, allowance) <= allowance) return { correct: true }
    }
  }

  return { correct: false }
}
