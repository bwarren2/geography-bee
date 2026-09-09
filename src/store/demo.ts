import { Rating } from 'ts-fsrs'
import type { StoredCard } from '../srs/model'
import { createCard, schedule } from '../srs/scheduler'
import type { Settings } from './store'

/**
 * Preview conveniences: opening the app with `?demo=<mode>` on a storage
 * that has never recorded a review populates it for a specific flow — no
 * fixture import, no curriculum grind. The guard is strict: any real review
 * history anywhere and the parameter is ignored, so a shared link cannot
 * clobber someone's actual progress.
 *
 * - `?demo=cities`: North & Central America established and the Cities pack
 *   started, so city cards introduce in the very first session.
 * - `?demo=islands`: every Caribbean and Pacific country met once and due
 *   now — young cards, so the sea parcels draw at near-full strength — and
 *   the whole first session is island locates. Rapid region sprints on
 *   both archipelagos work immediately too.
 */

export type DemoMode = 'cities' | 'islands'

const DAY = 86_400_000
const ESTABLISHED_SET = ['USA', 'CAN', 'MEX', 'GTM', 'HND', 'SLV', 'NIC', 'CRI', 'PAN', 'BLZ']

/** The two parcel regions' members, in their intro order. Hardcoded like the
 *  set above: the demo is a preview tool, not data-driven machinery. */
const ISLAND_SET = [
  'CUB', 'DOM', 'HTI', 'JAM', 'TTO', 'BHS', 'BRB', 'LCA', 'DMA', 'VCT', 'ATG', 'GRD', 'KNA',
  'PNG', 'SLB', 'FJI', 'VUT', 'WSM', 'KIR', 'FSM', 'TON', 'MHL', 'PLW', 'TUV', 'NRU',
]

export function demoMode(): DemoMode | null {
  if (typeof location === 'undefined') return null
  const mode = new URLSearchParams(location.search).get('demo')
  return mode === 'cities' || mode === 'islands' ? mode : null
}

export function citiesDemoCards(now: Date): Record<string, StoredCard> {
  const out: Record<string, StoredCard> = {}
  for (const iso3 of ESTABLISHED_SET) {
    for (const type of ['locate', 'identify'] as const) {
      let when = now.getTime() - 400 * DAY
      let card = createCard(iso3, type, new Date(when))
      for (let i = 0; i < 6; i++) {
        card = schedule(card, Rating.Good, new Date(when))
        when = Math.min(card.due, now.getTime() - DAY)
      }
      // Reviews follow their real schedule — the demo session should be city
      // introductions, not a wall of country confirmations.
      out[card.id] = card
    }
  }
  return out
}

export function citiesDemoSettings(base: Settings): Settings {
  return { ...base, packs: ['world', 'cities'], newCardsPerDay: 10 }
}

/** Every island country reviewed exactly once, a few days ago: young enough
 *  that the parcels draw near full strength, overdue enough that the first
 *  session is nothing but island locates. */
export function islandsDemoCards(now: Date): Record<string, StoredCard> {
  const out: Record<string, StoredCard> = {}
  for (const iso3 of ISLAND_SET) {
    const when = new Date(now.getTime() - 5 * DAY)
    const card = schedule(createCard(iso3, 'locate', when), Rating.Good, when)
    out[card.id] = card
  }
  return out
}

export function islandsDemoSettings(base: Settings): Settings {
  // No introductions: the demo session is the due island reviews, nothing else.
  return { ...base, packs: ['world'], newCardsPerDay: 0 }
}
