import { useEffect, useMemo, useRef, useState } from 'react'
import { geoPath } from 'd3-geo'
import { loadGeometry, loadIndex, type CountryFeature, type CountryIndex } from '../data/load'
import { mainland, makeProjection, type MapView } from './projection'

/** How a country is painted. Everything not listed renders as neutral land. */
export type MarkRole = 'target' | 'correct' | 'wrong' | 'context'

const ROLE_FILL: Record<MarkRole, string> = {
  target: '#f59e0b',
  correct: '#22c55e',
  wrong: '#ef4444',
  context: '#475569',
}

/**
 * Smallest projected extent, in CSS pixels, at which a country can be tapped
 * reliably. Below this we snap clicks to the nearest centroid, so Singapore is
 * as clickable as Kazakhstan — without it, roughly a sixth of the world is
 * unanswerable on a phone.
 */
const MIN_TAP_PX = 40
/** Below this projected extent we also draw a visible dot, since the polygon
 *  itself is too small to see. */
const MIN_VISIBLE_PX = 6
/** Movement beyond this between pointerdown and click counts as a pan, not a
 *  pick — otherwise dragging the map answers the question. */
const DRAG_SLOP_PX = 8
/** A snap zone never grows past this share of the gap to the next centroid, so
 *  a micro-state cannot swallow clicks aimed at its neighbour. */
const CROWDING_FACTOR = 0.45
const MIN_SNAP_PX = 5

interface GeoMapProps {
  view: MapView
  marks?: Record<string, MarkRole>
  /** ISO3 codes to label. */
  labels?: string[]
  onPick?: (iso3: string) => void
  /** Countries that may be picked. Others render but ignore clicks. */
  pickable?: Set<string>
  className?: string
}

function useSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return
      const { width, height } = entry.contentRect
      setSize({ width, height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return size
}

export function GeoMap({ view, marks, labels, onPick, pickable, className }: GeoMapProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const { width, height } = useSize(wrapRef)
  const [geo, setGeo] = useState<Map<string, CountryFeature> | null>(null)
  const [index, setIndex] = useState<CountryIndex | null>(null)
  const pressRef = useRef<{ x: number; y: number } | null>(null)

  // The world view uses the coarse topology (fast, and its 29 missing
  // microstates are sub-pixel there anyway); region views use the detailed one.
  const resolution = view.kind === 'world' ? '110m' : '50m'

  useEffect(() => {
    let live = true
    Promise.all([loadGeometry(resolution), loadIndex()]).then(([g, i]) => {
      if (live) {
        setGeo(g)
        setIndex(i)
      }
    })
    return () => {
      live = false
    }
  }, [resolution])

  const scene = useMemo(() => {
    if (!geo || !index || width < 2 || height < 2) return null

    const inView: CountryFeature[] =
      view.kind === 'world'
        ? [...geo.values()]
        : (index.regionBySlug.get(view.slug)?.countries ?? [])
            .map((iso3) => geo.get(iso3))
            .filter((f): f is CountryFeature => !!f)

    const projection = makeProjection(view, inView, width, height)
    const path = geoPath(projection)

    // Region views still draw surrounding countries so the region has context
    // and does not float in a void, but only those actually on screen.
    const drawn: CountryFeature[] = []
    for (const f of geo.values()) {
      const b = path.bounds(f)
      const offscreen =
        !Number.isFinite(b[0][0]) || b[1][0] < 0 || b[0][0] > width || b[1][1] < 0 || b[0][1] > height
      if (!offscreen) drawn.push(f)
    }

    const shapes = drawn.map((f) => {
      // Size and position come from the mainland, never the full geometry.
      // Natural Earth folds overseas territories into the parent country, so
      // France's full centroid sits in the Atlantic and Fiji's lands on
      // Tuvalu; and Kiribati's scattered islands would otherwise measure as one
      // Pacific-wide shape and never qualify for a snap zone despite every
      // individual island being untappable.
      const main = mainland(f)
      const b = path.bounds(main)
      const extent = Math.max(b[1][0] - b[0][0], b[1][1] - b[0][1])

      const record = index.byIso3.get(f.properties.iso3)
      const anchor = record ? projection(record.labelPoint) : null
      const [fx, fy] = anchor ?? path.centroid(main)

      return {
        iso3: f.properties.iso3,
        d: path(f) ?? '',
        cx: fx,
        cy: fy,
        extent,
        hasCentroid: Number.isFinite(fx) && Number.isFinite(fy),
      }
    })

    /**
     * Click snapping for countries too small to hit directly.
     *
     * Fixed-size hit circles do not work: at world scale over 200 of them
     * overlap, and whichever happens to render last silently wins. Instead each
     * small country gets a snap radius bounded by the distance to its nearest
     * neighbour, and a click resolves to the nearest centroid whose radius
     * contains it. Crowded areas shrink automatically, so tapping France stays
     * possible with Monaco alongside it.
     */
    const placed = shapes.filter((s) => s.hasCentroid)
    const snaps = shapes
      .filter((s) => s.hasCentroid && s.extent < MIN_TAP_PX)
      .map((s) => {
        let nearest = Infinity
        for (const other of placed) {
          if (other === s) continue
          nearest = Math.min(nearest, Math.hypot(other.cx - s.cx, other.cy - s.cy))
        }
        const radius = Number.isFinite(nearest)
          ? Math.max(MIN_SNAP_PX, Math.min(MIN_TAP_PX / 2, nearest * CROWDING_FACTOR))
          : MIN_TAP_PX / 2
        return { iso3: s.iso3, cx: s.cx, cy: s.cy, radius }
      })

    return { projection, path, shapes, snaps }
  }, [geo, index, view, width, height])

  const canPick = (iso3: string) => !!onPick && (!pickable || pickable.has(iso3))

  /**
   * All picking runs through the SVG so snapping is resolved before falling
   * back to whichever polygon was actually under the cursor.
   */
  const handleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!onPick || !scene) return

    const start = pressRef.current
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > DRAG_SLOP_PX) return

    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top

    let best: { iso3: string; dist: number } | null = null
    for (const s of scene.snaps) {
      const dist = Math.hypot(s.cx - x, s.cy - y)
      if (dist <= s.radius && (!best || dist < best.dist) && canPick(s.iso3)) {
        best = { iso3: s.iso3, dist }
      }
    }
    if (best) return onPick(best.iso3)

    const hit = (e.target as Element).closest?.('[data-iso3]')?.getAttribute('data-iso3')
    if (hit && canPick(hit)) onPick(hit)
  }

  return (
    <div
      ref={wrapRef}
      className={className}
      onPointerDown={(e) => (pressRef.current = { x: e.clientX, y: e.clientY })}
      style={{ width: '100%', height: '100%', touchAction: 'manipulation' }}
    >
      {scene && (
        <svg
          width={width}
          height={height}
          onClick={handleClick}
          style={{ display: 'block', cursor: onPick ? 'pointer' : 'default' }}
        >
          <rect width={width} height={height} fill="var(--ocean)" />

          <g>
            {scene.shapes.map((s) => (
              <path
                key={s.iso3}
                data-iso3={s.iso3}
                d={s.d}
                fill={marks?.[s.iso3] ? ROLE_FILL[marks[s.iso3]!] : 'var(--land)'}
                stroke="var(--border)"
                strokeWidth={0.5}
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </g>

          {/* Visible dots for countries whose polygon is too small to see. */}
          <g pointerEvents="none">
            {scene.shapes
              .filter((s) => s.hasCentroid && s.extent < MIN_VISIBLE_PX)
              .map((s) => (
                <circle
                  key={s.iso3}
                  cx={s.cx}
                  cy={s.cy}
                  r={3}
                  fill={marks?.[s.iso3] ? ROLE_FILL[marks[s.iso3]!] : 'var(--land)'}
                  stroke="var(--border)"
                  strokeWidth={0.5}
                />
              ))}
          </g>

          <g pointerEvents="none">
            {labels?.map((iso3) => {
              const s = scene.shapes.find((x) => x.iso3 === iso3)
              if (!s?.hasCentroid) return null
              const name = index?.byIso3.get(iso3)?.name ?? iso3
              return (
                <text
                  key={iso3}
                  x={s.cx}
                  y={s.cy - (s.extent < MIN_VISIBLE_PX ? 8 : 0)}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={11}
                  fontWeight={600}
                  fill="var(--label)"
                  stroke="var(--ocean)"
                  strokeWidth={3}
                  paintOrder="stroke"
                >
                  {name}
                </text>
              )
            })}
          </g>
        </svg>
      )}
    </div>
  )
}
