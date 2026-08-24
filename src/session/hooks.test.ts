import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import type { DataBundle } from '../types'

const bundle: DataBundle = JSON.parse(readFileSync('public/data/countries.json', 'utf8'))
const { hooks } = JSON.parse(readFileSync('public/data/hooks.json', 'utf8')) as {
  hooks: Record<string, { hook: string; place: string; exports: string[]; borders: string }>
}

describe('country hooks', () => {
  it('covers every country', () => {
    const missing = bundle.countries.filter((c) => !hooks[c.iso3]).map((c) => c.iso3)
    expect(missing).toEqual([])
  })

  it('has no entries for countries that do not exist', () => {
    const valid = new Set(bundle.countries.map((c) => c.iso3))
    expect(Object.keys(hooks).filter((k) => !valid.has(k))).toEqual([])
  })

  it('has substantive text in every field', () => {
    const thin = Object.entries(hooks)
      .filter(([, h]) => h.hook.trim().length < 30 || h.place.trim().length < 20)
      .map(([iso]) => iso)
    expect(thin).toEqual([])
  })

  it('keeps hooks short enough to read on a phone', () => {
    const tooLong = Object.entries(hooks)
      .filter(([, h]) => h.hook.length > 220)
      .map(([iso, h]) => `${iso} (${h.hook.length})`)
    expect(tooLong).toEqual([])
  })

  it('lists exports for every country that trades', () => {
    const empty = Object.entries(hooks)
      .filter(([iso, h]) => iso !== 'VAT' && (!Array.isArray(h.exports) || h.exports.length === 0))
      .map(([iso]) => iso)
    expect(empty).toEqual([])
  })

  it('tells every country’s border story, at readable length', () => {
    // The border story answers the question the shape itself raises — why the
    // lines run where they do. Every country gets one, substantial enough to
    // carry a treaty or a river, short enough for a phone reveal.
    const bad = Object.entries(hooks)
      .filter(([, h]) => !h.borders || h.borders.trim().length < 60 || h.borders.length > 340)
      .map(([iso, h]) => `${iso} (${h.borders?.length ?? 0})`)
    expect(bad).toEqual([])
  })

  it('names the confusable partner on each side of the classic mix-ups', () => {
    // These pairs are the ones a learner actually conflates; the hooks are the
    // only place the app says so out loud.
    for (const [a, needle] of [
      ['SVK', 'Sloven'],
      ['SVN', 'Slovak'],
      ['NER', 'Nigeria'],
      ['DMA', 'Dominican'],
    ] as const) {
      expect(`${hooks[a]!.hook} ${hooks[a]!.place}`).toContain(needle)
    }
  })
})
