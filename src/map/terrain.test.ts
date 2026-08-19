import { describe, expect, it } from 'vitest'
import { reprojectTerrain, viewBounds, type RasterWindow } from './terrain'

/**
 * A synthetic whole-world window: the western hemisphere solid red, the
 * eastern solid blue. Sampling through a projection stub then checks pixels
 * land in the right hemisphere without any real imagery.
 */
function hemisphereWindow(): RasterWindow {
  const width = 8
  const height = 4
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      data[i] = x < width / 2 ? 255 : 0 // red west
      data[i + 2] = x < width / 2 ? 0 : 255 // blue east
      data[i + 3] = 255
    }
  }
  return { data, width, height, lonLeft: -180, latTop: 90, degPerPxX: 360 / width, degPerPxY: 180 / height }
}

/** Linear plate carrée over a w×h viewport, shaped like a d3 projection. */
function fakeProjection(w: number, h: number) {
  const project = (ll: [number, number]): [number, number] => [
    ((ll[0] + 180) / 360) * w,
    ((90 - ll[1]) / 180) * h,
  ]
  const projection = project as typeof project & { invert: (xy: [number, number]) => [number, number] }
  projection.invert = (xy) => [(xy[0] / w) * 360 - 180, 90 - (xy[1] / h) * 180]
  return projection
}

describe('reprojectTerrain', () => {
  it('samples each destination pixel from the hemisphere the projection says it is', () => {
    const out = reprojectTerrain(hemisphereWindow(), fakeProjection(16, 8), 16, 8, 1)
    expect(out.width).toBe(16)
    expect(out.height).toBe(8)

    const px = (x: number, y: number) => {
      const i = (y * out.width + x) * 4
      return [out.data[i], out.data[i + 2], out.data[i + 3]]
    }
    expect(px(1, 4)).toEqual([255, 0, 255]) // far west -> red
    expect(px(14, 4)).toEqual([0, 255, 255]) // far east -> blue
  })

  it('interpolates bilinearly across the hemisphere seam', () => {
    // Dead centre of the viewport inverts to lon 0 — halfway between the last
    // red and first blue source columns. Nearest-neighbour would return a
    // pure colour; bilinear must blend both.
    const out = reprojectTerrain(hemisphereWindow(), fakeProjection(16, 8), 16, 8, 1)
    const i = (4 * out.width + 8) * 4
    expect(out.data[i]).toBeGreaterThan(60)
    expect(out.data[i]).toBeLessThan(200)
    expect(out.data[i + 2]).toBeGreaterThan(60)
    expect(out.data[i + 2]).toBeLessThan(200)
  })

  it('addresses samples geographically, honouring a window that starts mid-globe', () => {
    // Same pixels, but the window is declared to start at lon 0: what was
    // "west red" now covers 0..180E, so an eastern-hemisphere pixel reads red.
    const win = { ...hemisphereWindow(), lonLeft: 0 }
    const out = reprojectTerrain(win, fakeProjection(16, 8), 16, 8, 1)
    const i = (4 * out.width + 12) * 4 // ~lon 90E
    expect(out.data[i]).toBe(255)
  })

  it('leaves pixels transparent where the round-trip fails (outside the sphere)', () => {
    const proj = fakeProjection(16, 8)
    // A projection that disowns the left half of the viewport: everything
    // inverts, but re-projecting lands somewhere else.
    const broken = ((ll: [number, number]) => {
      const p = proj(ll)
      return p[0] < 8 ? ([p[0] + 100, p[1]] as [number, number]) : p
    }) as typeof proj
    broken.invert = proj.invert
    const out = reprojectTerrain(hemisphereWindow(), broken, 16, 8, 1)

    const alpha = (x: number, y: number) => out.data[(y * out.width + x) * 4 + 3]
    expect(alpha(2, 4)).toBe(0)
    expect(alpha(13, 4)).toBe(255)
  })

  it('renders at the requested supersampling scale', () => {
    const out = reprojectTerrain(hemisphereWindow(), fakeProjection(10, 10), 10, 10, 1.5)
    expect(out.width).toBe(15)
    expect(out.height).toBe(15)
  })
})

describe('viewBounds', () => {
  it('finds the geographic rectangle a plate carrée viewport sees', () => {
    // A viewport showing lon -90..90, lat -45..45 through a world-sized
    // projection: bounds must cover that rect (plus padding), not the globe.
    const world = fakeProjection(32, 16)
    const quarter = ((ll: [number, number]) => {
      const p = world(ll)
      return [p[0] - 8, p[1] - 4] as [number, number]
    }) as ReturnType<typeof fakeProjection>
    quarter.invert = (xy) => world.invert([xy[0] + 8, xy[1] + 4])

    const b = viewBounds(quarter, 16, 8)
    expect(b.lonLeft).toBeLessThanOrEqual(-90)
    expect(b.lonLeft).toBeGreaterThan(-110)
    expect(b.lonSpan).toBeGreaterThanOrEqual(180)
    expect(b.lonSpan).toBeLessThan(220)
    expect(b.latTop).toBeGreaterThanOrEqual(45)
    expect(b.latSpan).toBeLessThan(120)
  })

  it('falls back to the whole world when nothing inverts', () => {
    const dead = ((_ll: [number, number]) => null) as unknown as ReturnType<typeof fakeProjection>
    dead.invert = () => [NaN, NaN]
    expect(viewBounds(dead, 16, 8)).toEqual({ lonLeft: -180, latTop: 90, lonSpan: 360, latSpan: 180 })
  })
})
