import {
  createContext,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type FocusEvent,
  type PointerEvent,
} from "react";

/**
 * Pane activation deferral contract.
 *
 * Pane roots normally claim ownership on `pointerdowncapture`. Subtrees whose
 * action must finish against the old layout opt out by spreading
 * {@link paneActivationDeferProps}. The owning pane records that gesture, sees
 * its click from native document capture, then activates in the next task after
 * all child click handlers. A microtask is deliberately insufficient here:
 * browsers may run its checkpoint between capture listeners, before the click
 * reaches its target. The task boundary survives stopped propagation, React
 * portals, and a child replacing/removing itself during the action.
 *
 * Both the producer (the marker) and the consumer (the selector) derive from
 * the single attribute name below, so the contract cannot silently drift.
 */
const PANE_ACTIVATION_DEFER_ATTRIBUTE = "data-pane-activation-defer";

export const paneActivationDeferProps = {
  [PANE_ACTIVATION_DEFER_ATTRIBUTE]: "true",
} as const;

const PANE_ACTIVATION_DEFER_SELECTOR = `[${PANE_ACTIVATION_DEFER_ATTRIBUTE}="true"]`;

export function isPaneActivationDeferred(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(PANE_ACTIVATION_DEFER_SELECTOR) !== null;
}

const FOCUS_OWNING_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "[contenteditable]:not([contenteditable='false'])",
  "[tabindex]:not([tabindex='-1'])",
  "[role='button']",
  "[role='checkbox']",
  "[role='combobox']",
  "[role='link']",
  "[role='menuitem']",
  "[role='option']",
  "[role='radio']",
  "[role='slider']",
  "[role='switch']",
  "[role='tab']",
  "[role='textbox']",
].join(",");

export function ownsPaneActivationFocus(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(FOCUS_OWNING_SELECTOR) !== null;
}

export interface PaneActivationFocusIntent {
  readonly mark: (
    target: EventTarget | null,
    scope: EventTarget | null,
  ) => void;
  readonly shouldYieldAutoFocus: () => boolean;
}

const DEFAULT_FOCUS_INTENT: PaneActivationFocusIntent = {
  mark: () => undefined,
  shouldYieldAutoFocus: () => false,
};

// Covers the complete pointer/focus/route stabilization window without making
// the intent sticky across a later non-pointer navigation. A new pointer
// gesture clears it immediately; this is only the keyboard/programmatic
// fallback for an activation whose route commit resolves asynchronously.
const PANE_ACTIVATION_FOCUS_INTENT_TTL_MS = 2_000;

interface PaneActivationControlFocusOrigin {
  readonly element: Element;
  readonly scope: Element;
  readonly expiresAt: number;
}

let paneActivationControlFocusOrigin: PaneActivationControlFocusOrigin | null =
  null;

function clearPaneActivationControlFocusOrigin(): void {
  paneActivationControlFocusOrigin = null;
}

function markPaneActivationControlFocusOrigin(
  target: EventTarget | null,
  scope: EventTarget | null,
  expiresAt: number,
): void {
  if (!(target instanceof Element) || !(scope instanceof Element)) return;
  paneActivationControlFocusOrigin = { element: target, scope, expiresAt };
}

/**
 * Route synchronization normally focuses the newly selected tile container.
 * During a control-initiated activation, doing so would pull focus out of a
 * freshly opened portalled surface (Radix popover/menu) and dismiss it. The
 * pointer origin remains inside the target tile even when the active element
 * is in a document portal, so it is the durable ownership proof for this short
 * window.
 */
export function shouldYieldPaneActivationRouteFocus(
  routeTarget: Element,
): boolean {
  const origin = paneActivationControlFocusOrigin;
  if (origin === null) return false;
  if (
    Date.now() > origin.expiresAt ||
    !origin.element.isConnected ||
    !origin.scope.isConnected
  ) {
    clearPaneActivationControlFocusOrigin();
    return false;
  }
  return (
    routeTarget.contains(origin.scope) ||
    origin.scope.contains(routeTarget) ||
    routeTarget.contains(origin.element)
  );
}

export function resetPaneActivationFocusIntentsForTests(): void {
  clearPaneActivationControlFocusOrigin();
}

export const PaneActivationFocusIntentContext =
  createContext<PaneActivationFocusIntent>(DEFAULT_FOCUS_INTENT);

export function usePaneActivationFocusIntent(): PaneActivationFocusIntent {
  return use(PaneActivationFocusIntentContext);
}

/**
 * Runs a cleanup only after an in-flight pane-control activation has had its
 * bounded route/focus stabilization window. Consumers use this when their
 * ordinary inactive-state cleanup would otherwise erase the child action that
 * initiated activation (for example, opening a controlled popover in an
 * inactive pane). A genuine later pane deactivation has no focus intent and
 * therefore runs the cleanup immediately.
 */
export function runAfterPaneActivationFocusIntent(
  focusIntent: PaneActivationFocusIntent,
  callback: () => void,
): () => void {
  let cancelled = false;
  let timeout: number | null = null;

  const runWhenSettled = (): void => {
    if (cancelled) return;
    if (!focusIntent.shouldYieldAutoFocus()) {
      callback();
      return;
    }
    timeout = window.setTimeout(
      runWhenSettled,
      PANE_ACTIVATION_FOCUS_INTENT_TTL_MS,
    );
  };

  runWhenSettled();
  return () => {
    cancelled = true;
    if (timeout !== null) window.clearTimeout(timeout);
  };
}

export interface PaneActivationOwnership {
  readonly claimFocus: (event: PaneActivationClaimEvent) => void;
  readonly claimPointerDown: (event: PaneActivationClaimEvent) => void;
  readonly focusIntent: PaneActivationFocusIntent;
  readonly onFocusCapture: (event: FocusEvent<HTMLElement>) => void;
  readonly onPointerCancelCapture: () => void;
  readonly onPointerDownCapture: (event: PointerEvent<HTMLElement>) => void;
}

export interface PaneActivationClaimEvent {
  readonly defaultPrevented: boolean;
  readonly scope: EventTarget | null;
  readonly target: EventTarget | null;
}

type HostedPaneActivationClaim = (event: PaneActivationClaimEvent) => void;

const hostedPaneActivationClaims = new Map<
  string,
  Map<string, HostedPaneActivationClaim>
>();

export function registerHostedPaneActivationClaim(
  viewTabId: string,
  paneId: string,
  claim: HostedPaneActivationClaim,
): () => void {
  let claimsByPane = hostedPaneActivationClaims.get(viewTabId);
  if (claimsByPane === undefined) {
    claimsByPane = new Map();
    hostedPaneActivationClaims.set(viewTabId, claimsByPane);
  }
  claimsByPane.set(paneId, claim);
  return () => {
    if (claimsByPane.get(paneId) !== claim) return;
    claimsByPane.delete(paneId);
    if (claimsByPane.size === 0) hostedPaneActivationClaims.delete(viewTabId);
  };
}

export function claimHostedPaneActivation(
  viewTabId: string,
  paneId: string,
  event: PaneActivationClaimEvent,
): void {
  hostedPaneActivationClaims.get(viewTabId)?.get(paneId)?.(event);
}

interface PaneGestureSubscriber {
  readonly onClickCapture: () => void;
  readonly onPointerCancelCapture: () => void;
  readonly onPointerDownCapture: () => void;
}

const paneGestureSubscribers = new Set<PaneGestureSubscriber>();

function notifyPointerDownCapture(): void {
  clearPaneActivationControlFocusOrigin();
  paneGestureSubscribers.forEach((subscriber) =>
    subscriber.onPointerDownCapture(),
  );
}

function notifyPointerCancelCapture(): void {
  clearPaneActivationControlFocusOrigin();
  paneGestureSubscribers.forEach((subscriber) =>
    subscriber.onPointerCancelCapture(),
  );
}

function notifyClickCapture(): void {
  paneGestureSubscribers.forEach((subscriber) => subscriber.onClickCapture());
}

function subscribeToPaneGestures(
  subscriber: PaneGestureSubscriber,
): () => void {
  paneGestureSubscribers.add(subscriber);
  if (paneGestureSubscribers.size === 1) {
    document.addEventListener("pointerdown", notifyPointerDownCapture, true);
    document.addEventListener(
      "pointercancel",
      notifyPointerCancelCapture,
      true,
    );
    document.addEventListener("click", notifyClickCapture, true);
  }
  return () => {
    paneGestureSubscribers.delete(subscriber);
    if (paneGestureSubscribers.size !== 0) return;
    document.removeEventListener("pointerdown", notifyPointerDownCapture, true);
    document.removeEventListener(
      "pointercancel",
      notifyPointerCancelCapture,
      true,
    );
    document.removeEventListener("click", notifyClickCapture, true);
  };
}

/**
 * Owns one pane's activation gesture and composes with an enclosing pane (an
 * inner Epic canvas pane inside a top-level split surface). Automatic primary
 * focus yields throughout the activation's route-stabilization window, so a
 * control/portal keeps focus across transient pane bounces while a
 * blank-surface click retains editor/xterm focus.
 */
export function usePaneActivationOwnership(input: {
  readonly active: boolean;
  readonly activate: () => void;
}): PaneActivationOwnership {
  const { active, activate } = input;
  const activateRef = useRef(activate);
  const parentFocusIntent = usePaneActivationFocusIntent();
  const localFocusIntentExpiresAtRef = useRef(0);
  const localFocusIntentElementRef = useRef<Element | null>(null);
  const gestureEpochRef = useRef(0);
  const deferredGestureRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    activateRef.current = activate;
  }, [activate]);

  const mark = useCallback(
    (target: EventTarget | null, scope: EventTarget | null) => {
      const expiresAt = Date.now() + PANE_ACTIVATION_FOCUS_INTENT_TTL_MS;
      localFocusIntentExpiresAtRef.current = expiresAt;
      localFocusIntentElementRef.current =
        target instanceof Element ? target : null;
      markPaneActivationControlFocusOrigin(target, scope, expiresAt);
    },
    [],
  );
  const shouldYieldAutoFocus = useCallback(() => {
    const localIntent =
      Date.now() <= localFocusIntentExpiresAtRef.current &&
      localFocusIntentElementRef.current?.isConnected === true;
    if (!localIntent) {
      localFocusIntentExpiresAtRef.current = 0;
      localFocusIntentElementRef.current = null;
    }
    const parentIntent = parentFocusIntent.shouldYieldAutoFocus();
    return localIntent || parentIntent;
  }, [parentFocusIntent]);
  const focusIntent = useMemo(
    () => ({ mark, shouldYieldAutoFocus }),
    [mark, shouldYieldAutoFocus],
  );

  const clearDeferredGesture = useCallback(() => {
    deferredGestureRef.current = null;
  }, []);

  const claimPointerDown = useCallback(
    (event: PaneActivationClaimEvent) => {
      if (active || event.defaultPrevented) return;
      if (ownsPaneActivationFocus(event.target)) {
        mark(event.target, event.scope);
      }
      if (isPaneActivationDeferred(event.target)) {
        deferredGestureRef.current = gestureEpochRef.current;
        return;
      }
      clearDeferredGesture();
      activate();
    },
    [activate, active, clearDeferredGesture, mark],
  );

  const claimFocus = useCallback(
    (event: PaneActivationClaimEvent) => {
      if (active || event.defaultPrevented) return;
      // Mouse focus inside a deferred subtree belongs to the in-flight action;
      // activation completes after its click, not midway through the gesture.
      if (deferredGestureRef.current !== null) return;
      mark(event.target, event.scope);
      activate();
    },
    [activate, active, mark],
  );

  const onPointerDownCapture = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      claimPointerDown({
        defaultPrevented: event.defaultPrevented,
        scope: event.currentTarget,
        target: event.target,
      });
    },
    [claimPointerDown],
  );

  const onFocusCapture = useCallback(
    (event: FocusEvent<HTMLElement>) => {
      claimFocus({
        defaultPrevented: event.defaultPrevented,
        scope: event.currentTarget,
        target: event.target,
      });
    },
    [claimFocus],
  );

  useEffect(() => {
    const handleDocumentPointerDown = (): void => {
      // Native document capture runs before any pane's React capture handler,
      // so a new gesture clears stale ownership before its real pane can arm.
      gestureEpochRef.current += 1;
      localFocusIntentExpiresAtRef.current = 0;
      clearDeferredGesture();
    };
    const handleDocumentPointerCancel = (): void => {
      gestureEpochRef.current += 1;
      localFocusIntentExpiresAtRef.current = 0;
      clearDeferredGesture();
    };
    const handleDocumentClick = (): void => {
      const gestureEpoch = deferredGestureRef.current;
      if (gestureEpoch === null) return;
      deferredGestureRef.current = null;
      window.setTimeout(() => {
        // A later pointer gesture supersedes this one before its completion.
        if (gestureEpochRef.current !== gestureEpoch) return;
        activateRef.current();
      }, 0);
    };
    const unsubscribe = subscribeToPaneGestures({
      onClickCapture: handleDocumentClick,
      onPointerCancelCapture: handleDocumentPointerCancel,
      onPointerDownCapture: handleDocumentPointerDown,
    });
    return () => {
      gestureEpochRef.current += 1;
      localFocusIntentExpiresAtRef.current = 0;
      clearDeferredGesture();
      unsubscribe();
    };
  }, [clearDeferredGesture]);

  return {
    claimFocus,
    claimPointerDown,
    focusIntent,
    onFocusCapture,
    onPointerCancelCapture: clearDeferredGesture,
    onPointerDownCapture,
  };
}
