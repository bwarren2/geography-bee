import type { CountryIndex } from '../data/load'
import { cardId, cityCardId, type CardType, type StoredCard } from '../srs/model'
import { hasEarnedExtraTypes } from '../srs/scheduler'

/**
 * A pack is a named slice of the card space the learner opts into. Starting
 * one adds its cards to the daily rotation; pausing stops new introductions
 * while cards already created keep their review schedule (a card owes its
 * reviews to the forgetting curve, not to the pack that spawned it).
 *
 * Three families, all derived from the data bundle — packs are not a new
 * dataset, just named views over the existing one:
 *  - core:   the world curriculum, locate + identify in salience order
 *  - skill:  a third card type (capital / flag / borders) that generates cards
 *            only for countries whose locate + identify are established
 *  - region: a spotlight that introduces one region's countries ahead of the
 *            world curriculum
 */
export type PackKind = 'core' | 'skill' | 'region'

export interface PackDef {
  id: string
  kind: PackKind
  name: string
  blurb: string
}

export const WORLD_PACK_ID = 'world'
export const CITIES_PACK_ID = 'cities'

/** Card type each skill pack generates. */
export const SKILL_PACK_TYPES: Record<string, CardType> = {
  capitals: 'capital',
  flags: 'flag',
  borders: 'neighbors',
}

const SKILL_PACKS: PackDef[] = [
  {
    id: CITIES_PACK_ID,
    kind: 'skill',
    name: 'Cities',
    blurb: 'Place capitals and major cities on a map of countries you already know — and name them from a dot.',
  },
  {
    id: 'capitals',
    kind: 'skill',
    name: 'Capitals',
    blurb: 'Type the capital of countries you can already place on the map.',
  },
  {
    id: 'flags',
    kind: 'skill',
    name: 'Flags',
    blurb: 'Name the country from its flag, with distractors from its neighbourhood.',
  },
  {
    id: 'borders',
    kind: 'skill',
    name: 'Borders',
    blurb: 'Select every neighbour of a country. Island nations sit this one out.',
  },
]

export const regionPackId = (slug: string) => `region:${slug}`
export const regionSlugOf = (packId: string) =>
  packId.startsWith('region:') ? packId.slice('region:'.length) : null

export function allPacks(index: CountryIndex): PackDef[] {
  const regions = [...index.bundle.regions]
    .sort((a, b) => a.order - b.order)
    .map(
      (r): PackDef => ({
        id: regionPackId(r.slug),
        kind: 'region',
        name: r.name,
        blurb: `Bring all ${r.countries.length} countries of ${r.name} into the rotation now.`,
      }),
    )

  return [
    {
      id: WORLD_PACK_ID,
      kind: 'core',
      name: 'World map',
      blurb: 'Every UN member, introduced region by region, best-known first.',
    },
    ...SKILL_PACKS,
    ...regions,
  ]
}

export interface PackProgress {
  /** Countries this pack can ever cover. */
  total: number
  /** Countries with at least one of the pack's cards created. */
  started: number
  /** For skill packs: countries established enough to generate a card today. */
  readyNow?: number
}

export function packProgress(
  pack: PackDef,
  index: CountryIndex,
  cards: Record<string, StoredCard>,
): PackProgress {
  const established = (iso3: string) =>
    hasEarnedExtraTypes(cards[cardId(iso3, 'locate')], cards[cardId(iso3, 'identify')])

  if (pack.id === CITIES_PACK_ID) {
    // Progress counts cities, not countries: each city is its own answer.
    const started = index.cities.ordered.filter(
      (c) => cards[cityCardId(c.id, 'city-locate')],
    ).length
    const readyNow = index.cities.ordered.filter(
      (c) => !cards[cityCardId(c.id, 'city-locate')] && established(c.iso3),
    ).length
    return { total: index.cities.ordered.length, started, readyNow }
  }

  if (pack.kind === 'skill') {
    const type = SKILL_PACK_TYPES[pack.id]!
    const eligible = index.bundle.countries.filter(
      (c) => type !== 'neighbors' || c.borders.length > 0,
    )
    const started = eligible.filter((c) => cards[cardId(c.iso3, type)]).length
    const readyNow = eligible.filter(
      (c) => !cards[cardId(c.iso3, type)] && established(c.iso3),
    ).length
    return { total: eligible.length, started, readyNow }
  }

  const isos =
    pack.kind === 'core'
      ? index.bundle.countries.map((c) => c.iso3)
      : (index.regionBySlug.get(regionSlugOf(pack.id)!)?.countries ?? [])

  return {
    total: isos.length,
    started: isos.filter((iso3) => cards[cardId(iso3, 'locate')]).length,
  }
}
