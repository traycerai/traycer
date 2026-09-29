import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useCallback,
  type Ref,
  type FocusEventHandler,
  useRef,
  useState,
} from "react";
import {
  usePaneFocused,
  usePaneFocusProbe,
  usePaneVisible,
  usePanePortalContainer,
} from "@/components/epic-tabs/pane-visibility-context";
import {
  usePortalConcealed,
  PortalPresentationContext,
} from "@/components/ui/portal-concealment-context";
import { mergeRefs } from "@/lib/merge-refs";
import {
  isToastEvent,
  isOwnPaneTriggerEvent,
} from "@/components/ui/overlay-guards";
import { useOverlayFrameRegistration } from "@/components/ui/overlay-frame-context";

type ChangeDetails = {
  reason: string;
  event: Event;
  trigger: Element | undefined;
  cancel: () => void;
  isCanceled: boolean;
};
type Cycle = {
  token: number;
  open: boolean;
  logical: boolean;
  presentationOnly: boolean;
  focusSuppressed: boolean;
  resumed: boolean;
  opener: HTMLElement | null;
};
type FocusTarget =
  | boolean
  | React.RefObject<HTMLElement | null>
  | ((
      interaction: "" | "mouse" | "touch" | "pen" | "keyboard",
    ) => boolean | HTMLElement | null | void)
  | undefined;

export const OverlayPresentationContext = createContext({
  concealed: false,
  resumed: false,
  initialAllowed: (): boolean => true,
  finalAllowed: (): boolean => true,
  opener: (): HTMLElement | null => null,
});

function focusedElement(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body
    ? active
    : null;
}

function nextCycle(
  cycle: Cycle,
  logical: boolean,
  present: boolean,
  pendingActivation: boolean,
): Cycle {
  const open = logical && present;
  // Closing an owner that was already un-presented has no user-facing
  // completion or focus work, even when Activity reveals it in this render.
  const noPresentationWork = !present || (!open && !cycle.open);
  return {
    token: cycle.token + 1,
    open,
    logical,
    presentationOnly: noPresentationWork,
    focusSuppressed: noPresentationWork,
    resumed: open && cycle.logical && !pendingActivation,
    // Capture before descendants mount: their effects may focus an input
    // before Base asks for initialFocus. Presentation returns keep the opener.
    opener: logical && !cycle.logical ? focusedElement() : cycle.opener,
  };
}

/** Dialog/Popover retain owner state while Base releases document effects. */
export function useOverlayPresentation<D extends ChangeDetails>(props: {
  open: boolean | undefined;
  defaultOpen: boolean | undefined;
  onOpenChange: ((open: boolean, details: D) => void) | undefined;
  onOpenChangeComplete: ((open: boolean) => void) | undefined;
  paneAware: boolean;
}) {
  const [internalOpen, setInternalOpen] = useState(props.defaultOpen ?? false);
  const logical = props.open ?? internalOpen;
  const concealed = usePortalConcealed();
  const paneFocused = usePaneFocused();
  const paneVisible = usePaneVisible();
  const panePortal = usePanePortalContainer();
  const isPaneFocused = usePaneFocusProbe();
  const host = useContext(PortalPresentationContext);
  const present = !concealed && (!props.paneAware || paneFocused);
  const open = logical && present;
  const [cycle, setCycle] = useState<Cycle>(() => ({
    token: 0,
    open,
    logical,
    presentationOnly: false,
    focusSuppressed: !present,
    resumed: false,
    opener: logical ? focusedElement() : null,
  }));
  // Set only for the specific transition onOpenChange accepted as a cold-pane
  // trigger activation; a false "resumed" for that one transition tells
  // initialFocus to run fresh instead of treating it as a returning owner.
  const [pendingActivation, setPendingActivation] = useState(false);
  if (cycle.open !== open || cycle.logical !== logical) {
    setCycle(nextCycle(cycle, logical, present, pendingActivation));
  }
  if ((present || concealed || !paneVisible || !logical) && pendingActivation)
    setPendingActivation(false);
  const closeReason = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (logical) closeReason.current = null;
  }, [logical]);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const committed = useRef(cycle.token);
  const completed = useRef<string | null>(null);
  const [registration] = useState(() => ({}));
  useLayoutEffect(() => {
    committed.current = cycle.token;
  }, [cycle.token]);
  const register = host?.register;
  useLayoutEffect(() => register?.(registration), [register, registration]);
  useEffect(() => {
    if (concealed && !open) host?.closed(registration, host.generation);
  }, [concealed, open, host, registration]);
  useOverlayFrameRegistration(open);
  const isPresented = (): boolean =>
    present &&
    (!props.paneAware || isPaneFocused()) &&
    (host?.isPresented() ?? true);
  const initialAllowed = (): boolean => open && isPresented();
  const finalAllowed = (): boolean =>
    (!cycle.open || !mounted.current) &&
    !cycle.focusSuppressed &&
    // Base resolves finalFocus even when its queued task is suppressed.
    // Preserve its accepted nonmodal focus-out decision in our guarded task.
    closeReason.current !== "focus-out" &&
    cycle.token === committed.current &&
    isPresented() &&
    (host === null || host.isGeneration(host.generation));
  const onOpenChange = (next: boolean, details: D): void => {
    const activating =
      next &&
      !present &&
      paneVisible &&
      !concealed &&
      (host?.isPresented() ?? true) &&
      isOwnPaneTriggerEvent(details, panePortal);
    if ((!present && !activating) || (!next && isToastEvent(details))) {
      details.cancel();
      return;
    }
    setPendingActivation(activating);
    props.onOpenChange?.(next, details);
    if (details.isCanceled) {
      setPendingActivation(false);
    } else {
      closeReason.current = next ? null : details.reason;
      setInternalOpen(next);
    }
  };
  const onOpenChangeComplete = (next: boolean): void => {
    const completion = `${cycle.token}:${next}`;
    if (
      next === cycle.open &&
      cycle.token === committed.current &&
      !cycle.presentationOnly &&
      !cycle.resumed &&
      completed.current !== completion
    ) {
      completed.current = completion;
      props.onOpenChangeComplete?.(next);
    }
  };
  return {
    open,
    onOpenChange,
    onOpenChangeComplete,
    presentation: {
      concealed: !present,
      resumed: cycle.resumed,
      initialAllowed,
      finalAllowed,
      opener: () => cycle.opener,
    },
  };
}

export function useOverlayFocus(
  initialFocus: FocusTarget,
  finalFocus: FocusTarget,
  forwardedRef: Ref<HTMLDivElement> | undefined,
  onFocusCapture: FocusEventHandler<HTMLDivElement> | undefined,
) {
  const popupRef = useRef<HTMLDivElement>(null);
  const ref = useCallback(
    (element: HTMLDivElement | null) =>
      mergeRefs(popupRef, forwardedRef)(element),
    [forwardedRef],
  );
  const returnTo = useRef<HTMLElement | null>(null);
  const selectInitialInput = useRef(false);
  const presentation = useContext(OverlayPresentationContext);
  const resolve = (
    target: FocusTarget,
    interaction: "" | "mouse" | "touch" | "pen" | "keyboard",
  ) => {
    if (typeof target === "function") return target(interaction);
    if (target && typeof target === "object") return target.current;
    return target ?? true;
  };
  return {
    ref,
    initialFocus: (
      interaction: "" | "mouse" | "touch" | "pen" | "keyboard",
    ) => {
      selectInitialInput.current = false;
      if (!presentation.initialAllowed()) return false;
      const popup = popupRef.current;
      if (!presentation.resumed && popup) {
        const previous = presentation.opener();
        const trigger = Array.from(
          popup.ownerDocument.querySelectorAll<HTMLElement>("[aria-controls]"),
        ).find((element) => element.getAttribute("aria-controls") === popup.id);
        returnTo.current =
          interaction === ""
            ? (previous ?? trigger ?? null)
            : (trigger ?? previous);
      }
      if (initialFocus !== undefined) return resolve(initialFocus, interaction);
      if (presentation.resumed) return popupRef.current;
      selectInitialInput.current =
        !!popup && !popup.contains(popup.ownerDocument.activeElement);
      // Base queues default focus in rAF after resolving initialFocus. Expire
      // this one-shot selection after that rAF, so later user focus never selects.
      queueMicrotask(() =>
        requestAnimationFrame(() => {
          selectInitialInput.current = false;
        }),
      );
      return true;
    },
    onFocusCapture: (event: React.FocusEvent<HTMLDivElement>) => {
      onFocusCapture?.(event);
      if (!selectInitialInput.current) return;
      selectInitialInput.current = false;
      const target = event.target;
      // Radix FocusScope selected only an automatically focused input, never
      // a textarea or a caller-directed target. Preserve that default here.
      if (
        presentation.initialAllowed() &&
        target instanceof HTMLInputElement &&
        target.ownerDocument.activeElement === target
      )
        target.select();
    },
    finalFocus: (interaction: "" | "mouse" | "touch" | "pen" | "keyboard") => {
      // Base resolves finalFocus before its queued focus task. Return false to
      // suppress that task; authorize the callback AND focus at execution time,
      // after a possible committed pane transfer or owner unmount.
      queueMicrotask(() => {
        if (!presentation.finalAllowed()) return;
        const resolved = resolve(finalFocus, interaction);
        // Base allows a same-ID trigger to replace the opening node while open.
        // Resolve that replacement at close, after the presentation guard.
        let opener = returnTo.current;
        if (opener !== null && !opener.isConnected) {
          opener = opener.ownerDocument.getElementById(opener.id);
        }
        const target =
          resolved === true || resolved === null ? opener : resolved;
        if (
          target instanceof HTMLElement &&
          target.isConnected &&
          presentation.finalAllowed()
        ) {
          const options =
            interaction === "keyboard"
              ? { preventScroll: true, focusVisible: true }
              : { preventScroll: true };
          target.focus(options);
        }
      });
      return false;
    },
    concealed: presentation.concealed,
  };
}
