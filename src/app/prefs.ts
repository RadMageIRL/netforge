/**
 * Local preferences. Only the settings listed in PREF_SCHEMA can be stored, each with a validator,
 * so tool input (addresses, JSON, tokens) can never end up in storage by accident. Storage errors
 * (private windows, blocked site data) fall back to defaults instead of breaking the app.
 */
import { isValidTimeZone } from '../core/time/zones';

export interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface PrefSpec {
  readonly fallback: string;
  readonly valid: (value: string) => boolean;
  /** Shown on the About page next to the stored value. */
  readonly label: string;
}

export const PREF_PREFIX = 'netforge.';

export const PREF_SCHEMA = {
  theme: { fallback: 'dark', valid: (v: string) => v === 'dark' || v === 'light', label: 'Color theme' },
  lastTool: { fallback: '', valid: (v: string) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(v) && v.length <= 64, label: 'Last tool opened' },
  timeZone: { fallback: '', valid: (v: string) => isValidTimeZone(v), label: 'Timestamp Converter time zone' },
  jsonIndent: { fallback: '2', valid: (v: string) => v === '2' || v === '4' || v === 'tab', label: 'JSON Formatter indentation' },
} as const satisfies Record<string, PrefSpec>;

export type PrefKey = keyof typeof PREF_SCHEMA;

function spec(key: string): PrefSpec {
  if (!Object.prototype.hasOwnProperty.call(PREF_SCHEMA, key)) throw new Error(`Unknown preference "${key}"`);
  return PREF_SCHEMA[key as PrefKey];
}

export class Prefs {
  constructor(private readonly storage: StorageLike | null) {}

  get(key: PrefKey): string {
    const s = spec(key);
    try {
      const value = this.storage?.getItem(PREF_PREFIX + key) ?? null;
      return value !== null && s.valid(value) ? value : s.fallback;
    } catch {
      return s.fallback;
    }
  }

  /** Stores a valid value; returns false when the value is invalid or storage is unavailable. */
  set(key: PrefKey, value: string): boolean {
    const s = spec(key);
    if (!s.valid(value)) return false;
    if (!this.storage) return false;
    try {
      this.storage.setItem(PREF_PREFIX + key, value);
      return true;
    } catch {
      return false;
    }
  }

  /** Removes one stored preference, so it reads as its default again. */
  reset(key: PrefKey): void {
    spec(key);
    try {
      this.storage?.removeItem(PREF_PREFIX + key);
    } catch {
      // Nothing to do without storage access.
    }
  }

  /** The preferences actually stored on this device, for the About page. */
  stored(): { key: PrefKey; label: string; value: string }[] {
    const out: { key: PrefKey; label: string; value: string }[] = [];
    for (const key of Object.keys(PREF_SCHEMA) as PrefKey[]) {
      try {
        const value = this.storage?.getItem(PREF_PREFIX + key) ?? null;
        if (value !== null) out.push({ key, label: PREF_SCHEMA[key].label, value });
      } catch {
        // Unreadable storage holds nothing we can show.
      }
    }
    return out;
  }

  /** Removes every NetForge key, including any left by older versions. */
  clear(): void {
    if (!this.storage) return;
    try {
      const keys: string[] = [];
      for (let i = 0; i < this.storage.length; i++) {
        const k = this.storage.key(i);
        if (k !== null && k.startsWith(PREF_PREFIX)) keys.push(k);
      }
      for (const k of keys) this.storage.removeItem(k);
    } catch {
      // Nothing more can be done without storage access.
    }
  }
}

/** The browser's localStorage, or null when the browser refuses access to it. */
export function browserStorage(): StorageLike | null {
  try {
    const storage = window.localStorage;
    storage.getItem(`${PREF_PREFIX}probe`);
    return storage;
  } catch {
    return null;
  }
}
