import type { GeoProjection } from 'd3-geo'

/**
 * The optional satellite base layer (#5): NASA Blue Marble, shipped with the
 * app as one equirectangular JPEG and reprojected on-device into whatever
 * projection the current view uses. No tile servers — the app stays
 * offline-first with zero runtime network dependencies.
 */

export interface RasterSource {
  data: Uint8ClampedArray<ArrayBuffer>
  width: number
  height: number
}

/**
 * Inverse-projection resampling: walk every destination pixel, ask the
 * projection which lon/lat lands there, and copy that sample from the
 * equirectangular source. The forward round-trip guard rejects pixels
 * outside the projection's image (the void around an Equal Earth sphere),
 * which come back from invert() as plausible-looking coordinates.
 */
export function reprojectTerrain(
  src: RasterSource,
  projection: Pick<GeoProjection, 'invert'> & ((coords: [number, number]) => [number, number] | null),
  width: number,
  height: number,
  scale: number,
): RasterSource {
  const dw = Math.round(width * scale)
  const dh = Math.round(height * scale)
  const out = new Uint8ClampedArray(dw * dh * 4)

  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const ll = projection.invert?.([(x + 0.5) / scale, (y + 0.5) / scale])
      if (!ll || !Number.isFinite(ll[0]) || !Number.isFinite(ll[1])) continue

      const rt = projection(ll)
      if (!rt || Math.hypot(rt[0] - (x + 0.5) / scale, rt[1] - (y + 0.5) / scale) > 0.75) continue

      // Rotated projections can hand back longitudes outside [-180, 180).
      const lon = ((((ll[0] + 180) % 360) + 360) % 360) - 180
      const lat = Math.max(-90, Math.min(90, ll[1]))

      const sx = Math.min(src.width - 1, Math.floor(((lon + 180) / 360) * src.width))
      const sy = Math.min(src.height - 1, Math.floor(((90 - lat) / 180) * src.height))
      const si = (sy * src.width + sx) * 4
      const di = (y * dw + x) * 4
      out[di] = src.data[si]!
      out[di + 1] = src.data[si + 1]!
      out[di + 2] = src.data[si + 2]!
      out[di + 3] = 255
    }
  }
  return { data: out, width: dw, height: dh }
}

let sourcePromise: Promise<RasterSource> | null = null

/** Decode the shipped JPEG once per page load and keep its pixels. */
function loadSource(): Promise<RasterSource> {
  sourcePromise ??= (async () => {
    const res = await fetch('data/terrain.jpg')
    if (!res.ok) throw new Error(`terrain.jpg: ${res.status}`)
    const bitmap = await createImageBitmap(await res.blob())
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(bitmap, 0, 0)
    bitmap.close?.()
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
    return { data: img.data, width: img.width, height: img.height }
  })()
  return sourcePromise
}

/** Fraction of theme ground blended over the imagery so raw satellite colour
 *  sits inside the night-atlas palette instead of shouting over it. */
const TINT = 'rgba(10, 16, 31, 0.30)'

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
    const src = await loadSource()
    // Above 1.5x the extra invert() calls cost more than the sharpness pays.
    const scale = Math.min(window.devicePixelRatio || 1, 1.5)
    const raster = reprojectTerrain(src, projection, width, height, scale)

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
