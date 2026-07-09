import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  chordFromEvent,
  chordFromEventCtrlAware,
  isBareModifierEvent,
} from "@/lib/keybindings/chord";
import {
  dispatchAction,
  type DigitActionMatch,
  findActionForChord,
  isExternallyHandled,
  isRepeatSensitiveAction,
  matchDigitAction,
  registerBaseLeaderScope,
  resolveLeaderOwner,
} from "@/lib/keybindings/dispatch";
import { subscribeLeaderScopes } from "@/lib/keybindings/leader-scope";
import { getHistoryController } from "@/lib/history-navigation";
import type { ActionId } from "@/lib/keybindings/actions";
import {
  routerAdapterFor,
  type KeybindingRouterSource,
} from "@/lib/keybindings/router-adapter";
import {
  LeaderHeldContext,
  type LeaderModifier,
  type LeaderState,
} from "@/providers/keybinding-context";

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

/**
 * Tracks clean leader-hold sessions and publishes leader owners relative to the
 * modifier combo actually held (`mod`, `alt`, or `modShift`). Holding one leader
 * always reveals that modifier's owner, and also reveals the OTHER modifiers'
 * owners when a DIFFERENT scope owns them - so two sibling app scopes (canvas
 * tabs own `mod`, header tabs own `alt`) still show `⌘` and `⌥` badges together.
 * A lone overlay scope that binds all three dimensions (the model picker: `⌘`
 * rail, `⌥` reasoning, `⌘⇧` profile) only lights the one matching the held
 * combo. The dispatcher's chord matching still owns route-aware action
 * selection and fires digit shortcuts from the actual key event immediately.
 */
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

    // Publish the held modifier's owner always; publish the OTHER modifiers'
    // owners only when a DIFFERENT scope owns them. Two sibling app scopes
    // (canvas tabs own `mod`, header tabs own `alt`) still light both badge sets
    // on a single hold - the #3966 "show both task tabs" behavior. But a lone
    // overlay scope binding ALL THREE dimensions (the model picker: ⌘ rail, ⌥
    // reasoning, ⌘⇧ profile) owns each dimension under one scope id, so its
    // badge consumers can only be disambiguated by the held combo: ⌘ lights the
    // rail, ⌥ lights reasoning, ⌘⇧ lights the profile dropdown, never more than
    // one at once.
    const resolveVisibleLeaderState = (
      heldModifier: LeaderModifier,
      pathname: string,
    ): LeaderState => {
      const modOwner = resolveLeaderOwner("mod");
      const altOwner = resolveLeaderOwner("alt");
      const modShiftOwner = resolveLeaderOwner("modShift");
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
      const showModShift =
        heldModifier === "modShift" ||
        (modShiftOwner !== null &&
          modShiftOwner !== modOwner &&
          modShiftOwner !== altOwner);
      return {
        modHeld: showMod && modOwner !== null,
        altHeld: showAlt && altOwner !== null,
        modShiftHeld: showModShift && modShiftOwner !== null,
        modOwnerScopeId: showMod ? modOwner : null,
        altOwnerScopeId: showAlt ? altOwner : null,
        modShiftOwnerScopeId: showModShift ? modShiftOwner : null,
        pathname,
      };
    };

    const hasVisibleLeaderOwners = (): boolean => {
      return (
        resolveLeaderOwner("mod") !== null ||
        resolveLeaderOwner("alt") !== null ||
        resolveLeaderOwner("modShift") !== null
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
      if (!hasVisibleLeaderOwners()) {
        spendHintSession(pathname);
        return;
      }
      hintTimerRef.current = null;
      hintSessionRef.current = { status: "visible", modifier };
      showLeaderHints(modifier, pathname);
    };

    // Moves the hint session onto `modifier` - called both when a fresh bare
    // modifier keydown starts a hold, AND when the physically-held combo
    // changes while a leader is CONTINUOUSLY held (e.g. releasing Shift while
    // Cmd stays down: modShift -> mod, or the reverse, pressing Shift while
    // Cmd is already down). A VISIBLE session swaps to the new modifier
    // instantly - the hold delay was already cleared once for this
    // continuous hold, so re-imposing it on every combo change would make
    // hints flicker off and back on for no reason. A PENDING (or idle/spent)
    // session (re)starts the delay for the new modifier, same as a fresh hold.
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
      const modKeyHeld = event.metaKey || event.ctrlKey;
      const cleanMod = modKeyHeld && !event.altKey && !event.shiftKey;
      const cleanAlt = event.altKey && !modKeyHeld && !event.shiftKey;
      const cleanModShift = modKeyHeld && event.shiftKey && !event.altKey;
      if (cleanMod && hasVisibleLeaderOwners()) return "mod";
      if (cleanAlt && hasVisibleLeaderOwners()) return "alt";
      if (cleanModShift && hasVisibleLeaderOwners()) return "modShift";
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
        if (!hasVisibleLeaderOwners()) {
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

    const handleKeyDown = (event: KeyboardEvent) => {
      const pathname = adapter.getPathname();
      if (allLeaderModifiersReleased(event)) {
        resetHintSession(pathname);
      }

      if (isAnyDialogOpen()) {
        if (hasLeaderModifier(event)) spendHintSession(pathname);
        else resetHintSession(pathname);
        return;
      }

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

      // Digit actions (e.g. ⌘1 or header tab sequences like ⌥1,0) must match
      // before full chords -
      // otherwise a rebinding like `mod+1 → something` would shadow the
      // digit-by-number flow. `matchDigitAction` only succeeds when a digit
      // is the primary key + at least one modifier is held.
      const digitMatch = matchDigitAction(event);
      if (digitMatch !== null) {
        event.preventDefault();
        event.stopPropagation();
        handleDigitMatch(digitMatch, digitSequenceRef, digitSequenceTimerRef);
        return;
      }

      resetDigitSequence(digitSequenceRef, digitSequenceTimerRef);

      const actionId = resolveReservedAction(event);
      if (actionId === null) return;

      // Toggles (e.g. the model picker) must act once per physical press. Still
      // reserve the chord on OS key-repeat so the browser default can't run,
      // but skip re-dispatch so a held chord doesn't flip the toggle rapidly.
      if (event.repeat && isRepeatSensitiveAction(actionId)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      // Reserve any chord bound to a centrally-handled action - even when
      // dispatch can't act (e.g. `group.focus.right` with no right neighbour).
      // This stops the browser from running its own default for the same chord
      // (Cmd+Alt+Left/Right = history back/forward on Chrome+Safari).
      event.preventDefault();
      event.stopPropagation();
      dispatchAction(actionId, adapter);
    };

    // Mouse back/forward (buttons 3/4). Desktop-only: gated on the current
    // router carrying a persistent-history controller, so the browser/web build
    // never intercepts these. `preventDefault()` runs only when handled, so the
    // shell's native back/forward stays intact off-desktop.
    // NOTE: Windows may instead surface these as a main-process `app-command`
    // (`browser-backward`/`browser-forward`); that path is a verify-and-extend
    // follow-up tracked in the tech plan (§4.4).
    const handleMouseNav = (event: MouseEvent) => {
      if (getHistoryController(router.history) === null) return;
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
      // A modifier was released (e.g. Shift, while Cmd/Ctrl stays down) but
      // what remains held is STILL a clean, tracked combo - just a different
      // one (modShift -> mod). Without this, an active pending/visible
      // session would keep pointing at the released combo: visible hints for
      // the wrong tier stay lit, and a pending session's timer can reveal the
      // wrong tier's hints after the user already let go of it.
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

    // A scope registering/unregistering (e.g. the model picker opening or
    // closing) can change who owns visible leader badges. Re-resolve a VISIBLE
    // session immediately so badges flip without waiting for the next key event;
    // if no scope owns either leader anymore, the session is spent.
    const handleScopeChange = () => {
      const session = hintSessionRef.current;
      if (session.status !== "visible") return;
      const pathname = adapter.getPathname();
      if (!hasVisibleLeaderOwners()) {
        spendHintSession(pathname);
        return;
      }
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

/**
 * Resolve the chord to an action the provider should RESERVE (preventDefault +
 * dispatch). Prefers a Control-specific binding (macOS ⌃, distinct from ⌘),
 * falling back to the lenient `mod` chord so `ctrl+…` bindings match while every
 * existing `mod+…` chord keeps matching both ⌘ and Ctrl. Returns null for an
 * action handled OUTSIDE this dispatcher (e.g. dictation, owned by a
 * capture-phase hook) - reserving those would swallow the key when the owner is
 * inactive.
 */
function resolveReservedAction(event: KeyboardEvent): ActionId | null {
  const chord = chordFromEvent(event);
  if (chord === null) return null;
  const ctrlChord = chordFromEventCtrlAware(event);
  const actionId =
    (ctrlChord !== null && ctrlChord !== chord
      ? findActionForChord(ctrlChord)
      : null) ?? findActionForChord(chord);
  if (actionId === null) return null;
  return isExternallyHandled(actionId) ? null : actionId;
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

function isAnyDialogOpen(): boolean {
  if (typeof document === "undefined") return false;
  const dialogs = document.querySelectorAll(
    '[role="dialog"][data-state="open"]',
  );
  // A dialog that hosts a leader scope (the system-tab modal, the model picker
  // popover, …) opts out of the block via `data-leader-scope`: it's the
  // intended target of the leader shortcuts, so treat it as transparent to
  // chord dispatch. Any other open dialog still blocks, so chords don't fire
  // behind an unrelated modal.
  for (const node of dialogs) {
    if (!(node instanceof HTMLElement)) return true;
    if (node.dataset.leaderScope === undefined) return true;
  }
  return false;
}
