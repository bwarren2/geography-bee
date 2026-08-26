import { useEffect, useRef, useState } from 'react'
import { loadGeometry, type CountryFeature, type CountryIndex } from '../data/load'
import { distanceToFeatureKm } from '../map/distance'
import { GeoMap, type MarkRole } from '../map/GeoMap'
import type { ChallengeAnswer, ChallengeMode, ChallengeRun } from '../session/challenge'
import type { CountryRecord } from '../types'

const FLASH_HIT_MS = 350
const FLASH_MISS_MS = 1100

interface ChallengeViewProps {
  countries: CountryRecord[]
  mode: ChallengeMode
  index: CountryIndex
  onDone: (run: ChallengeRun) => void
  onQuit: () => void
}

/**
 * The World Challenge runner: the rapid-review loop stretched over all 195
 * countries, under deliberately fixed conditions — full borders, flat map,
 * one attempt, no reveal — so every run is the same test. Nothing here
 * writes to the store; the completed run is handed back whole, and quitting
 * midway discards it (a test you walked out of is not a comparable result).
 */
export function ChallengeView({ countries, mode, index, onDone, onQuit }: ChallengeViewProps) {
  const [pos, setPos] = useState(0)
  const [flash, setFlash] = useState<{ chosen: string; correct: boolean } | null>(null)
  const [tally, setTally] = useState({ answered: 0, correct: 0 })
  const [geo, setGeo] = useState<Map<string, CountryFeature> | null>(null)

  const answers = useRef<ChallengeAnswer[]>([])
  const shownAt = useRef(Date.now())
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    // 50m outlines carry a vertex every few km — that is what makes the
    // miss-distance number honest rather than a guess against a centroid.
    void loadGeometry('50m').then(setGeo)
  }, [])

  useEffect(() => {
    shownAt.current = Date.now()
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [pos])

  const country = countries[pos]
  if (!country) return null

  function advance() {
    setFlash(null)
    if (pos + 1 >= countries.length) {
      onDone({ at: Date.now(), mode, answers: answers.current })
    } else {
      setPos(pos + 1)
    }
  }

  function pick(iso3: string, lonlat?: [number, number]) {
    if (flash || !country) return

    const correct = iso3 === country.iso3
    const feature = geo?.get(country.iso3)
    const missKm =
      correct || !lonlat || !feature ? 0 : Math.round(distanceToFeatureKm(feature, lonlat))
    answers.current.push({
      iso3: country.iso3,
      chosen: iso3,
      correct,
      ms: Date.now() - shownAt.current,
      tap: lonlat ? [Math.round(lonlat[0] * 100) / 100, Math.round(lonlat[1] * 100) / 100] : null,
      missKm,
    })

    const nextTally = { answered: tally.answered + 1, correct: tally.correct + (correct ? 1 : 0) }
    setTally(nextTally)
    setFlash({ chosen: iso3, correct })
    timerRef.current = setTimeout(advance, correct ? FLASH_HIT_MS : FLASH_MISS_MS)
  }

  function quit() {
    if (window.confirm('Quit the challenge? This run will be discarded.')) onQuit()
  }

  const marks: Record<string, MarkRole> = {}
  if (flash) {
    marks[country.iso3] = 'correct'
    if (!flash.correct) marks[flash.chosen] = 'wrong'
  }

  return (
    <div className="study">
      <header className="study-head">
        <button className="ghost" onClick={quit}>
          ✕
        </button>
        <span className="lead-inline">{mode === 'blank' ? 'Blank challenge' : 'Challenge'}</span>
        <div className="progress">
          <div className="bar" style={{ width: `${(pos / countries.length) * 100}%` }} />
        </div>
        <span className="count">
          {pos + 1}/{countries.length}
        </span>
      </header>

      <div className="ask">
        <h2 className="prompt">Where is {country.name}?</h2>

        <div className="map-panel">
          <GeoMap
            key={country.iso3}
            view={{ kind: 'region', slug: country.region }}
            marks={marks}
            // Fixed test conditions per mode, whatever the cards have earned:
            // bordered runs always draw full borders, blank runs none at all
            // (coastline only) until the answer flash restores them so a miss
            // shows in context. No terrain either way — two runs a month
            // apart must differ only in the person taking them.
            borderOpacity={flash ? 1 : mode === 'blank' ? 0 : 1}
            labels={flash ? [country.iso3] : []}
            onPick={pick}
          />
        </div>

        <div className="ask-foot">
          <span className="muted">
            {flash ? (flash.correct ? 'Yes' : `That was ${index.byIso3.get(flash.chosen)?.name ?? 'elsewhere'}`) : ' '}
          </span>
          <span className="muted rapid-score">
            {tally.correct}/{tally.answered}
          </span>
        </div>
      </div>
    </div>
  )
}
