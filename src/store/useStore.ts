import { useEffect, useState } from 'react'
import { StudyStore, type StudySnapshot } from './store'

/** One store per page load; the app is single-user and single-tab in practice. */
export const store = new StudyStore()

/**
 * Card and aggregate writes are debounced, so an unflushed answer would be lost
 * if the tab went away first. `pagehide` is the reliable hook on iOS — `unload`
 * never fires there — and `visibilitychange` covers app switching, which is how
 * a phone session almost always ends.
 */
function installFlushHooks(): () => void {
  const flush = () => void store.flush()
  const onHidden = () => document.visibilityState === 'hidden' && flush()

  window.addEventListener('pagehide', flush)
  document.addEventListener('visibilitychange', onHidden)
  return () => {
    window.removeEventListener('pagehide', flush)
    document.removeEventListener('visibilitychange', onHidden)
  }
}

export function useStudyStore(): { snapshot: StudySnapshot | null; reload: () => void } {
  const [snapshot, setSnapshot] = useState<StudySnapshot | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => installFlushHooks(), [])
  useEffect(() => {
    void store.load().then(setSnapshot)
  }, [nonce])

  return { snapshot, reload: () => setNonce((n) => n + 1) }
}
