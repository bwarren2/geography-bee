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
