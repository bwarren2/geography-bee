import type { StoredCard } from '../srs/model'

const DAY = 86_400_000

/**
 * How many cards come due on each of the next `days` days, index 0 = today.
 * Pure counting over stored due dates — no scheduler simulation — using the
 * same UTC day boundaries as the daily new-card budget (`today()` in the
 * session builder), so "due today" here and "due" on the study button agree.
 * Anything overdue counts toward today: it is workload now, not history.
 * Cards due beyond the window are simply not counted.
 */
export function dueForecast(cards: Record<string, StoredCard>, now: Date, days = 3): number[] {
  const out = new Array<number>(days).fill(0)
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  for (const card of Object.values(cards)) {
    const due = new Date(card.due)
    const dueUtc = Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate())
    const idx = Math.max(0, Math.round((dueUtc - todayUtc) / DAY))
    if (idx < days) out[idx]!++
  }
  return out
}
