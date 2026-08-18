import { useRef } from 'react'
import type { CountryIndex } from '../data/load'
import { BOOST_STEP } from '../session/builder'
import { RAPID_MIN_SEEN } from '../session/rapid'
import { isEstablished, retrievability } from '../srs/scheduler'
import { BACKUP_NAG_DAYS, type StudySnapshot } from '../store/store'
import { store } from '../store/useStore'

interface HomeProps {
  snapshot: StudySnapshot
  index: CountryIndex
  dueCount: number
  newCount: number
  onStart: () => void
  /** True when granting more budget would actually surface more cards. */
  canBoost: boolean
  onBoost: () => void
  onRapid: () => void
  onPacks: () => void
  onDashboard: () => void
  onReload: () => void
}

export function Home({ snapshot, index, dueCount, newCount, onStart, canBoost, onBoost, onRapid, onPacks, onDashboard, onReload }: HomeProps) {
  const fileRef = useRef<HTMLInputElement>(null)
  const now = new Date()

  const seen = new Set(Object.values(snapshot.cards).map((c) => c.iso3))

  // Mastery is measured by stability, not by current retrievability. Anything
  // just reviewed has a retrievability near 1.0, so that measure would call a
  // country "solidly placed" seconds after first meeting it.
  const known = Object.values(snapshot.cards).filter(
    (c) => c.type === 'locate' && isEstablished(c),
  ).length

  // How much of the world is still holding right now, across everything seen.
  const locateCards = Object.values(snapshot.cards).filter((c) => c.type === 'locate')
  const retention = locateCards.length
    ? Math.round((locateCards.reduce((sum, c) => sum + retrievability(c, now), 0) / locateCards.length) * 100)
    : 0

  const daysSinceBackup = store.daysSinceBackup()
  const nagging = daysSinceBackup != null && daysSinceBackup >= BACKUP_NAG_DAYS

  async function exportBackup() {
    const json = await store.exportAll()
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `geography-bee-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    await store.markBackedUp()
    onReload()
  }

  async function importBackup(file: File) {
    try {
      await store.importAll(await file.text())
      onReload()
    } catch (e) {
      alert(`Could not import: ${(e as Error).message}`)
    }
  }

  return (
    <div className="home">
      <h1>Geography Bee</h1>

      <div className="stats">
        <Stat value={dueCount} label="due" />
        <Stat value={newCount} label="new" />
        <Stat value={`${seen.size}/${index.bundle.countries.length}`} label="countries seen" />
        <Stat value={known} label="solidly placed" />
        {locateCards.length > 0 && <Stat value={`${retention}%`} label="recall now" />}
      </div>

      <button className="primary big" onClick={onStart} disabled={dueCount + newCount === 0}>
        {dueCount + newCount === 0 ? 'Nothing due — come back later' : `Study ${dueCount + newCount} cards`}
      </button>

      {/* The daily cap quietly zeroes the "new" count once spent — which reads
          as a freshly started pack failing to enqueue. This makes the escape
          hatch explicit: force more into today without touching the cap. */}
      {canBoost && (
        <button className="big" onClick={onBoost}>
          +{BOOST_STEP} new cards today
        </button>
      )}

      {/* A sprint over countries already met: no teach screens, no reveal,
          just tap after tap — with every answer still recorded. */}
      {seen.size >= RAPID_MIN_SEEN && (
        <button className="big" onClick={onRapid}>
          ⚡ Rapid review
        </button>
      )}

      {store.quotaExhausted && (
        <p className="warn">
          Storage is full and progress is no longer saving. Export a backup, then clear some site data.
        </p>
      )}

      {nagging && (
        <p className="warn">
          No backup in {daysSinceBackup} days. Progress lives only in this browser — clearing site data
          erases it.
        </p>
      )}

      <div className="row">
        <button onClick={onDashboard}>Progress</button>
        <button onClick={onPacks}>Packs ({snapshot.settings.packs.length} started)</button>
        <button onClick={() => void exportBackup()}>Export backup</button>
        <button onClick={() => fileRef.current?.click()}>Import backup</button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void importBackup(f)
            e.target.value = ''
          }}
        />
      </div>
    </div>
  )
}

function Stat({ value, label }: { value: number | string; label: string }) {
  return (
    <div className="stat">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  )
}
