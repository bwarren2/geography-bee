import { describe, expect, it } from 'vitest'
import { clampTransform, IDENTITY, snapRadiusPx, zoomAround } from './GeoMap'

const W = 390
const H = 600

describe('map transform', () => {
  it('never zooms out past 1:1 or in past the ceiling', () => {
    expect(clampTransform({ k: 0.4, x: 0, y: 0 }, W, H).k).toBe(1)
    expect(clampTransform({ k: 99, x: 0, y: 0 }, W, H).k).toBe(8)
  })

  it('pins translation to zero at base zoom, so 1:1 is always exactly home', () => {
    const tf = clampTransform({ k: 1, x: -120, y: 80 }, W, H)
    expect(tf).toEqual(IDENTITY)
  })

  it('never lets a gap open at any edge while zoomed', () => {
    // Fling the map far off in every direction at 2x.
    for (const [x, y] of [[9999, 9999], [-9999, -9999], [9999, -9999]] as const) {
      const tf = clampTransform({ k: 2, x, y }, W, H)
      expect(tf.x).toBeLessThanOrEqual(0)
      expect(tf.x).toBeGreaterThanOrEqual(W - W * 2)
      expect(tf.y).toBeLessThanOrEqual(0)
      expect(tf.y).toBeGreaterThanOrEqual(H - H * 2)
    }
  })

  it('keeps the point under the cursor fixed while zooming', () => {
    const cx = 130
    const cy = 420
    const tf = zoomAround(IDENTITY, cx, cy, 3, W, H)
    // The base point that was under (cx, cy) must still project there.
    const baseX = (cx - 0) / 1
    const baseY = (cy - 0) / 1
    expect(baseX * tf.k + tf.x).toBeCloseTo(cx, 6)
    expect(baseY * tf.k + tf.y).toBeCloseTo(cy, 6)
  })

  it('round-trips a zoom in and back out to identity', () => {
    const zoomed = zoomAround(IDENTITY, 200, 300, 4, W, H)
    const back = zoomAround(zoomed, 200, 300, 1, W, H)
    expect(back).toEqual(IDENTITY)
  })
})

describe('snapRadiusPx', () => {
  it('caps at 45% of the on-screen gap, floors at 5, ceils at a half tap', () => {
    expect(snapRadiusPx(25)).toBeCloseTo(11.25) // crowded: Vatican beside San Marino at 1x
    expect(snapRadiusPx(4)).toBe(5) // never below the floor
    expect(snapRadiusPx(500)).toBe(20) // lonely: full half-tap target
    expect(snapRadiusPx(Infinity)).toBe(20)
  })

  it('grows with zoom until the enclave is a full-size target', () => {
    // The regression that prompted this: zooming toward Vatican City used to
    // leave its tap target frozen at the crowded 1x size.
    const gapAt1x = 25
    expect(snapRadiusPx(gapAt1x * 4)).toBe(20)
    expect(snapRadiusPx(gapAt1x * 2)).toBeGreaterThan(snapRadiusPx(gapAt1x))
  })
})
