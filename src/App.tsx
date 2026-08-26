import { useEffect, useMemo, useState } from 'react'
import { loadIndex, type CountryIndex } from './data/load'
import { BOOST_STEP, buildSession, today, type SessionItem } from './session/builder'
import {
  buildChallengeOrder,
  summarizeRun,
  type ChallengeRun,
  type ChallengeSummary,
} from './session/challenge'
import { buildDrills, type Drill } from './session/drills'
import { buildRapidQueue, RAPID_MIN_SEEN, type RapidItem } from './session/rapid'
import { store, useStudyStore } from './store/useStore'
import type { CountryRecord } from './types'
import { ChallengeView } from './ui/ChallengeView'
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
  | { name: 'challenge'; countries: CountryRecord[] }
  | { name: 'challenge-summary'; summary: ChallengeSummary; prev: ChallengeSummary | null; run: ChallengeRun }
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
        onChallenge={() => enter({ name: 'challenge', countries: buildChallengeOrder(index) })}
      />
    )
  }

  if (screen.name === 'challenge') {
    return (
      <ChallengeView
        countries={screen.countries}
        index={index}
        onQuit={leave}
        onDone={(run) => {
          const summary = summarizeRun(run)
          // The previous summary is read before this run is recorded, so the
          // results screen can say how this attempt compares to the last one.
          const prev = snapshot.challenges.summaries.at(-1) ?? null
          void store.recordChallenge(run, summary).then(reload)
          enter({ name: 'challenge-summary', summary, prev, run })
        }}
      />
    )
  }

  if (screen.name === 'challenge-summary') {
    const { summary: s, prev, run } = screen
    const pctOf = (x: ChallengeSummary) => Math.round((x.correct / x.total) * 100)
    const worst = run.answers
      .filter((a) => !a.correct)
      .sort((a, b) => b.missKm - a.missKm)
      .slice(0, 8)
    const delta = prev ? s.correct - prev.correct : null
    return (
      <div className="home">
        <h1>World Challenge</h1>
        <div className="stats">
          <div className="stat">
            <strong>
              {s.correct}/{s.total}
            </strong>
            <span>countries</span>
          </div>
          <div className="stat">
            <strong>{pctOf(s)}%</strong>
            <span>accuracy</span>
          </div>
          <div className="stat">
            <strong>{s.meanMissKm}km</strong>
            <span>mean miss</span>
          </div>
          <div className="stat">
            <strong>{(s.medianMs / 1000).toFixed(1)}s</strong>
            <span>median</span>
          </div>
        </div>
        {prev && (
          <p className="muted centered">
            Last run: {prev.correct}/{prev.total} · mean miss {prev.meanMissKm}km —{' '}
            {delta === 0
              ? 'same score'
              : `${delta! > 0 ? '+' : ''}${delta} countries`}
            {s.meanMissKm !== prev.meanMissKm &&
              `, misses ${s.meanMissKm < prev.meanMissKm ? 'closer' : 'wider'} by ${Math.abs(
                s.meanMissKm - prev.meanMissKm,
              )}km`}
          </p>
        )}
        {worst.length > 0 && (
          <section className="insight">
            <h2>Farthest misses</h2>
            <div className="spot-list">
              {worst.map((a) => (
                <div key={a.iso3} className="spot-row">
                  <span className="cname">
                    {index.byIso3.get(a.iso3)?.flag} {index.byIso3.get(a.iso3)?.name ?? a.iso3}
                  </span>
                  <span className="muted spot-detail">
                    tapped {index.byIso3.get(a.chosen)?.name ?? a.chosen} · {a.missKm}km off
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}
        <button className="primary big" onClick={leave}>
          Back
        </button>
      </div>
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
