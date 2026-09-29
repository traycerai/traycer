/** Sonner remains a separate interaction branch during the Base migration. */
export function isToastEvent(details: {
  reason: string;
  event: Event;
}): boolean {
  const inToaster = (target: EventTarget | null): boolean =>
    target instanceof Element &&
    target.closest("[data-sonner-toaster]") !== null;
  if (details.reason === "focus-out")
    return (
      details.event instanceof FocusEvent &&
      inToaster(details.event.relatedTarget)
    );
  return (
    (details.reason === "outside-press" || details.reason === "cancel-open") &&
    (inToaster(details.event.target) ||
      details.event.composedPath().some(inToaster))
  );
}

/** Base supplies this Root's trigger; deferred pane activation runs after click. */
export function isOwnPaneTriggerEvent(
  details: { reason: string; event: Event; trigger: Element | undefined },
  panePortal: HTMLElement | null,
): boolean {
  const { trigger, event } = details;
  // `list-navigation` is the keyboard equivalent of a trigger press: Base's
  // useListNavigation (floating-ui-react/hooks/useListNavigation.mjs:506-509,
  // openOnNavigationKeyDown) fires this same reason for an ArrowDown/etc. on
  // the trigger. Only accept it as a real KeyboardEvent, not a same-named
  // reason raised some other way.
  const isTriggerGesture =
    details.reason === "trigger-press" ||
    (details.reason === "list-navigation" && event instanceof KeyboardEvent);
  if (
    !isTriggerGesture ||
    !trigger?.isConnected ||
    !(event.target instanceof Node) ||
    !trigger.contains(event.target)
  )
    return false;
  // SurfacePresentationBoundary renders its portal host immediately after
  // its pane scope. A detached trigger in a different pane cannot open ours.
  return (
    panePortal === null ||
    panePortal.contains(trigger) ||
    trigger.closest("[data-pane-focused]")?.nextElementSibling === panePortal
  );
}
