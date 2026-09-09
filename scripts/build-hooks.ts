/**
 * Merge the hand-written per-region hook files into the single bundle the app
 * fetches, validating as it goes.
 *
 * Hooks are authored, not derived, so they live in `hooks/<region>.json` — one
 * file per quiz region. A single 195-entry file is unpleasant to edit and gives
 * every change a diff against the same blob; per-region files keep edits scoped
 * to the part of the world being worked on.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DataBundle } from '../src/types'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'hooks')
const OUT = join(ROOT, 'public', 'data', 'hooks.json')

interface Hook {
  hook: string
  place: string
  exports: string[]
  /** Why the border runs where it does. Required: a shape without its story
   *  is exactly what this dataset exists to prevent. */
  borders: string
}

const bundle: DataBundle = JSON.parse(readFileSync(join(ROOT, 'public/data/countries.json'), 'utf8'))
const cityIds = new Set(
  (JSON.parse(readFileSync(join(ROOT, 'public/data/cities.json'), 'utf8')).cities as { id: string }[]).map(
    (c) => c.id,
  ),
)
const validIso = new Set(bundle.countries.map((c) => c.iso3))
const regionOf = new Map(bundle.countries.map((c) => [c.iso3, c.region]))
const nameOf = new Map(bundle.countries.map((c) => [c.iso3, c.name]))

const merged: Record<string, Hook> = {}
const problems: string[] = []
const seen = new Map<string, string>()

if (!existsSync(SRC)) throw new Error(`No hooks directory at ${SRC}`)

// City hooks are one-liners keyed by city id, filed in their own file since
// cities are not regions. Validated against the built city list so a typo'd
// id fails the build instead of silently never showing.
const cityHooks: Record<string, string> = existsSync(join(SRC, 'cities.json'))
  ? JSON.parse(readFileSync(join(SRC, 'cities.json'), 'utf8'))
  : {}
for (const [id, text] of Object.entries(cityHooks)) {
  if (!cityIds.has(id)) problems.push(`cities.json: "${id}" is not a known city id`)
  if (!text?.trim()) problems.push(`cities.json: ${id} has an empty hook`)
}

/**
 * Region chains: authored orderings of countries along a shared structure —
 * an island arc, a coastal string, a band — the sequence knowledge that
 * per-country hooks structurally cannot carry. Keyed by region slug in
 * hooks/chains.json; not every region has one, and that is by design: a
 * chain is only authored where the region genuinely is a line. Stops are
 * "ISO3", "ISO3|Short Label", or "(Context Name)" for non-sovereign gap
 * islands and out-of-region continuations.
 */
interface Chain {
  title: string
  stops: string[]
  mnemonic?: string
}

const validRegion = new Set(bundle.regions.map((r) => r.slug))
const chains: Record<string, Chain[]> = existsSync(join(SRC, 'chains.json'))
  ? JSON.parse(readFileSync(join(SRC, 'chains.json'), 'utf8'))
  : {}
for (const [slug, regionChains] of Object.entries(chains)) {
  if (!validRegion.has(slug)) {
    problems.push(`chains.json: "${slug}" is not a quiz region`)
    continue
  }
  for (const chain of regionChains) {
    const where = `chains.json: ${slug} · "${chain.title || '?'}"`
    if (!chain.title?.trim()) problems.push(`${where}: empty title`)
    if (!Array.isArray(chain.stops) || chain.stops.length < 2) problems.push(`${where}: needs 2+ stops`)
    if (chain.mnemonic !== undefined && !chain.mnemonic.trim()) problems.push(`${where}: empty mnemonic`)
    const seenStops = new Set<string>()
    for (const stop of chain.stops ?? []) {
      if (stop.startsWith('(')) {
        if (!/^\(.+\)$/.test(stop)) problems.push(`${where}: malformed context stop "${stop}"`)
        continue
      }
      const iso3 = stop.split('|')[0]!
      if (!validIso.has(iso3)) problems.push(`${where}: "${iso3}" is not one of the 195 countries`)
      // A sovereign stop must live in the chain's own region: chains render
      // on that region's screens, and a foreign country drawn as a tappable
      // peer would point at a country not on the map. Out-of-region
      // continuations are written as context stops instead.
      else if (regionOf.get(iso3) !== slug) {
        problems.push(`${where}: ${iso3} belongs to region "${regionOf.get(iso3)}" — write it as a (context) stop`)
      }
      if (seenStops.has(iso3)) problems.push(`${where}: ${iso3} appears twice`)
      seenStops.add(iso3)
      if (stop.includes('|') && !stop.split('|')[1]?.trim()) problems.push(`${where}: empty label on "${stop}"`)
    }
  }
}

for (const file of readdirSync(SRC).filter((f) => f.endsWith('.json') && f !== 'cities.json' && f !== 'chains.json').sort()) {
  const slug = file.replace(/\.json$/, '')
  const entries: Record<string, Hook> = JSON.parse(readFileSync(join(SRC, file), 'utf8'))

  for (const [iso3, hook] of Object.entries(entries)) {
    if (!validIso.has(iso3)) {
      problems.push(`${file}: "${iso3}" is not one of the 195 countries`)
      continue
    }
    // Catching a country filed under the wrong region matters: the region files
    // are the only thing telling us which part of the world is still unwritten.
    if (regionOf.get(iso3) !== slug) {
      problems.push(`${file}: ${iso3} (${nameOf.get(iso3)}) belongs to region "${regionOf.get(iso3)}"`)
    }
    if (seen.has(iso3)) problems.push(`${iso3} appears in both ${seen.get(iso3)} and ${file}`)
    seen.set(iso3, file)

    for (const field of ['hook', 'place', 'borders'] as const) {
      if (!hook[field]?.trim()) problems.push(`${file}: ${iso3} has an empty ${field}`)
    }
    if (!Array.isArray(hook.exports)) problems.push(`${file}: ${iso3} exports must be an array`)

    merged[iso3] = hook
  }
}

if (problems.length) {
  throw new Error(`Hook validation failed:\n  ${problems.join('\n  ')}`)
}

writeFileSync(
  OUT,
  JSON.stringify(
    {
      version: 1,
      note: 'Generated by `npm run build:hooks` from the authored files in hooks/. Edit those, not this.',
      hooks: merged,
      cityHooks,
      chains,
    },
    null,
    2,
  ) + '\n',
)

// Coverage by region, so it is obvious what is left to write.
const written = new Set(Object.keys(merged))
const missing = bundle.regions
  .slice()
  .sort((a, b) => a.order - b.order)
  .map((r) => ({ slug: r.slug, gap: r.countries.filter((c) => !written.has(c)) }))
  .filter((r) => r.gap.length)

console.log(`${written.size}/${bundle.countries.length} countries have hooks`)
for (const r of missing) console.log(`  ${r.slug}: ${r.gap.length} left — ${r.gap.join(' ')}`)
if (!missing.length) console.log('  all regions complete')
