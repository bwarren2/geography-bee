/** Shared shapes for the committed data bundle and the runtime study model. */

export interface Currency {
  code: string
  name: string
  symbol: string | null
}

export interface CountryRecord {
  iso3: string
  iso2: string
  /** ISO 3166-1 numeric, zero-padded — the join key against Natural Earth. */
  isoNum: string
  name: string
  official: string
  /** Accepted alternates for typed answers (Ivory Coast, Burma, ...). */
  altNames: string[]
  capital: string[]
  /** Quiz region slug; coarser than `subregion`. */
  region: string
  subregion: string
  continent: string
  /** ISO3 codes of land neighbours. */
  borders: string[]
  landlocked: boolean
  areaKm2: number
  population: number | null
  flag: string
  currencies: Currency[]
  languages: string[]
  /** [lon, lat] editorial label point from world-countries. */
  labelPoint: [number, number]
  /** [lon, lat] true spherical centroid of the geometry. */
  centroid: [number, number]
  /** [west, south, east, north] */
  bbox: [number, number, number, number]
  /** Steradians of the sphere covered — drives click tolerance for micro-states. */
  solidAngle: number
  elevationM: number | null
  coastlineKm: number | null
  nationalDish: string | null
  /** False for the 29 countries too small to appear in the 110m world topology. */
  inWorldGeometry: boolean
  /** Composite of log(area) and log(population); higher is more widely known. */
  salience: number
  /** Global curriculum position: region order, then salience within region. */
  introOrder: number
}

/** One quizzable city: every country's capital plus the world's major
 *  non-capital cities. Placement is quizzed on a country-framed map, so a
 *  city's country must be established before its cards can appear. */
export interface CityRecord {
  /** `${iso3}-${slug}`, stable across rebuilds — card ids hang off it. */
  id: string
  name: string
  /** Accepted typed answers beyond the display name (historic, colloquial). */
  altNames: string[]
  iso3: string
  lonlat: [number, number]
  /** Metro population in millions (display only); null when unknown. */
  popM: number | null
  capital: boolean
  /** Global introduction order: country curriculum order, capital first. */
  rank: number
}

export interface QuizRegion {
  slug: string
  name: string
  order: number
  /** ISO3 codes in curriculum order. */
  countries: string[]
  /** [west, south, east, north], unwrapped so Oceania doesn't span the globe. */
  bbox: [number, number, number, number]
}

export interface DataBundle {
  version: number
  /** Names of bordering territories that are not UN members (French Guiana,
   *  Western Sahara), so neighbour lists never show a bare ISO code. */
  territoryNames: Record<string, string>
  generatedFrom: Record<string, string>
  regions: QuizRegion[]
  countries: CountryRecord[]
}
