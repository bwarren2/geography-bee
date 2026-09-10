import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import type { DataBundle } from '../types'
import { chainsFor, parseChainStop, type RegionChain } from './load'

const bundle: DataBundle = JSON.parse(readFileSync('public/data/countries.json', 'utf8'))
const { chains } = JSON.parse(readFileSync('public/data/hooks.json', 'utf8')) as {
  chains: Record<string, { title: string; stops: string[]; mnemonic?: string }[]>
}

describe('parseChainStop', () => {
  it('reads the three authored stop forms', () => {
    expect(parseChainStop('GRD')).toEqual({ iso3: 'GRD' })
    expect(parseChainStop('VCT|St Vincent')).toEqual({ iso3: 'VCT', label: 'St Vincent' })
    expect(parseChainStop('(Guadeloupe)')).toEqual({ label: 'Guadeloupe' })
  })
})

describe('region chains data', () => {
  const validIso = new Set(bundle.countries.map((c) => c.iso3))
  const regionOf = new Map(bundle.countries.map((c) => [c.iso3, c.region]))

  it('keys only real regions and keeps every sovereign stop in its region', () => {
    for (const [slug, regionChains] of Object.entries(chains)) {
      expect(bundle.regions.some((r) => r.slug === slug)).toBe(true)
      for (const chain of regionChains) {
        expect(chain.title.trim().length).toBeGreaterThan(0)
        expect(chain.stops.length).toBeGreaterThanOrEqual(2)
        for (const raw of chain.stops) {
          const stop = parseChainStop(raw)
          if (stop.iso3) {
            expect(validIso.has(stop.iso3)).toBe(true)
            expect(regionOf.get(stop.iso3)).toBe(slug)
          } else {
            expect(stop.label!.trim().length).toBeGreaterThan(0)
          }
        }
      }
    }
  })

  it('covers the archipelagos: the arc and all three Pacific bands', () => {
    expect(chains['caribbean']!.length).toBeGreaterThanOrEqual(2)
    expect(chains['pacific-islands']).toHaveLength(3)
  })

  it('keeps mnemonics readable on a phone', () => {
    for (const chain of Object.values(chains).flat()) {
      if (chain.mnemonic) expect(chain.mnemonic.length).toBeLessThanOrEqual(260)
    }
  })
})

describe('chainsFor', () => {
  const parsed = new Map<string, RegionChain[]>(
    Object.entries(chains).map(([slug, cs]) => [
      slug,
      cs.map((c) => ({ ...c, stops: c.stops.map(parseChainStop) })),
    ]),
  )

  it('finds the chains passing through a country, and only those', () => {
    // Grenada is on the arc but not in the Greater Antilles.
    const grd = chainsFor(parsed, 'caribbean', 'GRD')
    expect(grd).toHaveLength(1)
    expect(grd[0]!.title).toContain('Lesser Antilles')
    // Fiji is only on the Melanesia band.
    expect(chainsFor(parsed, 'pacific-islands', 'FJI').map((c) => c.title)).toEqual([
      'Melanesia: big to small, heading southeast',
    ])
    // Context stops never match: French Guiana is not a sovereign stop.
    expect(chainsFor(parsed, 'south-america', 'BRA')).toHaveLength(0)
  })
})
