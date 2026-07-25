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

// The registry's entire accommodation for a future foreground/fullscreen
// suppression layer (see the tech plan's appendix): reconcile() treats this
// exactly like "disabled" today, and nothing else in the design would need
// to change when a suppression layer starts driving it.
let suppressed = false;

// The exact Accelerator string currently registered per id, so a later
// reconcile() unregisters precisely what it registered (not a recomputed
// value that could drift) and the tray can display precisely what's live.
const registeredAccelerators = new Map<GlobalShortcutId, string>();

// The IPC handler is installed before the deferred startup reconcile runs.
// Keep its type-level promise (`Record<GlobalShortcutId, ...>`) true from
// module initialization so an early renderer snapshot always contains every
// definition. Reconcile replaces these boot placeholders with persisted intent
// plus the OS registration result and advances `sequence`.
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

// Every mutation of OS registration state - a plain reconcile (startup, a
// future suppression layer) or a settings-driven `applyGlobalShortcutIntent`
// transaction - flows through this single tail, mirroring
// `withHostLoginItemRegistrationLock`. Serializing only the persisted-intent
// write (as `global-shortcuts-preferences.ts` does on its own) is not enough:
// two concurrent transactions could still interleave their trial-register and
// rollback-reconcile steps and leave OS state, persisted intent, and reported
// status mutually divergent (the amended decision 7 "serialized end to end"
// rule, added after PR #533 review exposed this).
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

/**
 * Wires the resolver the `summon` definition focuses, and unregisters every
 * global shortcut on quit. Call once at startup, before the first
 * `reconcileGlobalShortcuts()`.
 */
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

/**
 * The sole code path that touches `globalShortcut.register`/`unregister`.
 * Never call this directly - it must only run inside
 * `withGlobalShortcutsQueue` (via `reconcileGlobalShortcuts` or
 * `applyGlobalShortcutIntent`), which is what actually serializes it.
 *
 * Acquire before release (amended decision 7): when the effective accelerator
 * changes, the new one is registered while the old is still held, and the old
 * is only released after the new registration succeeds. On refusal, the old
 * accelerator was never touched, so nothing needs re-registering and status
 * never claims `registered` when nothing is held. When the effective
 * accelerator is unchanged, this is a no-op against the OS.
 *
 * `overrides` lets a caller reconcile a trial intent for one id WITHOUT
 * persisting it - `applyGlobalShortcutIntent`'s transactional rebind passes
 * the desired intent as a trial, then an empty override to revert to the
 * still-persisted intent if the OS refused.
 */
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

/**
 * Public entry for a plain reconcile (startup, and a future suppression
 * layer). Serialized on the same queue as `applyGlobalShortcutIntent` so the
 * two families of callers can never interleave.
 */
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

/**
 * The Accelerator string actually registered with the OS for `id`, or
 * `null` when it's disabled or the OS refused it - i.e. exactly what's live,
 * for the tray's display-only accelerator (decision 9 in the tech plan).
 */
export function getRegisteredAccelerator(id: GlobalShortcutId): string | null {
  return registeredAccelerators.get(id) ?? null;
}

/**
 * Applies a desired intent for `id` transactionally against the OS: try the
 * new chord (acquire-before-release inside `reconcileGlobalShortcutsUnserialized`),
 * and if the OS refuses, revert to the still-persisted intent and never
 * persist the rejected attempt. Only a durably accepted registration is
 * written to disk.
 *
 * The ENTIRE transaction - trial registration, persist-or-revert, and the
 * resulting fan-out - runs as one unit on `withGlobalShortcutsQueue` (amended
 * decision 7's "serialized end to end" rule). It must call the unserialized
 * reconcile directly, never the queued `reconcileGlobalShortcuts` export -
 * re-entering the queue from inside itself would deadlock.
 *
 * May reject with `GlobalShortcutPersistenceError` if the OS accepted the new
 * chord but the write to disk failed; the caller (the IPC set-handler)
 * translates that into a friendly mutation error. The OS registration is not
 * rolled back in that case - see the tech plan's failure-handling table.
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
