import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { XIcon } from "lucide-react";

import { FrameCommentPortalContext } from "@/components/comments/frame-comment-surface-context";
import { useTabBodySelected } from "@/components/epic-canvas/canvas/tab-body-selected-context";
import {
  usePaneFocused,
  usePanePortalHostPresentation,
  usePaneVisible,
} from "@/components/epic-tabs/pane-visibility-context";
import { useBlockingLayerClaim } from "@/components/layout/shell/blocking-layer-claim";
import { BackdropDimSource } from "@/components/ui/backdrop-dim-source";
import { Button } from "@/components/ui/button";
import {
  claimFullscreen,
  releaseFullscreen,
  yieldFullscreen,
  type FullscreenClaim,
} from "@/lib/sandbox/overlay-owner";
import { cn } from "@/lib/utils";
import { SurfaceOverlayContainerContext } from "@/providers/surface-overlay-container-context";

import {
  ArtifactExpansionContext,
  EXPAND_TOGGLE_ATTRIBUTE,
  type ArtifactEscapeHandler,
} from "./artifact-expanded-context";

/**
 * The layers inside the surface that own Escape before it does: a menu, a
 * popover, a list, a nested dialog, the comment draft. Escape belongs to the
 * INNERMOST open layer, and none of these is a native popover or dialog that
 * the browser's own close-request stack would order for us - they are Radix
 * layers in ordinary DOM - so the surface asks before acting.
 *
 * Keyed on the design system's own `data-slot`s rather than a Radix internal.
 * A tooltip is deliberately absent: it does not own Escape, which is why the
 * press is taken in the CAPTURE phase, ahead of one.
 */
const NESTED_ESCAPE_OWNER = [
  '[data-slot="dropdown-menu-content"]',
  '[data-slot="dropdown-menu-sub-content"]',
  '[data-slot="context-menu-content"]',
  '[data-slot="context-menu-sub-content"]',
  '[data-slot="popover-content"]',
  '[data-slot="select-content"]',
  '[data-slot="dialog-content"]',
]
  .map((slot) => `${slot}:not([data-state="closed"])`)
  .concat("dialog[open]")
  .join(", ");

/**
 * Raises an artifact surface over the task IN PLACE: the instance that renders
 * inline is the one that expands, so every control the surface was given keeps
 * working, its selection and viewport carry over, and its page is not
 * reloaded.
 *
 * It replaces a `Dialog` whose content was a SECOND copy of the surface,
 * re-mounted with its wiring cut - the html frame's copy was built with
 * `commenting={false}`, `onBridge={null}` and no `toolbarControls`, the canvas
 * copy with `frameEvents={null}` and `awareness={null}` - so the expanded view
 * silently lost comments, presence, the version picker and everything else the
 * tile had passed in. One instance has nothing to forward and nothing to
 * drift.
 *
 * A NATIVE MODAL `<dialog>`, raised with `showModal()`. That is what keeps the
 * modality the copy-in-a-Dialog had: the browser makes the rest of the
 * document inert, which takes it out of the accessibility tree and out of
 * sequential focus navigation, so Tab cycles inside the surface in both
 * directions and a screen reader cannot wander behind it. The alternative was
 * a hand-written focus traversal, which is both weaker and bespoke; Radix's
 * `FocusScope` and `aria-hidden` are not dependencies here, and this surface
 * cannot borrow the Dialog primitive without re-mounting the children it
 * exists to keep. `showModal()` also promotes WITHOUT moving the element,
 * which matters because moving an artifact's iframe reloads its document.
 *
 * Inertness is why anything that needs the reader must END the expansion
 * rather than open over it: a confirm raised behind a modal would be
 * unreachable. `overlay-owner.ts` already guarantees that - it holds the
 * window's one top-layer claim, refuses a claim while something needs the
 * reader, and yields this one the moment a dialog appears outside it.
 */
export function ArtifactExpansion(props: {
  readonly title: string;
  readonly children: ReactNode;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);
  // State, not a ref: the portal containers below are published during render.
  // The element is created with the surface and never replaced.
  const [surface, setSurface] = useState<HTMLDialogElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const escapeRef = useRef<ArtifactEscapeHandler | null>(null);
  const claimRef = useRef<FullscreenClaim | null>(null);
  // `null` until the surface's first commit, which is where the inline state
  // is APPLIED rather than returned to.
  const shownRef = useRef<boolean | null>(null);
  const registerEscape = useCallback((handler: ArtifactEscapeHandler) => {
    escapeRef.current = handler;
    // Only the handler that is still registered may clear the slot: an
    // unmounting surface must not wipe its replacement's veto.
    return () => {
      if (escapeRef.current === handler) escapeRef.current = null;
    };
  }, []);
  // The host the comment draft and its mentions portal into, below. State, not
  // a ref: the context value is published during render.
  const [commentHost, setCommentHost] = useState<HTMLElement | null>(null);
  const paneFocused = usePaneFocused();
  // Both default to `true`, so a surface rendered without the hosts - a chat
  // row, an isolated test - is treated as on screen. Read separately: `&&`
  // would make the second one a conditional hook call.
  const paneVisible = usePaneVisible();
  const tabSelected = useTabBodySelected();
  const onScreen = paneVisible && tabSelected;
  const commentHostProps = usePanePortalHostPresentation(commentHost, {
    visible: paneVisible,
    focused: paneFocused,
  });

  const releaseClaim = (): void => {
    const claim = claimRef.current;
    claimRef.current = null;
    if (claim !== null) releaseFullscreen(claim);
  };
  /** Lowers the surface without moving focus. */
  const leave = (): void => {
    releaseClaim();
    setExpanded(false);
  };
  /**
   * Hands focus back to the toggle, which the collapse commit has just
   * remounted inside the (now inline) surface - so this belongs to the layout
   * effect below, after that commit, and never to the gesture that asked for
   * the collapse.
   */
  const focusToggle = useEffectEvent(() => {
    surface
      ?.querySelector<HTMLElement>(`[${EXPAND_TOGGLE_ATTRIBUTE}]`)
      ?.focus({ preventScroll: true });
  });
  const take = (): boolean => {
    if (claimRef.current !== null) return true;
    const row = surface?.closest("[data-message-id]") ?? null;
    const claim: FullscreenClaim = {
      // A yield has already released the claim, so this only lowers the
      // surface - and it must not move focus, which belongs to whatever
      // needed the reader.
      exit: () => {
        claimRef.current = null;
        setExpanded(false);
      },
      // The LIST key, so a long turn drawn as several items pins the one this
      // artifact sits in. A surface outside the transcript (a tile) has no row
      // and pins nothing.
      pinnedRowKey:
        row?.getAttribute("data-row-key") ??
        row?.getAttribute("data-message-id") ??
        null,
      // A nested dialog belongs to this surface - the comment draft, a confirm
      // raised from a control inside it - and must not end the expansion. Every
      // dialog outside it still does.
      surface: () => surface,
    };
    if (!claimFullscreen(claim)) return false;
    claimRef.current = claim;
    return true;
  };
  const expand = (): void => {
    // Asks whatever holds the top layer to give it up, as an app's Expand
    // does, and takes it in the SAME press: a surface the yield has lowered
    // does not read as a blocker of this one - an expanded artifact is a
    // `<dialog>` with no `role` attribute, so the blocker selector never
    // matched it, and a lowered app's surface is no dialog either - so
    // expanding a second artifact moves the raise rather than only lowering
    // the first.
    //
    // A refusal that survives the yield is something that needs the reader: an
    // approval, a link confirm, or a layer still open inside the surface that
    // just came down. Then the press lowers that surface and this one stays
    // inline, where its toggle is. Either way, never two raised at once.
    if (!take()) {
      yieldFullscreen();
      if (!take()) return;
    }
    setExpanded(true);
  };

  // The phone's back gesture stands down while the surface is up, and its back
  // button reaches it as Escape (`useSystemBack`). This is the gesture layer's
  // own counter, NOT a fullscreen blocker: holding one of those would end this
  // surface's claim in the commit that raised it.
  useBlockingLayerClaim(expanded);

  useLayoutEffect(() => {
    if (surface === null) return;
    const previous = shownRef.current;
    if (expanded === previous) return;
    shownRef.current = expanded;
    // The surface is a `<dialog>` that is ALWAYS open. CLOSED, the UA sheet
    // hides it outright - `dialog:not([open]) { display: none }` - and the
    // collapsed surface is the tile's own content, which has to lay out in
    // place; open and non-modal it is an ordinary box, which the classes below
    // turn into `display: contents` so it adds nothing to that layout. Opening
    // it by attribute rather than through `show()` also establishes no close
    // watcher, so a collapsed surface takes no part in Escape.
    //
    // Raising it is therefore close-then-`showModal()`: `showModal()` throws on
    // a dialog that is already open. Neither call moves the element, which is
    // what keeps the page inside it from reloading.
    //
    // Where the modal API is missing - jsdom defines neither method - the
    // surface stays an ordinary open dialog: no top layer, no inertness, no
    // browser focus cycle. The browser specs are what hold those three, and
    // the spec in `browser-tests/` is what reads them.
    const canModal =
      typeof surface.showModal === "function" &&
      typeof surface.close === "function";
    if (expanded) {
      if (canModal) {
        if (surface.open) surface.close();
        surface.showModal();
      }
      if (!surface.open) surface.setAttribute("open", "");
      closeRef.current?.focus({ preventScroll: true });
      return;
    }
    if (canModal && surface.open) surface.close();
    surface.setAttribute("open", "");
    // Nothing to hand focus back to on the first commit: the surface is
    // reaching its inline state, not returning to it.
    if (previous !== true) return;
    // Focus comes back to the toggle, unless the reader has already gone
    // somewhere that needs them. Closing a modal dialog restores focus to
    // whatever had it before, which is the toggle that has since unmounted, so
    // this is what actually puts focus back.
    const active = document.activeElement;
    if (
      active === null ||
      active === document.body ||
      surface.contains(active)
    ) {
      focusToggle();
    }
  }, [expanded, surface]);

  const exitOnEscape = useEffectEvent((event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented || surface === null) {
      return;
    }
    // An open layer inside the surface owns the press: it closes, the surface
    // stays. Asked of the DOM rather than of a registry so an unregistered
    // layer counts too. `querySelector` searches descendants only, so the
    // surface's own `dialog[open]` is not a match for itself.
    if (surface.querySelector(NESTED_ESCAPE_OWNER) !== null) return;
    // Then a local mode: a canvas tool disarms, a selection clears, a sticky
    // note commits its text. It reads the real event - the target it came
    // from, and whether to consume it - which is why Escape is taken here and
    // not from the dialog's own `cancel`.
    if (escapeRef.current?.(event) === true) {
      event.preventDefault();
      return;
    }
    leave();
  });
  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent): void => exitOnEscape(event);
    // The window's CAPTURE phase runs ahead of a tooltip's own Escape, which
    // would otherwise take the first press. The layers that do own Escape are
    // asked for above.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [expanded]);

  useEffect(() => {
    // The pane went to the background or the tab left the front. An off-screen
    // surface must not keep the window's one claim - nothing else could be
    // raised while it sat there invisibly - so it YIELDS, and the claim's own
    // `exit` lowers it. That is the same path a blocker takes, and it moves no
    // focus: focusing into a hidden pane would reactivate it.
    //
    // `expanded` implies a claim is held (`expand` sets it only after one is
    // taken), so this reaches exactly the surfaces that are up.
    if (onScreen || claimRef.current === null) return;
    yieldFullscreen();
  }, [onScreen]);

  useEffect(
    () => () => {
      const claim = claimRef.current;
      claimRef.current = null;
      if (claim !== null) releaseFullscreen(claim);
    },
    [],
  );

  return (
    <ArtifactExpansionContext.Provider
      value={{ expanded, expand, collapse: leave, registerEscape }}
    >
      {/* THE SAME container in both states, which is the contract this
          context carries: the comment composer is the only thing holding the
          reader's unsent text, and a `createPortal` whose container changes
          unmounts the draft and builds a new composer with nothing in it. So
          it is a host of this surface's own, rendered unconditionally below -
          one element inline and raised, like the canvas's
          (`use-canvas-presentation.ts`).

          Not the pane's host, which is where these portals live outside a
          surface: that host is outside the dialog, so a raised surface would
          leave the draft behind an inert document. Not the dialog element
          either - the host is governed by pane presentation, and governing the
          dialog would conceal the whole tile whenever another pane took
          focus. */}
      <FrameCommentPortalContext.Provider value={commentHost}>
        <SurfaceOverlayContainerContext.Provider
          value={expanded ? surface : null}
        >
          <dialog
            ref={setSurface}
            // An open `<dialog>` is a dialog to assistive tech, and this one
            // is always open (see the effect above) - but collapsed it is not
            // a dialog, it is the tile's own content, in place. `none`
            // suppresses the element's own semantics and leaves every child
            // exactly as accessible as it was. It holds only while no global
            // ARIA attribute is set here, which is why the label and
            // `aria-modal` below arrive with the raise and leave with it.
            role={expanded ? undefined : "none"}
            aria-modal={expanded ? true : undefined}
            aria-label={expanded ? props.title : undefined}
            data-state={expanded ? "open" : "closed"}
            // Escape is handled on keydown, where the real event is, so the
            // browser's own close request must not also lower the surface.
            onCancel={(event) => event.preventDefault()}
            className={cn(
              expanded
                ? [
                    // The UA sheet styles an open dialog: `fit-content` sizing,
                    // `margin: auto`, a `max-width`/`max-height` pair, a border,
                    // padding and `Canvas`/`CanvasText` colours. Each is undone,
                    // as `mcp-app-row`'s surface undoes the popover set.
                    "m-0 size-full max-h-none max-w-none border-0 bg-transparent p-0 text-inherit",
                    // The top layer escapes `#root`'s safe-area reservation, so
                    // the surface restores all four insets itself. The gutter
                    // tokens are `max(1rem, inset)`, which is also the 1rem the
                    // expanded dialog used to inset by.
                    "fixed inset-0 grid place-items-center pt-safe-top-gutter pr-safe-right-gutter pb-safe-bottom-gutter pl-safe-left-gutter",
                    // No transform here: a transformed ancestor becomes the
                    // containing block for the `fixed` menus portalled into
                    // this element, which would clip and mis-place them.
                    "backdrop:bg-black/10 backdrop:backdrop-blur-xs",
                  ]
                : "contents",
            )}
          >
            {expanded ? <BackdropDimSource strength="10" /> : null}
            <div
              className={cn(
                expanded
                  ? "flex h-full w-full flex-col overflow-hidden rounded-xl bg-popover text-popover-foreground ring-1 ring-foreground/10"
                  : "contents",
              )}
            >
              {expanded ? (
                <div className="flex shrink-0 items-center gap-2 border-b px-5 py-3">
                  <h2 className="min-w-0 flex-1 truncate font-heading text-ui-sm leading-snug font-semibold">
                    {props.title}
                  </h2>
                  <Button
                    ref={closeRef}
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Close"
                    onClick={() => leave()}
                  >
                    <XIcon className="size-4" />
                  </Button>
                </div>
              ) : null}
              <div className={cn(expanded ? "min-h-0 flex-1" : "contents")}>
                {props.children}
              </div>
              {/* The comment draft and the mentions it raises, kept mounted
                  with what the reader typed and concealed with the pane they
                  belong to - the same rules as the pane's own portal host,
                  which this surface cannot use. It is INSIDE the dialog, so a
                  raised surface takes it into the top layer with it, and it
                  sets no `display`, so the `hidden` attribute still wins over
                  it.

                  It adds neither a box nor a containing block. What portals in
                  here is out of flow, but not all of it is `fixed`: the draft
                  is, the mention list is `absolute`. So the draft stays
                  viewport-anchored, while the list resolves a positioned
                  ancestor - the dialog once raised, and the same one the
                  pane's host would have given it while inline, since this host
                  is static like that one and the panel between them is static
                  too, which is what keeps the panel's `overflow-hidden` from
                  clipping it. Either way floating-ui's absolute strategy
                  measures the ancestor it actually got. */}
              <div
                ref={setCommentHost}
                data-slot="artifact-comment-host"
                {...commentHostProps}
              />
            </div>
          </dialog>
        </SurfaceOverlayContainerContext.Provider>
      </FrameCommentPortalContext.Provider>
    </ArtifactExpansionContext.Provider>
  );
}
