import { geoPath } from 'd3-geo'
import type { CountryFeature } from '../data/load'
import type { QuizRegion } from '../types'
import { mainland, makeProjection } from './projection'

/**
 * The locate-framing contract (#3), two tiers calibrated against the real
 * table (`npm run audit:framing`):
 *
 * - MIN_FRAME_SHARE (3%) is the target for confusion-cluster regions — the
 *   cuts exist precisely so Honduras-vs-Nicaragua-grade reviews start at a
 *   workable size. It cannot be universal: no honest South America frame
 *   gives Uruguay 3% next to Brazil.
 * - FRAME_SHARE_FLOOR (0.2%, ~a 17px square on a phone) is the universal
 *   degeneracy line. Below it a country is not merely small, its frame is
 *   spending the screen on somewhere else entirely — every Central America
 *   country sat under it before the split, and pre-fix Australia (clobbered
 *   by Ashmore Reef's duplicate ISO id) fails it by construction.
 *
 * Countries under MICRO_EXEMPT_KM2 are exempt from both: no sane frame gets
 * Malta, the Caribbean micro-states, or Bhutan-beside-India to size, and the
 * snap zones (MIN_TAP_PX) already make them tappable by proximity.
 */
export const MIN_FRAME_SHARE = 0.03
export const FRAME_SHARE_FLOOR = 0.002
export const MICRO_EXEMPT_KM2 = 40_000

export interface FramingRow {
  region: string
  iso3: string
  /** Fraction of the viewport covered by the country's mainland bbox. */
  share: number
}

/**
 * Screen share of every country in its own region's initial locate view,
 * computed with the exact projection the app uses (`makeProjection` over
 * member mainlands), so the audit cannot drift from what players see.
 */
export function framingShares(
  regions: QuizRegion[],
  geo: Map<string, CountryFeature>,
  width: number,
  height: number,
): FramingRow[] {
  const rows: FramingRow[] = []
  for (const region of regions) {
    const features = region.countries
      .map((iso3) => geo.get(iso3))
      .filter((f): f is CountryFeature => !!f)
    const projection = makeProjection({ kind: 'region', slug: region.slug }, features, width, height)
    const path = geoPath(projection)
    for (const f of features) {
      const [[x0, y0], [x1, y1]] = path.bounds(mainland(f))
      rows.push({
        region: region.slug,
        iso3: f.properties.iso3,
        share: ((x1 - x0) * (y1 - y0)) / (width * height),
      })
    }
  }
  return rows
}
