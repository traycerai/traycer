/**
 * The edit firewall (4.4): the app column stays alive and stays quiet.
 *
 * `inert` is not usable here. It removes the subtree from hit testing, so a
 * region inside an inert `<main>` would never fire the hover and the click the
 * canvas resolves from - and pointing at the real thing is the whole model
 * (P3, L-01). What the column gets instead is a capture-phase listener per
 * gesture that could change something, plus a focus bounce so neither the
 * app's controls nor the canvas regions are tab stops (L-31).
 *
 * Wheel and touch scroll are deliberately absent: the app under the editor
 * keeps streaming and the transcript keeps scrolling (L-17).
 *
 * So is `contextmenu`, which is a narrower rule of its own - see
 * {@link contextMenuIsTheAppsOwn}.
 */

/**
 * Every gesture swallowed at the column unconditionally. `dragenter`,
 * `dragover`, `dragleave`, `drop` and `paste` are on the list because the
 * composer carries real handlers for all five (C-16), so a file dragged from
 * Finder onto the dimmed composer would otherwise attach itself mid-session.
 */
export const FIREWALLED_EVENT_TYPES = [
  "click",
  "dblclick",
  "auxclick",
  "pointerdown",
  "keydown",
  "keypress",
  "submit",
  "dragstart",
  "dragenter",
  "dragover",
  "dragleave",
  "drop",
  "paste",
] as const;

/**
 * Whether a right-click inside the column belongs to the APP rather than to
 * the editor (L-129).
 *
 * `contextmenu` was on the list above, and that made quick verbs - the
 * mode-less half of the whole model (L-19) - unreachable from inside a
 * session: the trigger never saw the event. A quick verb is not the app
 * acting, it is the same write the inspector's own control makes through the
 * same `region-control-io` seam, so on a region the event has to get through.
 *
 * Everywhere else it still does not. A right-click on a chat message, a
 * transcript or a text field is the app's own menu over the user's own
 * content, which is exactly what the firewall exists to keep quiet.
 *
 * So the test is "this press has somewhere to go", which is two facts and not
 * one. A named region says the verbs would know what they are about; a mounted
 * context-menu trigger says something is listening for the event. L-144 has
 * since put a trigger over every region a user can point at - the composer's
 * clusters, the dock's pill row and joined frame, the minimap, the Home tab
 * item, the header's usage cluster, plus the chrome that renders the verbs
 * INSIDE a menu it already owns, the sidebar rail. Keyed on the region alone
 * this let a press through to nothing wherever a host was missing or not yet
 * mounted, and it went on to Electron's own spell-check menu over sample
 * content.
 *
 * `data-slot="context-menu-trigger"` is what `components/ui/context-menu.tsx`
 * stamps on every trigger, `asChild` included, so a host that gains or loses a
 * menu moves this test with it and nothing has to remember a second marker.
 * The region half is what keeps the app's OWN context menus quiet: a menu on
 * something that is not a customizable piece of chrome is the app acting.
 */
function contextMenuIsTheAppsOwn(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  return (
    target.closest("[data-layout-region]") === null ||
    target.closest('[data-slot="context-menu-trigger"]') === null
  );
}

/**
 * A press on the Customizing tab itself (audit F1). It is the session's own
 * tab, not the app acting: activating it is a no-op, and its close is a way
 * out of the editor.
 */
function isSessionTabPress(event: Event): boolean {
  return (
    event.type !== "keydown" &&
    event.type !== "keypress" &&
    event.target instanceof Element &&
    event.target.closest('[data-tab-kind="sample-workspace"]') !== null
  );
}

export interface EditFirewallInput {
  /** The element 4.5 names the app column; never an ancestor of the inspector. */
  readonly column: HTMLElement;
  /**
   * Where focus goes when something inside the column takes it. Read on every
   * bounce rather than captured, because the inspector's own tree changes as
   * the user walks it.
   */
  readonly focusTarget: () => HTMLElement | null;
}

export function installEditFirewall(input: EditFirewallInput): () => void {
  const { column, focusTarget } = input;

  const swallow = (event: Event): void => {
    if (isSessionTabPress(event)) return;
    event.preventDefault();
    // Not `stopPropagation`: a handler bound on the column itself is exactly
    // as able to act on the app as one further down.
    event.stopImmediatePropagation();
  };

  const swallowAppMenu = (event: Event): void => {
    if (contextMenuIsTheAppsOwn(event.target)) swallow(event);
  };

  const bounce = (): void => {
    focusTarget()?.focus({ preventScroll: true });
  };

  for (const type of FIREWALLED_EVENT_TYPES) {
    column.addEventListener(type, swallow, true);
  }
  column.addEventListener("contextmenu", swallowAppMenu, true);
  column.addEventListener("focusin", bounce, true);
  // The column is announced through the relay row while the editor is open;
  // it is not an ancestor of the inspector, so the inspector stays readable
  // (4.5, 4.8).
  column.setAttribute("aria-hidden", "true");
  // Focus may already be inside the column when the session opens - the button
  // that opened it, most of the time.
  if (column.contains(document.activeElement)) bounce();

  return () => {
    for (const type of FIREWALLED_EVENT_TYPES) {
      column.removeEventListener(type, swallow, true);
    }
    column.removeEventListener("contextmenu", swallowAppMenu, true);
    column.removeEventListener("focusin", bounce, true);
    column.removeAttribute("aria-hidden");
  };
}
