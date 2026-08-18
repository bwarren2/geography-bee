import { useEffect, useMemo, useState } from 'react'
import { loadIndex, type CountryIndex } from './data/load'
import { BOOST_STEP, buildSession, today, type SessionItem } from './session/builder'
import { buildDrills, type Drill } from './session/drills'
import { buildRapidQueue, RAPID_MIN_SEEN, type RapidItem } from './session/rapid'
import { store, useStudyStore } from './store/useStore'
import { DashboardView } from './ui/DashboardView'
import { DrillView, type DrillResult } from './ui/DrillView'
import { Home } from './ui/Home'
import { PacksView } from './ui/PacksView'
import { RapidView } from './ui/RapidView'
import { StudyView, type SessionResult } from './ui/StudyView'

type Screen =
  | { name: 'home' }
  | { name: 'packs' }
  | { name: 'dashboard' }
  | { name: 'study'; items: SessionItem[] }
  | { name: 'rapid'; items: RapidItem[] }
  | { name: 'drills'; drills: Drill[]; result: SessionResult }
  | { name: 'summary'; result: SessionResult; drills?: DrillResult }

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

  // Would granting more budget actually surface more cards? Probing the real
  // builder answers it exactly — packs, gates and dedup included — so the
  // boost button can never appear when pressing it would do nothing.
  const canBoost = useMemo(() => {
    if (!index || !snapshot || !pending) return false
    const probe = buildSession({
      now: new Date(),
      index,
      cards: snapshot.cards,
      stats: snapshot.stats,
      settings: {
        ...snapshot.settings,
        newCardsPerDay: snapshot.settings.newCardsPerDay + BOOST_STEP,
      },
    })
    return probe.filter((i) => i.isNew).length > pending.filter((i) => i.isNew).length
  }, [index, snapshot, pending])

  if (!index || !snapshot || !pending) return <p className="loading">Loading…</p>

  if (screen.name === 'study') {
    return (
      <StudyView
        items={screen.items}
        index={index}
        onDone={(result) => {
          reload()
          // Drills come from the store directly, not the React snapshot: the
          // wrong clicks made seconds ago in this very session are the
          // freshest — and most drillable — confusions of all.
          const drills = buildDrills(store.snapshot().stats.confusion, index)
          if (drills.length) setScreen({ name: 'drills', drills, result })
          else setScreen({ name: 'summary', result })
        }}
        onQuit={() => {
          reload()
          setScreen({ name: 'home' })
        }}
      />
    )
  }

  if (screen.name === 'rapid') {
    return (
      <RapidView
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

  if (screen.name === 'drills') {
    return (
      <DrillView
        drills={screen.drills}
        index={index}
        onDone={(drillResult) => {
          reload()
          setScreen({ name: 'summary', result: screen.result, drills: drillResult })
        }}
      />
    )
  }

  if (screen.name === 'dashboard') {
    return <DashboardView index={index} snapshot={snapshot} onBack={() => setScreen({ name: 'home' })} />
  }

  if (screen.name === 'packs') {
    return (
      <PacksView
        index={index}
        snapshot={snapshot}
        onBack={() => setScreen({ name: 'home' })}
        onChanged={reload}
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
          {screen.drills && (
            <div className="stat">
              <strong>
                {screen.drills.correct}/{screen.drills.asked}
              </strong>
              <span>drills</span>
            </div>
          )}
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
      canBoost={canBoost}
      onBoost={() => {
        void store.grantBoost(BOOST_STEP, today(new Date())).then(reload)
      }}
      onRapid={() => {
        const items = buildRapidQueue(index, snapshot.cards, new Date())
        if (items.length) setScreen({ name: 'rapid', items })
      }}
      onPacks={() => setScreen({ name: 'packs' })}
      onDashboard={() => setScreen({ name: 'dashboard' })}
      onReload={reload}
    />
  )
}
