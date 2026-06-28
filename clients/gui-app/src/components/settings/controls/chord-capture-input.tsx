import { type ReactNode, useEffect, useReducer, useRef } from "react";
import { cn } from "@/lib/utils";
import { Kbd } from "@/components/ui/kbd";
import {
  chordFromEvent,
  chordFromEventCtrlAware,
  formatChordForDisplay,
  isBareModifierEvent,
  parseChordString,
  type ChordString,
} from "@/lib/keybindings/chord";
import { isMac } from "@/lib/keybindings/platform";
import { findConflict, type ConflictResult } from "@/lib/keybindings/conflicts";
import {
  ACTION_META,
  resolveActionDefaultChord,
  type ActionId,
} from "@/lib/keybindings/actions";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";

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
  const [captureState, dispatchCapture] = useReducer(captureReducer, {
    capturing: false,
    conflict: null,
  });
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!captureState.capturing) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isBareModifierEvent(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        dispatchCapture({ type: "cancel" });
        return;
      }
      if (event.key === "Backspace") {
        onClear();
        dispatchCapture({ type: "cancel" });
        return;
      }
      // Control-aware actions capture ⌃ distinctly from ⌘ (macOS can't detect
      // key-release while ⌘ is held, which push-to-talk needs); all others use
      // the lenient encoder so ⌃ and ⌘ both keep firing a `mod` binding.
      const controlAware = isControlAwareAction(actionId);
      const chord = controlAware
        ? chordFromEventCtrlAware(event)
        : chordFromEvent(event);
      if (chord === null) return;
      // For a Control-aware action on macOS, reject a Command (`mod`) capture:
      // ⌘ chords can't drive hold/toggle there (no key-release event).
      if (controlAware && isMac() && parseChordString(chord)?.mod === true) {
        dispatchCapture({
          type: "conflict",
          conflict: {
            severity: "os-clash",
            conflictingActionId: null,
            message:
              "Use Control (⌃), not ⌘ - macOS can't detect ⌘ key-release.",
          },
        });
        return;
      }
      const bindings = useKeybindingStore.getState().bindings;
      const result = findConflict(bindings, actionId, chord);
      if (result !== null && result.severity === "duplicate") {
        dispatchCapture({ type: "conflict", conflict: result });
        return;
      }
      onChange(chord);
      dispatchCapture({ type: "commit", conflict: result });
    };
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [captureState.capturing, actionId, onChange, onClear]);

  useEffect(() => {
    if (!captureState.capturing) return;
    const handleBlur = () => {
      dispatchCapture({ type: "cancel" });
    };
    const node = buttonRef.current;
    if (node === null) return;
    node.addEventListener("blur", handleBlur);
    return () => node.removeEventListener("blur", handleBlur);
  }, [captureState.capturing]);

  const display = value === null ? "Unbound" : formatChordForDisplay(value);

  let buttonStateClass: string;
  if (captureState.capturing) {
    buttonStateClass =
      "border border-primary/70 bg-primary/10 px-2.5 py-1 font-mono text-code-xs font-medium text-primary";
  } else if (value !== null) {
    buttonStateClass =
      "hover:opacity-75 focus-visible:ring-1 focus-visible:ring-primary/60";
  } else {
    buttonStateClass =
      "border border-border/60 bg-muted/40 px-2.5 py-1 font-mono text-code-xs font-medium tabular-nums text-muted-foreground hover:bg-muted focus-visible:border-primary/60";
  }

  let buttonContent: ReactNode;
  if (captureState.capturing) {
    buttonContent = "Press chord…";
  } else if (value !== null) {
    buttonContent = (
      <Kbd className="font-mono text-code-xs tabular-nums">{display}</Kbd>
    );
  } else {
    buttonContent = display;
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          dispatchCapture({ type: "toggle" });
        }}
        aria-pressed={captureState.capturing}
        aria-label={
          captureState.capturing
            ? `Recording new chord for ${actionId}`
            : `Rebind ${actionId}`
        }
        className={cn(
          "inline-flex min-w-[5rem] items-center justify-center rounded-md outline-none transition-colors",
          buttonStateClass,
        )}
      >
        {buttonContent}
      </button>
      {captureState.conflict !== null ? (
        <p
          className={cn(
            "text-ui-xs",
            captureState.conflict.severity === "duplicate"
              ? "text-destructive"
              : "text-amber-600 dark:text-amber-400",
          )}
        >
          {captureState.conflict.message}
        </p>
      ) : null}
    </div>
  );
}

interface CaptureState {
  readonly capturing: boolean;
  readonly conflict: ConflictResult | null;
}

type CaptureAction =
  | { readonly type: "toggle" }
  | { readonly type: "cancel" }
  | { readonly type: "conflict"; readonly conflict: ConflictResult }
  | {
      readonly type: "commit";
      readonly conflict: ConflictResult | null;
    };

function captureReducer(
  state: CaptureState,
  action: CaptureAction,
): CaptureState {
  if (action.type === "toggle") {
    return { capturing: !state.capturing, conflict: null };
  }
  if (action.type === "cancel") {
    return { capturing: false, conflict: null };
  }
  if (action.type === "conflict") {
    return { capturing: true, conflict: action.conflict };
  }
  return { capturing: false, conflict: action.conflict };
}
