import { CURRENT_PERSIST_VERSION } from "@/lib/persist/persist-options";

/**
 * Seed a persisted store's key, ONCE, from a value carried by other stores'
 * records — before that store hydrates.
 *
 * The sibling of `adoptLegacyPersistedKey`, for the case it cannot serve. That
 * one moves a whole blob from one key to another and deletes the original,
 * which is right when a store is simply re-bucketed. Here the legacy records
 * are still LIVE stores that keep the rest of their state (a popover's tab and
 * size, a panel's ordering), and only one field of theirs is moving out — so
 * this copies a derived value and leaves both originals untouched.
 *
 * Seeding before hydration rather than inside `merge` is what makes it once:
 * zustand does not write a store back after an ordinary merge, so a `merge`
 * that reached for the legacy records would consult them again on every launch,
 * and a deliberate return to the default could never survive a relaunch. After
 * this runs, the new key exists, and its own record is the only thing the store
 * ever reads again.
 *
 * The precedence rule is the same one `adoptLegacyPersistedKey` states: a
 * record already written under the new key wins outright.
 *
 * Storage is best-effort throughout. A corrupt legacy record, a storage that
 * throws (Safari private mode, a browser set to block site data), or a value
 * that is not the shape expected all resolve to "no seed" — the store then
 * starts at its defaults, which is what an install with no legacy record gets.
 */
export function seedPersistedStateFromLegacyKeys(input: {
  /** The store's own key. Present ⇒ nothing happens. */
  readonly name: string;
  /** Legacy record keys, in precedence order. */
  readonly legacyNames: ReadonlyArray<string>;
  /**
   * Derives the seed state from one legacy record's persisted `state` object.
   * `null` means "this record carries nothing to seed from", and the next
   * legacy name is tried.
   */
  readonly seedFrom: (
    legacyState: Record<string, unknown>,
  ) => Record<string, unknown> | null;
}): void {
  try {
    if (window.localStorage.getItem(input.name) !== null) return;
    for (const legacyName of input.legacyNames) {
      const legacyState = readPersistedState(legacyName);
      if (legacyState === null) continue;
      const seed = input.seedFrom(legacyState);
      if (seed === null) continue;
      window.localStorage.setItem(
        input.name,
        JSON.stringify({ state: seed, version: CURRENT_PERSIST_VERSION }),
      );
      return;
    }
  } catch {
    // Nothing here is worth failing a launch over: the store falls back to its
    // defaults, exactly as on a fresh install.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** One persisted record's `state` object, or `null` if it is not readable. */
function readPersistedState(name: string): Record<string, unknown> | null {
  const raw = window.localStorage.getItem(name);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    return isRecord(parsed.state) ? parsed.state : null;
  } catch {
    return null;
  }
}
