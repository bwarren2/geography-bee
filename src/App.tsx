import { useEffect, useMemo, useState } from 'react'
import { loadIndex, type CountryIndex } from './data/load'
import { buildSession, type SessionItem } from './session/builder'
import { useStudyStore } from './store/useStore'
import { Home } from './ui/Home'
import { StudyView, type SessionResult } from './ui/StudyView'

type Screen =
  | { name: 'home' }
  | { name: 'study'; items: SessionItem[] }
  | { name: 'summary'; result: SessionResult }

export function App() {
  const [index, setIndex] = useState<CountryIndex | null>(null)
  const { snapshot, reload } = useStudyStore()
  const [screen, setScreen] = useState<Screen>({ name: 'home' })

  useEffect(() => {
    void loadIndex().then(setIndex)
  }, [])

  // Rebuilt whenever storage changes so the home counts stay honest after a
  // session, an import, or a settings change.
  const pending = useMemo(() => {
    if (!index || !snapshot) return null
    return buildSession({
      now: new Date(),
      index,
      cards: snapshot.cards,
      stats: snapshot.stats,
      settings: snapshot.settings,
    })
  }, [index, snapshot])

  if (!index || !snapshot || !pending) return <p className="loading">Loading…</p>

  if (screen.name === 'study') {
    return (
      <StudyView
        items={screen.items}
        index={index}
        onDone={(result) => {
          reload()
          setScreen({ name: 'summary', result })
        }}
        onQuit={() => {
          reload()
          setScreen({ name: 'home' })
        }}
      />
    )
  }

  if (screen.name === 'summary') {
    const { answered, correct, introduced, elapsedMs } = screen.result
    const accuracy = answered ? Math.round((correct / answered) * 100) : 0
    return (
      <div className="home">
        <h1>Session done</h1>
        <div className="stats">
          <div className="stat">
            <strong>{answered}</strong>
            <span>answered</span>
          </div>
          <div className="stat">
            <strong>{accuracy}%</strong>
            <span>first try</span>
          </div>
          <div className="stat">
            <strong>{introduced}</strong>
            <span>new</span>
          </div>
          <div className="stat">
            <strong>{Math.round(elapsedMs / 1000)}s</strong>
            <span>elapsed</span>
          </div>
        </div>
        <button className="primary big" onClick={() => setScreen({ name: 'home' })}>
          Back
        </button>
      </div>
    )
  }

  return (
    <Home
      snapshot={snapshot}
      index={index}
      dueCount={pending.filter((i) => !i.isNew).length}
      newCount={pending.filter((i) => i.isNew).length}
      onStart={() => setScreen({ name: 'study', items: pending })}
      onReload={reload}
    />
  )
}
