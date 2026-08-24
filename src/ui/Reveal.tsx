import { useEffect, useState } from 'react'
import { GeoMap } from '../map/GeoMap'
import type { CityMark, MarkRole } from '../map/GeoMap'
import { loadCityHooks, loadDishPhotos, loadHooks, type CountryHook, type CountryIndex, type DishPhoto } from '../data/load'
import type { CityRecord, CountryRecord } from '../types'

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
  // The national dish renders separately: its pill expands into a photo.
  return out
}

interface RevealProps {
  terrain?: boolean
  country: CountryRecord
  /** Set for city cards: the reveal then anchors the city, not the country. */
  city?: CityRecord
  /** Where a missed city tap landed, to show against the real position. */
  tappedAt?: [number, number]
  index: CountryIndex
  correct: boolean
  /** What was picked instead, when that was a country. */
  chosen?: string
  onNext: () => void
}

export function Reveal({ country, city, tappedAt, index, terrain, correct, chosen, onNext }: RevealProps) {
  const [hook, setHook] = useState<CountryHook | null>(null)
  const [cityHook, setCityHook] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    if (city) void loadCityHooks().then((h) => live && setCityHook(h.get(city.id) ?? null))
    else void loadHooks().then((h) => live && setHook(h.get(country.iso3) ?? null))
    return () => {
      live = false
    }
  }, [country.iso3, city])

  if (city) {
    const dots: CityMark[] = [
      { lonlat: city.lonlat, role: correct ? 'correct' : 'target', label: city.name },
    ]
    if (tappedAt) dots.push({ lonlat: tappedAt, role: 'wrong' })
    // Sibling cities anchor the miss: seeing Ottawa beside Toronto is the
    // lesson, the same way neighbours label a country reveal.
    for (const sibling of index.cities.byCountry.get(city.iso3) ?? []) {
      if (sibling.id !== city.id) dots.push({ lonlat: sibling.lonlat, role: 'context', label: sibling.name })
    }

    const cityFacts = [
      city.capital ? `Capital of ${country.name}` : `Major city in ${country.name}`,
      ...(city.popM ? [`Population: ~${city.popM}M`] : []),
      ...(city.altNames.length ? [`Also: ${city.altNames.join(', ')}`] : []),
    ]

    return (
      <div className="reveal">
        <header className={correct ? 'verdict good' : 'verdict bad'}>
          <span className="flag">{country.flag}</span>
          <div>
            <strong>{city.name}</strong>
            {!correct && chosen && index.cities.byId.has(chosen) && (
              <div className="muted">you picked {index.cities.byId.get(chosen)!.name}</div>
            )}
          </div>
        </header>

        <div className="reveal-map">
          <GeoMap view={{ kind: 'country', iso3: country.iso3 }} cityMarks={dots} terrain={terrain} />
        </div>

        {cityHook && (
          <div className="hook">
            <p>{cityHook}</p>
          </div>
        )}

        <ul className="facts">
          {cityFacts.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>

        <button className="primary" onClick={onNext} autoFocus>
          Next
        </button>
      </div>
    )
  }

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
        {country.nationalDish && <DishFact country={country} />}
      </ul>

      <button className="primary" onClick={onNext} autoFocus>
        Next
      </button>
    </div>
  )
}

/**
 * The national dish pill, tappable when a photo exists: it expands into the
 * picture with its Commons credit line. The photo is fetched only on the
 * first tap per country (then service-worker cached), so the reveal stays as
 * light as before for anyone who never taps.
 */
function DishFact({ country }: { country: CountryRecord }) {
  const [photo, setPhoto] = useState<DishPhoto | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let live = true
    setOpen(false)
    void loadDishPhotos().then((m) => live && setPhoto(m.get(country.iso3) ?? null))
    return () => {
      live = false
    }
  }, [country.iso3])

  if (!photo) return <li>National dish: {country.nationalDish}</li>

  return (
    <li className={open ? 'dish open' : 'dish'}>
      <button className="dish-toggle" onClick={() => setOpen(!open)}>
        National dish: {country.nationalDish} {open ? '▾' : '▸'}
      </button>
      {open && (
        <figure className="dish-photo">
          <img src={`data/dishes/${country.iso3}.jpg`} alt={photo.dish} loading="lazy" />
          <figcaption className="muted">Photo: {photo.credit}</figcaption>
        </figure>
      )}
    </li>
  )
}
