import { useMemo, useState } from 'react'
import type { CountryIndex } from '../data/load'
import { recallFill } from '../map/colors'
import { GeoMap } from '../map/GeoMap'
import { APP_URL, buildShareCardSvg, progressCardContent, svgToPngBlob } from '../share/shareCard'
import type { DeclareLevel } from '../srs/seed'
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
}

export function DashboardView({ index, snapshot, onBack, onChanged }: DashboardViewProps) {
  const outlook = useMemo(() => buildOutlook(index, snapshot, new Date()), [index, snapshot])
  const [shareState, setShareState] = useState<'idle' | 'busy' | 'saved'>('idle')
  const [openRegion, setOpenRegion] = useState<string | null>(null)

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

  return (
    <div className="home dashboard">
      <header className="packs-head">
        <button className="ghost" onClick={onBack}>
          ← Back
        </button>
        <h1>Progress</h1>
      </header>

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
