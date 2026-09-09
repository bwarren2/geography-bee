import { Delaunay } from 'd3-delaunay'
import type { CountryFeature } from '../data/load'

/**
 * Sea parcels: a Voronoi partition of the ocean around an archipelago, one
 * cell per country — every point of sea belongs to its nearest island. In
 * the two regions where countries are near-invisible dots, this turns the
 * scatter into a normal map: large adjacent territories with borders
 * between them, so neighbour reasoning works and a wrong tap lands in a
 * nameable cell instead of anonymous ocean. It is not even a lie — nearest-
 * island sea is roughly what maritime zones look like.
 *
 * Parcels are training wheels on the exact dial borders already use: their
 * visibility fades with the locate card's stability, and tap forgiveness
 * (how far from an island a tap may land and still pick it) rides the same
 * number — assist you can see is assist you get, and the graduation exam is
 * honest empty ocean. Challenges never show them.
 */

/** Regions that get parcels: the two whose members are mostly micro-share
 *  islands in their own frame (see audit:framing). Deliberately a list, not
 *  a derived threshold — an area criterion loose enough to catch these two
 *  also catches Southern Europe, where cells over Iberia would be absurd.
 *  East Africa's island trio is the likeliest future addition. */
export const PARCEL_REGIONS = new Set(['caribbean', 'pacific-islands'])

/** Reach of the parcel pick at full visibility, in screen px. Big enough to
 *  cover a phone map panel — while cells are fully drawn, tapping anywhere
 *  in one picks its island. */
export const PARCEL_REACH_PX = 340

/** How far beyond the normal snap a tap may land and still resolve to the
 *  nearest island, scaled by how visible the parcels currently are — the
 *  forgiveness shrinks in lockstep with the fade. */
export const parcelReachPx = (opacity: number): number =>
  Math.max(0, Math.min(1, opacity)) * PARCEL_REACH_PX

/** Cap on Voronoi seeds per country, largest island parts first, so Kiribati
 *  reads as one lobed cell instead of thirty slivers. */
const MAX_SEEDS_PER_COUNTRY = 8
/** Same-country seeds closer than this (px) merge — islet clusters need one
 *  seed, not five coincident ones. */
const SEED_MERGE_PX = 8
/** Seeds this far outside the viewport are dropped; their cells could never
 *  be seen or usefully tapped. */
const OFFSCREEN_MARGIN_PX = 120

export interface ParcelSeed {
  iso3: string
  x: number
  y: number
}

export interface ParcelCell {
  iso3: string
  polygon: [number, number][]
}

export interface Parcels {
  seeds: ParcelSeed[]
  cells: ParcelCell[]
  /** SVG path of the dividing lines: cell edges where the owners differ.
   *  Same-owner internal edges and viewport-hull edges are omitted. */
  boundaries: string
}

type Project = (lonlat: [number, number]) => [number, number] | null

/** One seed per island part: the projected centroid of each polygon's outer
 *  ring, biggest parts first, capped and de-duplicated per country. */
export function parcelSeeds(
  features: CountryFeature[],
  project: Project,
  width: number,
  height: number,
): ParcelSeed[] {
  const out: ParcelSeed[] = []
  for (const f of features) {
    const polygons =
      f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates
    const parts: { x: number; y: number; area: number }[] = []
    for (const rings of polygons) {
      let ring = rings[0]
      if (!ring || ring.length < 3) continue
      // GeoJSON rings repeat the first vertex to close; drop the duplicate
      // so the centroid is a true vertex mean rather than skewed toward it.
      const first = ring[0]!
      const last = ring[ring.length - 1]!
      if (first[0] === last[0] && first[1] === last[1]) ring = ring.slice(0, -1)
      let sx = 0
      let sy = 0
      let n = 0
      let area = 0
      let prev: [number, number] | null = null
      let head: [number, number] | null = null
      for (const v of ring) {
        const p = project(v as [number, number])
        if (!p) continue
        sx += p[0]
        sy += p[1]
        n += 1
        if (prev) area += prev[0] * p[1] - p[0] * prev[1]
        else head = p
        prev = p
      }
      if (n < 3) continue
      // Close the shoelace back to the first vertex.
      if (prev && head) area += prev[0] * head[1] - head[0] * prev[1]
      parts.push({ x: sx / n, y: sy / n, area: Math.abs(area / 2) })
    }
    parts.sort((a, b) => b.area - a.area)

    const kept: { x: number; y: number }[] = []
    for (const part of parts) {
      if (kept.length >= MAX_SEEDS_PER_COUNTRY) break
      if (
        part.x < -OFFSCREEN_MARGIN_PX ||
        part.x > width + OFFSCREEN_MARGIN_PX ||
        part.y < -OFFSCREEN_MARGIN_PX ||
        part.y > height + OFFSCREEN_MARGIN_PX
      )
        continue
      if (kept.some((k) => Math.hypot(k.x - part.x, k.y - part.y) < SEED_MERGE_PX)) continue
      kept.push({ x: part.x, y: part.y })
    }
    for (const k of kept) out.push({ iso3: f.properties.iso3, x: k.x, y: k.y })
  }
  return out
}

/** Round for edge keying: cells sharing an edge must produce identical keys
 *  from both sides, and Voronoi vertices are exact from both, so a coarse
 *  half-pixel round is only insurance against float noise. */
const keyOf = (a: [number, number], b: [number, number]): string => {
  const pt = (p: [number, number]) => `${Math.round(p[0] * 2)},${Math.round(p[1] * 2)}`
  const ka = pt(a)
  const kb = pt(b)
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`
}

export function computeParcels(seeds: ParcelSeed[], width: number, height: number): Parcels | null {
  if (seeds.length < 2) return null
  const delaunay = Delaunay.from(
    seeds,
    (s) => s.x,
    (s) => s.y,
  )
  const voronoi = delaunay.voronoi([0, 0, width, height])

  const cells: ParcelCell[] = []
  const edges = new Map<string, { a: [number, number]; b: [number, number]; owners: Set<string> }>()
  for (let i = 0; i < seeds.length; i++) {
    const polygon = voronoi.cellPolygon(i) as [number, number][] | null
    if (!polygon) continue
    cells.push({ iso3: seeds[i]!.iso3, polygon })
    for (let v = 0; v < polygon.length - 1; v++) {
      const a = polygon[v]!
      const b = polygon[v + 1]!
      const key = keyOf(a, b)
      const entry = edges.get(key) ?? { a, b, owners: new Set<string>() }
      entry.owners.add(seeds[i]!.iso3)
      edges.set(key, entry)
    }
  }

  // Only edges seen from two different owners divide anything: same-owner
  // pairs are internal to a lobed cell, single-sighted edges lie on the
  // viewport hull.
  let boundaries = ''
  for (const e of edges.values()) {
    if (e.owners.size >= 2) {
      boundaries += `M${e.a[0].toFixed(1)},${e.a[1].toFixed(1)}L${e.b[0].toFixed(1)},${e.b[1].toFixed(1)}`
    }
  }

  return { seeds, cells, boundaries }
}

/** The owner of the nearest seed, if any lies within `maxDistPx` (screen
 *  pixels; the caller scales base-coordinate distance by the live zoom). */
export function nearestParcel(
  seeds: ParcelSeed[],
  x: number,
  y: number,
  scale: number,
  maxDistPx: number,
  canPick: (iso3: string) => boolean = () => true,
): string | null {
  let best: { iso3: string; dist: number } | null = null
  for (const s of seeds) {
    if (!canPick(s.iso3)) continue
    const dist = Math.hypot(s.x - x, s.y - y) * scale
    if (dist <= maxDistPx && (!best || dist < best.dist)) best = { iso3: s.iso3, dist }
  }
  return best?.iso3 ?? null
}
