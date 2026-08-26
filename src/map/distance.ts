import type { CountryFeature } from '../data/load'

const EARTH_RADIUS_KM = 6371

/** Great-circle distance between two [lon, lat] points, in km. */
export function haversineKm(a: [number, number], b: [number, number]): number {
  const rad = Math.PI / 180
  const dLat = (b[1] - a[1]) * rad
  const dLon = (b[0] - a[0]) * rad
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(s)))
}

/**
 * Distance from a point to a country, approximated as the minimum great-circle
 * distance to any vertex of its outline. Natural Earth 50m outlines carry a
 * vertex every few kilometres, which is well inside the precision a "how far
 * off was the tap" metric needs — the alternative, true point-to-segment
 * distance on a sphere, buys single-digit km at real cost in code.
 */
export function distanceToFeatureKm(feature: CountryFeature, p: [number, number]): number {
  const polygons =
    feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates
  let min = Infinity
  for (const rings of polygons) {
    for (const ring of rings) {
      for (const v of ring) {
        const d = haversineKm(v as [number, number], p)
        if (d < min) min = d
      }
    }
  }
  return min
}
