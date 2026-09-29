"use client";

import {
  createContext,
  use,
  useCallback,
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  FloatingDelayGroup,
  FloatingPortal,
  autoUpdate,
  flip,
  offset,
  safePolygon,
  shift,
  size,
  useDelayGroup,
  useDismiss,
  useFloating,
  useFocus,
  useHover,
  useInteractions,
  useRole,
  useTransitionStyles,
  type OpenChangeReason,
  type Placement,
  type Side,
  type UseTransitionStylesProps,
} from "@floating-ui/react";
import { useRender } from "@base-ui/react/use-render";

import { HOVER_PREVIEW_SURFACE_CLASS } from "@/components/ui/hover-preview-surface";
import { useAnyMenuOpen } from "@/components/ui/open-menus";
import { TooltipsSuppressedContext } from "@/components/ui/tooltip-wrapper";
import { usePortalConcealed } from "@/components/ui/portal-concealment-context";
import { useSafeAreaCollisionPadding } from "@/components/ui/safe-area-collision-padding";
import { useMotionEnabled } from "@/lib/animation/use-motion-enabled";
import { cn } from "@/lib/utils";

/**
 * The app's hover card: a card (or a label chip) that opens on hover and on
 * KEYBOARD focus, on Floating UI's interaction hooks.
 *
 * Grouped. A list or strip wraps its rows in one `HoverCardGroup`: the first
 * card waits for intent (500ms), and while one is open, or within 300ms of
 * the last closing, a sibling's opens at once and the group closes the one
 * before it, so one card is ever up and moving row to row is a hand-off, not
 * a new wait. A card outside any group waits every time.
 *
 * Shut while any menu is open anywhere.
 *
 * The top layer for Escape: the card listens on the document's CAPTURE phase
 * and stops the event, so the first Escape closes the card and never reaches
 * a Base dialog's (bubble-phase) dismissal - the next one closes the dialog.
 * Floating UI owns positioning, hover, focus, a press on the trigger or
 * outside, and ancestor scroll.
 *
 * Dismissed by a press on its trigger (a click - a keyboard Enter or Space
 * included - a right-click, the pointerdown that starts a drag), Escape, a
 * press outside, or a scroll of any ancestor.
 * A dismissed card stays shut until the pointer leaves and comes back, which
 * is what keeps a click from ending in a card that re-opens under the pointer.
 * The pointer can travel into the card through a safe polygon, so actions
 * inside it (copy path, a link) stay reachable.
 *
 * Focus opens it only when it is `:focus-visible`: Tab gives a keyboard user
 * the card, a mouse focus does not. The card's content is outside the tab
 * order (it is a preview, never focus-managed; controls that render later are
 * taken out too), so any action placed in it must also have a
 * keyboard-reachable home elsewhere.
 *
 * In a group, a card that replaces an open sibling appears at once and the
 * sibling goes at once: the fade is only for the first open and the last close.
 */
export type HoverCardOpenReason =
  | "hover"
  | "focus"
  | "press"
  | "escape"
  | "outside-press"
  | "scroll"
  | "group"
  /** Shut by `enabled={false}` or an open menu. */
  | "disabled";

/**
 * What the card IS, from its content: `tooltip` for text alone, `dialog`
 * (named by `label`) for anything with an action or structure in it.
 */
export type HoverCardSemantics =
  | { readonly role: "tooltip" }
  | { readonly role: "dialog"; readonly label: string };

export interface HoverCardProps {
  /** One element; it receives the ref and the interaction props, composed with its own (Base `useRender`). */
  readonly trigger: ReactElement;
  /** Mounted only while the card is open. */
  readonly content: ReactNode;
  /** A popover card surface, or the inverted label chip: the look only. */
  readonly appearance: "preview" | "tooltip";
  readonly semantics: HoverCardSemantics;
  readonly side: Side;
  readonly align: "start" | "center" | "end";
  readonly sideOffset: number;
  /**
   * `false` keeps it shut, and closes it if open (a controlled parent is
   * told through `onOpenChange`):
   * while renaming, dragging, or a popover on the same trigger is open.
   */
  readonly enabled: boolean;
  /** `null` leaves it uncontrolled. */
  readonly open: boolean | null;
  readonly onOpenChange:
    | ((open: boolean, reason: HoverCardOpenReason) => void)
    | null;
  readonly testId: string | null;
  readonly className: string | null;
}

const HOVER_CARD_DELAY = { open: 500, close: 150 };
/** How long after the last card closes a sibling still opens at once. */
const HOVER_CARD_GROUP_TIMEOUT_MS = 300;
const HOVER_CARD_TRANSITION_MS = 100;
const HOVER_CARD_FADE = { opacity: 0, transform: "scale(0.95)" };

const TABBABLE =
  'a[href], area[href], button, input, select, textarea, iframe, summary, [tabindex], [contenteditable]:not([contenteditable="false"])';

/**
 * Takes every control in `root` out of sequential focus, now and whenever one
 * renders later (metadata that loads after the card opens).
 */
function keepOutOfTabOrder(root: HTMLElement | null): (() => void) | undefined {
  if (root === null) return undefined;
  const sweep = () => {
    for (const node of root.querySelectorAll<HTMLElement>(TABBABLE)) {
      if (node.tabIndex !== -1) node.tabIndex = -1;
    }
  };
  sweep();
  const observer = new MutationObserver(sweep);
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["tabindex", "href", "contenteditable"],
  });
  return () => observer.disconnect();
}

const HoverCardGroupContext = createContext(false);

/** One list's cards: they share one clock and one open card. */
export function HoverCardGroup(props: {
  readonly children: ReactNode;
}): ReactNode {
  return (
    <HoverCardGroupContext value>
      <FloatingDelayGroup
        delay={HOVER_CARD_DELAY}
        timeoutMs={HOVER_CARD_GROUP_TIMEOUT_MS}
      >
        {props.children}
      </FloatingDelayGroup>
    </HoverCardGroupContext>
  );
}

function placementOf(side: Side, align: HoverCardProps["align"]): Placement {
  return align === "center" ? side : `${side}-${align}`;
}

/** A group closing a sibling calls `onOpenChange` with no reason. */
function reasonOf(reason: OpenChangeReason | undefined): HoverCardOpenReason {
  switch (reason) {
    case "hover":
    case "safe-polygon":
      return "hover";
    case "focus":
    case "focus-out":
      return "focus";
    case "reference-press":
    case "click":
      return "press";
    case "escape-key":
      return "escape";
    case "outside-press":
      return "outside-press";
    case "ancestor-scroll":
      return "scroll";
    case "list-navigation":
    case undefined:
      return "group";
  }
}

function isSibling(currentId: unknown, id: string | undefined): boolean {
  return currentId !== null && currentId !== id;
}

function labelOf(semantics: HoverCardSemantics): string | undefined {
  return semantics.role === "dialog" ? semantics.label : undefined;
}

/**
 * Escape, as the top layer: a capture-phase listener on the document runs
 * before a Base dialog's bubble-phase one, and stopping the event there keeps
 * that dialog open until the next Escape. Composition Escape (IME) is left to
 * the input method.
 */
function useEscapeAsTopLayer(
  open: boolean,
  close: (event: KeyboardEvent) => void,
): void {
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      close(event);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, close]);
}

/**
 * A fade for the first open and the last close; none for a card handed over
 * from a sibling or displaced by one, so a hand-off never paints two cards.
 */
function transitionOf(
  motionEnabled: boolean,
  enteredByHandoff: boolean,
  displaced: boolean,
): UseTransitionStylesProps {
  if (!motionEnabled) return { duration: 0, initial: {} };
  return {
    duration: {
      open: enteredByHandoff ? 0 : HOVER_CARD_TRANSITION_MS,
      close: displaced ? 0 : HOVER_CARD_TRANSITION_MS,
    },
    initial: enteredByHandoff ? {} : HOVER_CARD_FADE,
    close: HOVER_CARD_FADE,
    common: ({ side }) => ({ transformOrigin: TRANSFORM_ORIGIN[side] }),
  };
}

/** The card scales out of the edge facing its trigger. */
const TRANSFORM_ORIGIN: Record<Side, string> = {
  top: "bottom",
  right: "left",
  bottom: "top",
  left: "right",
};

/**
 * Whether no card may open: disabled, while any menu is open (the trigger's
 * own or another's, since a non-modal menu leaves the rows beside it
 * hoverable), or inside a scene that is shown rather than used.
 */
function useHoverCardSuppressed(enabled: boolean): boolean {
  const menuOpen = useAnyMenuOpen();
  const sceneSuppressed = use(TooltipsSuppressedContext);
  return !enabled || menuOpen || sceneSuppressed;
}

export function HoverCard(props: HoverCardProps): ReactNode {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const suppressed = useHoverCardSuppressed(props.enabled);
  // A suppressed card is CLOSED, not hidden, so lifting the suppression shows
  // nothing until a new hover: it forgets its own open state, and a controlled
  // parent is told to drop its.
  if (suppressed && uncontrolledOpen) setUncontrolledOpen(false);
  const open = (props.open ?? uncontrolledOpen) && !suppressed;
  const controlledOpen = props.open === true;
  const onOpenChange = props.onOpenChange;
  useEffect(() => {
    if (suppressed && controlledOpen) onOpenChange?.(false, "disabled");
  }, [suppressed, controlledOpen, onOpenChange]);
  const grouped = use(HoverCardGroupContext);
  const motionEnabled = useMotionEnabled();
  // Concealed region (see `portal-concealment-context`): un-present with the
  // region - the anchor is display:none and cannot deliver the close events.
  const concealed = usePortalConcealed();
  // The device insets are the collision padding, as for every other overlay
  // (see `safe-area-collision-padding.ts`).
  const safeArea = useSafeAreaCollisionPadding();
  const {
    refs: anchors,
    floatingStyles,
    context,
  } = useFloating({
    open,
    onOpenChange: (next, _event, reason) => {
      if (next && suppressed) return;
      if (props.open === null) setUncontrolledOpen(next);
      onOpenChange?.(next, reasonOf(reason));
    },
    placement: placementOf(props.side, props.align),
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(props.sideOffset),
      flip({ padding: safeArea }),
      shift({ padding: safeArea }),
      size({
        padding: safeArea,
        apply({ availableWidth, availableHeight, elements }) {
          elements.floating.style.setProperty(
            "--hover-card-available-width",
            `${String(availableWidth)}px`,
          );
          elements.floating.style.setProperty(
            "--hover-card-available-height",
            `${String(availableHeight)}px`,
          );
        },
      }),
    ],
  });
  // Bound here, not destructured: the setters are methods of the refs bag.
  const setReference = useCallback(
    (node: Element | null) => anchors.setReference(node),
    [anchors],
  );
  const setFloating = useCallback(
    (node: HTMLElement | null) => anchors.setFloating(node),
    [anchors],
  );
  const group = useDelayGroup(context, { enabled: grouped });
  // Another card of the group is the current one: this card is being handed
  // over from (it opens at once) or displaced by it (it goes at once).
  const siblingCurrent =
    grouped && isSibling(group.currentId, context.floatingId);
  // Latched when it opens: the group makes this card the current one a layout
  // effect later, which must not turn a hand-off into a fade mid-entry.
  const [wasOpen, setWasOpen] = useState(open);
  const [enteredByHandoff, setEnteredByHandoff] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setEnteredByHandoff(siblingCurrent);
  }
  // The interaction hooks stay on while suppressed; only the open is refused
  // (above). A disabled hook drops its handlers, and with them the pointer
  // leave and blur that clear its "dismissed until the pointer leaves" latch:
  // a right-clicked trigger would then never open on focus again.
  const hover = useHover(context, {
    delay: grouped ? group.delay : HOVER_CARD_DELAY,
    mouseOnly: true,
    handleClose: safePolygon({ requireIntent: false }),
  });
  const focus = useFocus(context, {
    visibleOnly: true,
  });
  // Escape is the top-layer listener's (below). A press on the trigger is the
  // reference press, and focus leaving the trigger is `useFocus`'s - a
  // hover-opened card outlives focus moving elsewhere.
  const dismiss = useDismiss(context, {
    escapeKey: false,
    outsidePress: true,
    outsidePressEvent: "pointerdown",
    referencePress: true,
    ancestorScroll: true,
  });
  const closeOnEscape = useCallback(
    (event: KeyboardEvent) => context.onOpenChange(false, event, "escape-key"),
    [context],
  );
  useEscapeAsTopLayer(open, closeOnEscape);
  // A suppressed preview must not overwrite a click-open popup's ARIA.
  const role = useRole(context, {
    role: props.semantics.role,
    enabled: !suppressed,
  });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    hover,
    focus,
    dismiss,
    role,
  ]);
  // Composes the trigger's own handlers and ref with these, so a trigger that
  // is also a popover, menu or drag handle keeps every one of its behaviours.
  const trigger = useRender({
    render: props.trigger,
    ref: setReference,
    props: getReferenceProps(),
  });
  const { isMounted, styles } = useTransitionStyles(
    context,
    transitionOf(motionEnabled, enteredByHandoff, siblingCurrent),
  );
  return (
    <>
      {trigger}
      {isMounted && !concealed ? (
        <FloatingPortal>
          <div
            ref={setFloating}
            data-slot="hover-card-positioner"
            style={floatingStyles}
            className="z-50"
            aria-label={labelOf(props.semantics)}
            {...getFloatingProps()}
          >
            <div
              ref={keepOutOfTabOrder}
              data-slot="hover-card-content"
              data-appearance={props.appearance}
              data-open={open ? "" : undefined}
              data-closed={open ? undefined : ""}
              data-side={context.placement.split("-")[0]}
              data-align={context.placement.split("-")[1] ?? "center"}
              data-testid={props.testId ?? undefined}
              style={styles}
              className={cn(
                "outline-hidden",
                props.appearance === "tooltip"
                  ? "rounded-md bg-foreground text-background shadow-sm"
                  : HOVER_PREVIEW_SURFACE_CLASS,
                // Last of the primitive-owned classes, so the shared surface
                // class can never displace the cap while a caller's `max-w-*`
                // still can.
                "max-w-safe-dvw",
                props.className,
              )}
            >
              {props.content}
            </div>
          </div>
        </FloatingPortal>
      ) : null}
    </>
  );
}
