import type { ActionId } from "@/lib/keybindings/actions";
import type { ChordString } from "@/lib/keybindings/chord";

export type ConflictSeverity = "duplicate" | "os-clash";

export interface ConflictResult {
  readonly severity: ConflictSeverity;
  /** Other action already bound to this chord (for duplicates). */
  readonly conflictingActionId: ActionId | null;
  readonly message: string;
}

/**
 * A chord reserved outside the renderer keybinding map - today, the desktop
 * global summon shortcut when it's actually registered with the OS. A global
 * shortcut swallows its chord system-wide before any renderer listener sees
 * it, so any overlap with it is a real conflict, checked bidirectionally:
 * capturing a global chord checks against every renderer binding, and
 * capturing a renderer binding checks against every reserved external chord.
 */
export interface ExternalReservedChord {
  readonly id: string;
  readonly label: string;
  readonly chord: ChordString;
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
  // `null` when the candidate has no self to exclude from the duplicate scan
  // (capturing a global chord, which isn't itself a renderer binding).
  excludeActionId: ActionId | null,
  candidate: ChordString,
  externalReserved: ReadonlyArray<ExternalReservedChord>,
): ConflictResult | null {
  for (const [id, chord] of Object.entries(bindings) as Array<
    [ActionId, ChordString | null]
  >) {
    if (id === excludeActionId) continue;
    if (chord === candidate) {
      return {
        severity: "duplicate",
        conflictingActionId: id,
        message: `Already bound to "${id}". Pick a different chord.`,
      };
    }
  }
  for (const reserved of externalReserved) {
    if (reserved.chord === candidate) {
      return {
        severity: "duplicate",
        conflictingActionId: null,
        message: `Already used by ${reserved.label}. Pick a different chord.`,
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
