/**
 * Makes a press inside a guest frame count as a press on the frame element
 * for every overlay on the page.
 *
 * A sandboxed iframe (HTML artifacts, canvases, MCP apps) and a `<webview>`
 * (browser tiles) swallow their own pointer events: nothing reaches this
 * document, and Chrome fires no `focusin` here when focus moves into an
 * iframe. So an overlay that dismisses on an outside interaction - a Radix
 * popover, a menu, a tooltip - never hears about the click and stays open
 * over the frame. What the parent does get is focus moving into the frame,
 * which the two kinds of frame announce differently:
 *
 * - An iframe is a frame of this page. The window blurs, the document still
 *   has focus (the focused area is inside it) and `document.activeElement`
 *   is the iframe element.
 * - A `<webview>` is its own web contents. The document loses focus
 *   outright, and the element itself receives a `focus` event, which the
 *   document sees in its capture phase.
 *
 * On either signal this replays the press as a `pointerdown` followed by a
 * `click` on the frame element, the pair Radix's dismissable layer needs:
 * it defers its outside-pointerdown dismissal to the gesture's click, and a
 * pointerdown with no click would leave the dismissal armed until the next
 * click anywhere. Both events bubble like the real ones would, so document
 * listeners of every kind see one ordinary outside press.
 *
 * A blur while the document has no focus is the application losing focus
 * to another window, not a press, and relays nothing. (Chrome delivers that
 * blur to an iframe's own window; the check is for an engine that delivers
 * it here, and for a `<webview>`, whose blur arrives that way.)
 *
 * Not relayed: a press while the frame already holds focus - neither signal
 * fires again - and anything the frame does with the press itself.
 *
 * `readFrame` is read at each signal, so a frame element that is replaced in
 * place (a reloaded iframe) stays covered. Returns the detach.
 */
export function attachGuestFramePressRelay(
  readFrame: () => Element | null,
): () => void {
  const onWindowBlur = (): void => {
    const frame = readFrame();
    if (frame === null || document.activeElement !== frame) return;
    if (!document.hasFocus()) return;
    relayGuestFramePress(frame);
  };
  const onFocus = (event: FocusEvent): void => {
    const frame = readFrame();
    if (frame === null || event.target !== frame) return;
    relayGuestFramePress(frame);
  };
  window.addEventListener("blur", onWindowBlur);
  document.addEventListener("focus", onFocus, true);
  return () => {
    window.removeEventListener("blur", onWindowBlur);
    document.removeEventListener("focus", onFocus, true);
  };
}

const relayed = new WeakSet<Event>();

/**
 * Whether `event` is one the relay dispatched. A frame's own host already
 * acted on the focus that announced the press, so it skips the replay rather
 * than treat it as a second gesture.
 */
export function isRelayedGuestFramePress(event: Event): boolean {
  return relayed.has(event);
}

/**
 * The whole gesture an outside press produces, on `frame`: pointerdown,
 * pointerup, click. The pointerup settles whatever the pointerdown armed
 * (the primary focus coordinator parks focus requests between the two), and
 * the click is what the dismissable layer waits for.
 */
function relayGuestFramePress(frame: Element): void {
  const pointer = {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerType: "mouse",
    pointerId: 1,
    isPrimary: true,
    button: 0,
  };
  const pointerdown = new PointerEvent("pointerdown", {
    ...pointer,
    buttons: 1,
  });
  const pointerup = new PointerEvent("pointerup", { ...pointer, buttons: 0 });
  const click = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: 0,
  });
  for (const event of [pointerdown, pointerup, click]) {
    relayed.add(event);
    frame.dispatchEvent(event);
  }
}
