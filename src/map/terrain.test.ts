import { describe, expect, it } from 'vitest'
import { reprojectTerrain, type RasterSource } from './terrain'

/**
 * A synthetic equirectangular source: the western hemisphere solid red, the
 * eastern solid blue. Sampling through a projection stub then checks pixels
 * land in the right hemisphere without any real imagery.
 */
function hemisphereSource(): RasterSource {
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
  return { data, width, height }
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
    const out = reprojectTerrain(hemisphereSource(), fakeProjection(16, 8), 16, 8, 1)
    expect(out.width).toBe(16)
    expect(out.height).toBe(8)

    const px = (x: number, y: number) => {
      const i = (y * out.width + x) * 4
      return [out.data[i], out.data[i + 2], out.data[i + 3]]
    }
    expect(px(2, 4)).toEqual([255, 0, 255]) // far west -> red
    expect(px(13, 4)).toEqual([0, 255, 255]) // far east -> blue
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
    const out = reprojectTerrain(hemisphereSource(), broken, 16, 8, 1)

    const alpha = (x: number, y: number) => out.data[(y * out.width + x) * 4 + 3]
    expect(alpha(2, 4)).toBe(0)
    expect(alpha(13, 4)).toBe(255)
  })

  it('renders at the requested supersampling scale', () => {
    const out = reprojectTerrain(hemisphereSource(), fakeProjection(10, 10), 10, 10, 1.5)
    expect(out.width).toBe(15)
    expect(out.height).toBe(15)
  })
})
