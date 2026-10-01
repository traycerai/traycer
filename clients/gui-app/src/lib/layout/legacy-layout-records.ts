// The leaf `keys` module rather than the `@/lib/persist` barrel, deliberately.
// The barrel re-exports `wipe.ts`, whose graph reaches the layout store, so
// importing it here would put THIS module in a cycle with the very store whose
// module body calls it - and the capture below would then be in its temporal
// dead zone at the moment the carry ran. `keys.ts` imports nothing, so it
// cannot form a cycle, and the key is still the one shared builder's.
import { persistKey, STORE_KEYS } from "@/lib/persist/keys";

/**
 * The two shipped records the layout carry reads, captured before any store
 * can rewrite them (L-49, L-61).
 *
 * The ordering problem this exists to remove: zustand's `persist` hydrates at
 * `create()` time and ENDS by writing the record back
 * (`persist.hydrate()` -> `setItem`), so the moment `settings-store.ts` or
 * `left-panel-store.ts` is evaluated, its record is rewritten through the
 * CURRENT `partialize` - which no longer carries the minimap side, the pinned
 * breakdown, the resource-monitor switch, the sidebar resource metrics, the
 * panel groups or the panel visibility overrides. A carry that reads
 * `localStorage` itself therefore
 * depends on which store module the entry path happened to import first, which
 * is not a thing any module states or a store suite can observe.
 *
 * So the raw bytes are read ONCE here, at this module's own load, and every
 * store that owns one of those records imports this module. Whichever store
 * loads first, its import graph reaches this module before its own body runs,
 * so the capture is strictly earlier than any rewrite - in the app, in a test,
 * and on any entry path, with no bootstrap call to remember.
 *
 * Reading is best effort by construction: a record that is absent, truncated
 * or not an object carries nothing rather than something malformed, and every
 * field is handed on UNPARSED so the layout store's own total resolvers decide
 * what each value is allowed to be.
 */

const SETTINGS_RECORD = readPersistedState(persistKey(STORE_KEYS.settings));
const LEFT_PANEL_RECORD = readPersistedState(persistKey(STORE_KEYS.leftPanel));

/** The settings record as it was on this launch, or `{}`. */
export function legacySettingsRecord(): Record<string, unknown> {
  return SETTINGS_RECORD ?? {};
}

/** The sidebar record as it was on this launch, or `{}`. */
export function legacyLeftPanelRecord(): Record<string, unknown> {
  return LEFT_PANEL_RECORD ?? {};
}

/** One persisted record's `state` object, or `null` if it is not readable. */
function readPersistedState(name: string): Record<string, unknown> | null {
  try {
    const raw = window.localStorage.getItem(name);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    return isRecord(parsed.state) ? parsed.state : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
