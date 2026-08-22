import { useEffect, useMemo, useRef, useState } from 'react'
import { geoPath } from 'd3-geo'
import { loadGeometry, loadIndex, type CountryFeature, type CountryIndex } from '../data/load'
import { mainland, makeProjection, type MapView } from './projection'
import { terrainLayerUrl } from './terrain'

/** How a country is painted. Everything not listed renders as neutral land. */
export type MarkRole = 'target' | 'correct' | 'wrong' | 'context'

/** A point-of-interest dot (cities). Rendered above fills, below labels. */
export interface CityMark {
  lonlat: [number, number]
  role: MarkRole
  label?: string
}

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
/** Minimum separation between two rendered labels before the later one is
 *  dropped. Wider than tall because names are wide and short. */
const LABEL_MIN_GAP_X = 54
const LABEL_MIN_GAP_Y = 14

const MAX_ZOOM = 8
const WHEEL_SENSITIVITY = 0.0022

/**
 * The map owns its own pan/zoom instead of leaving pinch to the browser.
 * Page-level pinch zoom was the original behaviour, and it made small
 * countries a trap: zoom the page in to tap Monaco, answer, and the reveal
 * replaces the question while the page is still magnified into a corner with
 * no obvious way back. An in-map transform never outlives its map — every card
 * starts at 1:1 — and a reset control is always in reach.
 */
export interface MapTransform {
  k: number
  x: number
  y: number
}

export const IDENTITY: MapTransform = { k: 1, x: 0, y: 0 }

/** Clamp scale to [1, MAX_ZOOM] and translation so the map always covers the
 *  viewport — no gap can open at any edge, and k=1 is always exactly home. */
export function clampTransform(tf: MapTransform, width: number, height: number): MapTransform {
  const k = Math.min(MAX_ZOOM, Math.max(1, tf.k))
  return {
    k,
    x: Math.min(0, Math.max(width - width * k, tf.x)),
    y: Math.min(0, Math.max(height - height * k, tf.y)),
  }
}

/** Rescale around a fixed screen point, so the spot under the cursor or pinch
 *  midpoint stays put while everything grows around it. */
export function zoomAround(
  tf: MapTransform,
  cx: number,
  cy: number,
  nextK: number,
  width: number,
  height: number,
): MapTransform {
  const k = Math.min(MAX_ZOOM, Math.max(1, nextK))
  return clampTransform(
    { k, x: cx - ((cx - tf.x) * k) / tf.k, y: cy - ((cy - tf.y) * k) / tf.k },
    width,
    height,
  )
}

interface GeoMapProps {
  view: MapView
  marks?: Record<string, MarkRole>
  /** Raw per-country fill colours (choropleths). A mark always wins over a
   *  fill, so answer feedback stays visible on a shaded map. */
  fills?: Record<string, string>
  /** Opacity of internal country borders, 0–1. At 0 the land is a single
   *  silhouette with only the coastline (the fill's edge against the ocean).
   *  Marked countries keep full-strength feedback regardless. Default 1. */
  borderOpacity?: number
  /** ISO3 codes to label. */
  labels?: string[]
  onPick?: (iso3: string) => void
  /** Countries that may be picked. Others render but ignore clicks. */
  pickable?: Set<string>
  /** City dots to draw (city cards and their reveals). */
  cityMarks?: CityMark[]
  /** With onPickPoint: the lon/lat the tap is measured against. */
  pointTarget?: [number, number]
  /** Free-point picking (city-locate): every tap reports where it landed and
   *  how far, in screen pixels, from pointTarget — zooming in tightens the
   *  requirement exactly like the country snap zones fade. */
  onPickPoint?: (result: { lonlat: [number, number]; screenDistPx: number }) => void
  /** Draw the reprojected satellite base layer under the countries (#5).
   *  Land fills go transparent so terrain shows through; marks, choropleth
   *  fills, and hit-testing are unaffected. */
  terrain?: boolean
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

/** Border linework over satellite imagery: a light ink, at well under full
 *  opacity so it reads as map lines rather than a lattice pasted on top.
 *  borderOpacity still multiplies in, so mastery fades it to nothing. */
const TERRAIN_BORDER = '#dbe5f2'
const TERRAIN_BORDER_ALPHA = 0.65

export function GeoMap({ view, marks, fills, labels, onPick, pickable, cityMarks, pointTarget, onPickPoint, terrain, className, borderOpacity = 1 }: GeoMapProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const { width, height } = useSize(wrapRef)
  const [geo, setGeo] = useState<Map<string, CountryFeature> | null>(null)
  const [index, setIndex] = useState<CountryIndex | null>(null)
  const pressRef = useRef<{ x: number; y: number } | null>(null)

  const [tf, setTf] = useState<MapTransform>(IDENTITY)
  /** Authoritative transform for gesture math; state lags a frame behind. */
  const tfRef = useRef(tf)
  /** Live pointers, for distinguishing pan from pinch. */
  const pointersRef = useRef(new Map<number, { x: number; y: number }>())
  /** Baseline captured when the pointer set changes; deltas apply against it. */
  const gestureRef = useRef<{
    tf: MapTransform
    mid: { x: number; y: number }
    dist: number
    captured: boolean
  } | null>(null)
  /** A pinch fires a stray click on some browsers; swallow it. */
  const suppressClickRef = useRef(false)

  const applyTf = (next: MapTransform) => {
    const clamped = clampTransform(next, width, height)
    tfRef.current = clamped
    setTf(clamped)
  }

  const localPoint = (e: { clientX: number; clientY: number }) => {
    const rect = wrapRef.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const rebaseGesture = () => {
    const pts = [...pointersRef.current.values()]
    if (pts.length === 0) {
      gestureRef.current = null
      return
    }
    const mid =
      pts.length >= 2
        ? { x: (pts[0]!.x + pts[1]!.x) / 2, y: (pts[0]!.y + pts[1]!.y) / 2 }
        : { ...pts[0]! }
    const dist = pts.length >= 2 ? Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y) : 0
    gestureRef.current = {
      tf: tfRef.current,
      mid,
      dist,
      captured: gestureRef.current?.captured ?? false,
    }
  }

  /**
   * Pointer capture is taken lazily — only once a drag exceeds slop or a
   * second finger lands. Capturing on every press retargets the eventual
   * click to the wrapper, which means the SVG's click handler never fires
   * and no tap can answer a card. A plain tap must stay uncaptured.
   */
  const capture = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current
    if (!g || g.captured) return
    for (const id of pointersRef.current.keys()) {
      try {
        e.currentTarget.setPointerCapture(id)
      } catch {
        /* pointer already gone */
      }
    }
    g.captured = true
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if ((e.target as Element).closest?.('.zoom-reset')) return
    pointersRef.current.set(e.pointerId, localPoint(e))
    if (pointersRef.current.size === 1) {
      pressRef.current = { x: e.clientX, y: e.clientY }
      suppressClickRef.current = false
    } else {
      suppressClickRef.current = true
    }
    rebaseGesture()
    // Two fingers is unambiguously a gesture; one finger might be a tap.
    if (pointersRef.current.size >= 2) capture(e)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(e.pointerId)) return
    pointersRef.current.set(e.pointerId, localPoint(e))
    const g = gestureRef.current
    if (!g) return

    const pts = [...pointersRef.current.values()]
    if (pts.length === 1) {
      const dx = pts[0]!.x - g.mid.x
      const dy = pts[0]!.y - g.mid.y
      // Below slop this is still possibly a tap; leave it uncaptured and
      // unmoved so the click, if it comes, lands on the country.
      if (!g.captured && Math.hypot(dx, dy) <= DRAG_SLOP_PX) return
      capture(e)
      // Pan. Harmless at k=1 — the clamp pins translation to zero there.
      applyTf({ k: g.tf.k, x: g.tf.x + dx, y: g.tf.y + dy })
    } else if (g.dist > 0) {
      const dist = Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y)
      const mid = { x: (pts[0]!.x + pts[1]!.x) / 2, y: (pts[0]!.y + pts[1]!.y) / 2 }
      const scaled = zoomAround(g.tf, g.mid.x, g.mid.y, (g.tf.k * dist) / g.dist, width, height)
      applyTf({ k: scaled.k, x: scaled.x + (mid.x - g.mid.x), y: scaled.y + (mid.y - g.mid.y) })
    }
  }

  const onPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(e.pointerId)
    rebaseGesture()
  }

  // Wheel zoom, attached by hand: React registers wheel listeners passively,
  // and a passive listener cannot preventDefault, so the page would scroll
  // while the map zooms underneath it.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const cur = tfRef.current
      const next = zoomAround(
        cur,
        e.clientX - rect.left,
        e.clientY - rect.top,
        cur.k * Math.exp(-e.deltaY * WHEEL_SENSITIVITY),
        width,
        height,
      )
      tfRef.current = next
      setTf(next)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [width, height])

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
        : view.kind === 'country'
          ? [geo.get(view.iso3)].filter((f): f is CountryFeature => !!f)
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

  /**
   * Greedy label placement: the requested order wins, and any later label whose
   * anchor falls too close to one already placed is dropped. Small neighbours
   * cluster tightly — Suriname and Guyana sit within a few pixels of each other
   * at region zoom — and overlapping text is less useful than one clear label.
   */
  const placedLabels = useMemo(() => {
    if (!scene || !labels?.length) return []
    const out: { iso3: string; s: (typeof scene.shapes)[number] }[] = []
    for (const iso3 of labels) {
      const s = scene.shapes.find((x) => x.iso3 === iso3)
      if (!s?.hasCentroid) continue
      const clash = out.some(
        (o) => Math.abs(o.s.cx - s.cx) < LABEL_MIN_GAP_X && Math.abs(o.s.cy - s.cy) < LABEL_MIN_GAP_Y,
      )
      if (!clash) out.push({ iso3, s })
    }
    return out
  }, [scene, labels])

  /** Object URL of the reprojected satellite layer for the current view.
   *  Rendered off-thread of the interaction path and cached across the
   *  per-card GeoMap remounts, so only the first view of a region pays. */
  const [terrainUrl, setTerrainUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!terrain || !scene) {
      setTerrainUrl(null)
      return
    }
    let live = true
    const key =
      view.kind === 'world' ? 'world' : view.kind === 'country' ? `country:${view.iso3}` : `region:${view.slug}`
    terrainLayerUrl(key, scene.projection, width, height)
      .then((url) => live && setTerrainUrl(url))
      .catch(() => live && setTerrainUrl(null))
    return () => {
      live = false
    }
  }, [terrain, scene, view, width, height])

  const canPick = (iso3: string) => !!onPick && (!pickable || pickable.has(iso3))

  /**
   * All picking runs through the SVG so snapping is resolved before falling
   * back to whichever polygon was actually under the cursor.
   */
  const handleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if ((!onPick && !onPickPoint) || !scene) return
    if (suppressClickRef.current) return

    const start = pressRef.current
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > DRAG_SLOP_PX) return

    const rect = e.currentTarget.getBoundingClientRect()
    // Scene geometry lives in base (unzoomed) coordinates; invert the transform.
    const x = (e.clientX - rect.left - tf.x) / tf.k
    const y = (e.clientY - rect.top - tf.y) / tf.k

    if (onPickPoint) {
      const lonlat = scene.projection.invert?.([x, y])
      const target = pointTarget ? scene.projection(pointTarget) : null
      if (lonlat && target) {
        onPickPoint({
          lonlat: lonlat as [number, number],
          screenDistPx: Math.hypot(target[0] - x, target[1] - y) * tf.k,
        })
      }
      return
    }

    // Snap distances compare in screen pixels, so zooming in shrinks the snap
    // zones on the ground: the assist fades out exactly as it stops being
    // needed, and a zoomed-in tap lands where it visibly points.
    let best: { iso3: string; dist: number } | null = null
    for (const s of scene.snaps) {
      const dist = Math.hypot(s.cx - x, s.cy - y) * tf.k
      if (dist <= s.radius && (!best || dist < best.dist) && canPick(s.iso3)) {
        best = { iso3: s.iso3, dist }
      }
    }
    if (best) return onPick?.(best.iso3)

    const hit = (e.target as Element).closest?.('[data-iso3]')?.getAttribute('data-iso3')
    if (hit && canPick(hit)) onPick?.(hit)
  }

  return (
    <div
      ref={wrapRef}
      className={className}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      style={{ width: '100%', height: '100%', touchAction: 'none', position: 'relative' }}
    >
      {scene && (
        <svg
          width={width}
          height={height}
          onClick={handleClick}
          style={{ display: 'block', cursor: onPick || onPickPoint ? 'pointer' : 'default' }}
        >
          <rect width={width} height={height} fill="var(--ocean)" />

          <g transform={`translate(${tf.x},${tf.y}) scale(${tf.k})`}>
          {terrain && terrainUrl && (
            <image
              href={terrainUrl}
              x={0}
              y={0}
              width={width}
              height={height}
              preserveAspectRatio="none"
              pointerEvents="none"
            />
          )}
          <g>
            {scene.shapes.map((s) => {
              const onTerrain = !!(terrain && terrainUrl)
              // Over terrain the land itself is the imagery; a transparent
              // fill (never 'none') keeps the polygon clickable.
              const fill = marks?.[s.iso3]
                ? ROLE_FILL[marks[s.iso3]!]
                : (fills?.[s.iso3] ?? (onTerrain ? 'transparent' : 'var(--land)'))
              return (
                <path
                  key={s.iso3}
                  data-iso3={s.iso3}
                  d={s.d}
                  fill={fill}
                  // Satellite imagery is dark and busy, so borders over it
                  // follow the cartographic convention for imagery: light
                  // linework, slightly wider than the flat map's hairline —
                  // a dark stroke simply vanishes into the tinted terrain.
                  stroke={onTerrain ? TERRAIN_BORDER : 'var(--border)'}
                  // On plain land, fading blends the stroke toward the land
                  // colour rather than using opacity: adjacent fills leave
                  // anti-aliasing seams, and a transparent stroke lets the
                  // ocean grin through them as ghost borders. A land-coloured
                  // stroke seals the seams while being invisible — and it
                  // widens as it fades, because a hairline is not enough paint
                  // to cover the seam it hides. Over terrain the fills are
                  // transparent, there are no seams, and plain stroke opacity
                  // is the honest fade — same mastery signal, different medium.
                  strokeWidth={onTerrain ? 0.8 : 0.5 + (1 - borderOpacity) * 1.1}
                  strokeOpacity={onTerrain ? borderOpacity * TERRAIN_BORDER_ALPHA : undefined}
                  vectorEffect="non-scaling-stroke"
                  style={
                    !onTerrain && borderOpacity < 1
                      ? { stroke: `color-mix(in srgb, var(--border) ${Math.round(borderOpacity * 100)}%, var(--land))` }
                      : undefined
                  }
                />
              )
            })}
          </g>

          {cityMarks && cityMarks.length > 0 && (
            <g pointerEvents="none">
              {(() => {
                // Greedy label placement, earlier marks winning: the target
                // city is always listed first, so a crowded coast (New York
                // beside Washington) drops the context label, never the answer.
                const kept: { x: number; y: number }[] = []
                return cityMarks.map((m, i) => {
                  const p = scene.projection(m.lonlat)
                  if (!p) return null
                  let showLabel = !!m.label
                  if (showLabel) {
                    const clash = kept.some(
                      (o) => Math.abs(o.x - p[0]) < LABEL_MIN_GAP_X && Math.abs(o.y - p[1]) < LABEL_MIN_GAP_Y * 2,
                    )
                    if (clash) showLabel = false
                    else kept.push({ x: p[0], y: p[1] })
                  }
                  return (
                    <g key={i}>
                      <circle
                        cx={p[0]}
                        cy={p[1]}
                        r={5.5 / tf.k}
                        fill={ROLE_FILL[m.role]}
                        stroke="var(--ocean)"
                        strokeWidth={1.5 / tf.k}
                      />
                      {showLabel && (
                        <text
                          x={p[0]}
                          y={p[1] - 11 / tf.k}
                          textAnchor="middle"
                          fontSize={11 / tf.k}
                          fontWeight={600}
                          fill="var(--label)"
                          stroke="var(--ocean)"
                          strokeWidth={3 / tf.k}
                          paintOrder="stroke"
                        >
                          {m.label}
                        </text>
                      )}
                    </g>
                  )
                })
              })()}
            </g>
          )}

          {/* Visible dots for countries whose polygon is too small to see. */}
          {/* Dots and labels counter-scale by 1/k to hold constant screen
              size — text ballooning to 8x is worse than useless. */}
          <g pointerEvents="none">
            {scene.shapes
              .filter((s) => s.hasCentroid && s.extent * tf.k < MIN_VISIBLE_PX)
              .map((s) => (
                <circle
                  key={s.iso3}
                  cx={s.cx}
                  cy={s.cy}
                  r={3 / tf.k}
                  fill={marks?.[s.iso3] ? ROLE_FILL[marks[s.iso3]!] : (fills?.[s.iso3] ?? 'var(--land)')}
                  stroke="var(--border)"
                  strokeWidth={0.5 / tf.k}
                  opacity={marks?.[s.iso3] ? 1 : borderOpacity}
                />
              ))}
          </g>

          <g pointerEvents="none">
            {placedLabels.map(({ iso3, s }) => {
              const name = index?.byIso3.get(iso3)?.name ?? iso3
              return (
                <text
                  key={iso3}
                  x={s.cx}
                  y={s.cy - (s.extent * tf.k < MIN_VISIBLE_PX ? 8 / tf.k : 0)}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={11 / tf.k}
                  fontWeight={600}
                  fill="var(--label)"
                  stroke="var(--ocean)"
                  strokeWidth={3 / tf.k}
                  paintOrder="stroke"
                >
                  {name}
                </text>
              )
            })}
          </g>
          </g>
        </svg>
      )}

      {tf.k > 1.01 && (
        <button
          type="button"
          className="zoom-reset"
          onClick={(e) => {
            e.stopPropagation()
            applyTf(IDENTITY)
          }}
        >
          ⤢ 1:1
        </button>
      )}
    </div>
  )
}
