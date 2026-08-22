import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildCityIndex } from '../data/load'
import type { CountryIndex } from '../data/load'
import type { DataBundle } from '../types'
import { MemoryDriver } from '../store/driver'
import { StudyStore } from '../store/store'
import { buildDrills } from './drills'

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

describe('buildDrills', () => {
  it('drills a pair once its confusions reach the threshold', () => {
    expect(buildDrills({ 'SVK>SVN': 2 }, index)).toHaveLength(2)
    expect(buildDrills({ 'SVK>SVN': 1 }, index)).toHaveLength(0)
  })

  it('pools both directions of a pair before thresholding', () => {
    // One mistake each way is still the same confusion twice.
    const drills = buildDrills({ 'SVK>SVN': 1, 'SVN>SVK': 1 }, index)
    expect(drills).toHaveLength(2)
  })

  it('asks both directions of every drilled pair', () => {
    const drills = buildDrills({ 'NER>NGA': 3 }, index)
    expect(drills).toContainEqual({ target: 'NER', other: 'NGA' })
    expect(drills).toContainEqual({ target: 'NGA', other: 'NER' })
  })

  it('caps the round at the worst pairs', () => {
    const confusion = {
      'SVK>SVN': 5,
      'NER>NGA': 4,
      'DMA>DOM': 3,
      'AUT>AUS': 2,
      'LVA>LTU': 2,
      'GMB>GNB': 2,
    }
    const drills = buildDrills(confusion, index)
    expect(drills).toHaveLength(8) // 4 pairs × 2 directions
    expect(drills.some((d) => d.target === 'SVK' || d.other === 'SVK')).toBe(true)
  })

  it('ignores junk keys and unknown countries', () => {
    expect(buildDrills({ 'SVK>SVK': 9, 'XXX>SVN': 9, 'SVK>': 9 }, index)).toHaveLength(0)
  })
})

describe('adjustConfusion', () => {
  it('decays to deletion and never goes negative', async () => {
    const store = new StudyStore(new MemoryDriver())
    await store.load()
    await store.adjustConfusion('SVK>SVN', +2)
    expect(store.snapshot().stats.confusion['SVK>SVN']).toBe(2)
    await store.adjustConfusion('SVK>SVN', -1)
    expect(store.snapshot().stats.confusion['SVK>SVN']).toBe(1)
    await store.adjustConfusion('SVK>SVN', -1)
    expect(store.snapshot().stats.confusion['SVK>SVN']).toBeUndefined()
    await store.adjustConfusion('SVK>SVN', -1)
    expect(store.snapshot().stats.confusion['SVK>SVN']).toBeUndefined()
  })
})
