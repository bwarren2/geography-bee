import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { Rating } from 'ts-fsrs'
import { buildCityIndex } from '../data/load'
import type { CountryIndex } from '../data/load'
import type { CityRecord, DataBundle } from '../types'
import { cardId, cityCardId, type StoredCard } from '../srs/model'
import { createCard, ESTABLISHED_STABILITY_DAYS, schedule } from '../srs/scheduler'
import { DEFAULT_SETTINGS } from '../store/store'
import { answerModeFor, buildSession, pickCityOptions, stimulusFor } from './builder'
import { matchCityAnswer } from './matching'
import { allPacks, packProgress } from './packs'

const bundle: DataBundle = JSON.parse(readFileSync('public/data/countries.json', 'utf8'))
const cityRecords: CityRecord[] = JSON.parse(readFileSync('public/data/cities.json', 'utf8')).cities

const index: CountryIndex = {
  bundle,
  byIso3: new Map(bundle.countries.map((c) => [c.iso3, c])),
  byIsoNum: new Map(bundle.countries.map((c) => [c.isoNum, c])),
  regionBySlug: new Map(bundle.regions.map((r) => [r.slug, r])),
  ordered: [...bundle.countries].sort((a, b) => a.introOrder - b.introOrder),
  cities: buildCityIndex(cityRecords),
}

const now = new Date('2026-06-01T09:00:00Z')

/** Locate + identify pushed past the established threshold, honestly. */
function established(iso3: string): Record<string, StoredCard> {
  const out: Record<string, StoredCard> = {}
  for (const type of ['locate', 'identify'] as const) {
    let card = createCard(iso3, type, new Date('2025-01-01'))
    let when = new Date('2025-01-01').getTime()
    while (card.stability < ESTABLISHED_STABILITY_DAYS) {
      card = schedule(card, Rating.Good, new Date(when))
      when = card.due
    }
    out[card.id] = card
  }
  return out
}

describe('cities dataset', () => {
  it('gives every country exactly one capital and valid coordinates', () => {
    const byCountry = new Map<string, CityRecord[]>()
    for (const c of cityRecords) {
      expect(index.byIso3.has(c.iso3)).toBe(true)
      expect(c.lonlat[0]).toBeGreaterThanOrEqual(-180)
      expect(c.lonlat[0]).toBeLessThanOrEqual(180)
      expect(Math.abs(c.lonlat[1])).toBeLessThanOrEqual(90)
      if (!byCountry.has(c.iso3)) byCountry.set(c.iso3, [])
      byCountry.get(c.iso3)!.push(c)
    }
    expect(byCountry.size).toBe(195)
    for (const [iso3, list] of byCountry) {
      expect(list.filter((c) => c.capital).length, iso3).toBe(1)
    }
    expect(new Set(cityRecords.map((c) => c.id)).size).toBe(cityRecords.length)
  })

  it('orders introduction by country curriculum, capitals first', () => {
    const usa = index.cities.byCountry.get('USA')!
    expect(usa[0]!.capital).toBe(true)
    // The USA leads the curriculum, so its capital is the first city overall.
    expect(index.cities.ordered[0]!.id).toBe(usa[0]!.id)
  })
})

describe('city card modes', () => {
  it('locate is a point tap on a plain country frame; identify mirrors country identify', () => {
    expect(answerModeFor('city-locate', false)).toBe('map-point')
    expect(stimulusFor('city-locate')).toBe('map-plain')
    expect(answerModeFor('city-identify', true)).toBe('choice')
    expect(answerModeFor('city-identify', false)).toBe('text')
    expect(stimulusFor('city-identify')).toBe('map-city')
  })
})

describe('cities pack in a session', () => {
  const base = {
    now,
    index,
    stats: { perCard: {}, daily: {}, confusion: {} },
    settings: { ...DEFAULT_SETTINGS, packs: ['cities'] },
  }

  it('introduces nothing while no country is established', () => {
    const items = buildSession({ ...base, cards: {} })
    expect(items).toHaveLength(0)
  })

  it('introduces a mastered country\'s cities, locate first, teach screen on', () => {
    const items = buildSession({ ...base, cards: established('USA') })
    expect(items.length).toBeGreaterThan(0)
    const first = items.find((i) => i.city)!
    expect(first.card.type).toBe('city-locate')
    expect(first.city!.capital).toBe(true)
    expect(first.city!.iso3).toBe('USA')
    expect(first.introduce).toBe(true)
    // Its identify twin is queued in the same budget window.
    expect(items.some((i) => i.card.type === 'city-identify' && i.city!.id === first.city!.id)).toBe(true)
  })

  it('brings a due city card back with its city resolved', () => {
    const city = index.cities.byCountry.get('USA')![0]!
    const due = {
      ...createCard('USA', 'city-locate', now, cityCardId(city.id, 'city-locate')),
      due: now.getTime() - 1000,
    }
    const items = buildSession({ ...base, cards: { [due.id]: due } })
    expect(items[0]!.city?.id).toBe(city.id)
    expect(items[0]!.isNew).toBe(false)
  })
})

describe('pickCityOptions', () => {
  it('prefers same-country cities, then the region', () => {
    const toronto = index.cities.byId.get('CAN-toronto')!
    const opts = pickCityOptions(toronto, index)
    expect(opts[0]).toBe('CAN-toronto')
    expect(opts).toContain('CAN-ottawa')
    expect(opts).toHaveLength(4)
    expect(new Set(opts).size).toBe(4)
  })
})

describe('matchCityAnswer', () => {
  const all = index.cities.ordered
  const byId = (id: string) => index.cities.byId.get(id)!

  it('accepts alternates and small typos', () => {
    expect(matchCityAnswer('Saigon', byId('VNM-ho-chi-minh-city'), all).correct).toBe(true)
    expect(matchCityAnswer('Otawa', byId('CAN-ottawa'), all).correct).toBe(true)
  })

  it('never forgives typing a different real city', () => {
    const res = matchCityAnswer('Osaka', byId('JPN-nagoya'), all)
    expect(res.correct).toBe(false)
    expect(res.matchedOther).toBe('JPN-osaka')
  })
})

describe('cities pack listing', () => {
  it('appears as a skill pack and counts per-city progress', () => {
    const pack = allPacks(index).find((p) => p.id === 'cities')!
    expect(pack.kind).toBe('skill')

    const cards = established('USA')
    const before = packProgress(pack, index, cards)
    expect(before.total).toBe(cityRecords.length)
    expect(before.started).toBe(0)
    expect(before.readyNow).toBe(index.cities.byCountry.get('USA')!.length)

    const usa = index.cities.byCountry.get('USA')![0]!
    cards[cityCardId(usa.id, 'city-locate')] = createCard('USA', 'city-locate', now, cityCardId(usa.id, 'city-locate'))
    expect(packProgress(pack, index, cards).started).toBe(1)
  })
})
