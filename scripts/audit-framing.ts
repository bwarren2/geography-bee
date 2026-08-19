/**
 * Framing audit (#3): prints the screen share every country gets in its
 * region's initial locate view, flagging violations of the contract in
 * `src/map/framing.ts`. The vitest guard (`src/map/framing.test.ts`) enforces
 * the same numbers; this script is for eyeballing the full table when cutting
 * regions.
 */
import { FRAME_SHARE_FLOOR, framingShares, MICRO_EXEMPT_KM2, MIN_FRAME_SHARE } from '../src/map/framing'
import { loadCommittedBundle, loadCommittedGeometry } from './geo-node'

// Reference viewport ≈ the map panel on a phone. Shares shift only mildly
// with aspect, and the guard uses the same constants, so calibration holds.
const W = 390
const H = 390

const bundle = loadCommittedBundle()
const geo = loadCommittedGeometry(bundle)
const areaOf = new Map(bundle.countries.map((c) => [c.iso3, c.areaKm2]))
const nameOf = new Map(bundle.countries.map((c) => [c.iso3, c.name]))

const rows = framingShares(bundle.regions, geo, W, H)
const byRegion = new Map<string, typeof rows>()
for (const r of rows) {
  if (!byRegion.has(r.region)) byRegion.set(r.region, [])
  byRegion.get(r.region)!.push(r)
}

let failures = 0
let warnings = 0
for (const region of [...bundle.regions].sort((a, b) => a.order - b.order)) {
  const members = (byRegion.get(region.slug) ?? []).sort((a, b) => a.share - b.share)
  console.log(`\n${region.slug}`)
  for (const m of members) {
    const micro = (areaOf.get(m.iso3) ?? 0) < MICRO_EXEMPT_KM2
    let tag = '   ok'
    if (micro) tag = 'micro'
    else if (m.share < FRAME_SHARE_FLOOR) (tag = ' FAIL'), failures++
    else if (m.share < MIN_FRAME_SHARE) (tag = ' warn'), warnings++
    console.log(
      `  ${tag}  ${(m.share * 100).toFixed(2).padStart(6)}%  ${m.iso3}  ${nameOf.get(m.iso3)}`,
    )
  }
}

console.log(
  `\n${failures} below the ${FRAME_SHARE_FLOOR * 100}% degeneracy floor, ` +
    `${warnings} below the ${MIN_FRAME_SHARE * 100}% cluster target ` +
    `(micro-states exempt under ${MICRO_EXEMPT_KM2.toLocaleString('en-US')} km²)`,
)
if (failures) process.exit(1)
