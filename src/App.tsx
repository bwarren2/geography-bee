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
import { RapidPickerView } from './ui/RapidPickerView'
import { RapidView } from './ui/RapidView'
import { StudyView, type SessionResult } from './ui/StudyView'

type Screen =
  | { name: 'home' }
  | { name: 'packs' }
  | { name: 'dashboard' }
  | { name: 'study'; items: SessionItem[] }
  | { name: 'rapid-pick' }
  | { name: 'rapid'; items: RapidItem[] }
  // No session result when drills are launched on their own from the
  // dashboard's mix-up list; the summary then shows only the drill score.
  | { name: 'drills'; drills: Drill[]; result?: SessionResult }
  | { name: 'summary'; result?: SessionResult; drills?: DrillResult }

export function App() {
  const [index, setIndex] = useState<CountryIndex | null>(null)
  const { snapshot, reload } = useStudyStore()
  const [screen, setScreen] = useState<Screen>({ name: 'home' })

  useEffect(() => {
    void loadIndex().then(setIndex)
  }, [])

  // Phones treat the back gesture as the universal "leave this screen", but a
  // purely state-driven SPA creates no history entries, so each swipe walked
  // out of the document itself — and a few in a row stranded the user on a
  // blank restored page (#2). Every departure from home pushes exactly one
  // entry, and screens that replace one another mid-flow (study → drills →
  // summary) share it: back always means "back to home", and only from home
  // does the gesture actually leave the app.
  const enter = (next: Screen) => {
    if (screen.name === 'home') window.history.pushState({ screen: next.name }, '')
    else window.history.replaceState({ screen: next.name }, '')
    setScreen(next)
  }

  // In-app Back buttons travel through history so the pushed entry is
  // consumed; the popstate handler performs the actual screen change.
  const leave = () => window.history.back()

  useEffect(() => {
    // Only home can be rebuilt from scratch — study and rapid queues live in
    // memory — so every history traversal, backward or forward, resolves to
    // home. A sub-screen marker on the landed entry is scrubbed so the entry
    // behaves as a home entry from here on.
    const onPop = () => {
      if (window.history.state?.screen) window.history.replaceState(null, '')
      reload()
      setScreen({ name: 'home' })
    }
    // A full reload renders home no matter which entry it happened on.
    if (window.history.state?.screen) window.history.replaceState(null, '')
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [reload])

  useEffect(() => {
    // Coming back from the back/forward cache: the tree is alive but the
    // snapshot may predate answers flushed after the page was frozen.
    const onShow = (e: PageTransitionEvent) => e.persisted && reload()
    window.addEventListener('pageshow', onShow)
    return () => window.removeEventListener('pageshow', onShow)
  }, [reload])

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
        terrain={snapshot.settings.terrain}
        onDone={(result) => {
          reload()
          // Drills come from the store directly, not the React snapshot: the
          // wrong clicks made seconds ago in this very session are the
          // freshest — and most drillable — confusions of all.
          const drills = buildDrills(store.snapshot().stats.confusion, index)
          if (drills.length) enter({ name: 'drills', drills, result })
          else enter({ name: 'summary', result })
        }}
        onQuit={leave}
      />
    )
  }

  if (screen.name === 'rapid-pick') {
    return (
      <RapidPickerView
        index={index}
        snapshot={snapshot}
        onBack={leave}
        onPick={(slug) => {
          const items = buildRapidQueue(index, snapshot.cards, new Date(), undefined, Math.random, slug ?? undefined)
          if (items.length) enter({ name: 'rapid', items })
        }}
      />
    )
  }

  if (screen.name === 'rapid') {
    return (
      <RapidView
        items={screen.items}
        index={index}
        terrain={snapshot.settings.terrain}
        onDone={(result) => {
          reload()
          enter({ name: 'summary', result })
        }}
        onQuit={leave}
      />
    )
  }

  if (screen.name === 'drills') {
    return (
      <DrillView
        drills={screen.drills}
        index={index}
        terrain={snapshot.settings.terrain}
        onDone={(drillResult) => {
          reload()
          enter({ name: 'summary', result: screen.result, drills: drillResult })
        }}
      />
    )
  }

  if (screen.name === 'dashboard') {
    return (
      <DashboardView
        index={index}
        snapshot={snapshot}
        onBack={leave}
        onChanged={reload}
        onSprint={(items) => {
          if (items.length) enter({ name: 'rapid', items })
        }}
        onDrill={(drills) => {
          if (drills.length) enter({ name: 'drills', drills })
        }}
      />
    )
  }

  if (screen.name === 'packs') {
    return (
      <PacksView
        index={index}
        snapshot={snapshot}
        onBack={leave}
        onChanged={reload}
      />
    )
  }

  if (screen.name === 'summary') {
    const { answered = 0, correct = 0, introduced = 0, elapsedMs = 0 } = screen.result ?? {}
    const accuracy = answered ? Math.round((correct / answered) * 100) : 0
    return (
      <div className="home">
        <h1>{screen.result ? 'Session done' : 'Drills done'}</h1>
        <div className="stats">
          {screen.result && (
            <>
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
            </>
          )}
          {screen.drills && (
            <div className="stat">
              <strong>
                {screen.drills.correct}/{screen.drills.asked}
              </strong>
              <span>drills</span>
            </div>
          )}
        </div>
        <button className="primary big" onClick={leave}>
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
      onStart={() => enter({ name: 'study', items: pending })}
      canBoost={canBoost}
      onBoost={() => {
        void store.grantBoost(BOOST_STEP, today(new Date())).then(reload)
      }}
      onRapid={() => enter({ name: 'rapid-pick' })}
      onPacks={() => enter({ name: 'packs' })}
      onDashboard={() => enter({ name: 'dashboard' })}
      onReload={reload}
    />
  )
}
