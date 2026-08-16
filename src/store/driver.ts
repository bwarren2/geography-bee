/**
 * Key/value persistence behind an async interface.
 *
 * localStorage is synchronous, so the promises here resolve immediately — but
 * the async shape is deliberate. It costs nothing now and means swapping in
 * IndexedDB later (if raw review history ever needs to outgrow the ~5MB
 * ceiling) is a change to this file rather than to every call site.
 */
export interface KeyValueDriver {
  get<T>(key: string): Promise<T | null>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
  keys(prefix: string): Promise<string[]>
}

export class QuotaError extends Error {
  constructor(readonly key: string) {
    super(`Storage quota exceeded writing ${key}`)
    this.name = 'QuotaError'
  }
}

const isQuotaError = (e: unknown) =>
  e instanceof DOMException &&
  (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22)

export class LocalStorageDriver implements KeyValueDriver {
  constructor(private readonly backing: Storage = window.localStorage) {}

  async get<T>(key: string): Promise<T | null> {
    const raw = this.backing.getItem(key)
    if (raw == null) return null
    try {
      return JSON.parse(raw) as T
    } catch {
      // A corrupt value should cost one key, not the whole study history.
      console.warn(`Discarding unparseable value at ${key}`)
      return null
    }
  }

  async set(key: string, value: unknown): Promise<void> {
    try {
      this.backing.setItem(key, JSON.stringify(value))
    } catch (e) {
      if (isQuotaError(e)) throw new QuotaError(key)
      throw e
    }
  }

  async remove(key: string): Promise<void> {
    this.backing.removeItem(key)
  }

  async keys(prefix: string): Promise<string[]> {
    const out: string[] = []
    for (let i = 0; i < this.backing.length; i++) {
      const k = this.backing.key(i)
      if (k?.startsWith(prefix)) out.push(k)
    }
    return out
  }
}

/** In-memory driver for tests and for browsers that block storage entirely. */
export class MemoryDriver implements KeyValueDriver {
  private readonly map = new Map<string, string>()

  async get<T>(key: string): Promise<T | null> {
    const raw = this.map.get(key)
    return raw == null ? null : (JSON.parse(raw) as T)
  }
  async set(key: string, value: unknown): Promise<void> {
    this.map.set(key, JSON.stringify(value))
  }
  async remove(key: string): Promise<void> {
    this.map.delete(key)
  }
  async keys(prefix: string): Promise<string[]> {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix))
  }
}

export function defaultDriver(): KeyValueDriver {
  try {
    const probe = '__gb_probe__'
    window.localStorage.setItem(probe, '1')
    window.localStorage.removeItem(probe)
    return new LocalStorageDriver()
  } catch {
    // Private-mode Safari and locked-down browsers throw on access. Studying
    // still works; progress just will not survive a reload.
    console.warn('localStorage unavailable — progress will not persist')
    return new MemoryDriver()
  }
}
