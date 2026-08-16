import { useEffect, useState } from 'react'
import { GeoMap } from './map/GeoMap'
import type { MapView } from './map/projection'
import { loadIndex, type CountryIndex } from './data/load'
import type { MarkRole } from './map/GeoMap'

/**
 * Temporary harness for milestone 2: renders every map view and reports what
 * was clicked, so projection fitting and tap targets can be checked by hand
 * before the study loop exists.
 */
export function App() {
  const [index, setIndex] = useState<CountryIndex | null>(null)
  const [view, setView] = useState<MapView>({ kind: 'world' })
  const [picked, setPicked] = useState<string | null>(null)

  useEffect(() => {
    loadIndex().then(setIndex)
  }, [])

  if (!index) return <p style={{ padding: 24 }}>Loading…</p>

  const marks: Record<string, MarkRole> = picked ? { [picked]: 'target' } : {}
  const country = picked ? index.byIso3.get(picked) : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <select
          value={view.kind === 'world' ? 'world' : view.slug}
          onChange={(e) =>
            setView(e.target.value === 'world' ? { kind: 'world' } : { kind: 'region', slug: e.target.value })
          }
          style={{ padding: 10, background: 'var(--panel)', color: 'var(--text)', borderRadius: 10, border: '1px solid #334155' }}
        >
          <option value="world">World ({index.bundle.countries.length})</option>
          {index.bundle.regions
            .slice()
            .sort((a, b) => a.order - b.order)
            .map((r) => (
              <option key={r.slug} value={r.slug}>
                {r.name} ({r.countries.length})
              </option>
            ))}
        </select>
        <span style={{ color: 'var(--muted)' }}>
          {country ? `${country.flag} ${country.name} — ${country.subregion}` : 'tap a country'}
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0 }}>
        <GeoMap
          view={view}
          marks={marks}
          labels={picked ? [picked] : []}
          onPick={setPicked}
        />
      </div>
    </div>
  )
}
