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
import type { ConflictResult } from "@/lib/keybindings/conflicts";

const NO_MODIFIER_MESSAGE =
  "Global shortcuts need at least one modifier key (⌘, Ctrl, Shift, or Alt).";

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
  /**
   * Reject a captured chord with no modifier held. A global (OS-level)
   * shortcut with a bare key (`a`, Space, an arrow) would swallow ordinary
   * typing system-wide, so the global-shortcut row passes `true`; renderer
   * keybinding capture is unaffected and always passes `false`.
   */
  readonly requireModifier: boolean;
  /**
   * Disables entering capture mode (and force-cancels an in-progress capture)
   * while a caller-owned async mutation is in flight - e.g. the global
   * shortcut row disables this while its `set` invoke is pending, so a user
   * can't fire overlapping rebind requests. Renderer keybinding capture is a
   * synchronous local write and always passes `false`.
   */
  readonly disabled: boolean;
  /**
   * The chord that clearing (Backspace) resolves to for conflict-checking
   * purposes, or `null` when clearing simply unbinds (no chord becomes
   * effective, so there's nothing to check). The global shortcut row passes
   * the definition's default chord - `chord: null` there persists as "use
   * the default", which is a real, live chord exactly as reservable as one
   * the user captures directly (decision 6: every commit path, including
   * clear-to-default, runs the conflict check). Renderer keybinding capture
   * passes `null` - unbinding an action is always safe.
   */
  readonly clearResolvesTo: ChordString | null;
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
  const {
    value,
    controlAware,
    requireModifier,
    disabled,
    clearResolvesTo,
    label,
    checkConflict,
    onCapture,
    onClear,
  } = props;
  const [captureState, dispatchCapture] = useReducer(captureReducer, {
    capturing: false,
    conflict: null,
  });
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (disabled && captureState.capturing) {
      dispatchCapture({ type: "cancel" });
    }
  }, [disabled, captureState.capturing]);

  useEffect(() => {
    if (!captureState.capturing) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isBareModifierEvent(event)) return;
      event.preventDefault();
      event.stopPropagation();
      const decision = decideChordCapture(event, {
        controlAware,
        requireModifier,
        clearResolvesTo,
        checkConflict,
      });
      if (decision === null) return;
      if (decision.kind === "cancel") {
        dispatchCapture({ type: "cancel" });
        return;
      }
      if (decision.kind === "block") {
        dispatchCapture({ type: "conflict", conflict: decision.conflict });
        return;
      }
      if (decision.kind === "clear") {
        onClear();
      } else {
        onCapture(decision.chord);
      }
      dispatchCapture({ type: "commit", conflict: decision.conflict });
    };
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [
    captureState.capturing,
    controlAware,
    requireModifier,
    clearResolvesTo,
    checkConflict,
    onCapture,
    onClear,
  ]);

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
        disabled={disabled}
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
          "inline-flex min-w-[5rem] items-center justify-center rounded-md outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-50",
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

/**
 * What a capturing keydown should do, decided as pure data so the event
 * handler itself stays a simple dispatch table. `null` means "not a
 * complete chord yet, ignore" (e.g. a modifier-only combination).
 */
type ChordKeyDownDecision =
  | { readonly kind: "cancel" }
  | { readonly kind: "block"; readonly conflict: ConflictResult }
  | { readonly kind: "clear"; readonly conflict: ConflictResult | null }
  | {
      readonly kind: "capture";
      readonly chord: ChordString;
      readonly conflict: ConflictResult | null;
    };

interface ChordKeyDownOptions {
  readonly controlAware: boolean;
  readonly requireModifier: boolean;
  readonly clearResolvesTo: ChordString | null;
  readonly checkConflict: (candidate: ChordString) => ChordCaptureCheck | null;
}

function decideChordCapture(
  event: KeyboardEvent,
  options: ChordKeyDownOptions,
): ChordKeyDownDecision | null {
  if (event.key === "Escape") return { kind: "cancel" };
  if (event.key === "Backspace") {
    if (options.clearResolvesTo === null)
      return { kind: "clear", conflict: null };
    const check = options.checkConflict(options.clearResolvesTo);
    if (check !== null && check.blocksCommit) {
      return { kind: "block", conflict: check.conflict };
    }
    return { kind: "clear", conflict: check === null ? null : check.conflict };
  }
  const chord = options.controlAware
    ? chordFromEventCtrlAware(event)
    : chordFromEvent(event);
  if (chord === null) return null;
  if (options.requireModifier && !chordHasModifier(chord)) {
    return {
      kind: "block",
      conflict: {
        severity: "os-clash",
        conflictingActionId: null,
        message: NO_MODIFIER_MESSAGE,
      },
    };
  }
  const check = options.checkConflict(chord);
  if (check !== null && check.blocksCommit) {
    return { kind: "block", conflict: check.conflict };
  }
  return {
    kind: "capture",
    chord,
    conflict: check === null ? null : check.conflict,
  };
}

function chordHasModifier(chord: ChordString): boolean {
  const parts = parseChordString(chord);
  return (
    parts !== null && (parts.mod || parts.ctrl || parts.shift || parts.alt)
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
