import { geoPath } from 'd3-geo'
import type { CountryIndex, CountryFeature } from '../data/load'
import { loadGeometry } from '../data/load'
import { makeProjection } from '../map/projection'
import { recallFill } from '../map/colors'
import { buildOutlook } from '../stats/outlook'
import type { StudySnapshot } from '../store/store'

/**
 * The share card (#4): a 1200×630 image — the standard rich-embed shape — of
 * the mastery choropleth with a headline. It is drawn from scratch rather
 * than serialised from the live map DOM: the app's SVG leans on CSS custom
 * properties that die outside the document, and a card wants a designed
 * layout, not a screenshot.
 *
 * Discord and friends unfurl links by fetching them, so a static site can
 * never show per-user progress in a link preview — the crawler cannot see
 * localStorage. Sharing the rendered image itself sidesteps that: a shared
 * PNG displays natively everywhere.
 */

export const APP_URL = 'https://geography-bee-three.vercel.app'

/** The night-atlas palette as literals: CSS variables do not exist inside a
 *  standalone SVG rendered through an <img> element. */
const C = {
  bg: '#0a101f',
  ocean: '#0b1220',
  land: '#334155',
  border: '#0b1220',
  text: '#e6ecf5',
  muted: '#90a3c0',
  accent: '#f5a821',
}

const SERIF = "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif"
const SANS = "system-ui, -apple-system, 'Segoe UI', sans-serif"

export const CARD_W = 1200
export const CARD_H = 630

export interface CardContent {
  /** Big line under the wordmark: the hero stat, or a tagline. */
  headline: string
  /** Quieter line under the headline. */
  subline: string
  paths: { d: string; fill: string }[]
  /** Path outlining the globe (the projection's sphere). */
  sphere: string
  legend: { label: string; fill: string }[] | null
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Compose the card as an SVG string. Pure: everything projected is already
 *  in `content`, so tests need no DOM and no geometry. */
export function buildShareCardSvg(content: CardContent): string {
  const legend = content.legend
    ? content.legend
        .map(({ label, fill }, i) => {
          const x = 48 + i * 150
          return (
            `<rect x="${x}" y="${CARD_H - 58}" width="18" height="18" rx="5" fill="${fill}"/>` +
            `<text x="${x + 26}" y="${CARD_H - 43}" font-family="${SANS}" font-size="17" fill="${C.muted}">${esc(label)}</text>`
          )
        })
        .join('')
    : ''

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}">` +
    `<rect width="${CARD_W}" height="${CARD_H}" fill="${C.bg}"/>` +
    `<path d="${content.sphere}" fill="${C.ocean}"/>` +
    content.paths.map((p) => `<path d="${p.d}" fill="${p.fill}" stroke="${C.border}" stroke-width="0.5"/>`).join('') +
    // Text sits above the map's empty upper corners; a soft scrim keeps it
    // legible if land drifts underneath (labels wear ink, never map colour).
    `<rect width="${CARD_W}" height="150" fill="${C.bg}" opacity="0.55"/>` +
    `<text x="48" y="64" font-family="${SERIF}" font-size="40" font-weight="600" fill="${C.text}">Geography Bee</text>` +
    `<text x="48" y="112" font-family="${SANS}" font-size="30" font-weight="650" fill="${C.accent}">${esc(content.headline)}</text>` +
    `<text x="48" y="142" font-family="${SANS}" font-size="19" fill="${C.muted}">${esc(content.subline)}</text>` +
    legend +
    `<text x="${CARD_W - 48}" y="${CARD_H - 43}" text-anchor="end" font-family="${SANS}" font-size="17" fill="${C.muted}">${esc(APP_URL.replace('https://', ''))}</text>` +
    `</svg>`
  )
}

/** Project the world into the card's map area and colour it. */
export function worldPaths(
  geo: Map<string, CountryFeature>,
  fills: Record<string, string>,
): Pick<CardContent, 'paths' | 'sphere'> {
  const features = [...geo.values()]
  const projection = makeProjection({ kind: 'world' }, features, CARD_W, CARD_H + 210)
  const path = geoPath(projection)
  return {
    // The projection fits a taller box, then the map is nudged up so the
    // sphere's midriff fills the card and the empty poles hang off-frame.
    sphere: path({ type: 'Sphere' }) ?? '',
    paths: features.map((f) => ({
      d: path(f) ?? '',
      fill: fills[f.properties.iso3] ?? C.land,
    })),
  }
}

/** Assemble the learner's live progress card content. */
export async function progressCardContent(
  index: CountryIndex,
  snapshot: StudySnapshot,
  now: Date,
): Promise<CardContent> {
  const geo = await loadGeometry('110m')
  const outlook = buildOutlook(index, snapshot, now)

  const fills: Record<string, string> = {}
  let seen = 0
  for (const [iso3, s] of outlook.countries) {
    if (s.seen) seen++
    const fill = recallFill(s.recall, s.seen)
    if (fill) fills[iso3] = fill
  }

  const total = index.bundle.countries.length
  return {
    ...worldPaths(geo, fills),
    headline: `${outlook.overall.mastered} of ${total} countries solidly placed`,
    subline: `${seen} met so far · ${now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`,
    legend: [
      { label: 'unseen', fill: C.land },
      { label: 'fading', fill: recallFill(0.2, true)! },
      { label: 'holding', fill: recallFill(0.6, true)! },
      { label: 'solid', fill: recallFill(1, true)! },
    ],
  }
}

/** Rasterise the SVG at 2x for retina-crisp embeds. Browser-only. */
export function svgToPngBlob(svg: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      const canvas = document.createElement('canvas')
      canvas.width = CARD_W * 2
      canvas.height = CARD_H * 2
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png')
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('share card SVG failed to render'))
    }
    img.src = url
  })
}
