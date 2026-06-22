import type { ActionId } from "@/lib/keybindings/actions";
import type { ChordString } from "@/lib/keybindings/chord";

export type ConflictSeverity = "duplicate" | "os-clash";

export interface ConflictResult {
  readonly severity: ConflictSeverity;
  /** Other action already bound to this chord (for duplicates). */
  readonly conflictingActionId: ActionId | null;
  readonly message: string;
}
const OS_CLASH_CHORDS: Readonly<Record<ChordString, string>> = {
  "mod+q": "Quit application on most OSes.",
  "mod+c": "Copy in most apps.",
  "mod+v": "Paste in most apps.",
  "mod+x": "Cut in most apps.",
  "mod+z": "Undo in most apps.",
  "mod+shift+z": "Redo on many apps.",
  "mod+a": "Select all in most apps.",
  "mod+f": "Find in most apps.",
  "mod+r": "Reload in browsers.",
  "mod+shift+r": "Hard reload in browsers.",
  "mod+n": "New window in most apps.",
  "mod+p": "Print in most apps.",
  "mod+s": "Save in most apps.",
};

export function findConflict(
  bindings: Readonly<Record<ActionId, ChordString | null>>,
  actionId: ActionId,
  candidate: ChordString,
): ConflictResult | null {
  for (const [id, chord] of Object.entries(bindings) as Array<
    [ActionId, ChordString | null]
  >) {
    if (id === actionId) continue;
    if (chord === candidate) {
      return {
        severity: "duplicate",
        conflictingActionId: id,
        message: `Already bound to "${id}". Pick a different chord.`,
      };
    }
  }
  if (Object.hasOwn(OS_CLASH_CHORDS, candidate)) {
    return {
      severity: "os-clash",
      conflictingActionId: null,
      message: `Overrides OS shortcut: ${OS_CLASH_CHORDS[candidate]}`,
    };
  }
  return null;
}
