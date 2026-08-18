import { useEffect, useRef, useState } from 'react'
import type { CountryIndex } from '../data/load'
import { GeoMap, type MarkRole } from '../map/GeoMap'
import { borderOpacityFor } from '../session/builder'
import type { RapidItem } from '../session/rapid'
import { deriveRating, type AnswerOutcome } from '../srs/model'
import { schedule } from '../srs/scheduler'
import { store } from '../store/useStore'
import type { SessionResult } from './StudyView'

/** How long the answer flash stays on screen. A hit needs only an instant of
 *  green; a miss lingers long enough to actually see where the country was. */
const FLASH_HIT_MS = 350
const FLASH_MISS_MS = 1100

interface RapidViewProps {
  items: RapidItem[]
  index: CountryIndex
  onDone: (result: SessionResult) => void
  onQuit: () => void
}

/**
 * The sprint loop: prompt, tap, flash, next. One attempt per card — speed is
 * the point, so a miss records Again and moves on rather than holding the
 * question open. Everything lands in the same store as a normal session:
 * FSRS state, review log, aggregates, and the confusion matrix (a rapid
 * wrong-click is a confusion like any other, and feeds the drill queue).
 */
export function RapidView({ items, index, onDone, onQuit }: RapidViewProps) {
  const [pos, setPos] = useState(0)
  const [flash, setFlash] = useState<{ chosen: string; correct: boolean } | null>(null)
  const [tally, setTally] = useState({ answered: 0, correct: 0 })

  const startedAt = useRef(Date.now())
  const shownAt = useRef(Date.now())
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const item = items[pos]

  useEffect(() => {
    shownAt.current = Date.now()
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [pos])

  if (!item) return null
  const { card, country } = item

  function advance(nextTally: { answered: number; correct: number }) {
    setFlash(null)
    if (pos + 1 >= items.length) {
      void store.flush()
      onDone({
        answered: nextTally.answered,
        correct: nextTally.correct,
        introduced: 0,
        elapsedMs: Date.now() - startedAt.current,
      })
    } else {
      setPos(pos + 1)
    }
  }

  function pick(iso3: string) {
    if (flash) return // answer already given; ignore taps during the flash

    const correct = iso3 === country.iso3
    const outcome: AnswerOutcome = {
      correct,
      latencyMs: Date.now() - shownAt.current,
      chosen: iso3,
      hadWrongAttempt: false,
      assisted: false,
    }
    const rating = deriveRating('locate', outcome)
    const now = new Date()
    void store.recordAnswer(
      schedule(card, rating, now),
      {
        c: card.id,
        t: now.getTime(),
        r: rating,
        ms: outcome.latencyMs,
        ...(correct ? {} : { w: iso3 }),
      },
      {},
    )

    const nextTally = { answered: tally.answered + 1, correct: tally.correct + (correct ? 1 : 0) }
    setTally(nextTally)
    setFlash({ chosen: iso3, correct })
    timerRef.current = setTimeout(() => advance(nextTally), correct ? FLASH_HIT_MS : FLASH_MISS_MS)
  }

  const marks: Record<string, MarkRole> = {}
  if (flash) {
    marks[country.iso3] = 'correct'
    if (!flash.correct) marks[flash.chosen] = 'wrong'
  }

  return (
    <div className="study">
      <header className="study-head">
        <button className="ghost" onClick={onQuit}>
          ✕
        </button>
        <span className="lead-inline">Rapid</span>
        <div className="progress">
          <div className="bar" style={{ width: `${(pos / items.length) * 100}%` }} />
        </div>
        <span className="count">
          {pos + 1}/{items.length}
        </span>
      </header>

      <div className="ask">
        <h2 className="prompt">Where is {country.name}?</h2>

        <div className="map-panel">
          <GeoMap
            key={card.id}
            view={{ kind: 'region', slug: country.region }}
            marks={marks}
            // The sprint asks at the same difficulty the card has earned; the
            // answer flash restores full borders so the miss shows in context.
            borderOpacity={flash ? 1 : borderOpacityFor(card)}
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
