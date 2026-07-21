import { type ReactNode, useEffect, useReducer, useRef } from "react";
import { cn } from "@/lib/utils";
import { Kbd } from "@/components/ui/kbd";
import {
  chordFromEvent,
  chordFromEventCtrlAware,
  formatChordForDisplay,
  isBareModifierEvent,
  type ChordString,
} from "@/lib/keybindings/chord";
import type { ConflictResult } from "@/lib/keybindings/conflicts";

/**
 * Result of validating a just-captured chord: the conflict message to show,
 * and whether it blocks the capture from committing (a true conflict) or is
 * warn-only (an OS-clash chord that still gets bound).
 */
export interface ChordCaptureCheck {
  readonly conflict: ConflictResult;
  readonly blocksCommit: boolean;
}

export interface ChordCaptureCoreProps {
  readonly value: ChordString | null;
  /**
   * Whether the ⌃ key should be captured distinctly from ⌘ (macOS can't
   * detect ⌘ key-release, which hold/toggle actions need) - see
   * `chordFromEventCtrlAware`'s doc for the full rationale. Global shortcuts
   * have no hold/release semantics, so they always pass `false`.
   */
  readonly controlAware: boolean;
  /** Interpolated into "Rebind {label}" / "Recording new chord for {label}". */
  readonly label: string;
  readonly checkConflict: (candidate: ChordString) => ChordCaptureCheck | null;
  readonly onCapture: (chord: ChordString) => void;
  readonly onClear: () => void;
}

/**
 * Click-to-capture chord input, extracted from the action-scoped
 * `ChordCaptureInput` so the desktop global-shortcut settings row can reuse
 * the exact capture mechanics (click to arm, next full chord keydown commits,
 * Escape cancels, Backspace clears, blur cancels) without being coupled to a
 * renderer `ActionId` or `useKeybindingStore` - conflict-checking and the
 * committed value are both supplied by the caller.
 */
export function ChordCaptureCore(props: ChordCaptureCoreProps) {
  const { value, controlAware, label, checkConflict, onCapture, onClear } =
    props;
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
      const chord = controlAware
        ? chordFromEventCtrlAware(event)
        : chordFromEvent(event);
      if (chord === null) return;
      const check = checkConflict(chord);
      if (check !== null && check.blocksCommit) {
        dispatchCapture({ type: "conflict", conflict: check.conflict });
        return;
      }
      onCapture(chord);
      dispatchCapture({
        type: "commit",
        conflict: check === null ? null : check.conflict,
      });
    };
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [captureState.capturing, controlAware, checkConflict, onCapture, onClear]);

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
            ? `Recording new chord for ${label}`
            : `Rebind ${label}`
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
