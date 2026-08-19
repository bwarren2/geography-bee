import type { GeoProjection } from 'd3-geo'

/**
 * The optional satellite base layer (#5): NASA Blue Marble, shipped with the
 * app as one equirectangular JPEG and reprojected on-device into whatever
 * projection the current view uses. No tile servers — the app stays
 * offline-first with zero runtime network dependencies. The image is
 * runtime-cached by the service worker rather than precached, so only
 * learners who turn terrain on ever download it.
 *
 * The source is 8192×4096 — decoded whole it would be a 134MB pixel buffer,
 * over the canvas limits of older iPhones. So the full image is never
 * materialised: for each view a geographic window is cropped during decode
 * (`createImageBitmap` with a crop rect), downscaled to just above the
 * layer's own resolution, and sampled bilinearly from there.
 */

/** A decoded rectangle of the equirectangular source with its geographic
 *  anchoring, so samples are addressed by lon/lat rather than source pixel. */
export interface RasterWindow {
  data: Uint8ClampedArray<ArrayBuffer>
  width: number
  height: number
  /** Longitude of the window's left edge (may need wrapping to reach a sample). */
  lonLeft: number
  /** Latitude of the window's top edge. */
  latTop: number
  degPerPxX: number
  degPerPxY: number
}

export interface GeoWindowBounds {
  lonLeft: number
  latTop: number
  lonSpan: number
  latSpan: number
}

type Projectionish = Pick<GeoProjection, 'invert'> & ((coords: [number, number]) => [number, number] | null)

const wrap360 = (deg: number) => ((deg % 360) + 360) % 360

/** Does the forward projection agree that this lon/lat lands on this pixel?
 *  invert() outside a projection's image (the void around an Equal Earth
 *  sphere) returns plausible-looking garbage; the round trip exposes it. */
function roundTrips(projection: Projectionish, ll: [number, number], x: number, y: number): boolean {
  const rt = projection(ll)
  return !!rt && Math.hypot(rt[0] - x, rt[1] - y) <= 0.75
}

/**
 * The geographic rectangle a viewport can see, found by inverse-projecting a
 * sample grid. Longitudes are unwrapped around their circular mean so views
 * straddling the antimeridian (the Pacific) get one contiguous window.
 */
export function viewBounds(projection: Projectionish, width: number, height: number): GeoWindowBounds {
  const N = 12
  const lons: number[] = []
  let latMin = Infinity
  let latMax = -Infinity
  let sumX = 0
  let sumY = 0

  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      const x = (i / N) * width
      const y = (j / N) * height
      const ll = projection.invert?.([x, y])
      if (!ll || !Number.isFinite(ll[0]) || !Number.isFinite(ll[1])) continue
      if (!roundTrips(projection, ll, x, y)) continue
      lons.push(ll[0])
      latMin = Math.min(latMin, ll[1])
      latMax = Math.max(latMax, ll[1])
      sumX += Math.cos((ll[0] * Math.PI) / 180)
      sumY += Math.sin((ll[0] * Math.PI) / 180)
    }
  }

  if (!lons.length) return { lonLeft: -180, latTop: 90, lonSpan: 360, latSpan: 180 }

  const mean = (Math.atan2(sumY, sumX) * 180) / Math.PI
  let lonMin = Infinity
  let lonMax = -Infinity
  for (const lon of lons) {
    const d = ((lon - mean + 540) % 360) - 180
    lonMin = Math.min(lonMin, d)
    lonMax = Math.max(lonMax, d)
  }

  const padLon = Math.max(1, (lonMax - lonMin) * 0.05)
  const padLat = Math.max(1, (latMax - latMin) * 0.05)
  const lonSpan = Math.min(360, lonMax - lonMin + 2 * padLon)
  const latTop = Math.min(90, latMax + padLat)
  const latSpan = Math.min(180, latTop - Math.max(-90, latMin - padLat))
  return { lonLeft: mean + lonMin - padLon, latTop, lonSpan, latSpan }
}

/**
 * Inverse-projection resampling: walk every destination pixel, ask the
 * projection which lon/lat lands there, and take a bilinear sample from the
 * window. Bilinear matters — nearest-neighbour at region zoom turns the
 * source grid into visible blocks.
 */
export function reprojectTerrain(
  win: RasterWindow,
  projection: Projectionish,
  width: number,
  height: number,
  scale: number,
): { data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number } {
  const dw = Math.round(width * scale)
  const dh = Math.round(height * scale)
  const out = new Uint8ClampedArray(dw * dh * 4)
  const { data, width: ww, height: wh } = win

  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const px = (x + 0.5) / scale
      const py = (y + 0.5) / scale
      const ll = projection.invert?.([px, py])
      if (!ll || !Number.isFinite(ll[0]) || !Number.isFinite(ll[1])) continue
      if (!roundTrips(projection, ll, px, py)) continue

      const gx = wrap360(ll[0] - win.lonLeft) / win.degPerPxX - 0.5
      const gy = (win.latTop - ll[1]) / win.degPerPxY - 0.5

      const x0 = Math.max(0, Math.min(ww - 1, Math.floor(gx)))
      const y0 = Math.max(0, Math.min(wh - 1, Math.floor(gy)))
      const x1 = Math.min(ww - 1, x0 + 1)
      const y1 = Math.min(wh - 1, y0 + 1)
      const fx = Math.max(0, Math.min(1, gx - x0))
      const fy = Math.max(0, Math.min(1, gy - y0))

      const i00 = (y0 * ww + x0) * 4
      const i10 = (y0 * ww + x1) * 4
      const i01 = (y1 * ww + x0) * 4
      const i11 = (y1 * ww + x1) * 4
      const di = (y * dw + x) * 4
      for (let c = 0; c < 3; c++) {
        const top = data[i00 + c]! * (1 - fx) + data[i10 + c]! * fx
        const bot = data[i01 + c]! * (1 - fx) + data[i11 + c]! * fx
        out[di + c] = top * (1 - fy) + bot * fy
      }
      out[di + 3] = 255
    }
  }
  return { data: out, width: dw, height: dh }
}

let blobPromise: Promise<{ blob: Blob; width: number; height: number }> | null = null

/** Fetch the JPEG once per page load and learn its dimensions; pixels are
 *  only ever decoded per-window, never for the whole image. */
function loadSource() {
  blobPromise ??= (async () => {
    const res = await fetch('data/terrain.jpg')
    if (!res.ok) throw new Error(`terrain.jpg: ${res.status}`)
    const blob = await res.blob()
    const probe = await createImageBitmap(blob)
    const size = { width: probe.width, height: probe.height }
    probe.close?.()
    return { blob, ...size }
  })()
  return blobPromise
}

/**
 * Crop the source down to the window's geographic rectangle, decoding only
 * that region and scaling it to no more than `targetWidthPx` across. A
 * window crossing the antimeridian is stitched from two crops.
 */
async function extractWindow(bounds: GeoWindowBounds, targetWidthPx: number): Promise<RasterWindow> {
  const { blob, width: srcW, height: srcH } = await loadSource()
  const pxPerDegX = srcW / 360
  const pxPerDegY = srcH / 180

  const sx = wrap360(bounds.lonLeft + 180) * pxPerDegX
  const sy = Math.max(0, (90 - bounds.latTop) * pxPerDegY)
  const sw = Math.min(srcW, bounds.lonSpan * pxPerDegX)
  const sh = Math.min(srcH - sy, bounds.latSpan * pxPerDegY)

  const outW = Math.max(2, Math.round(Math.min(sw, targetWidthPx)))
  const ratio = outW / sw
  const outH = Math.max(2, Math.round(sh * ratio))

  const canvas = document.createElement('canvas')
  canvas.width = outW
  canvas.height = outH
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!

  const drawCrop = async (cropX: number, cropW: number, destX: number, destW: number) => {
    const bmp = await createImageBitmap(
      blob,
      Math.floor(cropX),
      Math.floor(sy),
      Math.ceil(cropW),
      Math.ceil(sh),
    )
    ctx.drawImage(bmp, destX, 0, destW, outH)
    bmp.close?.()
  }

  if (sx + sw <= srcW) {
    await drawCrop(sx, sw, 0, outW)
  } else {
    const firstW = srcW - sx
    const split = Math.round(firstW * ratio)
    await drawCrop(sx, firstW, 0, split)
    await drawCrop(0, sw - firstW, split, outW - split)
  }

  const img = ctx.getImageData(0, 0, outW, outH)
  return {
    data: img.data as Uint8ClampedArray<ArrayBuffer>,
    width: outW,
    height: outH,
    lonLeft: bounds.lonLeft,
    latTop: bounds.latTop,
    degPerPxX: bounds.lonSpan / outW,
    degPerPxY: bounds.latSpan / outH,
  }
}

/** Fraction of theme ground blended over the imagery so raw satellite colour
 *  sits inside the night-atlas palette instead of shouting over it. */
const TINT = 'rgba(10, 16, 31, 0.30)'

/** How much finer than the layer itself the window is sampled — headroom for
 *  bilinear filtering and mild in-map zoom before the source pixel grid shows. */
const WINDOW_OVERSAMPLE = 2

/** Rendered layers keyed by view+size. Each holds an object URL; a small LRU
 *  keeps remounts (GeoMap remounts per card) from re-running the resample. */
const layers = new Map<string, Promise<string>>()
const LAYER_CAP = 4

export function terrainLayerUrl(
  key: string,
  projection: GeoProjection,
  width: number,
  height: number,
): Promise<string> {
  const fullKey = `${key}|${width}x${height}`
  const hit = layers.get(fullKey)
  if (hit) return hit

  const promise = (async () => {
    // Above 1.5x the extra invert() calls cost more than the sharpness pays.
    const scale = Math.min(window.devicePixelRatio || 1, 1.5)
    const bounds = viewBounds(projection, width, height)
    const win = await extractWindow(bounds, width * scale * WINDOW_OVERSAMPLE)
    const raster = reprojectTerrain(win, projection, width, height, scale)

    const canvas = document.createElement('canvas')
    canvas.width = raster.width
    canvas.height = raster.height
    const ctx = canvas.getContext('2d')!
    ctx.putImageData(new ImageData(raster.data, raster.width, raster.height), 0, 0)
    ctx.fillStyle = TINT
    ctx.fillRect(0, 0, raster.width, raster.height)

    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'),
    )
    return URL.createObjectURL(blob)
  })()

  layers.set(fullKey, promise)
  if (layers.size > LAYER_CAP) {
    const [oldestKey, oldest] = layers.entries().next().value!
    layers.delete(oldestKey)
    void oldest.then((url) => URL.revokeObjectURL(url)).catch(() => {})
  }
  return promise
}
