import { useMemo } from 'react'
import type { CountryIndex } from '../data/load'
import { recallFill } from '../map/colors'
import { GeoMap, type CityMark } from '../map/GeoMap'
import { CHALLENGE_MODES, type ChallengeMode } from '../session/challenge'
import { RAPID_REGION_MIN_SEEN, rapidSeenByRegion, selectRapidCards } from '../session/rapid'
import { retrievability } from '../srs/scheduler'
import { cardId } from '../srs/model'
import type { StudySnapshot } from '../store/store'

interface RapidPickerViewProps {
  index: CountryIndex
  snapshot: StudySnapshot
  /** null = whole world (the classic spread round). */
  onPick: (regionSlug: string | null) => void
  /** Start a World Challenge — all 195, scored on its own per-mode record. */
  onChallenge: (mode: ChallengeMode) => void
  onBack: () => void
}

/** Farther than this from every anchor, in degrees, a tap is just ocean. */
const PICK_RADIUS_DEG = 14

const wrapDelta = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

/**
 * Pick a focus for rapid review off the mastery map itself: every region
 * wears its current recall shading, with an anchor dot at its centroid —
 * so "what should I sprint?" and "where am I weak?" are the same glance,
 * and the reddest dot is the answer to both.
 */
export function RapidPickerView({ index, snapshot, onPick, onChallenge, onBack }: RapidPickerViewProps) {
  const now = useMemo(() => new Date(), [])
  const seenByRegion = useMemo(() => rapidSeenByRegion(index, snapshot.cards), [index, snapshot])
  // Whether a whole-world sprint would contain anything: due cards, or cards
  // whose recall has actually slipped. All fresh -> say so instead of a
  // silent dead button; region sprints stay available regardless.
  const worldCount = useMemo(() => selectRapidCards(index, snapshot.cards, now).length, [index, snapshot, now])

  const fills = useMemo(() => {
    const out: Record<string, string> = {}
    for (const c of index.bundle.countries) {
      const card = snapshot.cards[cardId(c.iso3, 'locate')]
      if (!card || card.reps === 0) continue
      const fill = recallFill(retrievability(card, now), true)
      if (fill) out[c.iso3] = fill
    }
    return out
  }, [index, snapshot, now])

  /** Region anchors: circular-mean longitude and mean latitude of members'
   *  label points — regions straddling the antimeridian included. */
  const anchors = useMemo(() => {
    return index.bundle.regions.map((region) => {
      let x = 0
      let y = 0
      let lat = 0
      const members = region.countries
        .map((iso3) => index.byIso3.get(iso3))
        .filter((c): c is NonNullable<typeof c> => !!c)
      for (const c of members) {
        const rad = (c.labelPoint[0] * Math.PI) / 180
        x += Math.cos(rad)
        y += Math.sin(rad)
        lat += c.labelPoint[1]
      }
      const lon = (Math.atan2(y / members.length, x / members.length) * 180) / Math.PI
      const eligible = (seenByRegion.get(region.slug) ?? 0) >= RAPID_REGION_MIN_SEEN
      return { slug: region.slug, name: region.name, lonlat: [lon, lat / members.length] as [number, number], eligible }
    })
  }, [index, seenByRegion])

  const marks: CityMark[] = anchors.map((a) => ({
    lonlat: a.lonlat,
    role: a.eligible ? 'target' : 'context',
    label: a.eligible ? a.name : undefined,
  }))

  function pickAt(lonlat: [number, number]) {
    let best: { slug: string; dist: number } | null = null
    for (const a of anchors) {
      if (!a.eligible) continue
      const dist = Math.hypot(wrapDelta(a.lonlat[0], lonlat[0]), a.lonlat[1] - lonlat[1])
      if (dist <= PICK_RADIUS_DEG && (!best || dist < best.dist)) best = { slug: a.slug, dist }
    }
    if (best) onPick(best.slug)
  }

  return (
    <div className="home rapid-picker">
      <header className="packs-head">
        <button className="ghost" onClick={onBack}>
          ← Back
        </button>
        <h1>Rapid review</h1>
      </header>

      <button className="primary big" onClick={() => onPick(null)} disabled={worldCount === 0}>
        {worldCount === 0 ? 'All fresh — nothing due for a sprint' : '🌍 Whole world'}
      </button>

      <p className="muted">
        Or tap a region to sprint just that part of the map — the shading is your recall right now,
        so the reddest dot is the best pick. Dim dots need {RAPID_REGION_MIN_SEEN}+ studied countries.
      </p>

      <div className="picker-map">
        <GeoMap
          view={{ kind: 'world', trim: true }}
          initialZoom={1.35}
          fills={fills}
          cityMarks={marks}
          pointTarget={[0, 0]}
          onPickPoint={({ lonlat }) => pickAt(lonlat)}
        />
      </div>

      {CHALLENGE_MODES.map((m) => (
        <button key={m.mode} className="challenge-start" onClick={() => onChallenge(m.mode)}>
          {m.mode === 'blank' ? '🌑' : '🏆'} {m.title}
          <span className="muted">{m.blurb}</span>
        </button>
      ))}
      <p className="muted small">
        Challenges are tests, separate from your review stats — each title keeps its own record, so
        a run only ever competes with your earlier runs of the same kind. Quitting midway discards
        the run.
      </p>
    </div>
  )
}
