import { isValidChordString } from "@traycer-clients/shared/keybindings/chord-core";
import {
  GLOBAL_SHORTCUT_IDS,
  globalShortcutIntentSchema,
} from "@traycer-clients/shared/keybindings/global-shortcuts";
import type {
  GlobalShortcutId,
  GlobalShortcutIntent,
} from "../../ipc-contracts/global-shortcuts-types";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../../ipc-contracts/ipc-channels";
import {
  applyGlobalShortcutIntent,
  getGlobalShortcutsSnapshot,
  onGlobalShortcutsChange,
} from "../app/shortcuts";
import { isGlobalShortcutPersistenceError } from "../app/global-shortcuts-preferences";
import { describeLogError, log } from "../app/logger";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";

export const GLOBAL_SHORTCUT_SAVE_FAILED_MESSAGE =
  "Couldn't save the shortcut preference. Please try again.";

export function registerGlobalShortcutsIpc(bridge: RunnerIpcBridge): void {
  bridge.handleInvoke(RunnerHostInvoke.globalShortcutsGetSnapshot, () =>
    getGlobalShortcutsSnapshot(),
  );

  bridge.handleInvoke(
    RunnerHostInvoke.globalShortcutsSet,
    async (_event, id: unknown, intent: unknown) => {
      const parsedId = parseGlobalShortcutId(id);
      const parsedIntent = parseGlobalShortcutIntent(intent);
      try {
        return await applyGlobalShortcutIntent(parsedId, parsedIntent);
      } catch (err) {
        if (!isGlobalShortcutPersistenceError(err)) {
          throw err;
        }
        // The renderer should not receive a filesystem error or user-data
        // path, but the original (redacted) error remains in the main-process
        // log for diagnostics.
        log.error("[global-shortcuts] failed to persist shortcut intent", {
          id: parsedId,
          error: describeLogError(err.cause),
        });
        throw new Error(GLOBAL_SHORTCUT_SAVE_FAILED_MESSAGE);
      }
    },
  );

  bridge.disposeFns.push(
    onGlobalShortcutsChange((snapshot) => {
      bridge.fanOut(RunnerHostEvent.globalShortcutsChange, snapshot);
    }),
  );
}

function parseGlobalShortcutId(value: unknown): GlobalShortcutId {
  const id = GLOBAL_SHORTCUT_IDS.find((candidate) => candidate === value);
  if (id !== undefined) return id;
  throw new Error(`Unknown global shortcut id: ${String(value)}`);
}

function parseGlobalShortcutIntent(value: unknown): GlobalShortcutIntent {
  const intent = globalShortcutIntentSchema.parse(value);
  // Structural validity (a string) isn't semantic validity - reject a
  // non-canonical chord (e.g. "mod+", wrong token order, an unsupported key)
  // here rather than letting it reach `reconcile()`/Electron (amended
  // decision 3).
  if (intent.chord !== null && !isValidChordString(intent.chord)) {
    throw new Error("Malformed global shortcut intent: chord is not valid");
  }
  return intent;
}
