/**
 * Builds `fixtures/framing-review.json`: an importable backup whose locate
 * cards for every re-cut region (#3) are in Review state and permanently
 * overdue, so the moment it is imported the study queue is full of exactly
 * the reviews the new frames exist for — Honduras vs Nicaragua, the Balkans,
 * the Koreas — with no teaching phase in the way.
 *
 * Import it through the home screen's "Import backup" button. It REPLACES
 * all progress in that browser, so it is meant for preview deployments, not
 * for a device holding real history.
 *
 * `npm run build:fixture` regenerates it; committed output keeps the branch
 * testable without a checkout.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Rating } from 'ts-fsrs'
import type { StoredCard } from '../src/srs/model'
import { createCard, schedule } from '../src/srs/scheduler'
import type { DataBundle } from '../src/types'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundle: DataBundle = JSON.parse(readFileSync(join(ROOT, 'public/data/countries.json'), 'utf8'))

const REGIONS = [
  'central-america',
  'north-america',
  'balkans',
  'eastern-europe',
  'russia',
  'japan-koreas',
  'china-mongolia',
  'sahel',
  'western-africa',
  'australia-nz',
]

const DAY = 86_400_000
// A fixed, past epoch keeps the file deterministic; due dates in the past
// stay due forever, so the fixture never goes stale.
const NOW = new Date('2026-08-01T00:00:00Z').getTime()

const cards: Record<string, StoredCard> = {}
for (const slug of REGIONS) {
  const region = bundle.regions.find((r) => r.slug === slug)
  if (!region) throw new Error(`No region ${slug} in the bundle`)
  for (const iso3 of region.countries) {
    let when = NOW - 45 * DAY
    let card = createCard(iso3, 'locate', new Date(when))
    for (let i = 0; i < 3; i++) {
      card = schedule(card, Rating.Good, new Date(when))
      when = Math.min(card.due, NOW - DAY)
    }
    cards[card.id] = { ...card, due: NOW }
  }
}

const backup = {
  format: 'geography-bee/v1',
  exportedAt: new Date(NOW).toISOString(),
  cards,
  stats: { perCard: {}, daily: {}, confusion: {} },
  settings: {
    newCardsPerDay: 0, // reviews only: nothing new dilutes the framing check
    packs: ['world'],
    boost: { day: '', extra: 0 },
    regionsVersion: 2,
  },
  meta: { schema: 1, lastBackupAt: NOW, createdAt: NOW },
  log: [],
}

mkdirSync(join(ROOT, 'fixtures'), { recursive: true })
const out = join(ROOT, 'fixtures', 'framing-review.json')
writeFileSync(out, JSON.stringify(backup, null, 2) + '\n')
console.log(`${Object.keys(cards).length} overdue locate cards across ${REGIONS.length} regions -> ${out}`)

// ---------------------------------------------------------------------------
// Cities demo: North & Central America established, Cities pack started, so
// importing it makes a session introduce city cards immediately.
// ---------------------------------------------------------------------------
const cityDemo: Record<string, StoredCard> = {}
for (const iso3 of ['USA', 'CAN', 'MEX', 'GTM', 'HND', 'SLV', 'NIC', 'CRI', 'PAN', 'BLZ']) {
  for (const type of ['locate', 'identify'] as const) {
    let when = NOW - 400 * DAY
    let card = createCard(iso3, type, new Date(when))
    for (let i = 0; i < 6; i++) {
      card = schedule(card, Rating.Good, new Date(when))
      when = Math.min(card.due, NOW - DAY)
    }
    cityDemo[card.id] = card // due follows the schedule: no country reviews queued
  }
}

const cityBackup = {
  ...backup,
  cards: cityDemo,
  settings: { ...backup.settings, newCardsPerDay: 10, packs: ['world', 'cities'] },
}
const out2 = join(ROOT, 'fixtures', 'cities-demo.json')
writeFileSync(out2, JSON.stringify(cityBackup, null, 2) + '\n')
console.log(`cities demo: ${Object.keys(cityDemo).length} established map cards -> ${out2}`)
