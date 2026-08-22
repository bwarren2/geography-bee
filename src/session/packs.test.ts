import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { Rating } from 'ts-fsrs'
import { buildCityIndex } from '../data/load'
import type { CountryIndex } from '../data/load'
import type { DataBundle } from '../types'
import { cardId, type StoredCard } from '../srs/model'
import { createCard, schedule } from '../srs/scheduler'
import { allPacks, packProgress, regionPackId } from './packs'

const bundle: DataBundle = JSON.parse(readFileSync('public/data/countries.json', 'utf8'))
const cityRecords = JSON.parse(readFileSync('public/data/cities.json', 'utf8')).cities
const index: CountryIndex = {
  bundle,
  byIso3: new Map(bundle.countries.map((c) => [c.iso3, c])),
  byIsoNum: new Map(bundle.countries.map((c) => [c.isoNum, c])),
  regionBySlug: new Map(bundle.regions.map((r) => [r.slug, r])),
  ordered: [...bundle.countries].sort((a, b) => a.introOrder - b.introOrder),
  cities: buildCityIndex(cityRecords),
}

const established = (iso: string): StoredCard[] =>
  (['locate', 'identify'] as const).map((t) => {
    let c = createCard(iso, t, new Date('2026-01-01'))
    for (let i = 0; i < 8; i++) c = schedule(c, Rating.Easy, new Date(c.due))
    return c
  })

describe('packs', () => {
  it('indexes one core, four skills, and every region', () => {
    const packs = allPacks(index)
    expect(packs.filter((p) => p.kind === 'core')).toHaveLength(1)
    expect(packs.filter((p) => p.kind === 'skill')).toHaveLength(4)
    expect(packs.filter((p) => p.kind === 'region')).toHaveLength(bundle.regions.length)
    expect(new Set(packs.map((p) => p.id)).size).toBe(packs.length)
  })

  it('counts world progress by countries with a locate card', () => {
    const world = allPacks(index).find((p) => p.id === 'world')!
    const cards: Record<string, StoredCard> = {}
    for (const iso of ['PER', 'BRA']) cards[cardId(iso, 'locate')] = createCard(iso, 'locate', new Date())
    const prog = packProgress(world, index, cards)
    expect(prog).toMatchObject({ total: 195, started: 2 })
  })

  it('scopes region progress to that region', () => {
    const anz = allPacks(index).find((p) => p.id === regionPackId('australia-nz'))!
    const cards: Record<string, StoredCard> = {
      [cardId('AUS', 'locate')]: createCard('AUS', 'locate', new Date()),
      [cardId('PER', 'locate')]: createCard('PER', 'locate', new Date()), // not australia-nz
    }
    expect(packProgress(anz, index, cards)).toMatchObject({ total: 2, started: 1 })
  })

  it('excludes borderless countries from the borders pack entirely', () => {
    const borders = allPacks(index).find((p) => p.id === 'borders')!
    const landlockedOrBordered = bundle.countries.filter((c) => c.borders.length > 0).length
    expect(packProgress(borders, index, {}).total).toBe(landlockedOrBordered)
  })

  it('reports readiness for skill packs from established countries', () => {
    const capitals = allPacks(index).find((p) => p.id === 'capitals')!
    const cards: Record<string, StoredCard> = {}
    for (const c of established('PER')) cards[c.id] = c
    for (const c of established('BRA')) cards[c.id] = c
    // BRA already has its capital card; only PER is ready to generate one.
    cards[cardId('BRA', 'capital')] = createCard('BRA', 'capital', new Date())
    const prog = packProgress(capitals, index, cards)
    expect(prog.readyNow).toBe(1)
    expect(prog.started).toBe(1)
  })
})
