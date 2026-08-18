import { useEffect, useMemo, useRef, useState } from 'react'
import type { CountryIndex } from '../data/load'
import { GeoMap, type MarkRole } from '../map/GeoMap'
import { deriveRating, type AnswerOutcome } from '../srs/model'
import { schedule } from '../srs/scheduler'
import { answerModeFor, stimulusFor, type SessionItem } from '../session/builder'
import { matchAnswer } from '../session/matching'
import { store } from '../store/useStore'
import { Reveal } from './Reveal'

export interface SessionResult {
  answered: number
  correct: number
  introduced: number
  elapsedMs: number
}

interface StudyViewProps {
  items: SessionItem[]
  index: CountryIndex
  onDone: (result: SessionResult) => void
  onQuit: () => void
}

type Phase = 'teach' | 'ask' | 'reveal'

export function StudyView({ items, index, onDone, onQuit }: StudyViewProps) {
  const [pos, setPos] = useState(0)
  const [phase, setPhase] = useState<Phase>('ask')
  const [wrongPicks, setWrongPicks] = useState<string[]>([])
  const [typed, setTyped] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [tally, setTally] = useState({ answered: 0, correct: 0, introduced: 0 })

  const startedAt = useRef(Date.now())
  const shownAt = useRef(Date.now())
  const item = items[pos]

  // A brand new country gets shown before it is asked about: nobody can recall
  // what they have never seen, and a guaranteed miss teaches nothing.
  useEffect(() => {
    if (!item) return
    setPhase(item.introduce ? 'teach' : 'ask')
    setWrongPicks([])
    setTyped('')
    setSelected([])
    shownAt.current = Date.now()
  }, [pos, item])

  const options = useMemo(
    () => (item ? shuffleStable(item.options, item.card.id) : []),
    [item],
  )

  if (!item) return null

  const { card, country } = item
  const correctSoFar = wrongPicks.length === 0

  async function finish(correct: boolean, chosen?: string) {
    const outcome: AnswerOutcome = {
      correct,
      latencyMs: Date.now() - shownAt.current,
      chosen,
      hadWrongAttempt: wrongPicks.length > 0,
      assisted: item!.assisted,
    }
    const rating = deriveRating(card.type, outcome)
    const now = new Date()
    const next = schedule(card, rating, now)

    await store.recordAnswer(
      next,
      {
        c: card.id,
        t: now.getTime(),
        r: rating,
        ms: outcome.latencyMs,
        // Only a genuine country mix-up is worth recording; a typo is not a
        // confusion between two places.
        ...(wrongPicks[0] ? { w: wrongPicks[0] } : {}),
      },
      { introduced: item!.isNew },
    )

    setTally((t) => ({
      answered: t.answered + 1,
      correct: t.correct + (correct ? 1 : 0),
      introduced: t.introduced + (item!.isNew ? 1 : 0),
    }))
    setPhase('reveal')
  }

  function next() {
    if (pos + 1 >= items.length) {
      void store.flush()
      onDone({ ...tally, elapsedMs: Date.now() - startedAt.current })
    } else {
      setPos(pos + 1)
    }
  }

  /** A wrong attempt is recorded and the question stays open — recovering after
   *  a miss is still recall, and grades as Hard rather than as a failure. */
  function wrong(iso3?: string) {
    setWrongPicks((w) => (iso3 && w.includes(iso3) ? w : [...w, iso3 ?? '']))
  }

  const mode = answerModeFor(card.type, item.assisted)
  const stimulus = stimulusFor(card.type)

  const marks: Record<string, MarkRole> = {}
  for (const w of wrongPicks) if (w) marks[w] = 'wrong'
  if (stimulus === 'map-highlight') marks[country.iso3] = 'target'
  if (mode === 'map-multi') for (const s of selected) marks[s] = 'correct'

  return (
    <div className="study">
      <header className="study-head">
        <button className="ghost" onClick={onQuit}>
          ✕
        </button>
        <div className="progress">
          <div className="bar" style={{ width: `${(pos / items.length) * 100}%` }} />
        </div>
        <span className="count">
          {pos + 1}/{items.length}
        </span>
      </header>

      {phase === 'teach' && (
        <div className="teach">
          <p className="lead">New country</p>
          <h2>
            {country.flag} {country.name}
          </h2>
          <div className="map-panel">
            <GeoMap
              view={{ kind: 'region', slug: country.region }}
              marks={{ [country.iso3]: 'target' }}
              labels={[country.iso3]}
            />
          </div>
          <p className="muted">{index.regionBySlug.get(country.region)?.name}</p>
          <button
            className="primary"
            autoFocus
            onClick={() => {
              shownAt.current = Date.now()
              setPhase('ask')
            }}
          >
            Got it
          </button>
        </div>
      )}

      {phase === 'ask' && (
        <div className="ask">
          <h2 className="prompt">{promptFor(item, index)}</h2>

          {/* What is shown. A locate card must never highlight its own answer. */}
          {stimulus === 'flag' ? (
            <div className="big-flag">{country.flag}</div>
          ) : (
            <div className="map-panel">
              <GeoMap
                view={{ kind: 'region', slug: country.region }}
                marks={marks}
                labels={stimulus === 'map-highlight' && mode === 'map-multi' ? [country.iso3] : []}
                onPick={
                  mode === 'map-single'
                    ? (iso3) => (iso3 === country.iso3 ? void finish(true, iso3) : wrong(iso3))
                    : mode === 'map-multi'
                      ? (iso3) =>
                          setSelected((s) =>
                            s.includes(iso3) ? s.filter((x) => x !== iso3) : [...s, iso3],
                          )
                      : undefined
                }
              />
            </div>
          )}

          {/* How it is answered, switched on one derived mode so the control can
              never disagree with the question being asked. */}
          {mode === 'choice' ? (
            <div className="options">
              {options.map((iso3) => {
                const wrongPick = wrongPicks.includes(iso3)
                return (
                  <button
                    key={iso3}
                    className={wrongPick ? 'option wrong' : 'option'}
                    disabled={wrongPick}
                    onClick={() => (iso3 === country.iso3 ? void finish(true, iso3) : wrong(iso3))}
                  >
                    {index.byIso3.get(iso3)?.name ?? iso3}
                  </button>
                )
              })}
            </div>
          ) : mode === 'map-multi' ? (
            <button
              className="primary"
              onClick={() => {
                const want = new Set(country.borders)
                const got = new Set(selected)
                const exact = want.size === got.size && [...want].every((w) => got.has(w))
                if (!exact) wrong()
                void finish(exact)
              }}
            >
              Done ({selected.length}/{country.borders.length})
            </button>
          ) : mode === 'text' ? (
            <form
              className="typed"
              onSubmit={(e) => {
                e.preventDefault()
                if (!typed.trim()) return
                const expected =
                  card.type === 'capital'
                    ? { ok: country.capital.some((c) => sameish(c, typed)) }
                    : matchAnswer(typed, country, index.bundle.countries)
                if ('ok' in expected ? expected.ok : expected.correct) {
                  void finish(true)
                } else {
                  wrong('matchedOther' in expected ? expected.matchedOther : undefined)
                  setTyped('')
                }
              }}
            >
              <input
                autoFocus
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={card.type === 'capital' ? 'Capital city' : 'Country name'}
                autoCapitalize="words"
                autoCorrect="off"
                spellCheck={false}
              />
              <button className="primary" type="submit">
                Check
              </button>
            </form>
          ) : (
            // map-single: the map itself is the input, so there is no control here.
            <p className="muted centered">Tap the country on the map</p>
          )}

          <div className="ask-foot">
            {wrongPicks.length > 0 && <span className="muted">Not quite — try again</span>}
            <button className="ghost" onClick={() => void finish(false, wrongPicks[0])}>
              Show answer
            </button>
          </div>
        </div>
      )}

      {phase === 'reveal' && (
        <Reveal
          country={country}
          index={index}
          correct={correctSoFar}
          chosen={wrongPicks.find(Boolean)}
          onNext={next}
        />
      )}
    </div>
  )
}

function promptFor(item: SessionItem, index: CountryIndex): string {
  const { country, card } = item
  const region = index.regionBySlug.get(country.region)?.name ?? 'the region'
  switch (card.type) {
    case 'locate':
      return `Where is ${country.name}?`
    case 'identify':
      return 'Which country is highlighted?'
    case 'capital':
      return `Capital of ${country.name}?`
    case 'flag':
      return 'Whose flag is this?'
    case 'neighbors':
      return `Select every country bordering ${country.name} (${region})`
  }
}

const sameish = (a: string, b: string) =>
  a
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '') ===
  b
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')

/** Deterministic shuffle keyed by card id, so options do not jump around on
 *  re-render but are not in a giveaway order either. */
function shuffleStable<T>(items: T[], seed: string): T[] {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0
  return items
    .map((v, i) => ({ v, k: Math.sin(h + i * 97) }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.v)
}
