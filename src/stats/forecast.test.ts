import { describe, expect, it } from 'vitest'
import { createCard } from '../srs/scheduler'
import type { StoredCard } from '../srs/model'
import { dueForecast } from './forecast'

const now = new Date('2026-03-10T15:00:00Z')

function cardDue(iso3: string, at: string): StoredCard {
  return { ...createCard(iso3, 'locate', now), due: new Date(at).getTime() }
}

describe('dueForecast', () => {
  it('buckets cards by UTC calendar day for the requested window', () => {
    const cards = {
      a: cardDue('PER', '2026-03-10T16:00:00Z'), // later today
      b: cardDue('BRA', '2026-03-11T02:00:00Z'), // tomorrow
      c: cardDue('CHL', '2026-03-11T23:00:00Z'), // tomorrow
      d: cardDue('ARG', '2026-03-12T09:00:00Z'), // day after
    }
    expect(dueForecast(cards, now)).toEqual([1, 2, 1])
  })

  it('counts overdue cards as due today, not lost history', () => {
    const cards = {
      a: cardDue('PER', '2026-02-01T00:00:00Z'),
      b: cardDue('BRA', '2026-03-10T01:00:00Z'), // earlier today also counts
    }
    expect(dueForecast(cards, now)).toEqual([2, 0, 0])
  })

  it('ignores cards due beyond the window', () => {
    const cards = { a: cardDue('PER', '2026-03-13T00:00:00Z') }
    expect(dueForecast(cards, now)).toEqual([0, 0, 0])
  })

  it('day boundaries follow UTC, matching the daily budget convention', () => {
    // 23:30 UTC: a card due 40 minutes later is tomorrow's workload.
    const late = new Date('2026-03-10T23:30:00Z')
    const cards = { a: cardDue('PER', '2026-03-11T00:10:00Z') }
    expect(dueForecast(cards, late)).toEqual([0, 1, 0])
  })

  it('handles an empty collection', () => {
    expect(dueForecast({}, now)).toEqual([0, 0, 0])
  })
})
