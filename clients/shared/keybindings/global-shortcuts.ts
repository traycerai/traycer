import { z } from "zod";
import type { ChordString } from "./chord-core";

/**
 * Static table of global (OS-level) shortcuts the app offers. Today there is
 * one entry (`summon`); the id union exists so a second global shortcut never
 * re-invents the intent/status/reconcile machinery - see the desktop's
 * `electron-main/app/shortcuts.ts` for the registry itself.
 */
export const GLOBAL_SHORTCUT_IDS = ["summon"] as const;
export type GlobalShortcutId = (typeof GLOBAL_SHORTCUT_IDS)[number];

/**
 * Each definition's default chord (`intent.chord === null` means "use this").
 * The single source of truth for both the main-process registry
 * (`electron-main/app/shortcuts.ts`'s `DEFINITIONS`) and the renderer (the
 * global-shortcut settings row needs it to conflict-check what clearing to
 * default would actually commit - decision 6's "every commit path, including
 * clear-to-default, runs the conflict check").
 */
export const GLOBAL_SHORTCUT_DEFAULT_CHORDS: Readonly<
  Record<GlobalShortcutId, ChordString>
> = {
  summon: "mod+shift+space",
};

/**
 * User intent for one global shortcut, persisted in the main process
 * (`global-shortcuts.json`) and carried as-is over IPC. `chord: null` means
 * "use the definition's default chord".
 */
export const globalShortcutIntentSchema = z.object({
  enabled: z.boolean(),
  chord: z.string().nullable(),
});
export type GlobalShortcutIntent = z.infer<typeof globalShortcutIntentSchema>;

/**
 * What the OS actually granted for one shortcut, as reconciled by main:
 * - `registered` - the OS accepted the registration; the chord is live.
 * - `rejected` - the OS refused (another app already holds the chord).
 * - `disabled` - the user turned the shortcut off (or reconciliation is
 *   currently suppressed), so it was never offered to the OS.
 */
export type GlobalShortcutRegistrationStatus =
  "registered" | "rejected" | "disabled";

export interface GlobalShortcutStatus {
  readonly id: GlobalShortcutId;
  readonly intent: GlobalShortcutIntent;
  /** `intent.chord ?? <definition's default>` - the chord reconcile() acted on. */
  readonly effectiveChord: ChordString;
  readonly status: GlobalShortcutRegistrationStatus;
}
