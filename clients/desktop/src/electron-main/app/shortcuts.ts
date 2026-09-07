import { app, globalShortcut } from "electron";
import {
  toAccelerator,
  type ChordString,
} from "@traycer-clients/shared/keybindings/chord-core";
import {
  GLOBAL_SHORTCUT_DEFAULT_CHORDS,
  GLOBAL_SHORTCUT_IDS,
  type GlobalShortcutId,
  type GlobalShortcutIntent,
  type GlobalShortcutRegistrationStatus,
  type GlobalShortcutsSnapshot,
  type GlobalShortcutStatus,
} from "../../ipc-contracts/global-shortcuts-types";
import { log } from "./logger";
import {
  getGlobalShortcutIntent,
  hydrateGlobalShortcutIntents,
  setGlobalShortcutIntent,
} from "./global-shortcuts-preferences";

export interface ShortcutTargetWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  show(): void;
  restore(): void;
  focus(): void;
}

export type { GlobalShortcutsSnapshot };

interface GlobalShortcutDefinition {
  readonly id: GlobalShortcutId;
  readonly defaultChord: ChordString;
  readonly run: () => void;
}

type ChangeListener = (snapshot: GlobalShortcutsSnapshot) => void;

let resolveTargetWindow: (() => ShortcutTargetWindow | null) | null = null;

// One entry today (`summon`); a second global shortcut is added here and
// nowhere else - reconcile() and persistence already generalize over
// `GLOBAL_SHORTCUT_IDS`.
const DEFINITIONS: readonly GlobalShortcutDefinition[] = [
  {
    id: "summon",
    defaultChord: GLOBAL_SHORTCUT_DEFAULT_CHORDS.summon,
    run: () => {
      const window = resolveTargetWindow?.() ?? null;
      if (window === null || window.isDestroyed()) return;
      if (window.isMinimized()) {
        window.restore();
      }
      if (!window.isVisible()) {
        window.show();
      }
      window.focus();
    },
  },
];

let suppressed = false;

// The exact Accelerator string currently registered per id, so a later
// reconcile() unregisters precisely what it registered (not a recomputed
// value that could drift) and the tray can display precisely what's live.
const registeredAccelerators = new Map<GlobalShortcutId, string>();

// The IPC handler is installed before the deferred startup reconcile runs.
let statuses = Object.fromEntries(
  GLOBAL_SHORTCUT_IDS.map((id) => [
    id,
    {
      id,
      intent: { enabled: true, chord: null },
      effectiveChord: GLOBAL_SHORTCUT_DEFAULT_CHORDS[id],
      status: "disabled",
    },
  ]),
) as Record<GlobalShortcutId, GlobalShortcutStatus>;
let sequence = 0;
const listeners = new Set<ChangeListener>();
let quitHandlerInstalled = false;

let globalShortcutsQueueTail: Promise<void> = Promise.resolve();

function withGlobalShortcutsQueue<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  const result = globalShortcutsQueueTail.then(operation);
  globalShortcutsQueueTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function acceleratorPlatform(): "mac" | "other" {
  return process.platform === "darwin" ? "mac" : "other";
}

/** Call once at startup, before the first `reconcileGlobalShortcuts()`. */
export function initGlobalShortcutsRegistry(
  resolveWindow: () => ShortcutTargetWindow | null,
): void {
  resolveTargetWindow = resolveWindow;
  if (!quitHandlerInstalled) {
    quitHandlerInstalled = true;
    app.on("will-quit", () => {
      globalShortcut.unregisterAll();
      registeredAccelerators.clear();
    });
  }
}

async function reconcileGlobalShortcutsUnserialized(
  overrides: Partial<Record<GlobalShortcutId, GlobalShortcutIntent>>,
): Promise<GlobalShortcutsSnapshot> {
  await hydrateGlobalShortcutIntents();
  const nextStatuses = {} as Record<GlobalShortcutId, GlobalShortcutStatus>;
  for (const def of DEFINITIONS) {
    const intent = overrides[def.id] ?? getGlobalShortcutIntent(def.id);
    const effectiveChord = intent.chord ?? def.defaultChord;
    const previousAccelerator = registeredAccelerators.get(def.id);
    const desiredAccelerator =
      intent.enabled && !suppressed
        ? toAccelerator(effectiveChord, acceleratorPlatform())
        : null;

    let status: GlobalShortcutRegistrationStatus;
    if (desiredAccelerator === null) {
      if (previousAccelerator !== undefined) {
        globalShortcut.unregister(previousAccelerator);
        registeredAccelerators.delete(def.id);
      }
      status = "disabled";
    } else if (previousAccelerator === desiredAccelerator) {
      // Already held and unchanged - no OS churn.
      status = "registered";
    } else {
      const ok = globalShortcut.register(desiredAccelerator, def.run);
      if (ok) {
        registeredAccelerators.set(def.id, desiredAccelerator);
        // Only release the old accelerator now that the new one is live -
        // never leaves the user without any working chord in between.
        if (previousAccelerator !== undefined) {
          globalShortcut.unregister(previousAccelerator);
        }
        status = "registered";
      } else {
        log.warn("[shortcuts] global shortcut registration refused", {
          id: def.id,
          accelerator: desiredAccelerator,
        });
        // The old accelerator (if any) was never released - still live.
        status = "rejected";
      }
    }
    nextStatuses[def.id] = { id: def.id, intent, effectiveChord, status };
  }
  statuses = nextStatuses;
  sequence += 1;
  const snapshot = getGlobalShortcutsSnapshot();
  for (const listener of listeners) {
    listener(snapshot);
  }
  return snapshot;
}

/** Serialized on the same queue as `applyGlobalShortcutIntent` so the two families of callers can never interleave. */
export function reconcileGlobalShortcuts(
  overrides: Partial<Record<GlobalShortcutId, GlobalShortcutIntent>>,
): Promise<GlobalShortcutsSnapshot> {
  return withGlobalShortcutsQueue(() =>
    reconcileGlobalShortcutsUnserialized(overrides),
  );
}

export function getGlobalShortcutsSnapshot(): GlobalShortcutsSnapshot {
  return { sequence, statuses };
}

export function onGlobalShortcutsChange(listener: ChangeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getRegisteredAccelerator(id: GlobalShortcutId): string | null {
  return registeredAccelerators.get(id) ?? null;
}

/**
 * Applies a desired intent for `id` transactionally against the OS: try the new chord (acquire-before-release inside `reconcileGlobalShortcutsUnserialized`), and if the OS refuses.
 * It must call the unserialized reconcile directly, never the queued `reconcileGlobalShortcuts` export - re-entering the queue from inside itself would deadlock.
 */
export function applyGlobalShortcutIntent(
  id: GlobalShortcutId,
  intent: GlobalShortcutIntent,
): Promise<GlobalShortcutStatus> {
  return withGlobalShortcutsQueue(async () => {
    const trial = await reconcileGlobalShortcutsUnserialized({ [id]: intent });
    const trialStatus = trial.statuses[id];
    if (trialStatus.status === "rejected") {
      // Revert: an empty override means reconcile() re-reads the
      // still-untouched persisted intent, re-registering the previous chord.
      await reconcileGlobalShortcutsUnserialized({});
      return trialStatus;
    }
    await setGlobalShortcutIntent(id, intent);
    return trialStatus;
  });
}
