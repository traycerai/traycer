import { useMemo } from "react";
import {
  ChordCaptureCore,
  type ChordCaptureCheck,
} from "@/components/settings/controls/chord-capture-core";
import { parseChordString, type ChordString } from "@/lib/keybindings/chord";
import { isMac } from "@/lib/keybindings/platform";
import {
  findConflict,
  type ExternalReservedChord,
} from "@/lib/keybindings/conflicts";
import {
  ACTION_META,
  resolveActionDefaultChord,
  type ActionId,
} from "@/lib/keybindings/actions";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
import { useSummonHotkey } from "@/hooks/runner/use-summon-hotkey";

// An action is "Control-aware" when its platform-effective default chord targets
// the Control key specifically (e.g. the dictation toggle, and the model-picker
// toggle's ⌃⌥M on macOS). Only these capture ⌃ vs ⌘ distinctly; every other
// action keeps the lenient capture (Control → `mod`) so rebinding a normal
// action by pressing Control on macOS still produces a binding that fires on ⌘
// as before.
function isControlAwareAction(actionId: ActionId): boolean {
  const def = resolveActionDefaultChord(ACTION_META[actionId]);
  return def !== null && parseChordString(def)?.ctrl === true;
}

interface ChordCaptureInputProps {
  actionId: ActionId;
  value: ChordString | null;
  onChange: (next: ChordString) => void;
  onClear: () => void;
}

/**
 * Click the chip to enter capture mode; the next full chord keydown becomes
 * the new binding. Escape cancels capture, Backspace clears the binding.
 * Duplicate chords block save with an inline error; OS-clash chords save
 * but show a warning. No separate clear button - use Backspace while the
 * chip is active.
 */
export function ChordCaptureInput(props: ChordCaptureInputProps) {
  const { actionId, value, onChange, onClear } = props;
  const controlAware = isControlAwareAction(actionId);
  // The desktop's global summon shortcut swallows its chord system-wide
  // before any renderer listener sees it - so it's a real conflict for a
  // renderer binding. Reserved by persisted INTENT, not live OS status
  // (amended decision 6): a chord the user intends enabled stays reserved
  // even while the OS currently rejects it, because it will register on a
  // later launch and would otherwise silently swallow a renderer binding
  // placed on it in the meantime. Only `enabled: false` frees the chord -
  // the enable-path check (R1, in the settings row) guards re-enabling.
  const { status: summonStatus } = useSummonHotkey();
  const externalReserved = useMemo<ReadonlyArray<ExternalReservedChord>>(() => {
    if (summonStatus === null || !summonStatus.intent.enabled) {
      return [];
    }
    return [
      {
        id: "global.summon",
        label: "Summon Traycer (global shortcut)",
        chord: summonStatus.effectiveChord,
      },
    ];
  }, [summonStatus]);

  return (
    <ChordCaptureCore
      value={value}
      controlAware={controlAware}
      requireModifier={false}
      disabled={false}
      clearResolvesTo={null}
      label={actionId}
      onCapture={onChange}
      onClear={onClear}
      checkConflict={(candidate): ChordCaptureCheck | null => {
        // For a Control-aware action on macOS, reject a Command (`mod`)
        // capture: ⌘ chords can't drive hold/toggle there (no key-release
        // event).
        if (
          controlAware &&
          isMac() &&
          parseChordString(candidate)?.mod === true
        ) {
          return {
            blocksCommit: true,
            conflict: {
              severity: "os-clash",
              conflictingActionId: null,
              message:
                "Use Control (⌃), not ⌘ - macOS can't detect ⌘ key-release.",
            },
          };
        }
        const bindings = useKeybindingStore.getState().bindings;
        const result = findConflict(
          bindings,
          actionId,
          candidate,
          externalReserved,
        );
        if (result === null) return null;
        return {
          blocksCommit: result.severity === "duplicate",
          conflict: result,
        };
      }}
    />
  );
}
