interface PendingOpenerFocus {
  readonly key: string;
  cancelled: boolean;
  readonly stopWatching: () => void;
}

const mountedOpeners = new Map<string, () => void>();
let pending: PendingOpenerFocus | null = null;

function openerKey(tabId: string, paneId: string): string {
  return JSON.stringify([tabId, paneId]);
}

function clearPending(): void {
  pending?.stopWatching();
  pending = null;
}

/** Explicit New Tab gestures are delivered when the target picker is ready. */
export function requestPaneOpenerFocus(tabId: string, paneId: string): void {
  clearPending();
  const key = openerKey(tabId, paneId);
  const focus = mountedOpeners.get(key);
  if (focus !== undefined) {
    focus();
    return;
  }

  // Retain a cancelled request until its target mounts, so the picker's
  // ordinary mount autofocus cannot undo the user's intervening interaction.
  const cancel = (): void => {
    if (pending?.key !== key) return;
    pending.cancelled = true;
    pending.stopWatching();
  };
  const stopWatching = (): void => {
    document.removeEventListener("focusin", cancel, true);
    document.removeEventListener("pointerdown", cancel, true);
    document.removeEventListener("keydown", cancel, true);
    window.removeEventListener("blur", cancel);
  };
  pending = { key, cancelled: false, stopWatching };
  document.addEventListener("focusin", cancel, true);
  document.addEventListener("pointerdown", cancel, true);
  document.addEventListener("keydown", cancel, true);
  window.addEventListener("blur", cancel);
}

/** Only an active, mounted picker registers; registration acknowledges readiness. */
export function registerPaneOpenerFocus(
  tabId: string,
  paneId: string,
  focus: () => void,
  autofocus: boolean,
): () => void {
  const key = openerKey(tabId, paneId);
  mountedOpeners.set(key, focus);
  if (pending?.key === key) {
    const cancelled = pending.cancelled;
    clearPending();
    if (!cancelled) focus();
  } else if (autofocus && (pending === null || pending.cancelled)) {
    focus();
  }
  return () => {
    if (mountedOpeners.get(key) === focus) mountedOpeners.delete(key);
  };
}

export function resetPaneOpenerFocusForTests(): void {
  clearPending();
  mountedOpeners.clear();
}
