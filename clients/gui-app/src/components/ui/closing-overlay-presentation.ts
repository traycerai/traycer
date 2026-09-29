import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  usePaneFocused,
  usePaneFocusProbe,
  usePaneVisible,
  usePanePortalContainer,
} from "@/components/epic-tabs/pane-visibility-context";
import {
  PortalPresentationContext,
  usePortalConcealed,
} from "@/components/ui/portal-concealment-context";
import { useOverlayFrameRegistration } from "@/components/ui/overlay-frame-context";
import {
  isToastEvent,
  isOwnPaneTriggerEvent,
} from "@/components/ui/overlay-guards";

export type PresentationLossDetails = {
  reason: "presentation-loss";
  cause: "concealment" | "pane-blur";
  event: Event;
};
type ChangeDetails = {
  reason: string;
  event: Event;
  trigger: Element | undefined;
  cancel: () => void;
  isCanceled: boolean;
};
export const ClosingOverlayContext = createContext({
  concealed: false,
  preferOpener: false,
  finalAllowed: (): boolean => true,
  initialAllowed: (): boolean => true,
  opener: (): HTMLElement | null => null,
});

function focusedElement(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.activeElement instanceof HTMLElement &&
    document.activeElement !== document.body
    ? document.activeElement
    : null;
}

type ClosingCycle = {
  token: number;
  open: boolean;
  logical: boolean;
  suppressed: boolean;
  opener: HTMLElement | null;
  preferOpener: boolean;
};

function nextClosingCycle(
  cycle: ClosingCycle,
  logical: boolean,
  present: boolean,
  triggerOpened: boolean,
): ClosingCycle {
  const open = logical && present;
  const opening = logical && !cycle.logical;
  return {
    token: cycle.token + (cycle.open !== open ? 1 : 0),
    open,
    logical,
    suppressed: open ? false : cycle.suppressed || !present,
    opener: opening ? focusedElement() : cycle.opener,
    preferOpener: opening ? !triggerOpened : cycle.preferOpener,
  };
}

/** Menu/Select close their owner before Activity disconnects its effects. */
export function useClosingOverlay<D extends ChangeDetails>(props: {
  open: boolean | undefined;
  defaultOpen: boolean | undefined;
  onOpenChange:
    | ((open: boolean, details: D | PresentationLossDetails) => void)
    | undefined;
  onOpenChangeComplete: ((open: boolean) => void) | undefined;
  actions: RefObject<{ unmount: () => void } | null>;
  select: boolean;
}) {
  const [internalOpen, setInternalOpen] = useState(props.defaultOpen ?? false);
  const [triggerOpened, setTriggerOpened] = useState(false);
  const logical = props.open ?? internalOpen;
  const concealed = usePortalConcealed();
  const paneFocused = usePaneFocused();
  const paneVisible = usePaneVisible();
  const panePortal = usePanePortalContainer();
  const pendingActivation = useRef(false);
  const isPaneFocused = usePaneFocusProbe();
  const host = useContext(PortalPresentationContext);
  const present = !concealed && paneFocused;
  const open = logical && present;
  useLayoutEffect(() => {
    if (present || concealed || !paneVisible || !logical)
      pendingActivation.current = false;
  }, [present, concealed, paneVisible, logical]);
  const [cycle, setCycle] = useState({
    token: 0,
    open,
    logical,
    suppressed: !present,
    opener: logical ? focusedElement() : null,
    preferOpener: true,
  });
  // Base Menu forgets its opening interaction on close; Select retains it.
  if (cycle.logical && !logical && !props.select) setTriggerOpened(false);
  if (cycle.open !== open || cycle.logical !== logical)
    setCycle(nextClosingCycle(cycle, logical, present, triggerOpened));
  const committed = useRef(cycle.token);
  const mounted = useRef(false);
  const closeReason = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (logical) closeReason.current = null;
  }, [logical]);
  useLayoutEffect(() => {
    committed.current = cycle.token;
  }, [cycle.token]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const notified = useRef(-1);
  const notify = props.onOpenChange;
  useLayoutEffect(() => {
    if (
      !present &&
      logical &&
      !pendingActivation.current &&
      notified.current !== cycle.token
    ) {
      notified.current = cycle.token;
      setInternalOpen(false);
      notify?.(false, {
        reason: "presentation-loss",
        cause: concealed ? "concealment" : "pane-blur",
        event: new Event("traycer:overlay-presentation-loss"),
      });
    }
  }, [present, logical, cycle.token, concealed, paneVisible, notify]);
  const [registration] = useState(() => ({}));
  const register = host?.register;
  useLayoutEffect(() => register?.(registration), [register, registration]);
  const unmounted = useRef(-1);
  useEffect(() => {
    if (concealed && !open && unmounted.current !== cycle.token) {
      unmounted.current = cycle.token;
      props.actions.current?.unmount();
    }
    if (concealed && !open) host?.closed(registration, host.generation);
  }, [
    concealed,
    open,
    logical,
    cycle.token,
    props.actions,
    host,
    registration,
  ]);
  useOverlayFrameRegistration(open);
  const completed = useRef<string | null>(null);
  const canActivate = (details: D): boolean =>
    !present &&
    paneVisible &&
    !concealed &&
    (host?.isPresented() ?? true) &&
    isOwnPaneTriggerEvent(details, panePortal);
  return {
    open,
    concealed,
    onOpenChange: (next: boolean, details: D): void => {
      const activating = next && canActivate(details);
      if ((!present && !activating) || (!next && isToastEvent(details))) {
        details.cancel();
        return;
      }
      pendingActivation.current = activating;
      if (next) setTriggerOpened(true);
      props.onOpenChange?.(next, details);
      if (details.isCanceled) {
        pendingActivation.current = false;
        if (next) setTriggerOpened(triggerOpened);
      } else {
        if (next) notified.current = -1;
        closeReason.current = next ? null : details.reason;
        setInternalOpen(next);
      }
    },
    onOpenChangeComplete: (next: boolean): void => {
      const key = `${cycle.token}:${next}`;
      if (
        next === cycle.open &&
        committed.current === cycle.token &&
        completed.current !== key
      ) {
        completed.current = key;
        props.onOpenChangeComplete?.(next);
      }
    },
    presentation: {
      concealed: concealed || (!props.select && !paneFocused),
      preferOpener: cycle.preferOpener,
      opener: () => cycle.opener,
      initialAllowed: (): boolean =>
        cycle.open &&
        mounted.current &&
        committed.current === cycle.token &&
        present &&
        isPaneFocused() &&
        (host === null ||
          (host.isPresented() && host.isGeneration(host.generation))),
      finalAllowed: (): boolean =>
        (!cycle.open || !mounted.current) &&
        !cycle.suppressed &&
        closeReason.current !== "focus-out" &&
        closeReason.current !== "trigger-hover" &&
        committed.current === cycle.token &&
        present &&
        isPaneFocused() &&
        (host === null ||
          (host.isPresented() && host.isGeneration(host.generation))),
    },
  };
}

type FinalFocus =
  | boolean
  | RefObject<HTMLElement | null>
  | ((
      interaction: "" | "mouse" | "touch" | "pen" | "keyboard",
    ) => boolean | HTMLElement | null | void)
  | undefined;

/** Follow the public ARIA links into portalled submenus when testing ownership. */
function containsPopupFocus(popup: HTMLElement, active: Element): boolean {
  const pending = [popup];
  const seen = new Set<HTMLElement>();
  for (const element of pending) {
    if (seen.has(element)) continue;
    seen.add(element);
    if (element.contains(active)) return true;
    for (const trigger of element.querySelectorAll("[aria-controls]")) {
      const controlled = trigger.getAttribute("aria-controls");
      const child = controlled
        ? element.ownerDocument.getElementById(controlled)
        : null;
      if (child) pending.push(child);
    }
  }
  return false;
}

/** These families have no initialFocus API; capture their linked opener on mount. */
export function useClosingOverlayFocus(finalFocus: FinalFocus) {
  const presentation = useContext(ClosingOverlayContext);
  const popup = useRef<HTMLDivElement>(null);
  const linkedTrigger = useRef<HTMLElement | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const mountedPopup = useRef<HTMLDivElement | null>(null);
  const lookup = useRef<{
    element: HTMLDivElement;
    opener: HTMLElement | null;
    preferOpener: boolean;
  } | null>(null);
  useLayoutEffect(() => {
    const element = popup.current;
    if (element) mountedPopup.current = element;
    const opener = presentation.opener();
    if (
      element &&
      (lookup.current?.element !== element ||
        lookup.current.opener !== opener ||
        lookup.current.preferOpener !== presentation.preferOpener)
    ) {
      lookup.current = {
        element,
        opener,
        preferOpener: presentation.preferOpener,
      };
      const trigger = Array.from(
        element.ownerDocument.querySelectorAll<HTMLElement>("[aria-controls]"),
      ).find((candidate) => {
        const id = candidate.getAttribute("aria-controls");
        const controlled = id ? element.ownerDocument.getElementById(id) : null;
        return controlled !== null && element.contains(controlled);
      });
      // Select links its inner List; the link disappears once open becomes false.
      if (trigger) linkedTrigger.current = trigger;
    }
    const reference = linkedTrigger.current?.isConnected
      ? linkedTrigger.current
      : null;
    returnTo.current =
      presentation.preferOpener && opener?.isConnected
        ? opener
        : (reference ?? opener);
  }, [presentation]);
  return {
    popup,
    concealed: presentation.concealed,
    initialAllowed: presentation.initialAllowed,
    finalFocus: (interaction: "" | "mouse" | "touch" | "pen" | "keyboard") => {
      const element = mountedPopup.current;
      const usesDefaultTarget =
        finalFocus === undefined || typeof finalFocus === "boolean";
      const focusMovedOutside = (): boolean => {
        const active = element?.ownerDocument.activeElement;
        return Boolean(
          usesDefaultTarget &&
          element &&
          active &&
          active !== element.ownerDocument.body &&
          active !== returnTo.current &&
          !containsPopupFocus(element, active),
        );
      };
      // Base calls a resolver even when its later restore decision would skip.
      // Preserve the default outside-focus decision before scheduling our move.
      if (focusMovedOutside()) return false;
      queueMicrotask(() => {
        if (!presentation.finalAllowed() || focusMovedOutside()) return;
        let resolved: boolean | HTMLElement | null | void;
        if (typeof finalFocus === "function")
          resolved = finalFocus(interaction);
        else if (typeof finalFocus === "object") resolved = finalFocus.current;
        else resolved = finalFocus ?? true;
        const target =
          resolved === true || resolved === null ? returnTo.current : resolved;
        if (
          target instanceof HTMLElement &&
          target.isConnected &&
          presentation.finalAllowed()
        )
          target.focus(
            interaction === "keyboard"
              ? { preventScroll: true, focusVisible: true }
              : { preventScroll: true },
          );
      });
      return false;
    },
  };
}
