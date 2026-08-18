import { Rating } from 'ts-fsrs'
import type { CountryIndex } from '../data/load'
import { cardId, STARTING_TYPES, type StoredCard } from '../srs/model'
import { createCard, isEstablished, retrievability, schedule } from '../srs/scheduler'
import { regionSlugOf, WORLD_PACK_ID } from '../session/packs'
import type { Settings, StudySnapshot } from '../store/store'

/**
 * Projections for the dashboard: how solid each country is right now, and how
 * long until each region — and the world — is durably learned at the current
 * pace. Everything here is an estimate and is labelled as one in the UI, but
 * each piece is grounded in something real: recall comes from the forgetting
 * curve, maturation from simulating the actual scheduler, and pace from the
 * user's own recent history.
 */

export interface CountryStanding {
  iso3: string
  /** Current recall probability of the locate card; 0 when unseen. */
  recall: number
  seen: boolean
  /** Both locate and identify established. */
  mastered: boolean
}

export interface RegionOutlook {
  slug: string
  name: string
  total: number
  seen: number
  mastered: number
  /** Days until every country in the region is mastered at current pace.
   *  null: never, because the region is in no started pack. 0: already done. */
  etaDays: number | null
}

export interface Outlook {
  countries: Map<string, CountryStanding>
  regions: RegionOutlook[]
  overall: { total: number; seen: number; mastered: number; etaDays: number | null }
  /** Consecutive days with at least one review, ending today or yesterday. */
  streakDays: number
  /** Reviews per day over the trailing week. */
  reviewsPerDay: number
  /** New cards per day actually achieved recently — the pace projections use. */
  introPerDay: number
}

const DAY_MS = 86_400_000
/** Give up simulating a card after this many reviews — a card that cannot
 *  reach establishment in 60 simulated successes is a data bug, not a plan. */
const SIM_CAP = 60
/** Pace lookback. Long enough to smooth a missed weekend, short enough to
 *  track a real change of habit. */
const PACE_WINDOW_DAYS = 14

/**
 * Days from `now` until this card becomes established, assuming every future
 * review is answered Good on the day it comes due. Simulating the real
 * scheduler keeps this honest against whatever FSRS actually does, instead of
 * hand-waving an interval sequence that would drift the first time parameters
 * change.
 */
export function daysToEstablish(card: StoredCard, now: Date): number {
  if (isEstablished(card)) return 0
  let c = card
  let clock = Math.max(c.due, now.getTime())
  for (let i = 0; i < SIM_CAP; i++) {
    c = schedule(c, Rating.Good, new Date(clock))
    if (isEstablished(c)) return Math.max(0, (clock - now.getTime()) / DAY_MS)
    clock = Math.max(c.due, clock)
  }
  return Number.POSITIVE_INFINITY
}

/** Days for a brand-new card to become established — the maturation tail every
 *  not-yet-introduced country pays after its introduction day arrives. */
export function freshCardLagDays(now: Date): number {
  return daysToEstablish(createCard('SIM', 'locate', now), now)
}

const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10)

export function streakFrom(daily: Record<string, { reviews: number }>, now: Date): number {
  let streak = 0
  // A streak survives until a full day is missed; today still counts as alive
  // even if you have not studied yet.
  let cursor = now.getTime()
  if (!daily[dayKey(cursor)]?.reviews) cursor -= DAY_MS
  while (daily[dayKey(cursor)]?.reviews) {
    streak += 1
    cursor -= DAY_MS
  }
  return streak
}

function paceFrom(
  daily: Record<string, { reviews: number; introduced: number }>,
  now: Date,
  fallbackIntro: number,
): { reviewsPerDay: number; introPerDay: number } {
  const days = Object.keys(daily).sort()
  if (!days.length) return { reviewsPerDay: 0, introPerDay: fallbackIntro }

  // Window from first-ever activity, capped at the lookback — so a two-day-old
  // habit is not averaged over two empty weeks.
  const firstDay = new Date(`${days[0]}T00:00:00Z`).getTime()
  const daysSinceFirst = Math.max(1, Math.floor((now.getTime() - firstDay) / DAY_MS) + 1)
  const window = Math.min(PACE_WINDOW_DAYS, daysSinceFirst)

  let reviews = 0
  let introduced = 0
  for (let i = 0; i < window; i++) {
    const d = daily[dayKey(now.getTime() - i * DAY_MS)]
    reviews += d?.reviews ?? 0
    introduced += d?.introduced ?? 0
  }
  const reviewWindow = Math.min(7, window)
  let recentReviews = 0
  for (let i = 0; i < reviewWindow; i++) {
    recentReviews += daily[dayKey(now.getTime() - i * DAY_MS)]?.reviews ?? 0
  }
  return {
    reviewsPerDay: recentReviews / reviewWindow,
    // A learner mid-lapse still gets a projection: fall back to the configured
    // daily budget rather than dividing by a week of zeroes.
    introPerDay: introduced > 0 ? introduced / window : fallbackIntro,
  }
}

/**
 * Unseen countries in the order they will actually be introduced: region
 * spotlights in start order, then the world tour. Mirrors the session
 * builder's priority; countries in no started pack are excluded and reported
 * as out of rotation.
 */
function introductionQueue(
  index: CountryIndex,
  cards: Record<string, StoredCard>,
  settings: Settings,
): string[] {
  const unseen = (iso3: string) => !cards[cardId(iso3, STARTING_TYPES[0]!)]
  const queue: string[] = []
  const queued = new Set<string>()
  const push = (iso3: string) => {
    if (unseen(iso3) && !queued.has(iso3)) {
      queued.add(iso3)
      queue.push(iso3)
    }
  }

  for (const packId of settings.packs) {
    const slug = regionSlugOf(packId)
    if (!slug) continue
    for (const iso3 of index.regionBySlug.get(slug)?.countries ?? []) push(iso3)
  }
  if (settings.packs.includes(WORLD_PACK_ID)) {
    for (const c of index.ordered) push(c.iso3)
  }
  return queue
}

export function buildOutlook(index: CountryIndex, snapshot: StudySnapshot, now: Date): Outlook {
  const { cards, stats, settings } = snapshot

  const countries = new Map<string, CountryStanding>()
  for (const c of index.bundle.countries) {
    const locate = cards[cardId(c.iso3, 'locate')]
    const identify = cards[cardId(c.iso3, 'identify')]
    countries.set(c.iso3, {
      iso3: c.iso3,
      recall: locate ? retrievability(locate, now) : 0,
      seen: !!locate,
      mastered: isEstablished(locate) && isEstablished(identify),
    })
  }

  const { reviewsPerDay, introPerDay } = paceFrom(stats.daily ?? {}, now, settings.newCardsPerDay)
  const queue = introductionQueue(index, cards, settings)
  const queuePos = new Map(queue.map((iso3, i) => [iso3, i]))
  const freshLag = freshCardLagDays(now)

  /** Days until one country is mastered, or null if it can never be reached. */
  const countryEta = (iso3: string): number | null => {
    const standing = countries.get(iso3)!
    if (standing.mastered) return 0

    if (!standing.seen) {
      const pos = queuePos.get(iso3)
      if (pos === undefined) return null // in no started pack
      if (introPerDay <= 0) return null
      // Two cards per country ahead of it in the queue, then its own
      // maturation once introduced.
      return ((pos + 1) * STARTING_TYPES.length) / introPerDay + freshLag
    }

    let worst = 0
    for (const type of STARTING_TYPES) {
      const card = cards[cardId(iso3, type)] ?? createCard(iso3, type, now)
      worst = Math.max(worst, daysToEstablish(card, now))
    }
    return Number.isFinite(worst) ? worst : null
  }

  const regionOutlook = (slug: string, name: string, isos: string[]): RegionOutlook => {
    let seen = 0
    let mastered = 0
    let eta: number | null = 0
    for (const iso3 of isos) {
      const s = countries.get(iso3)!
      if (s.seen) seen += 1
      if (s.mastered) mastered += 1
      const e = countryEta(iso3)
      // One unreachable country makes the region unreachable — that is the
      // honest answer, and the UI says why (not in rotation).
      eta = eta === null || e === null ? null : Math.max(eta, e)
    }
    return { slug, name, total: isos.length, seen, mastered, etaDays: eta }
  }

  const regions = [...index.bundle.regions]
    .sort((a, b) => a.order - b.order)
    .map((r) => regionOutlook(r.slug, r.name, r.countries))

  const all = regionOutlook(
    'overall',
    'Overall',
    index.bundle.countries.map((c) => c.iso3),
  )

  return {
    countries,
    regions,
    overall: { total: all.total, seen: all.seen, mastered: all.mastered, etaDays: all.etaDays },
    streakDays: streakFrom(stats.daily ?? {}, now),
    reviewsPerDay,
    introPerDay,
  }
}

/** "~3 wk", "~4 mo" — deliberately coarse, because the inputs are estimates. */
export function formatEta(days: number | null): string {
  if (days === null) return '—'
  if (days <= 0) return 'done'
  if (days < 1.5) return '~1 day'
  if (days < 14) return `~${Math.round(days)} days`
  if (days < 70) return `~${Math.round(days / 7)} wk`
  if (days < 700) return `~${Math.round(days / 30.4)} mo`
  return `~${(days / 365).toFixed(1)} yr`
}
