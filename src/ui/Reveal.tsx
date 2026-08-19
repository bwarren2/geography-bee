import { useEffect, useState } from 'react'
import { GeoMap } from '../map/GeoMap'
import type { MarkRole } from '../map/GeoMap'
import { loadHooks, type CountryHook, type CountryIndex } from '../data/load'
import type { CountryRecord } from '../types'

const fmt = new Intl.NumberFormat('en-US')

/** Context shown after every answer. Facts are not tested here — their job is
 *  to give the shape a story so the location has something to hang on. */
function facts(country: CountryRecord, index: CountryIndex): string[] {
  const out: string[] = []
  if (country.capital.length) out.push(`Capital: ${country.capital.join(', ')}`)
  if (country.population) out.push(`Population: ${fmt.format(country.population)}`)
  out.push(`Area: ${fmt.format(Math.round(country.areaKm2))} km²`)
  if (country.languages.length) out.push(`Language: ${country.languages.slice(0, 3).join(', ')}`)
  if (country.currencies.length) out.push(`Currency: ${country.currencies[0]!.name}`)

  if (country.landlocked) out.push('Landlocked')
  else if (country.coastlineKm) out.push(`Coastline: ${fmt.format(Math.round(country.coastlineKm))} km`)

  if (country.borders.length) {
    const names = country.borders.map(
      (b) => index.byIso3.get(b)?.name ?? index.bundle.territoryNames[b] ?? b,
    )
    out.push(`Borders: ${names.join(', ')}`)
  }
  if (country.nationalDish) out.push(`National dish: ${country.nationalDish}`)
  return out
}

interface RevealProps {
  terrain?: boolean
  country: CountryRecord
  index: CountryIndex
  correct: boolean
  /** What was picked instead, when that was a country. */
  chosen?: string
  onNext: () => void
}

export function Reveal({ country, index, terrain, correct, chosen, onNext }: RevealProps) {
  const [hook, setHook] = useState<CountryHook | null>(null)
  useEffect(() => {
    let live = true
    void loadHooks().then((h) => live && setHook(h.get(country.iso3) ?? null))
    return () => {
      live = false
    }
  }, [country.iso3])

  const marks: Record<string, MarkRole> = { [country.iso3]: correct ? 'correct' : 'target' }
  for (const b of country.borders) marks[b] ??= 'context'
  if (chosen && chosen !== country.iso3) marks[chosen] = 'wrong'

  const labels = [country.iso3, ...country.borders.slice(0, 8)]
  if (chosen) labels.push(chosen)

  return (
    <div className="reveal">
      <header className={correct ? 'verdict good' : 'verdict bad'}>
        <span className="flag">{country.flag}</span>
        <div>
          <strong>{country.name}</strong>
          {!correct && chosen && chosen !== country.iso3 && (
            <div className="muted">you picked {index.byIso3.get(chosen)?.name ?? chosen}</div>
          )}
        </div>
      </header>

      <div className="reveal-map">
        <GeoMap view={{ kind: 'region', slug: country.region }} marks={marks} labels={labels} terrain={terrain} />
      </div>

      {hook && (
        <div className="hook">
          <p>{hook.hook}</p>
          <p className="place">{hook.place}</p>
          {hook.exports.length > 0 && <p className="place">Exports: {hook.exports.join(', ')}</p>}
        </div>
      )}

      <ul className="facts">
        {facts(country, index).map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>

      <button className="primary" onClick={onNext} autoFocus>
        Next
      </button>
    </div>
  )
}
