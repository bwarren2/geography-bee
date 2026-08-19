import { useEffect, useState } from 'react'
import type { CountryIndex } from '../data/load'
import { GeoMap, type MarkRole } from '../map/GeoMap'
import type { Drill } from '../session/drills'
import { store } from '../store/useStore'

export interface DrillResult {
  asked: number
  correct: number
}

interface DrillViewProps {
  terrain?: boolean
  drills: Drill[]
  index: CountryIndex
  onDone: (result: DrillResult) => void
}

/**
 * The confusion round: both candidates highlighted, tap the named one. A wrong
 * pick feeds the pair's confusion count and the question stays open; a first-
 * try success decays it. Pairs drill themselves out of rotation by being
 * answered well.
 */
export function DrillView({ drills, index, terrain, onDone }: DrillViewProps) {
  const [pos, setPos] = useState(0)
  const [missed, setMissed] = useState(false)
  const [tally, setTally] = useState({ asked: 0, correct: 0 })

  const drill = drills[pos]

  useEffect(() => {
    setMissed(false)
  }, [pos])

  if (!drill) return null

  const target = index.byIso3.get(drill.target)
  const other = index.byIso3.get(drill.other)
  if (!target || !other) return null

  function advance(firstTry: boolean) {
    setTally((t) => ({ asked: t.asked + 1, correct: t.correct + (firstTry ? 1 : 0) }))
    if (pos + 1 >= drills.length) {
      void store.flush()
      onDone({ asked: tally.asked + 1, correct: tally.correct + (firstTry ? 1 : 0) })
    } else {
      setPos(pos + 1)
    }
  }

  function pick(iso3: string) {
    if (iso3 === drill!.target) {
      if (!missed) void store.adjustConfusion(`${drill!.target}>${drill!.other}`, -1)
      advance(!missed)
    } else {
      // Confusing them again, live, is exactly the signal the matrix records.
      void store.adjustConfusion(`${drill!.target}>${drill!.other}`, +1)
      setMissed(true)
    }
  }

  const marks: Record<string, MarkRole> = {
    [drill.target]: 'context',
    [drill.other]: missed ? 'wrong' : 'context',
  }

  return (
    <div className="study">
      <header className="study-head">
        <span className="lead-inline">Confusion round</span>
        <div className="progress">
          <div className="bar" style={{ width: `${(pos / drills.length) * 100}%` }} />
        </div>
        <span className="count">
          {pos + 1}/{drills.length}
        </span>
      </header>

      <div className="ask">
        <h2 className="prompt">
          Tap {target.flag} {target.name}
        </h2>
        <p className="muted centered">You keep mixing it up with {other.name} — both are marked.</p>

        <div className="map-panel">
          <GeoMap
            key={`${drill.target}|${drill.other}`}
            view={{ kind: 'region', slug: target.region }}
            marks={marks}
            terrain={terrain}
            pickable={new Set([drill.target, drill.other])}
            onPick={pick}
          />
        </div>

        <div className="ask-foot">
          {missed && <span className="muted">That is {other.name} — try the other one</span>}
        </div>
      </div>
    </div>
  )
}
