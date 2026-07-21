import { app } from "electron";
import { join } from "node:path";
import { isValidChordString } from "@traycer-clients/shared/keybindings/chord-core";
import {
  GLOBAL_SHORTCUT_IDS,
  globalShortcutIntentSchema,
  type GlobalShortcutId,
  type GlobalShortcutIntent,
} from "@traycer-clients/shared/keybindings/global-shortcuts";
import {
  createJsonFileStore,
  type StrictJsonFileStore,
} from "./json-file-store";

const STORE_FILE_NAME = "global-shortcuts.json";

type GlobalShortcutIntents = Readonly<
  Record<GlobalShortcutId, GlobalShortcutIntent>
>;

export const GLOBAL_SHORTCUT_PERSISTENCE_ERROR_CODE =
  "global-shortcut-persistence-failed";

export class GlobalShortcutPersistenceError extends Error {
  readonly code = GLOBAL_SHORTCUT_PERSISTENCE_ERROR_CODE;
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("Failed to persist global shortcut preference");
    this.name = "GlobalShortcutPersistenceError";
    this.cause = cause;
  }
}

export function isGlobalShortcutPersistenceError(
  error: unknown,
): error is GlobalShortcutPersistenceError {
  return (
    error instanceof GlobalShortcutPersistenceError &&
    error.code === GLOBAL_SHORTCUT_PERSISTENCE_ERROR_CODE
  );
}

// `chord: null` means "use the definition's default chord" - see
// `GlobalShortcutIntent`.
const DEFAULT_INTENT: GlobalShortcutIntent = { enabled: true, chord: null };
const DEFAULT_INTENTS: GlobalShortcutIntents = Object.fromEntries(
  GLOBAL_SHORTCUT_IDS.map((id) => [id, DEFAULT_INTENT]),
) as GlobalShortcutIntents;

let intents = DEFAULT_INTENTS;
let hydration: Promise<GlobalShortcutIntents> | null = null;
let store: StrictJsonFileStore<GlobalShortcutIntents> | null = null;
let intentMutationQueue: Promise<void> = Promise.resolve();

function parseIntents(value: unknown): GlobalShortcutIntents {
  if (value === null || typeof value !== "object") return DEFAULT_INTENTS;
  return Object.fromEntries(
    GLOBAL_SHORTCUT_IDS.map((id) => {
      const parsed = globalShortcutIntentSchema.safeParse(
        Reflect.get(value, id),
      );
      return [id, parsed.success ? sanitizeChord(parsed.data) : DEFAULT_INTENT];
    }),
  ) as GlobalShortcutIntents;
}

// Structural validation (the zod schema) only confirms `chord` is a string or
// null - it says nothing about whether that string is a canonical chord. A
// persisted value like `"mod+"` or an unsupported key would otherwise reach
// `reconcile()` and Electron unchanged. Coercion here is semantic: resolve an
// invalid chord to `null` ("use the definition's default"), keeping the rest
// of the intent (`enabled`) as persisted.
function sanitizeChord(intent: GlobalShortcutIntent): GlobalShortcutIntent {
  if (intent.chord !== null && !isValidChordString(intent.chord)) {
    return { enabled: intent.enabled, chord: null };
  }
  return intent;
}

function getStore() {
  store ??= createJsonFileStore<GlobalShortcutIntents>(
    join(app.getPath("userData"), STORE_FILE_NAME),
    DEFAULT_INTENTS,
    parseIntents,
  );
  return store;
}

/**
 * Loads the persisted global-shortcut intent before the registry's first
 * `reconcile()` call. A corrupt or missing file resolves every id to its
 * default intent (enabled, definition default chord) rather than blocking
 * startup - matching `hydrateUpdatePreferences`'s default-safe contract.
 */
export function hydrateGlobalShortcutIntents(): Promise<GlobalShortcutIntents> {
  if (hydration !== null) return hydration;
  hydration = getStore()
    .load()
    .then((loaded) => {
      intents = loaded;
      return loaded;
    });
  return hydration;
}

export function getGlobalShortcutIntent(
  id: GlobalShortcutId,
): GlobalShortcutIntent {
  return intents[id];
}

/**
 * Persists a durably-accepted intent change. Callers must only invoke this
 * after the registry's `reconcile()` has already confirmed the OS accepted
 * the corresponding chord - this module has no opinion on OS registration,
 * only on making an already-accepted intent survive a restart.
 */
export function setGlobalShortcutIntent(
  id: GlobalShortcutId,
  intent: GlobalShortcutIntent,
): Promise<void> {
  const mutation = intentMutationQueue.then(async () => {
    await hydrateGlobalShortcutIntents();
    if (sameIntent(intents[id], intent)) return;
    const next = { ...intents, [id]: intent };
    try {
      await getStore().saveStrict(next);
    } catch (err) {
      throw new GlobalShortcutPersistenceError(err);
    }
    intents = next;
  });
  intentMutationQueue = mutation.then(
    () => undefined,
    () => undefined,
  );
  return mutation;
}

function sameIntent(a: GlobalShortcutIntent, b: GlobalShortcutIntent): boolean {
  return a.enabled === b.enabled && a.chord === b.chord;
}
