import type {
  BrowserViewAgentFocusReport,
  BrowserViewAgentFocusSignal,
  BrowserViewBridge,
} from "@traycer-clients/shared/platform/browser-view";
import { browserGuestRegistrationOf } from "./persistent-browser-guest-host";

type Focusable = HTMLElement | SVGElement;

const FOCUS_EVENT_TYPES = ["blur", "focus", "focusin", "focusout"] as const;

/**
 * The page half of the agent focus guard; desktop main holds the other.
 *
 * Main opens a bracket (`begin`) before each agent input in a browser tile and
 * closes it (`end`) once the focus it moved is handed back, over the same
 * frame channel Chromium uses to move this page's focus into a tile, so a move
 * an agent causes always lands inside one. Inside a bracket no trusted focus event reaches app code; when the last
 * one closes, focus an agent took goes back to where the person had it, and
 * app code hears only the net change, as synthetic events.
 *
 * Intent - the element focus belongs on - moves only for the person and for
 * app code: a focus event with `sourceCapabilities` came from the person's
 * mouse or keyboard, one inside `focus()` / `blur()` came from app code, and a
 * move into the tile of an agent input in flight came from that agent unless
 * main said the person pressed there (`personPress`).
 */
export function startAgentFocusGuard(bridge: BrowserViewBridge): () => void {
  let intent: Focusable | null = isFocusable(document.activeElement)
    ? document.activeElement
    : null;
  let pendingRestore: Focusable | null = null;
  let restoring = false;
  let scriptDepth = 0;
  let composing = false;
  let agentTiles = new Set<string>();
  /** Open brackets: bracket id to the tile its input is aimed at. */
  const brackets = new Map<string, string>();
  /** Brackets held until an input-method composition ends. */
  const held = new Set<string>();
  /** Held brackets main closed before the page could open them. */
  const closedUnopened = new Set<string>();
  const personPressed = new Set<string>();

  const isAgentTile = (element: Element | null): boolean => {
    const registrationId = browserGuestRegistrationOf(element);
    return registrationId !== null && agentTiles.has(registrationId);
  };
  const lostFocus = (element: Element | null): boolean =>
    element === null || element === document.body || isAgentTile(element);

  // What app code has heard: the window's focus and the element it last heard gain it.
  let heardWindow = document.hasFocus();
  let heardElement: Element | null =
    heardWindow && !lostFocus(document.activeElement)
      ? document.activeElement
      : null;
  const bracketOpenFor = (registrationId: string): boolean => {
    for (const tile of brackets.values()) {
      if (tile === registrationId) return true;
    }
    return false;
  };

  const restoreFocusMethods = wrapFocusMethods(
    () => restoring,
    (delta) => {
      scriptDepth += delta;
    },
  );

  /** A focus move of the guard's own: not classified as anyone's intent. */
  const quietly = (move: () => void): void => {
    restoring = true;
    try {
      move();
    } finally {
      restoring = false;
    }
  };
  const refocus = (element: Focusable): void => {
    quietly(() => {
      element.focus({ preventScroll: true });
    });
  };
  const setIntent = (element: Focusable | null): void => {
    intent = element;
    pendingRestore = null;
  };
  const focusedElement = (): Element | null => {
    const active = document.activeElement;
    return document.hasFocus() && active !== null && !lostFocus(active)
      ? active
      : null;
  };
  // Each step reads focus afresh: a handler of an event an earlier step
  // dispatched may have moved it, and its own events were heard as they fired.
  // Within a pair, as Chromium does: a blur handler that moved focus empties
  // focusout's related target, and a focus handler that did drops focusin.
  const report = (): void => {
    const blurredFor = focusedElement();
    if (heardElement !== null && heardElement !== blurredFor) {
      const was = heardElement;
      heardElement = null;
      dispatchFocusEvent(was, "blur", blurredFor);
      const moved = focusedElement() !== blurredFor;
      dispatchFocusEvent(was, "focusout", moved ? null : blurredFor);
    }
    if (heardWindow && !document.hasFocus()) {
      heardWindow = false;
      dispatchFocusEvent(window, "blur", null);
    }
    if (!heardWindow && document.hasFocus()) {
      heardWindow = true;
      dispatchFocusEvent(window, "focus", null);
    }
    const element = focusedElement();
    if (element !== null && heardElement !== element) {
      heardElement = element;
      dispatchFocusEvent(element, "focus", null);
      if (focusedElement() === element) {
        dispatchFocusEvent(element, "focusin", null);
      }
    }
  };
  const settle = (): void => {
    if (intent === null || !intent.isConnected) return;
    if (!lostFocus(document.activeElement)) return;
    // Page focus came back with the window: put it back now. Otherwise when
    // the window returns, on the same queue as its first key.
    if (document.hasFocus()) refocus(intent);
    else pendingRestore = intent;
  };
  const repair = (): void => {
    if (
      pendingRestore !== null &&
      pendingRestore.isConnected &&
      lostFocus(document.activeElement)
    ) {
      refocus(pendingRestore);
    }
    pendingRestore = null;
    if (brackets.size === 0) report();
  };

  const tell = (report: BrowserViewAgentFocusReport): void => {
    void bridge.reportAgentFocus(report).catch(() => undefined);
  };
  // Focus this page's frame: Chromium moves the window's focus back for that
  // report, sent ahead of the answer on the same channel, whatever the tile
  // holding it has. Blurring the agent's tile does it when no element should
  // get it, or the element can't take it now. A tile the person pressed into
  // is theirs, and is left alone.
  const reclaim = (reclaimId: string): void => {
    if (
      intent !== null &&
      intent.isConnected &&
      lostFocus(document.activeElement)
    ) {
      refocus(intent);
    }
    const active = document.activeElement;
    if (active instanceof HTMLElement && isAgentTile(active)) {
      quietly(() => {
        active.blur();
      });
    }
    pendingRestore = null;
    tell({ kind: "reclaimed", reclaimId });
    if (brackets.size === 0) report();
  };
  // Answered at once: main sends nothing into a held bracket, however long
  // the composition lasts.
  const begin = async (
    signal: Extract<BrowserViewAgentFocusSignal, { kind: "begin" }>,
  ): Promise<void> => {
    const { bracketId } = signal;
    agentTiles = new Set(signal.agentRegistrationIds);
    // A composition the move interrupted would commit into the wrong field.
    if (composing) {
      held.add(bracketId);
      tell({ kind: "bracketHeld", bracketId });
      await compositionEnded();
      held.delete(bracketId);
      if (closedUnopened.delete(bracketId)) return;
    }
    brackets.set(bracketId, signal.registrationId);
    tell({ kind: "bracketOpened", bracketId });
  };
  const end = (bracketId: string): void => {
    const registrationId = brackets.get(bracketId);
    if (registrationId === undefined) {
      // Not held here either: its begin went to the page this one replaced.
      if (held.has(bracketId)) closedUnopened.add(bracketId);
      return;
    }
    brackets.delete(bracketId);
    if (bracketOpenFor(registrationId)) return;
    personPressed.delete(registrationId);
    settle();
    if (brackets.size === 0) report();
  };

  const classifyWindowBlur = (): void => {
    const registrationId = browserGuestRegistrationOf(document.activeElement);
    if (registrationId === null) return;
    // Into the tile of an agent input in flight: that agent took it, unless
    // the person pressed there. Into any other tile: the person or app code.
    if (bracketOpenFor(registrationId) && !personPressed.has(registrationId)) {
      // Main learns here of a move Chromium made after the input's dispatch.
      tell({ kind: "tileTookFocus", registrationId });
      queueMicrotask(settle);
      return;
    }
    personPressed.delete(registrationId);
    setIntent(null);
  };
  const classify = (event: Event): void => {
    const target = event.target;
    if (event.type === "focusin" && target instanceof Element) {
      if (!lostFocus(target) && isFocusable(target)) setIntent(target);
      return;
    }
    if (event.type !== "blur") return;
    if (target === window) {
      classifyWindowBlur();
      return;
    }
    // Chromium-only, and absent from the DOM typings.
    const capabilities: unknown = Reflect.get(event, "sourceCapabilities");
    const byPerson =
      (capabilities !== null && capabilities !== undefined) || scriptDepth > 0;
    const related =
      event instanceof FocusEvent && event.relatedTarget instanceof Element
        ? event.relatedTarget
        : null;
    if (byPerson && (related === null || lostFocus(related))) setIntent(null);
  };

  const onFocusEvent = (event: Event): void => {
    // Chromium fires the window's own focus and blur as plain events.
    if (!event.isTrusted) return;
    if (!restoring) classify(event);
    // Put back as page focus returns, and reported: Chromium dispatches no
    // focus event for the element put back.
    if (
      event.type === "focus" &&
      event.target === window &&
      pendingRestore !== null &&
      !restoring
    ) {
      event.stopImmediatePropagation();
      repair();
      return;
    }
    if (!restoring && brackets.size === 0) {
      if (event.target === window) heardWindow = event.type === "focus";
      else if (event.type === "focus" && event.target instanceof Element) {
        heardElement = event.target;
      } else if (event.type === "blur" && heardElement === event.target) {
        heardElement = null;
      }
      return;
    }
    event.stopImmediatePropagation();
  };
  const onCompositionStart = (): void => {
    composing = true;
  };
  const onCompositionEnd = (): void => {
    composing = false;
  };

  for (const type of FOCUS_EVENT_TYPES) {
    window.addEventListener(type, onFocusEvent, true);
  }
  document.addEventListener("compositionstart", onCompositionStart, true);
  document.addEventListener("compositionend", onCompositionEnd, true);
  const signals = bridge.onAgentFocusSignal((signal) => {
    switch (signal.kind) {
      case "begin":
        void begin(signal);
        return;
      case "end":
        end(signal.bracketId);
        return;
      case "personPress":
        personPressed.add(signal.registrationId);
        return;
      case "reclaim":
        reclaim(signal.reclaimId);
        return;
    }
  });
  // Main waits for a bracket to open only in a page that said it runs the guard.
  tell({ kind: "guardStarted" });

  return () => {
    tell({ kind: "guardStopped" });
    signals.dispose();
    for (const type of FOCUS_EVENT_TYPES) {
      window.removeEventListener(type, onFocusEvent, true);
    }
    document.removeEventListener("compositionstart", onCompositionStart, true);
    document.removeEventListener("compositionend", onCompositionEnd, true);
    restoreFocusMethods();
  };
}

function isFocusable(element: Element | null): element is Focusable {
  return element instanceof HTMLElement || element instanceof SVGElement;
}

function compositionEnded(): Promise<void> {
  return new Promise((resolve) => {
    document.addEventListener(
      "compositionend",
      () => {
        resolve();
      },
      { once: true, capture: true },
    );
  });
}

function dispatchFocusEvent(
  target: EventTarget,
  type: (typeof FOCUS_EVENT_TYPES)[number],
  relatedTarget: Element | null,
): void {
  // As Chromium does: the window's own focus and blur are plain events.
  target.dispatchEvent(
    target === window
      ? new Event(type)
      : new FocusEvent(type, {
          bubbles: type === "focusin" || type === "focusout",
          relatedTarget,
        }),
  );
}

/**
 * Counts app code's own `focus()` / `blur()` calls, so a focus change made
 * inside one is read as app code's intent, a blur to nothing included. The
 * guard's own restore is not counted.
 */
function wrapFocusMethods(
  isRestoring: () => boolean,
  adjustDepth: (delta: 1 | -1) => void,
): () => void {
  const restores: Array<() => void> = [];
  for (const prototype of [HTMLElement.prototype, SVGElement.prototype]) {
    for (const name of ["focus", "blur"] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      const original: unknown = descriptor?.value;
      if (descriptor === undefined || typeof original !== "function") continue;
      Object.defineProperty(prototype, name, {
        ...descriptor,
        value: function callAsAppCode(this: unknown, ...args: unknown[]) {
          if (isRestoring()) {
            const restored: unknown = Reflect.apply(original, this, args);
            return restored;
          }
          adjustDepth(1);
          try {
            const result: unknown = Reflect.apply(original, this, args);
            return result;
          } finally {
            adjustDepth(-1);
          }
        },
      });
      restores.push(() => {
        Object.defineProperty(prototype, name, descriptor);
      });
    }
  }
  return () => {
    for (const restore of restores) restore();
  };
}
