import { app, globalShortcut } from "electron";
import {
  toAccelerator,
  type ChordString,
} from "@traycer-clients/shared/keybindings/chord-core";
import type {
  GlobalShortcutId,
  GlobalShortcutIntent,
  GlobalShortcutRegistrationStatus,
  GlobalShortcutsSnapshot,
  GlobalShortcutStatus,
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
    defaultChord: "mod+shift+space",
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

let statuses = {} as Record<GlobalShortcutId, GlobalShortcutStatus>;
let sequence = 0;
const listeners = new Set<ChangeListener>();
let quitHandlerInstalled = false;

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
 * Startup, a settings change, and a future suppression layer all converge
 * here (see the tech plan's governing mechanism).
 *
 * `overrides` lets a caller reconcile a trial intent for one id WITHOUT
 * persisting it - `applyGlobalShortcutIntent`'s transactional rebind calls
 * this once with the desired intent as a trial, then again with no override
 * to revert to the still-persisted intent if the OS refused.
 */
export async function reconcileGlobalShortcuts(
  overrides: Partial<Record<GlobalShortcutId, GlobalShortcutIntent>>,
): Promise<GlobalShortcutsSnapshot> {
  await hydrateGlobalShortcutIntents();
  const nextStatuses = {} as Record<GlobalShortcutId, GlobalShortcutStatus>;
  for (const def of DEFINITIONS) {
    const intent = overrides[def.id] ?? getGlobalShortcutIntent(def.id);
    const effectiveChord = intent.chord ?? def.defaultChord;

    const previousAccelerator = registeredAccelerators.get(def.id);
    if (previousAccelerator !== undefined) {
      globalShortcut.unregister(previousAccelerator);
      registeredAccelerators.delete(def.id);
    }

    let status: GlobalShortcutRegistrationStatus;
    if (!intent.enabled || suppressed) {
      status = "disabled";
    } else {
      const accelerator = toAccelerator(effectiveChord, acceleratorPlatform());
      const ok = globalShortcut.register(accelerator, def.run);
      if (ok) {
        registeredAccelerators.set(def.id, accelerator);
        status = "registered";
      } else {
        log.warn("[shortcuts] global shortcut registration refused", {
          id: def.id,
          accelerator,
        });
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
 * Applies a desired intent for `id` transactionally against the OS: unregister
 * the current chord, try the new one, and if the OS refuses, re-register the
 * previous chord and never persist the rejected attempt. Only a durably
 * accepted registration is written to disk - a rejected trial leaves both the
 * OS registration and the persisted intent exactly as they were.
 *
 * May reject with `GlobalShortcutPersistenceError` if the OS accepted the new
 * chord but the write to disk failed; the caller (the IPC set-handler)
 * translates that into a friendly mutation error. The OS registration is not
 * rolled back in that case - see the tech plan's failure-handling table.
 */
export async function applyGlobalShortcutIntent(
  id: GlobalShortcutId,
  intent: GlobalShortcutIntent,
): Promise<GlobalShortcutStatus> {
  const trial = await reconcileGlobalShortcuts({ [id]: intent });
  const trialStatus = trial.statuses[id];
  if (trialStatus.status === "rejected") {
    // Revert: an empty override means reconcile() re-reads the
    // still-untouched persisted intent, re-registering the previous chord.
    await reconcileGlobalShortcuts({});
    return trialStatus;
  }
  await setGlobalShortcutIntent(id, intent);
  return trialStatus;
}
