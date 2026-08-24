import { geoArea, geoCentroid, geoEqualEarth, geoMercator, type GeoProjection } from 'd3-geo'
import type { CountryFeature } from '../data/load'

export type MapView =
  | { kind: 'world'; trim?: boolean }
  | { kind: 'region'; slug: string }
  | { kind: 'country'; iso3: string }

const PAD = 8
/** Extra inset as a fraction of the viewport's short side, so the outermost
 *  countries in a region are not flush against the edge. */
const BREATHING_ROOM = 0.04
/** Country views breathe more: city cards assume the country is known, so
 *  the frame is mostly that country with just enough neighbour showing to
 *  confirm which one it is. */
const COUNTRY_BREATHING = 0.13

/**
 * The largest single polygon of a country, used for framing only.
 *
 * Natural Earth folds overseas departments into the parent country, so France's
 * geometry spans French Guiana to Réunion and Portugal's includes the Azores.
 * Framing a region by full country bounds therefore zooms "Western Europe" out
 * to half the planet. Mainlands give the extent a human would draw.
 */
const mainlandCache = new WeakMap<CountryFeature, CountryFeature>()

export function mainland(f: CountryFeature): CountryFeature {
  if (f.geometry.type !== 'MultiPolygon') return f
  const hit = mainlandCache.get(f)
  if (hit) return hit

  let best = f.geometry.coordinates[0]
  let bestArea = -1
  for (const coordinates of f.geometry.coordinates) {
    const a = geoArea({ type: 'Polygon', coordinates })
    // Guard against inverted winding, which reports a polygon as nearly the
    // whole sphere instead of a small island.
    const area = Math.min(a, 4 * Math.PI - a)
    if (area > bestArea) {
      bestArea = area
      best = coordinates
    }
  }
  const out = { ...f, geometry: { type: 'Polygon', coordinates: best! } } as CountryFeature
  mainlandCache.set(f, out)
  return out
}

/**
 * Circular mean of longitudes. A plain average puts the centre of Oceania in
 * the middle of Africa, because its members straddle the antimeridian and the
 * positive and negative longitudes cancel out.
 */
function meanLongitude(features: CountryFeature[]): number {
  let x = 0
  let y = 0
  for (const f of features) {
    const [lon] = centroidOf(f)
    const rad = (lon * Math.PI) / 180
    x += Math.cos(rad)
    y += Math.sin(rad)
  }
  return (Math.atan2(y / features.length, x / features.length) * 180) / Math.PI
}

const centroidCache = new WeakMap<CountryFeature, [number, number]>()
function centroidOf(f: CountryFeature): [number, number] {
  let c = centroidCache.get(f)
  if (!c) {
    // Spherical centroid, not the planar average of raw coordinates — the
    // latter lands in the wrong hemisphere for anything crossing 180°.
    c = geoCentroid(f) as [number, number]
    centroidCache.set(f, c)
  }
  return c
}

/**
 * World view uses Equal Earth (area-honest, so relative country sizes are not
 * a lie you have to unlearn later). Region views use Mercator rotated to the
 * region's centre longitude, which keeps shapes recognisable at country scale
 * and sidesteps antimeridian wrapping without any bbox arithmetic.
 */
export function makeProjection(
  view: MapView,
  features: CountryFeature[],
  width: number,
  height: number,
): GeoProjection {
  if (view.kind === 'world' || features.length === 0) {
    // trim: fit the inhabited band instead of the whole sphere — everything
    // below 56°S is ocean and Antarctica, and nothing quizzable sits past
    // 84°N, so the sphere fit spends a third of the panel on empty polar
    // dead space.
    const target =
      view.kind === 'world' && view.trim
        ? ({
            type: 'Polygon',
            coordinates: [
              [
                [-179.9, -56],
                [179.9, -56],
                [179.9, 84],
                [-179.9, 84],
                [-179.9, -56],
              ],
            ],
          } as const)
        : ({ type: 'Sphere' } as const)
    return geoEqualEarth().fitExtent(
      [
        [PAD, PAD],
        [width - PAD, height - PAD],
      ],
      target as never,
    )
  }

  const factor = view.kind === 'country' ? COUNTRY_BREATHING : BREATHING_ROOM
  const pad = Math.max(PAD, Math.min(width, height) * factor)
  return geoMercator()
    .rotate([-meanLongitude(features), 0])
    .fitExtent(
      [
        [pad, pad],
        [width - pad, height - pad],
      ],
      { type: 'FeatureCollection', features: features.map(mainland) } as never,
    )
}
