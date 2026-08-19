import { useMemo, useState } from 'react'
import type { CountryIndex } from '../data/load'
import { recallFill } from '../map/colors'
import { GeoMap } from '../map/GeoMap'
import { APP_URL, buildShareCardSvg, progressCardContent, svgToPngBlob } from '../share/shareCard'
import { buildOutlook, formatEta } from '../stats/outlook'
import type { StudySnapshot } from '../store/store'

export { recallFill }

interface DashboardViewProps {
  index: CountryIndex
  snapshot: StudySnapshot
  onBack: () => void
}

export function DashboardView({ index, snapshot, onBack }: DashboardViewProps) {
  const outlook = useMemo(() => buildOutlook(index, snapshot, new Date()), [index, snapshot])
  const [shareState, setShareState] = useState<'idle' | 'busy' | 'saved'>('idle')

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
        <GeoMap view={{ kind: 'world' }} fills={fills} />
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
            <tr key={r.slug}>
              <td>{r.name}</td>
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
          ))}
        </tbody>
      </table>
      <p className="muted small">
        ETA is when the region's last country becomes durably known — introduction queue at your
        recent pace, then maturation simulated with the real scheduler assuming steady correct
        answers. “—” means the region is in no started pack.
      </p>
    </div>
  )
}
