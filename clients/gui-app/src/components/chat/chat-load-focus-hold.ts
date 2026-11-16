import {
  createContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import {
  usePaneActivationFocusIntent,
  type PaneActivationFocusIntent,
} from "@/components/epic-canvas/pane-activation";

const TEXT_ENTRY_SELECTOR = [
  "input:not([type='button']):not([type='checkbox']):not([type='radio']):not([type='submit']):not([type='reset'])",
  "textarea",
  "select",
  "[contenteditable]:not([contenteditable='false'])",
].join(",");

const OVERLAY_SELECTOR = [
  "[role='menu']",
  "[role='listbox']",
  "[role='dialog']",
  "[role='alertdialog']",
  "[data-radix-popper-content-wrapper]",
].join(",");

// An expanded tree row is `aria-expanded` too, so the popup claim is required.
const OPEN_POPUP_TRIGGER_SELECTOR =
  "[aria-expanded='true'][aria-haspopup]:not([aria-haspopup='false'])";

/**
 * Whether focus sits in something the reader is in the middle of using
 * outside `surface`: a field they are typing in, an open menu or popover, or
 * the trigger of one that keeps focus on its trigger while open (the resource
 * monitor's popover does).
 * Focus on a plain control (the sidebar row that opened the chat) or on an
 * ancestor of the surface (the pane container route sync focuses) is not held.
 */
function focusIsHeldOutside(surface: Element | null): boolean {
  const active = document.activeElement;
  if (active === null || active === document.body) return false;
  if (surface !== null) {
    if (surface.contains(active) || active.contains(surface)) return false;
  }
  return (
    active.matches(TEXT_ENTRY_SELECTOR) ||
    active.closest(OVERLAY_SELECTOR) !== null ||
    active.closest(OPEN_POPUP_TRIGGER_SELECTOR) !== null
  );
}

/**
 * Keeps a chat's first transcript from taking focus away from what the reader
 * started doing while it loaded.
 *
 * The composer mounts with the transcript and focuses itself, which is right
 * when the reader is still waiting on the chat and wrong once they have moved
 * on: taking focus closes the menu they opened and ends the rename they were
 * typing. A press or key in the active tile's window while it loads, or
 * before an autofocus the load scheduled has run, arms the hold; the next one
 * after that releases it, so a later pane switch
 * focuses the composer as before. The gesture that opened the chat lands
 * before the tile is active and never arms it.
 */
/**
 * Load-time autofocus that is scheduled for later than its commit (the
 * interview field's frame-deferred focus) registers here, so the hold keeps
 * arming until it has run or been cancelled. `begin` returns the settle call,
 * which is idempotent; outside a loading chat it is a no-op.
 */
export interface ChatLoadAutofocusTracker {
  readonly begin: () => () => void;
}

const NOOP_SETTLE = (): void => undefined;

export const ChatLoadAutofocusContext = createContext<ChatLoadAutofocusTracker>(
  { begin: () => NOOP_SETTLE },
);

type LoadPhase = "loading" | "settling" | "done";

export function useChatLoadFocusHold(input: {
  readonly loaded: boolean;
  readonly active: boolean;
  readonly surface: { readonly current: Element | null };
}): {
  readonly intent: PaneActivationFocusIntent;
  readonly loadAutofocus: ChatLoadAutofocusTracker;
} {
  const { loaded, active, surface } = input;
  const parent = usePaneActivationFocusIntent();
  const activeRef = useRef(active);
  // "settling": loaded, with autofocus the load scheduled still outstanding.
  const phaseRef = useRef<LoadPhase>(loaded ? "done" : "loading");
  const outstandingRef = useRef(0);
  const heldRef = useRef(false);

  useLayoutEffect(() => {
    activeRef.current = active;
    if (loaded && phaseRef.current === "loading") {
      phaseRef.current = outstandingRef.current > 0 ? "settling" : "done";
    }
  }, [active, loaded]);

  useEffect(() => {
    const onInteraction = (): void => {
      heldRef.current = activeRef.current && phaseRef.current !== "done";
    };
    document.addEventListener("pointerdown", onInteraction, true);
    document.addEventListener("keydown", onInteraction, true);
    return () => {
      document.removeEventListener("pointerdown", onInteraction, true);
      document.removeEventListener("keydown", onInteraction, true);
    };
  }, []);

  const loadAutofocus = useMemo<ChatLoadAutofocusTracker>(
    () => ({
      begin: () => {
        if (phaseRef.current === "done") return NOOP_SETTLE;
        outstandingRef.current += 1;
        let settled = false;
        return () => {
          if (settled) return;
          settled = true;
          outstandingRef.current -= 1;
          if (phaseRef.current === "settling" && outstandingRef.current === 0) {
            phaseRef.current = "done";
          }
        };
      },
    }),
    [],
  );

  const intent = useMemo(
    () => ({
      mark: parent.mark,
      shouldYieldAutoFocus: () =>
        parent.shouldYieldAutoFocus() ||
        (heldRef.current && focusIsHeldOutside(surface.current)),
    }),
    [parent, surface],
  );
  return useMemo(() => ({ intent, loadAutofocus }), [intent, loadAutofocus]);
}
