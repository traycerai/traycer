type TerminalFocusCallback = () => void;

const focusCallbacks = new Map<string, TerminalFocusCallback>();
let pendingInstanceId: string | null = null;
let scheduledInstanceId: string | null = null;
let scheduledTimer: number | null = null;

/**
 * Fulfilment is deferred one macrotask and last-wins. Requests typically
 * arrive from event handlers that just flipped the active tab in the store -
 * at that instant React has not committed the target wrapper's flip away from
 * `invisible`, and browsers silently reject focus on a hidden element without
 * retrying once it becomes visible. Deferring lands the focus after the
 * commit; collapsing the panel cancels the deferred work via
 * {@link clearPendingTerminalFocus} so a hidden terminal can never grab the
 * keyboard back.
 */
function scheduleFocus(instanceId: string): void {
  if (scheduledTimer !== null) window.clearTimeout(scheduledTimer);
  scheduledInstanceId = instanceId;
  scheduledTimer = window.setTimeout(() => {
    scheduledTimer = null;
    const target = scheduledInstanceId;
    scheduledInstanceId = null;
    if (target === null) return;
    // The tile may have unmounted since the request (tab closed mid-flight);
    // a vanished target simply drops the request rather than re-parking it.
    focusCallbacks.get(target)?.();
  }, 0);
}

/**
 * Imperative focus bridge for mounted xterm hosts, keyed by tile instance id.
 * Mirrors `composer-focus-registry`: surfaces that need to move keyboard focus
 * into a terminal (the landing panel on expand, tab activation from the strip)
 * request it here instead of threading refs through the tile tree. A request
 * for an instance whose xterm engine has not mounted yet is parked and fires
 * once on registration, so "create a tab, then focus it" works while the
 * tile bootstrap is still in flight.
 */
export function registerTerminalFocus(
  instanceId: string,
  focus: TerminalFocusCallback,
): () => void {
  focusCallbacks.set(instanceId, focus);
  if (pendingInstanceId === instanceId) {
    pendingInstanceId = null;
    scheduleFocus(instanceId);
  }
  return () => {
    if (focusCallbacks.get(instanceId) === focus) {
      focusCallbacks.delete(instanceId);
    }
  };
}

export function focusTerminalInstance(instanceId: string): void {
  if (!focusCallbacks.has(instanceId)) {
    // A still-scheduled fulfilment for an earlier request must not fire once
    // a newer, not-yet-mounted instance has been requested - last-wins covers
    // parked requests too.
    scheduledInstanceId = null;
    if (scheduledTimer !== null) {
      window.clearTimeout(scheduledTimer);
      scheduledTimer = null;
    }
    pendingInstanceId = instanceId;
    return;
  }
  pendingInstanceId = null;
  scheduleFocus(instanceId);
}

/**
 * Drops a parked focus request and cancels any deferred fulfilment, so a
 * terminal that mounts later - or one revealed after the panel already
 * collapsed - cannot steal focus from wherever the user moved it since.
 */
export function clearPendingTerminalFocus(): void {
  pendingInstanceId = null;
  scheduledInstanceId = null;
  if (scheduledTimer !== null) {
    window.clearTimeout(scheduledTimer);
    scheduledTimer = null;
  }
}

export function resetTerminalFocusRegistryForTests(): void {
  focusCallbacks.clear();
  clearPendingTerminalFocus();
}
