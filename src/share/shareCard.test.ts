import { describe, expect, it } from 'vitest'
import { loadCommittedBundle, loadCommittedGeometry } from '../../scripts/geo-node'
import { buildShareCardSvg, CARD_H, CARD_W, worldPaths } from './shareCard'

const bundle = loadCommittedBundle()
const geo = loadCommittedGeometry(bundle)

describe('share card', () => {
  it('projects every country into the card', () => {
    const { paths, sphere } = worldPaths(geo, { PER: 'hsl(76, 48%, 34%)' })
    expect(paths.length).toBe(geo.size)
    expect(sphere.length).toBeGreaterThan(10)
    // The requested fill survives; everything else gets the neutral land.
    const fills = new Set(paths.map((p) => p.fill))
    expect(fills.has('hsl(76, 48%, 34%)')).toBe(true)
    expect(fills.has('#334155')).toBe(true)
  })

  it('renders a standalone SVG with no CSS custom properties', () => {
    const svg = buildShareCardSvg({
      ...worldPaths(geo, {}),
      headline: '12 of 195 countries solidly placed',
      subline: '30 met so far',
      legend: [{ label: 'unseen', fill: '#334155' }],
    })
    expect(svg).toContain(`width="${CARD_W}" height="${CARD_H}"`)
    expect(svg).toContain('12 of 195 countries solidly placed')
    expect(svg).toContain('unseen')
    expect(svg).toContain('geography-bee-three.vercel.app')
    // A detached SVG rendered through <img> cannot resolve CSS variables.
    expect(svg).not.toContain('var(')
  })

  it('escapes markup-significant characters in text', () => {
    const svg = buildShareCardSvg({
      ...worldPaths(geo, {}),
      headline: 'Fish & Chips <3',
      subline: '"quoted"',
      legend: null,
    })
    expect(svg).toContain('Fish &amp; Chips &lt;3')
    expect(svg).toContain('&quot;quoted&quot;')
  })
})
