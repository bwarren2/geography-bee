import { useMemo } from 'react'
import type { CountryIndex } from '../data/load'
import { recallFill } from '../map/colors'
import { GeoMap } from '../map/GeoMap'
import { challengeTitle, summarizeRun, type ChallengeRun } from '../session/challenge'
import {
  missAxisTicks,
  missDotplot,
  regionBreakdown,
  timeHistogram,
} from '../stats/challengeInsights'

interface ChallengeRunViewProps {
  run: ChallengeRun
  index: CountryIndex
  onBack: () => void
}

const DOT_W = 360
const DOT_H = 96
const DOT_PAD = 12

/**
 * One run under the microscope: an error choropleth (every country green or
 * red for exactly this run), error rate by world area, every miss as a dot
 * on a distance axis, and a histogram of answer times. All of it reads the
 * stored per-answer detail, so an old run's breakdown never changes.
 */
export function ChallengeRunView({ run, index, onBack }: ChallengeRunViewProps) {
  const summary = useMemo(() => summarizeRun(run), [run])
  const regions = useMemo(() => regionBreakdown(run, index), [run, index])
  const histogram = useMemo(() => timeHistogram(run.answers), [run])
  const maxMissKm = Math.max(1, ...run.answers.map((a) => a.missKm))
  const dots = useMemo(() => missDotplot(run.answers), [run])

  const fills: Record<string, string> = {}
  for (const a of run.answers) {
    fills[a.iso3] = recallFill(a.correct ? 1 : 0, true)!
  }

  const shakyRegions = regions.filter((r) => r.wrong > 0)
  const cleanCount = regions.length - shakyRegions.length
  const maxCount = Math.max(1, ...histogram.map((b) => b.count))
  const maxRow = Math.max(1, ...dots.map((d) => Math.abs(d.row)))
  const dotY = (row: number) => DOT_H / 2 + row * Math.min(9, (DOT_H / 2 - 8) / maxRow)
  const dotX = (x: number) => DOT_PAD + x * (DOT_W - 2 * DOT_PAD)

  return (
    <div className="home dashboard">
      <header className="packs-head">
        <button className="ghost" onClick={onBack}>
          ← Back
        </button>
        <h1>{challengeTitle(run.mode)}</h1>
      </header>
      <p className="muted run-date">
        {new Date(run.at).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}
        {run.terrain ? ' · 🛰️ satellite terrain' : ''}
      </p>

      <div className="stats">
        <div className="stat">
          <strong>
            {summary.correct}/{summary.total}
          </strong>
          <span>countries</span>
        </div>
        <div className="stat">
          <strong>{Math.round((summary.correct / summary.total) * 100)}%</strong>
          <span>accuracy</span>
        </div>
        <div className="stat">
          <strong>{summary.meanMissKm}km</strong>
          <span>mean miss</span>
        </div>
        <div className="stat">
          <strong>{(summary.medianMs / 1000).toFixed(1)}s</strong>
          <span>median</span>
        </div>
      </div>

      <div className="dash-map">
        <GeoMap view={{ kind: 'world', trim: true }} fills={fills} />
      </div>
      <p className="muted small">
        This run, country by country: green answered right, red missed.
      </p>

      <section className="insight">
        <h2>Error rate by world area</h2>
        <div className="spot-list">
          {shakyRegions.map((r) => (
            <div key={r.slug} className="spot-row">
              <span className="cname">{r.name}</span>
              <div className="minibar miss">
                <div className="fill" style={{ width: `${Math.round((r.wrong / r.total) * 100)}%` }} />
              </div>
              <span className="muted spot-detail">
                missed {r.wrong}/{r.total}
              </span>
            </div>
          ))}
        </div>
        <p className="muted small">
          {shakyRegions.length === 0
            ? 'A clean sweep — every region perfect.'
            : cleanCount > 0
              ? `Worst areas first; ${cleanCount} ${cleanCount === 1 ? 'region was' : 'regions were'} error-free.`
              : 'Worst areas first.'}
        </p>
      </section>

      {dots.length > 0 && (
        <section className="insight">
          <h2>How far the misses landed</h2>
          <svg
            className="dotplot"
            viewBox={`0 0 ${DOT_W} ${DOT_H + 18}`}
            role="img"
            aria-label="Each dot is one miss, placed by its distance from the target"
          >
            <line
              x1={DOT_PAD}
              y1={DOT_H / 2}
              x2={DOT_W - DOT_PAD}
              y2={DOT_H / 2}
              stroke="var(--line)"
              strokeWidth={1}
            />
            {missAxisTicks(maxMissKm).map((t) => (
              <g key={t}>
                <line
                  x1={dotX(Math.sqrt(t / maxMissKm))}
                  y1={DOT_H / 2 - 4}
                  x2={dotX(Math.sqrt(t / maxMissKm))}
                  y2={DOT_H / 2 + 4}
                  stroke="var(--line)"
                  strokeWidth={1}
                />
                <text
                  x={dotX(Math.sqrt(t / maxMissKm))}
                  y={DOT_H + 12}
                  textAnchor="middle"
                  fontSize={10}
                  fill="var(--muted)"
                >
                  {t >= 1000 ? `${t / 1000}k` : `${t}km`}
                </text>
              </g>
            ))}
            {dots.map((d) => (
              <circle key={`${d.iso3}-${d.missKm}`} cx={dotX(d.x)} cy={dotY(d.row)} r={3.4} className="miss-dot">
                <title>
                  {index.byIso3.get(d.iso3)?.name ?? d.iso3}: {d.missKm}km
                </title>
              </circle>
            ))}
          </svg>
          <p className="muted small">
            One dot per miss on a square-root distance scale — near misses get room, and the goal
            over runs is the whole swarm sliding left. Farthest:{' '}
            {index.byIso3.get(dots.at(-1)!.iso3)?.name} at {dots.at(-1)!.missKm}km.
          </p>
        </section>
      )}

      <section className="insight">
        <h2>Time per answer</h2>
        <div className="histo">
          {histogram.map((b) => (
            <div key={b.label} className="histo-col" title={`${b.label}s: ${b.count}`}>
              <span className="histo-count">{b.count > 0 ? b.count : ''}</span>
              <div className="histo-track">
                {b.count > 0 && (
                  <div className="histo-bar" style={{ height: `${Math.max(4, (b.count / maxCount) * 100)}%` }} />
                )}
              </div>
              <span className="histo-label">{b.label}</span>
            </div>
          ))}
        </div>
        <p className="muted small">
          Seconds per answer across all {summary.total} countries. Recall you actually own sits in
          the leftmost bars; a long right tail is searching, not knowing.
        </p>
      </section>
    </div>
  )
}
