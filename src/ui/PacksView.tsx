import type { CountryIndex } from '../data/load'
import { allPacks, packProgress, type PackDef } from '../session/packs'
import type { StudySnapshot } from '../store/store'
import { store } from '../store/useStore'

interface PacksViewProps {
  index: CountryIndex
  snapshot: StudySnapshot
  onBack: () => void
  /** Re-read storage so the home screen's due/new counts stay honest. */
  onChanged: () => void
}

const KIND_LABEL = { core: 'Core', skill: 'Skills', region: 'Region spotlights' } as const

export function PacksView({ index, snapshot, onBack, onChanged }: PacksViewProps) {
  const packs = allPacks(index)
  const started = snapshot.settings.packs

  async function toggle(pack: PackDef) {
    const next = started.includes(pack.id)
      ? started.filter((id) => id !== pack.id)
      : [...started, pack.id] // append: start order is also introduction priority
    await store.setSettings({ packs: next })
    onChanged()
  }

  const groups: { kind: PackDef['kind']; blurb?: string }[] = [
    { kind: 'core' },
    { kind: 'skill', blurb: 'Add a new kind of question for countries you can already place — each unlocks per country once its map cards are solid.' },
    { kind: 'region', blurb: 'Pull a region into the rotation ahead of the world tour.' },
  ]

  return (
    <div className="home">
      <header className="packs-head">
        <button className="ghost" onClick={onBack}>
          ← Back
        </button>
        <h1>Packs</h1>
      </header>
      <p className="muted">
        Started packs feed the daily rotation ({snapshot.settings.newCardsPerDay} new cards a day).
        Pausing one stops new cards; anything already learned keeps its reviews.
      </p>

      {groups.map(({ kind, blurb }) => (
        <section key={kind} className="pack-group">
          <h2>{KIND_LABEL[kind]}</h2>
          {blurb && <p className="muted">{blurb}</p>}
          {packs
            .filter((p) => p.kind === kind)
            .map((pack) => {
              const on = started.includes(pack.id)
              const prog = packProgress(pack, index, snapshot.cards)
              const detail =
                pack.kind === 'skill'
                  ? `${prog.started}/${prog.total} cards · ${prog.readyNow} ready now`
                  : `${prog.started}/${prog.total} countries`
              return (
                <div key={pack.id} className={on ? 'pack on' : 'pack'}>
                  <div className="pack-text">
                    <strong>{pack.name}</strong>
                    <span className="muted">{pack.blurb}</span>
                    <span className="pack-progress">{detail}</span>
                  </div>
                  <button className={on ? '' : 'primary'} onClick={() => void toggle(pack)}>
                    {on ? 'Pause' : 'Start'}
                  </button>
                </div>
              )
            })}
        </section>
      ))}
    </div>
  )
}
