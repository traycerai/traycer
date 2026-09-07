import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  hasPlatformModKey,
  isBareModifierEvent,
  resolveMatchingChord,
} from "@/lib/keybindings/chord";
import {
  dispatchAction,
  findActionMatchForChord,
  type DigitActionMatch,
  isExternallyHandled,
  isRepeatSensitiveAction,
  matchDigitAction,
  registerBaseLeaderScope,
  resolveLeaderOwner,
} from "@/lib/keybindings/dispatch";
import { subscribeLeaderScopes } from "@/lib/keybindings/leader-scope";
import { historyNavChromeAvailable } from "@/lib/history-navigation";
import type { ActionId } from "@/lib/keybindings/actions";
import { ACTION_META, type TerminalPolicy } from "@/lib/keybindings/actions";
import { isMac } from "@/lib/keybindings/platform";
import {
  routerAdapterFor,
  type KeybindingRouterSource,
} from "@/lib/keybindings/router-adapter";
import {
  LeaderHeldContext,
  type LeaderModifier,
  type LeaderState,
} from "@/providers/keybinding-context";
import {
  isDiffsEditorEvent,
  isEditableEventTarget,
} from "@/lib/keybindings/editable-target";
import { useScreencastArmedStore } from "@/stores/screencast-armed-store";

interface KeybindingProviderProps {
  readonly router: KeybindingRouterSource;
  readonly children: ReactNode;
}

const INITIAL_LEADER: LeaderState = {
  modHeld: false,
  altHeld: false,
  modShiftHeld: false,
  modOwnerScopeId: null,
  altOwnerScopeId: null,
  modShiftOwnerScopeId: null,
  pathname: "/",
};
const LEADER_HINT_DELAY_MS = 300;
const DIGIT_SEQUENCE_COMMIT_MS = 450;

type LeaderHintSession =
  | { readonly status: "idle" }
  | { readonly status: "pending"; readonly modifier: LeaderModifier }
  | { readonly status: "visible"; readonly modifier: LeaderModifier }
  | { readonly status: "spent" };

interface DigitSequenceSession {
  readonly actionId: ActionId;
  readonly digits: ReadonlyArray<number>;
  readonly dispatchSequence: (digits: ReadonlyArray<number>) => boolean;
}

interface RefBox<T> {
  current: T;
}

/** Ordinary leader-hold reveals this modifier's owner and a sibling scope's other modifier. Shifted leader never falls through to ordinary leaders. */
export function KeybindingProvider(props: KeybindingProviderProps) {
  const { router, children } = props;
  const [leaderState, setLeaderState] = useState<LeaderState>(INITIAL_LEADER);
  const leaderStateRef = useRef<LeaderState>(INITIAL_LEADER);
  const hintSessionRef = useRef<LeaderHintSession>({ status: "idle" });
  const hintTimerRef = useRef<number | null>(null);
  const digitSequenceRef = useRef<DigitSequenceSession | null>(null);
  const digitSequenceTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const adapter = routerAdapterFor(router);
    const armedRef = {
      current: useScreencastArmedStore.getState().ownerId !== null,
    };
    const unsubscribeArmed = useScreencastArmedStore.subscribe((state) => {
      armedRef.current = state.ownerId !== null;
    });

    const clearHintTimer = () => {
      if (hintTimerRef.current === null) return;
      window.clearTimeout(hintTimerRef.current);
      hintTimerRef.current = null;
    };

    const applyLeaderState = (next: LeaderState) => {
      const prev = leaderStateRef.current;
      if (
        prev.modHeld === next.modHeld &&
        prev.altHeld === next.altHeld &&
        prev.modShiftHeld === next.modShiftHeld &&
        prev.modOwnerScopeId === next.modOwnerScopeId &&
        prev.altOwnerScopeId === next.altOwnerScopeId &&
        prev.modShiftOwnerScopeId === next.modShiftOwnerScopeId &&
        prev.pathname === next.pathname
      ) {
        return;
      }
      leaderStateRef.current = next;
      setLeaderState(next);
    };

    // Ordinary hold lights this modifier and a sibling scope's other modifier.
    // Shifted leader is exact-owner-only and must not light ordinary badges.
    const resolveVisibleLeaderState = (
      heldModifier: LeaderModifier,
      pathname: string,
    ): LeaderState => {
      const modOwner = resolveLeaderOwner("mod");
      const altOwner = resolveLeaderOwner("alt");
      const modShiftOwner = resolveLeaderOwner("modShift");
      if (heldModifier === "modShift") {
        return {
          modHeld: false,
          altHeld: false,
          modShiftHeld: modShiftOwner !== null,
          modOwnerScopeId: null,
          altOwnerScopeId: null,
          modShiftOwnerScopeId: modShiftOwner,
          pathname,
        };
      }
      const showMod =
        heldModifier === "mod" ||
        (modOwner !== null &&
          modOwner !== altOwner &&
          modOwner !== modShiftOwner);
      const showAlt =
        heldModifier === "alt" ||
        (altOwner !== null &&
          altOwner !== modOwner &&
          altOwner !== modShiftOwner);
      return {
        modHeld: showMod && modOwner !== null,
        altHeld: showAlt && altOwner !== null,
        modShiftHeld: false,
        modOwnerScopeId: showMod ? modOwner : null,
        altOwnerScopeId: showAlt ? altOwner : null,
        modShiftOwnerScopeId: null,
        pathname,
      };
    };

    const hasLeaderOwner = (modifier: LeaderModifier): boolean => {
      if (modifier === "modShift") {
        return resolveLeaderOwner("modShift") !== null;
      }
      // Ordinary Cmd/Option sessions intentionally retain the sibling-owner
      // behavior: holding one ordinary modifier can still reveal the other
      // ordinary scope when only that scope is active.
      return (
        resolveLeaderOwner("mod") !== null || resolveLeaderOwner("alt") !== null
      );
    };

    const showLeaderHints = (
      heldModifier: LeaderModifier,
      pathname: string,
    ) => {
      applyLeaderState(resolveVisibleLeaderState(heldModifier, pathname));
    };

    const hideLeaderHints = (pathname: string) => {
      applyLeaderState({
        modHeld: false,
        altHeld: false,
        modShiftHeld: false,
        modOwnerScopeId: null,
        altOwnerScopeId: null,
        modShiftOwnerScopeId: null,
        pathname,
      });
    };

    const resetHintSession = (pathname: string) => {
      clearHintTimer();
      resetDigitSequence(digitSequenceRef, digitSequenceTimerRef);
      hintSessionRef.current = { status: "idle" };
      hideLeaderHints(pathname);
    };

    const spendHintSession = (pathname: string) => {
      clearHintTimer();
      hintSessionRef.current = { status: "spent" };
      hideLeaderHints(pathname);
    };

    const revealPendingSession = (modifier: LeaderModifier) => {
      const session = hintSessionRef.current;
      if (session.status !== "pending" || session.modifier !== modifier) {
        return;
      }
      const pathname = adapter.getPathname();
      if (!hasLeaderOwner(modifier)) {
        spendHintSession(pathname);
        return;
      }
      hintTimerRef.current = null;
      hintSessionRef.current = { status: "visible", modifier };
      showLeaderHints(modifier, pathname);
    };

    // Visible hold swaps modifier instantly; pending/idle/spent restarts the
    // delay. Re-imposing the delay on combo change would flicker hints.
    const transitionLeaderSession = (
      modifier: LeaderModifier,
      pathname: string,
    ) => {
      const session = hintSessionRef.current;
      if (session.status === "spent") return;
      if (session.status === "visible") {
        clearHintTimer();
        hintSessionRef.current = { status: "visible", modifier };
        showLeaderHints(modifier, pathname);
        return;
      }
      if (session.status === "pending" && session.modifier === modifier) {
        hideLeaderHints(pathname);
        return;
      }
      clearHintTimer();
      hintSessionRef.current = { status: "pending", modifier };
      hideLeaderHints(pathname);
      hintTimerRef.current = window.setTimeout(() => {
        revealPendingSession(modifier);
      }, LEADER_HINT_DELAY_MS);
    };

    const cleanLeaderModifierFromEvent = (
      event: KeyboardEvent,
    ): LeaderModifier | null => {
      const modKeyHeld = hasPlatformModKey(event);
      const cleanMod = modKeyHeld && !event.altKey && !event.shiftKey;
      const cleanAlt = event.altKey && !modKeyHeld && !event.shiftKey;
      const cleanModShift = modKeyHeld && event.shiftKey && !event.altKey;
      if (cleanMod && hasLeaderOwner("mod")) return "mod";
      if (cleanAlt && hasLeaderOwner("alt")) return "alt";
      if (cleanModShift && hasLeaderOwner("modShift")) return "modShift";
      return null;
    };

    const allLeaderModifiersReleased = (event: KeyboardEvent): boolean => {
      return !event.metaKey && !event.ctrlKey && !event.altKey;
    };

    const hasLeaderModifier = (event: KeyboardEvent): boolean => {
      return event.metaKey || event.ctrlKey || event.altKey;
    };

    const handleRouteChange = () => {
      const pathname = adapter.getPathname();
      const session = hintSessionRef.current;
      if (session.status === "pending" || session.status === "visible") {
        if (!hasLeaderOwner(session.modifier)) {
          spendHintSession(pathname);
          return;
        }
        if (session.status === "visible") {
          showLeaderHints(session.modifier, pathname);
          return;
        }
      }
      hideLeaderHints(pathname);
    };

    // Reserved v1 list is empty - OS-level chords live in the Electron menu
    // and never reach this listener. No action-id list.
    const skipAppActions = (
      event: KeyboardEvent,
      pathname: string,
    ): boolean => {
      if (isAnyDialogOpen()) {
        if (hasLeaderModifier(event)) spendHintSession(pathname);
        else resetHintSession(pathname);
        return true;
      }
      if (!armedRef.current) return false;
      if (hasLeaderModifier(event)) spendHintSession(pathname);
      else resetHintSession(pathname);
      resetDigitSequence(digitSequenceRef, digitSequenceTimerRef);
      return true;
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const pathname = adapter.getPathname();
      if (allLeaderModifiersReleased(event)) {
        resetHintSession(pathname);
      }

      if (skipAppActions(event, pathname)) return;

      const cleanModifier = cleanLeaderModifierFromEvent(event);
      if (isBareModifierEvent(event)) {
        if (cleanModifier === null) {
          if (hasLeaderModifier(event)) spendHintSession(pathname);
          return;
        }
        transitionLeaderSession(cleanModifier, pathname);
        return;
      }

      if (hasLeaderModifier(event)) spendHintSession(pathname);
      if (event.defaultPrevented) return;
      // Diffs claims bare typing and undo/redo. Other modified chords still
      // resolve as app actions. Do not reserve Cmd-Z before the editor sees it.
      if (isDiffsEditorOwnedKey(event, hasLeaderModifier(event))) return;
      if (isArtifactEditorLinkShortcut(event)) return;

      // Digit actions match before full chords so a mod+1 rebinding cannot
      // shadow digit-by-number. matchDigitAction needs a digit plus a modifier.
      const digitMatch = matchDigitAction(event);
      if (
        handleDigitKeyDown(
          event,
          digitMatch,
          digitSequenceRef,
          digitSequenceTimerRef,
        )
      )
        return;

      resetDigitSequence(digitSequenceRef, digitSequenceTimerRef);

      const actionId = resolveReservedAction(event);
      if (actionId === null) return;
      if (
        shouldPassCtrlChordToFocusedTerminal(event, actionId.terminalPolicy)
      ) {
        return;
      }

      // Toggles (e.g. the model picker) must act once per physical press. Still
      // reserve the chord on OS key-repeat so the browser default can't run,
      // but skip re-dispatch so a held chord doesn't flip the toggle rapidly.
      if (event.repeat && isRepeatSensitiveAction(actionId.actionId)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      // Reserve even when dispatch cannot act, or the browser runs history
      // back/forward for the same chord.
      event.preventDefault();
      event.stopPropagation();
      dispatchAction(actionId.actionId, adapter);
    };

    // Mouse back/forward (buttons 3/4): desktop chrome predicate, not history brand.
    // preventDefault only when handled so native back/forward stays elsewhere.
    const handleMouseNav = (event: MouseEvent) => {
      if (!historyNavChromeAvailable(router.history)) return;
      if (event.button === 3) {
        event.preventDefault();
        adapter.goBack();
      } else if (event.button === 4) {
        event.preventDefault();
        adapter.goForward();
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      const pathname = adapter.getPathname();
      if (allLeaderModifiersReleased(event)) {
        commitDigitSequence(digitSequenceRef, digitSequenceTimerRef);
        resetHintSession(pathname);
        return;
      }
      const cleanModifier = cleanLeaderModifierFromEvent(event);
      if (cleanModifier === null) {
        if (hasLeaderModifier(event)) spendHintSession(pathname);
        return;
      }
      // Remaining held combo is still clean (modShift -> mod). Without this,
      // hints stay on the released tier.
      const session = hintSessionRef.current;
      if (
        (session.status === "pending" || session.status === "visible") &&
        session.modifier !== cleanModifier
      ) {
        transitionLeaderSession(cleanModifier, pathname);
      }
    };

    const handleBlur = () => {
      resetHintSession(adapter.getPathname());
    };

    // Re-resolve pending/visible session when a scope registers. Spend it if
    // the owner disappears so a stale timer cannot revive.
    const handleScopeChange = () => {
      const session = hintSessionRef.current;
      if (session.status !== "pending" && session.status !== "visible") return;
      const pathname = adapter.getPathname();
      if (!hasLeaderOwner(session.modifier)) {
        spendHintSession(pathname);
        return;
      }
      if (session.status !== "visible") return;
      showLeaderHints(session.modifier, pathname);
    };

    const unregisterBaseScope = registerBaseLeaderScope(adapter);
    const unsubscribeScopes = subscribeLeaderScopes(handleScopeChange);
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    window.addEventListener("keyup", handleKeyUp, { capture: true });
    window.addEventListener("blur", handleBlur);
    // Capture-phase to match keydown/keyup: app history nav should win before a
    // descendant (editor, xterm) can swallow mouse buttons 3/4.
    window.addEventListener("auxclick", handleMouseNav, { capture: true });
    const unsubscribeHistory = router.history.subscribe(handleRouteChange);
    return () => {
      clearHintTimer();
      resetDigitSequence(digitSequenceRef, digitSequenceTimerRef);
      unsubscribeArmed();
      unsubscribeHistory();
      unsubscribeScopes();
      unregisterBaseScope();
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
      window.removeEventListener("keyup", handleKeyUp, { capture: true });
      window.removeEventListener("blur", handleBlur);
      window.removeEventListener("auxclick", handleMouseNav, { capture: true });
    };
  }, [router]);

  return (
    <LeaderHeldContext.Provider value={leaderState}>
      {children}
    </LeaderHeldContext.Provider>
  );
}

/** Reserve only when this dispatcher owns the chord. Bare macOS Control must not fall through to a plain key; null means another owner (e.g. dictation). */
interface ReservedAction {
  readonly actionId: ActionId;
  readonly terminalPolicy: TerminalPolicy;
}

function resolveReservedAction(event: KeyboardEvent): ReservedAction | null {
  const chord = resolveMatchingChord(event);
  if (chord === null) return null;
  const match = findActionMatchForChord(chord);
  if (match === null) return null;
  // Cmd+Left/Right is history and also start/end of line in text fields.
  // Keep global nav without breaking editing.
  if (
    (match.actionId === "nav.back" || match.actionId === "nav.forward") &&
    (chord === "mod+arrowleft" || chord === "mod+arrowright") &&
    (isEditableEventTarget(event.target) || isDiffsEditorEvent(event))
  ) {
    return null;
  }
  if (isExternallyHandled(match.actionId)) return null;
  return match;
}

function shouldPassCtrlChordToFocusedTerminal(
  event: KeyboardEvent,
  terminalPolicy: TerminalPolicy,
): boolean {
  return (
    !isMac() &&
    event.ctrlKey &&
    terminalPolicy === "shell" &&
    isTerminalEventTarget(event.target)
  );
}

function isTerminalEventTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest("[data-terminal-host]") !== null
  );
}

function isDiffsHistoryShortcut(event: KeyboardEvent): boolean {
  return (
    hasPlatformModKey(event) && !event.altKey && event.key.toLowerCase() === "z"
  );
}

function isDiffsEditorOwnedKey(
  event: KeyboardEvent,
  hasLeaderModifier: boolean,
): boolean {
  return (
    isDiffsEditorEvent(event) &&
    (!hasLeaderModifier || isDiffsHistoryShortcut(event))
  );
}

function isArtifactEditorLinkShortcut(event: KeyboardEvent): boolean {
  const target = event.target;
  return (
    event.key.toLowerCase() === "k" &&
    (event.metaKey || event.ctrlKey) &&
    target instanceof Element &&
    target.closest("[data-artifact-editor]") !== null
  );
}

function clearDigitSequenceTimer(timerRef: RefBox<number | null>): void {
  if (timerRef.current === null) return;
  window.clearTimeout(timerRef.current);
  timerRef.current = null;
}

function resetDigitSequence(
  sequenceRef: RefBox<DigitSequenceSession | null>,
  timerRef: RefBox<number | null>,
): void {
  clearDigitSequenceTimer(timerRef);
  sequenceRef.current = null;
}

function commitDigitSequence(
  sequenceRef: RefBox<DigitSequenceSession | null>,
  timerRef: RefBox<number | null>,
): void {
  clearDigitSequenceTimer(timerRef);
  const session = sequenceRef.current;
  if (session === null) return;
  sequenceRef.current = null;
  session.dispatchSequence(session.digits);
}

function scheduleDigitSequenceCommit(
  sequenceRef: RefBox<DigitSequenceSession | null>,
  timerRef: RefBox<number | null>,
): void {
  clearDigitSequenceTimer(timerRef);
  timerRef.current = window.setTimeout(() => {
    commitDigitSequence(sequenceRef, timerRef);
  }, DIGIT_SEQUENCE_COMMIT_MS);
}

function handleDigitMatch(
  match: DigitActionMatch,
  sequenceRef: RefBox<DigitSequenceSession | null>,
  timerRef: RefBox<number | null>,
): boolean {
  if (match.dispatchSequence === null || match.sequenceState === null) {
    resetDigitSequence(sequenceRef, timerRef);
    return match.run();
  }

  const current = sequenceRef.current;
  const digits =
    current !== null && current.actionId === match.actionId
      ? [...current.digits, match.digit]
      : [match.digit];
  const state = match.sequenceState(digits);
  if (state === "invalid") {
    resetDigitSequence(sequenceRef, timerRef);
    return false;
  }

  sequenceRef.current = {
    actionId: match.actionId,
    digits,
    dispatchSequence: match.dispatchSequence,
  };
  if (state === "exact") {
    commitDigitSequence(sequenceRef, timerRef);
    return true;
  }

  scheduleDigitSequenceCommit(sequenceRef, timerRef);
  return true;
}

function handleDigitKeyDown(
  event: KeyboardEvent,
  match: DigitActionMatch | null,
  sequenceRef: RefBox<DigitSequenceSession | null>,
  timerRef: RefBox<number | null>,
): boolean {
  if (match === null) return false;
  if (
    shouldPassCtrlChordToFocusedTerminal(
      event,
      ACTION_META[match.actionId].terminalPolicy,
    )
  )
    return true;

  event.preventDefault();
  event.stopPropagation();
  handleDigitMatch(match, sequenceRef, timerRef);
  return true;
}

function isAnyDialogOpen(): boolean {
  if (typeof document === "undefined") return false;
  const dialogs = document.querySelectorAll(
    '[role="dialog"][data-state="open"]',
  );
  // data-leader-scope dialogs are transparent to chord dispatch. Any other
  // open dialog still blocks.
  for (const node of dialogs) {
    if (!(node instanceof HTMLElement)) return true;
    if (node.dataset.leaderScope === undefined) return true;
  }
  return false;
}
