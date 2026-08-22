import { Rating } from 'ts-fsrs'
import type { StoredCard } from '../srs/model'
import { createCard, schedule } from '../srs/scheduler'
import type { Settings } from './store'

/**
 * Preview convenience: opening the app with `?demo=cities` on a storage that
 * has never recorded a review populates it with North & Central America
 * established and the Cities pack started, so city cards introduce in the
 * very first session — no fixture import, no curriculum grind. The guard is
 * strict: any real review history anywhere and the parameter is ignored, so
 * a shared link cannot clobber someone's actual progress.
 */

const DAY = 86_400_000
const ESTABLISHED_SET = ['USA', 'CAN', 'MEX', 'GTM', 'HND', 'SLV', 'NIC', 'CRI', 'PAN', 'BLZ']

export function demoRequested(): boolean {
  if (typeof location === 'undefined') return false
  return new URLSearchParams(location.search).get('demo') === 'cities'
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
