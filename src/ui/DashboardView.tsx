import { useMemo, useState } from 'react'
import type { CountryIndex } from '../data/load'
import { recallFill } from '../map/colors'
import { GeoMap } from '../map/GeoMap'
import { buildDrills, DRILL_MIN_CONFUSIONS, type Drill } from '../session/drills'
import { buildRapidQueue, buildTargetedQueue, type RapidItem } from '../session/rapid'
import { APP_URL, buildShareCardSvg, progressCardContent, svgToPngBlob } from '../share/shareCard'
import type { DeclareLevel } from '../srs/seed'
import { activityByDay, topConfusions, troubleSpots, weakAreas } from '../stats/insights'
import { buildOutlook, cityMastery, countryMastery, formatEta } from '../stats/outlook'
import type { StudySnapshot } from '../store/store'
import type { CityRecord } from '../types'
import { store } from '../store/useStore'

export { recallFill }

interface DashboardViewProps {
  index: CountryIndex
  snapshot: StudySnapshot
  onBack: () => void
  onChanged: () => void
  onSprint: (items: RapidItem[]) => void
  onDrill: (drills: Drill[]) => void
}

export function DashboardView({ index, snapshot, onBack, onChanged, onSprint, onDrill }: DashboardViewProps) {
  const now = useMemo(() => new Date(), [])
  const outlook = useMemo(() => buildOutlook(index, snapshot, now), [index, snapshot, now])
  const spots = useMemo(() => troubleSpots(index, snapshot.cards, snapshot.stats), [index, snapshot])
  const areas = useMemo(() => weakAreas(index, snapshot.cards, snapshot.stats), [index, snapshot])
  const mixups = useMemo(
    () => topConfusions(snapshot.stats.confusion, index, DRILL_MIN_CONFUSIONS),
    [index, snapshot],
  )
  const activity = useMemo(() => activityByDay(snapshot.stats.daily, now), [snapshot, now])
  const [shareState, setShareState] = useState<'idle' | 'busy' | 'saved'>('idle')
  const [openRegion, setOpenRegion] = useState<string | null>(null)
  // Two audiences, one screen: Overview answers "how far along am I?",
  // Analytics answers "what is going wrong and what do I do about it?".
  // A local tab keeps the back gesture meaning "home" from either.
  const [tab, setTab] = useState<'overview' | 'analytics'>('overview')

  async function declare(iso3: string, level: DeclareLevel) {
    await store.declareCountry(iso3, level, new Date())
    onChanged()
  }

  async function declareCity(city: CityRecord, level: DeclareLevel) {
    await store.declareCity(city, level, new Date())
    onChanged()
  }

  /** Render the choropleth card and hand it to the OS share sheet — a shared
   *  image displays natively in Discord and friends, which a static site's
   *  link preview never could (the crawler cannot see this browser's
   *  progress). Fallback: save the PNG. */
  async function shareProgress() {
    setShareState('busy')
    try {
      const content = await progressCardContent(index, snapshot, new Date())
      const blob = await svgToPngBlob(buildShareCardSvg(content))
      const file = new File([blob], 'geography-bee-progress.png', { type: 'image/png' })
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Geography Bee', text: `${content.headline} — ${APP_URL}` })
        setShareState('idle')
      } else {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = file.name
        a.click()
        URL.revokeObjectURL(url)
        setShareState('saved')
        setTimeout(() => setShareState('idle'), 2000)
      }
    } catch {
      // Dismissing the share sheet rejects; that is not an error.
      setShareState('idle')
    }
  }

  const fills: Record<string, string> = {}
  for (const [iso3, s] of outlook.countries) {
    const fill = recallFill(s.recall, s.seen)
    if (fill) fills[iso3] = fill
  }

  const pct = (n: number, total: number) => (total ? Math.round((n / total) * 100) : 0)

  const windowReviews = activity.reduce((sum, d) => sum + d.reviews, 0)
  const windowCorrect = activity.reduce((sum, d) => sum + d.correct, 0)
  const maxReviews = Math.max(1, ...activity.map((d) => d.reviews))

  const countryName = (iso3: string) => {
    const c = index.byIso3.get(iso3)
    return c ? `${c.flag} ${c.name}` : iso3
  }

  return (
    <div className="home dashboard">
      <header className="packs-head">
        <button className="ghost" onClick={onBack}>
          ← Back
        </button>
        <h1>Progress</h1>
      </header>

      <div className="tab-bar">
        <button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>
          Overview
        </button>
        <button className={tab === 'analytics' ? 'active' : ''} onClick={() => setTab('analytics')}>
          Analytics
        </button>
      </div>

      {tab === 'overview' && (
        <>
          <div className="stats">
            <div className="stat">
              <strong>{outlook.streakDays}</strong>
              <span>day streak</span>
            </div>
            <div className="stat">
              <strong>{Math.round(outlook.reviewsPerDay)}</strong>
              <span>reviews/day</span>
            </div>
            <div className="stat">
              <strong>{outlook.introPerDay.toFixed(1)}</strong>
              <span>new cards/day</span>
            </div>
            <div className="stat">
              <strong>{outlook.overall.mastered}</strong>
              <span>mastered</span>
            </div>
          </div>

          <div className="dash-map">
            <GeoMap view={{ kind: 'world', trim: true }} fills={fills} />
          </div>
          <div className="legend">
            <span className="chip" style={{ background: 'var(--land)' }} /> unseen
            <span className="chip" style={{ background: recallFill(0.2, true) }} /> fading
            <span className="chip" style={{ background: recallFill(0.6, true) }} /> holding
            <span className="chip" style={{ background: recallFill(1, true) }} /> solid
            <button className="ghost share-map" onClick={() => void shareProgress()} disabled={shareState === 'busy'}>
              {shareState === 'busy' ? 'Rendering…' : shareState === 'saved' ? 'Saved ✓' : '↗ Share map'}
            </button>
          </div>

          <div className="eta-headline">
            <strong>
              Whole world mastered: {formatEta(outlook.overall.etaDays)}
            </strong>
            <span className="muted">
              {outlook.overall.mastered}/{outlook.overall.total} countries solid on both map cards, at your
              current pace of {outlook.introPerDay.toFixed(1)} new cards a day. Estimates, not promises.
            </span>
          </div>
        </>
      )}

      {tab === 'analytics' && (
        <>
          {windowReviews > 0 && (
            <section className="insight">
              <div className="insight-head">
                <h2>Last 4 weeks</h2>
                <span className="muted small">
                  {windowReviews} reviews · {pct(windowCorrect, windowReviews)}% first-try
                </span>
              </div>
              <div className="activity-bars">
                {activity.map((d) => (
                  <div key={d.day} className="abar-slot" title={`${d.day}: ${d.reviews} reviews`}>
                    {d.reviews > 0 && (
                      <div
                        className="abar"
                        style={{
                          height: `${Math.max(8, Math.round((d.reviews / maxReviews) * 100))}%`,
                          background: recallFill(d.reviews ? d.correct / d.reviews : 0, true),
                        }}
                      />
                    )}
                  </div>
                ))}
              </div>
              <p className="muted small">
                Bar height is reviews that day; colour is that day's first-try accuracy on the usual
                fading–solid scale.
              </p>
            </section>
          )}

          {spots.length > 0 && (
            <section className="insight">
              <div className="insight-head">
                <h2>Trouble spots</h2>
                <button
                  className="ghost sprint"
                  onClick={() => onSprint(buildTargetedQueue(index, snapshot.cards, spots.map((s) => s.iso3)))}
                >
                  ⚡ Sprint these
                </button>
              </div>
              {areas.length > 0 && (
                <div className="weak-areas">
                  {areas.map((a) => (
                    <button
                      key={a.slug}
                      className="ghost weak-area"
                      onClick={() =>
                        onSprint(buildRapidQueue(index, snapshot.cards, new Date(), undefined, Math.random, a.slug))
                      }
                    >
                      ⚡ {a.name}
                      <span className="muted">
                        {' '}
                        · {a.spots} of {a.seen} shaky
                      </span>
                    </button>
                  ))}
                </div>
              )}
              <div className="spot-list">
                {spots.map((s) => (
                  <div key={s.iso3} className="spot-row">
                    <span className="cname">{countryName(s.iso3)}</span>
                    <div className="minibar miss">
                      <div className="fill" style={{ width: `${Math.round(s.missRate * 100)}%` }} />
                    </div>
                    <span className="muted spot-detail">
                      missed {s.lapses}/{s.reps} · {s.avgSeconds.toFixed(0)}s avg
                    </span>
                  </div>
                ))}
              </div>
              <p className="muted small">
                Map cards you keep getting wrong, worst first — miss rate weighted by how hard the
                scheduler currently rates the card, so an old rough patch fades once a country settles.
                Sprint runs a rapid round over exactly this list; the region buttons sprint a whole
                weak area instead.
              </p>
            </section>
          )}

          {mixups.length > 0 && (
            <section className="insight">
              <div className="insight-head">
                <h2>Frequent mix-ups</h2>
                <button
                  className="ghost sprint"
                  onClick={() => onDrill(buildDrills(snapshot.stats.confusion, index))}
                >
                  🎯 Drill these
                </button>
              </div>
              <div className="spot-list">
                {mixups.map((m) => (
                  <div key={`${m.a}|${m.b}`} className="spot-row">
                    <span className="cname">
                      {countryName(m.a)} ↔ {countryName(m.b)}
                    </span>
                    <span className="muted spot-detail">×{m.count}</span>
                  </div>
                ))}
              </div>
              <p className="muted small">
                Pairs you have swapped on the map, both directions pooled. Drilling shows both and asks
                you to tell them apart; each correct discrimination decays a pair's count until it
                leaves this list.
              </p>
            </section>
          )}

          {windowReviews === 0 && spots.length === 0 && mixups.length === 0 && (
            <p className="muted">Nothing to diagnose yet — these fill in as you review.</p>
          )}
        </>
      )}

      {tab === 'overview' && (
        <>
          <table className="region-table">
            <thead>
              <tr>
                <th>Region</th>
                <th>Mastered</th>
                <th></th>
                <th>ETA</th>
              </tr>
            </thead>
            <tbody>
              {outlook.regions.map((r) => (
                <RegionRows
                  key={r.slug}
                  region={r}
                  open={openRegion === r.slug}
                  onToggle={() => setOpenRegion(openRegion === r.slug ? null : r.slug)}
                  index={index}
                  snapshot={snapshot}
                  outlook={outlook}
                  onDeclare={declare}
                  onDeclareCity={declareCity}
                  pct={pct}
                />
              ))}
            </tbody>
          </table>
          <p className="muted small">
            ETA is when the region's last country becomes durably known — introduction queue at your
            recent pace, then maturation simulated with the real scheduler assuming steady correct
            answers. “—” means the region is in no started pack. Tap a region for its countries;
            declaring one known queues a single confirming review per map card.
          </p>
        </>
      )}
    </div>
  )
}

interface RegionRowsProps {
  region: ReturnType<typeof buildOutlook>['regions'][number]
  open: boolean
  onToggle: () => void
  index: CountryIndex
  snapshot: StudySnapshot
  outlook: ReturnType<typeof buildOutlook>
  onDeclare: (iso3: string, level: DeclareLevel) => Promise<void>
  onDeclareCity: (city: CityRecord, level: DeclareLevel) => Promise<void>
  pct: (n: number, total: number) => number
}

/** One region's summary row, expanding into its countries: name, position on
 *  the mastery scale, and — until a country is solid — a declare button.
 *  "Know it" claims the learned tier; from halfway up, "Know it cold" claims
 *  full mastery. Both are upgrades only, and each queues a confirming pass. */
function RegionRows({ region: r, open, onToggle, index, snapshot, outlook, onDeclare, onDeclareCity, pct }: RegionRowsProps) {
  const [openCountry, setOpenCountry] = useState<string | null>(null)
  return (
    <>
      <tr className="region-row" onClick={onToggle}>
        <td>
          <span className="chev">{open ? '▾' : '▸'}</span> {r.name}
        </td>
        <td className="num">
          {r.mastered}/{r.total}
        </td>
        <td className="barcell">
          <div className="minibar">
            <div className="fill" style={{ width: `${pct(r.mastered, r.total)}%` }} />
            <div className="seen" style={{ width: `${pct(r.seen, r.total)}%` }} />
          </div>
        </td>
        <td className="num">{formatEta(r.etaDays)}</td>
      </tr>
      {open && (
        <tr className="country-detail">
          <td colSpan={4}>
            <div className="country-list">
              {(index.regionBySlug.get(r.slug)?.countries ?? []).map((iso3) => {
                const country = index.byIso3.get(iso3)
                const standing = outlook.countries.get(iso3)
                const mastery = countryMastery(snapshot.cards, iso3)
                const level: DeclareLevel = mastery < 0.5 ? 'learned' : 'mastered'
                const cities = index.cities.byCountry.get(iso3) ?? []
                const citiesOpen = openCountry === iso3
                return (
                  <div key={iso3}>
                    <div className="country-row">
                      <button
                        className="ghost cname"
                        onClick={() => setOpenCountry(citiesOpen ? null : iso3)}
                      >
                        <span className="chev">{citiesOpen ? '▾' : '▸'}</span> {country?.flag}{' '}
                        {country?.name ?? iso3}
                      </button>
                      <div className="minibar">
                        <div className="fill" style={{ width: `${Math.round(mastery * 100)}%` }} />
                      </div>
                      <span className="cm-pct muted">
                        {!standing?.seen ? 'unseen' : `${Math.round(mastery * 100)}%`}
                      </span>
                      {standing?.mastered ? (
                        <span className="solid-check">✓ solid</span>
                      ) : (
                        <button className="ghost declare" onClick={() => void onDeclare(iso3, level)}>
                          {level === 'learned' ? 'Know it' : 'Know it cold'}
                        </button>
                      )}
                    </div>
                    {citiesOpen &&
                      cities.map((city) => {
                        const cm = cityMastery(snapshot.cards, city.id)
                        const seen = cm > 0
                        const solid = cm >= 1
                        const cityLevel: DeclareLevel = cm < 0.5 ? 'learned' : 'mastered'
                        return (
                          <div key={city.id} className="country-row city-row">
                            <span className="cname">
                              {city.name}
                              {city.capital && <span className="cap-tag"> capital</span>}
                            </span>
                            <div className="minibar">
                              <div className="fill" style={{ width: `${Math.round(cm * 100)}%` }} />
                            </div>
                            <span className="cm-pct muted">{!seen ? 'unseen' : `${Math.round(cm * 100)}%`}</span>
                            {solid ? (
                              <span className="solid-check">✓ solid</span>
                            ) : (
                              <button
                                className="ghost declare"
                                onClick={() => void onDeclareCity(city, cityLevel)}
                              >
                                {cityLevel === 'learned' ? 'Know it' : 'Know it cold'}
                              </button>
                            )}
                          </div>
                        )
                      })}
                  </div>
                )
              })}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
