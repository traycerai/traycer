import {
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  autoUpdate,
  computePosition,
  flip,
  offset,
  shift,
} from "@floating-ui/dom";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { ShortcutHint } from "@/components/ui/shortcut-hint";
import { cn } from "@/lib/utils";
import { useCoarsePointer } from "@/hooks/ui/use-coarse-pointer";
import { useSafeAreaCollisionPadding } from "@/components/ui/safe-area-collision-padding";
import { focusGuideTarget, interactWithGuideTarget } from "./guide-target";
import {
  escapeOwnedElsewhere,
  MODAL_OVERLAY_SELECTOR,
  OPEN_OVERLAY_SELECTOR,
  OVERLAY_SELECTOR,
  CLOSING_OVERLAY_SELECTOR,
} from "./guide-overlays";
// The card wears the acts' own button. `.onboarding-button` is global, but it
// ships in the onboarding page's chunk - which never loads when the app starts
// straight into the first-task guide, so the import has to be here too.
import "./onboarding.css";
import "./first-task-guide.css";

interface CoachmarkProgress {
  readonly step: number;
  readonly total: number;
}

/** See `CoachmarkProps.cardAnchor`. */
export interface CoachmarkCardAnchor {
  readonly selector: string;
  readonly placement: "top-start" | "bottom-start";
}

interface CoachmarkProps {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly progress: CoachmarkProgress | null;
  readonly rootRef: RefObject<HTMLElement | null>;
  readonly selector: string;
  /**
   * Where the CARD goes, when that is not "beside the thing it points at".
   *
   * The halo always lands on `selector`; this moves only the floater. One step
   * needs it: on a phone the drawer's task list fills the drawer, so a card
   * anchored under the first row covers the rows the step is telling the user
   * to tap. It anchors above the drawer's Settings row instead, and the halo
   * stays where the instruction is.
   *
   * Resolved inside the card's own portal (the drawer, for that step), so a
   * selector here names an element on the same surface as the target.
   */
  readonly cardAnchor: CoachmarkCardAnchor | null;
  readonly onClose: () => void;
  readonly onTarget: ((target: HTMLElement, keyboard: boolean) => void) | null;
  readonly back: (() => void) | null;
  readonly action: {
    readonly label: string;
    readonly onClick: () => void;
  } | null;
}

function cardOf(node: EventTarget | null): Element | null {
  return node instanceof Element ? node.closest(".first-task-coachmark") : null;
}

function hasModifier(event: KeyboardEvent): boolean {
  return [
    event.repeat,
    event.metaKey,
    event.ctrlKey,
    event.altKey,
    event.shiftKey,
  ].includes(true);
}

/** The card's exit, the text crossfade's first half, and the anchor glide. */
const EXIT_MS = 160;
const TEXT_OUT_MS = 120;
const GLIDE_MS = 320;
/** How long a just-closed picker is given to finish collapsing. */
const PICKER_SETTLE_MS = 120;
/** The spotlight's bleed around the target, in px on every side. */
const HALO_INSET = 4;
/**
 * The card's clearance from every edge of the surface it floats in.
 *
 * 16, which is the page's own gutter, not the 12 this used to use: inside the
 * mobile navigation drawer the card is on a 295pt surface, and a card that
 * clears a phone's edges by less than the content beside it reads as having
 * missed its mark. It pairs with the card's width clamp (see
 * `--coachmark-available` below): the clamp leaves exactly this much on each
 * side, so `shift` never has to choose which edge to honour.
 */
const CARD_EDGE_PADDING = 16;

export function OnboardingCoachmark(props: CoachmarkProps) {
  const { onClose, onTarget } = props;
  const [keyboardNavigation, setKeyboardNavigation] = useState(false);
  const target = useGuideTarget(props.rootRef, props.selector);
  const held = useHeldTarget(target);
  const copy = useCrossfadedCopy(props);
  const safeArea = useSafeAreaCollisionPadding();
  const coarsePointer = useCoarsePointer();
  const cardRef = useRef<HTMLDivElement>(null);
  const floaterRef = useRef<HTMLDivElement>(null);
  const haloRef = useRef<HTMLDivElement>(null);
  const dimRef = useRef<HTMLDivElement>(null);
  const cutoutRef = useRef<SVGRectElement>(null);
  const maskId = `first-task-coachmark-dim-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const headingId = `${maskId}-title`;
  const descriptionId = `${maskId}-body`;
  const portal =
    held?.closest<HTMLElement>(MODAL_OVERLAY_SELECTOR) ?? document.body;

  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (target === null || event.defaultPrevented || event.isComposing) return;
    const card = cardOf(event.target);
    if (event.key === "Escape") {
      // Escape closes the guide from anywhere on the surface: the person
      // pressing it wants out of the guidance, not out of whatever happens
      // to hold focus. Only a dismissable surface that is genuinely
      // elsewhere answers it first.
      if (escapeOwnedElsewhere([target, cardRef.current])) return;
      event.preventDefault();
      if (card) focusGuideTarget(target);
      onClose();
      return;
    }
    if (!card || hasModifier(event)) return;
    const forward =
      event.key === "ArrowRight" ||
      (event.key === "Enter" && event.target === card);
    if (event.key !== "ArrowLeft" && !forward) return;
    event.preventDefault();
    setKeyboardNavigation(true);
    if (!forward) props.back?.();
    else if (props.action !== null) props.action.onClick();
    else interactWithGuideTarget(target);
  });
  // Armed for the coachmark's whole life, not per target. Keyed on `target`,
  // the listener went up one effect flush AFTER the commit that put the card
  // on screen - a card the user can see with nothing listening behind it.
  // `handleKeyDown` already declines a null target, and React swaps an effect
  // event's body in the same mutation phase that writes the DOM, so the guard
  // is armed by the very commit that shows the card.
  useEffect(() => {
    const leaveCard = (event: FocusEvent): void => {
      if (
        event.target instanceof Element &&
        event.target.closest(".first-task-coachmark") &&
        event.relatedTarget instanceof Element &&
        !event.relatedTarget.closest(".first-task-coachmark")
      )
        setKeyboardNavigation(false);
    };
    // Capture before a picker can close and re-resolve the target in the same
    // event.
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    window.addEventListener("focusout", leaveCard);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
      window.removeEventListener("focusout", leaveCard);
    };
  }, []);

  const revealTarget = useEffectEvent((element: HTMLElement) =>
    onTarget?.(element, keyboardNavigation),
  );
  useEffect(() => {
    if (target !== null) revealTarget(target);
  }, [target, onTarget]);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (card === null) return;
    const focused = document.activeElement;
    if (
      (keyboardNavigation && card.contains(focused)) ||
      focused === document.body ||
      focused === card.closest(MODAL_OVERLAY_SELECTOR)
    )
      card.focus({ preventScroll: true });
  }, [keyboardNavigation, props.id]);

  useLayoutEffect(() => {
    const floater = floaterRef.current;
    const halo = haloRef.current;
    if (target === null || floater === null) return;
    const padding = {
      top: Math.max(CARD_EDGE_PADDING, safeArea.top),
      right: Math.max(CARD_EDGE_PADDING, safeArea.right),
      bottom: Math.max(CARD_EDGE_PADDING, safeArea.bottom),
      left: Math.max(CARD_EDGE_PADDING, safeArea.left),
    };
    const boundary = portal === document.body ? "clippingAncestors" : portal;
    // A step change moves the card between two live anchors, and only then
    // does it glide - a scroll or a resize has to track the target frame for
    // frame. An empty transform is a card that has never been placed.
    const glide = floater.style.transform !== "";
    const glideElements = [floater, halo, dimRef.current];
    setGliding(glideElements, glide);
    const settle = glide
      ? setTimeout(() => setGliding(glideElements, false), GLIDE_MS + 40)
      : null;

    // A position resolves asynchronously, so one requested for a target the
    // effect has since left could land after the new target's own and paint
    // the halo on a detached node. Only the latest request may paint.
    let positionRequest = 0;
    const reposition = (): void => {
      const request = ++positionRequest;
      // The card can never be wider than the surface it floats in: on the body
      // that is the viewport, inside a portalled overlay it is that overlay.
      // Written as a custom property because the floater is `width: max-content`
      // and a percentage on it would resolve against nothing useful; the card
      // one level in reads it (`first-task-guide.css`).
      const available =
        portal === document.body ? window.innerWidth : portal.clientWidth;
      floater.style.setProperty("--coachmark-available", `${available}px`);
      // The card's anchor, which is the step's target unless the step moved it
      // off the thing it points at (see `cardAnchor`). Resolved per tick rather
      // than once: it belongs to the same surface as the target, so it appears
      // and leaves with it.
      const anchorSpec = props.cardAnchor;
      const anchor =
        anchorSpec === null
          ? target
          : (portal.querySelector<HTMLElement>(anchorSpec.selector) ?? target);
      void computePosition(anchor, floater, {
        strategy: "fixed",
        placement: anchorSpec?.placement ?? "bottom-start",
        // No arrow: the halo on the target is the connection, and 10px is
        // close enough to read as one gesture with it.
        middleware: [
          offset(10),
          flip({ padding, boundary }),
          shift({ padding, boundary }),
        ],
      }).then(({ x, y }) => {
        if (!floater.isConnected || request !== positionRequest) return;
        floater.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
        paintSpotlight(target, halo, cutoutRef.current, portal);
      });
    };
    reposition();
    const stop = autoUpdate(target, floater, reposition);
    return () => {
      positionRequest += 1;
      stop();
      if (settle !== null) window.clearTimeout(settle);
    };
  }, [target, portal, safeArea, props.cardAnchor]);

  if (held === null) return null;
  const exiting = target === null;
  // One question, two answers. A step whose target lives inside an overlay
  // has to clear that overlay's own layer - every one of them rests at z-50,
  // above the card's resting home - and must not dim, because dimming the app
  // behind a surface that already owns attention would darken the very thing
  // the step is about.
  const overOverlay = held.closest(OVERLAY_SELECTOR) !== null;
  const dimmed = !overOverlay;
  const state = exiting ? "exiting" : "entered";
  return createPortal(
    <>
      {dimmed ? (
        <div
          ref={dimRef}
          data-testid="guide-coachmark-dim"
          data-state={state}
          aria-hidden="true"
          className="first-task-coachmark-dim"
          data-over-overlay={overOverlay}
        >
          <svg className="first-task-coachmark-dim-svg" aria-hidden="true">
            <defs>
              <mask id={maskId}>
                <rect
                  className="first-task-coachmark-dim-sheet"
                  width="100%"
                  height="100%"
                />
                <rect
                  ref={cutoutRef}
                  className="first-task-coachmark-dim-cutout"
                />
              </mask>
            </defs>
            <rect
              className="first-task-coachmark-dim-fill"
              width="100%"
              height="100%"
              mask={`url(#${maskId})`}
            />
          </svg>
        </div>
      ) : null}
      <div
        ref={haloRef}
        data-testid="guide-coachmark-halo"
        data-state={state}
        aria-hidden="true"
        className="first-task-coachmark-halo"
        data-over-overlay={overOverlay}
      >
        <span key={props.id} className="first-task-coachmark-pulse" />
      </div>
      <div
        ref={floaterRef}
        data-state={state}
        className="first-task-coachmark-floater"
        data-over-overlay={overOverlay}
      >
        <div className="first-task-coachmark-surface">
          <div
            ref={cardRef}
            data-testid="guide-coachmark"
            tabIndex={-1}
            role="dialog"
            aria-modal={false}
            aria-labelledby={headingId}
            aria-describedby={descriptionId}
            // Withheld on a touch device, along with the keycap below: there is
            // no Enter to press, and promising four keys that do not exist is
            // worse than saying nothing. The listener stays armed either way -
            // a Bluetooth keyboard on a phone still works, it is just not
            // advertised.
            aria-keyshortcuts={
              coarsePointer ? undefined : "ArrowLeft ArrowRight Enter Escape"
            }
            data-keyboard-navigation={keyboardNavigation || undefined}
            data-text-state={copy.swapping ? "out" : "in"}
            // The surface is `PopoverContent`'s, class for class: a coachmark
            // floating over the app's own chrome is a popover, and a glass fill
            // let the drafts list read straight through it. The width is the
            // card's own (see the stylesheet), and `max-w-safe-dvw` is the
            // sanctioned safe-area cap for anything `fixed`.
            className="first-task-coachmark max-w-safe-dvw bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10"
          >
            <div className="first-task-coachmark-eyebrow-row">
              {copy.progress === null ? null : (
                <ProgressBars progress={copy.progress} />
              )}
              <Button
                type="button"
                variant="muted"
                size="icon-sm"
                aria-label="Dismiss getting started guide"
                className="-mt-1 -mr-1 ml-auto shrink-0"
                onClick={() => {
                  focusGuideTarget(held);
                  onClose();
                }}
              >
                <X className="size-3.5" />
              </Button>
            </div>
            <h2 id={headingId} className="first-task-coachmark-title">
              {copy.title}
            </h2>
            <p
              id={descriptionId}
              aria-live="polite"
              className="first-task-coachmark-body"
            >
              {copy.content}
            </p>
            <div className="first-task-coachmark-footer">
              {props.back === null ? null : (
                <button
                  type="button"
                  className="onboarding-button onboarding-button--quiet"
                  onClick={(event) => {
                    setKeyboardNavigation(event.detail === 0);
                    props.back?.();
                  }}
                >
                  Back
                </button>
              )}
              <button
                type="button"
                className="onboarding-button onboarding-button--primary"
                onClick={(event) => {
                  setKeyboardNavigation(event.detail === 0);
                  if (props.action !== null) props.action.onClick();
                  else interactWithGuideTarget(held);
                }}
              >
                <span className="first-task-coachmark-action-label">
                  {copy.label}
                </span>
                {/* The cap rides the button's own foreground: these are plain
                    `.onboarding-button` elements, so `Kbd`'s in-Button rules
                    never fire here. Absent on touch, where there is no key to
                    draw. */}
                {coarsePointer ? null : (
                  <ShortcutHint>
                    <Kbd aria-hidden="true" variant="inherit">
                      ↵
                    </Kbd>
                  </ShortcutHint>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>,
    portal,
  );
}

/**
 * The card's step-progress row. Completed steps are filled; the current step
 * and those after it stay as track, so the row reads as "how far you have
 * come" rather than "where you are". The accessible value carries the step.
 */
function ProgressBars(props: { readonly progress: CoachmarkProgress }) {
  const { step, total } = props.progress;
  return (
    <div
      role="progressbar"
      aria-valuemin={1}
      aria-valuemax={total}
      aria-valuenow={step}
      aria-label={`Step ${step} of ${total}`}
      data-testid="guide-coachmark-progress"
      className="first-task-coachmark-progress"
    >
      {Array.from({ length: total }, (_, index) => (
        <span
          key={index}
          data-filled={index < step - 1 || undefined}
          className={cn(
            "first-task-coachmark-progress-bar",
            index < step - 1 && "first-task-coachmark-progress-bar--filled",
          )}
        />
      ))}
    </div>
  );
}

/**
 * Keeps the card mounted through its exit after the target goes away - and,
 * incidentally, across the one null render a step change costs, so the card
 * glides between two anchors instead of popping.
 */
function useHeldTarget(target: HTMLElement | null): HTMLElement | null {
  const [held, setHeld] = useState<HTMLElement | null>(target);
  // Remembered during render, not in an effect: holding the departing target
  // is derived state, and an effect would cost a cascading render for it.
  if (target !== null && target !== held) setHeld(target);
  useEffect(() => {
    if (target !== null) return;
    const timer = window.setTimeout(() => setHeld(null), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [target]);
  return target ?? held;
}

interface CoachmarkCopy {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly progress: CoachmarkProgress | null;
  readonly label: string;
}

function progressEqual(
  a: CoachmarkProgress | null,
  b: CoachmarkProgress | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.step === b.step && a.total === b.total;
}

/**
 * The words lag a step change by the first half of the crossfade, so the card
 * fades its old copy out while it glides and fades the new copy in on arrival.
 * Only the words lag: the buttons always run the live step's callbacks.
 */
function useCrossfadedCopy(
  props: CoachmarkProps,
): CoachmarkCopy & { readonly swapping: boolean } {
  const label = props.action?.label ?? "Try it";
  const [shown, setShown] = useState<CoachmarkCopy>({
    id: props.id,
    title: props.title,
    content: props.content,
    progress: props.progress,
    label,
  });
  const swapping = shown.id !== props.id;
  const next: CoachmarkCopy = {
    id: props.id,
    title: props.title,
    content: props.content,
    progress: props.progress,
    label,
  };
  // Same step, edited copy (a title that follows the picked folder): the words
  // just change, there is nothing to travel between - so this is derived state
  // and belongs in render, not in an effect that would cascade a render for it.
  if (
    !swapping &&
    (shown.title !== next.title ||
      shown.content !== next.content ||
      !progressEqual(shown.progress, next.progress) ||
      shown.label !== next.label)
  ) {
    setShown(next);
  }
  useEffect(() => {
    if (!swapping) return;
    const timer = window.setTimeout(
      () =>
        setShown({
          id: props.id,
          title: props.title,
          content: props.content,
          progress: props.progress,
          label,
        }),
      TEXT_OUT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [swapping, props.id, props.title, props.content, props.progress, label]);
  return { ...shown, swapping };
}

// Pickers own attention while open. Observe mounting, visibility, and closing
// instead of advancing a tour on timers or swallowing application clicks.
function useGuideTarget(
  rootRef: RefObject<HTMLElement | null>,
  selector: string,
): HTMLElement | null {
  const [resolved, setResolved] = useState<{
    selector: string;
    target: HTMLElement | null;
  }>({ selector, target: null });
  // Outlives the effect on purpose: a step often changes BECAUSE a picker
  // closed, and the new step must still wait for that picker to finish.
  const overlayWasOpen = useRef(false);
  useEffect(() => {
    let settle: number | null = null;
    const update = (measured: boolean): void => {
      const overlayOpen =
        document.querySelector(OPEN_OVERLAY_SELECTOR) !== null;
      if (!measured) {
        // A picker that just closed is still collapsing, and the target
        // underneath it has not landed yet - measuring now pins the card to a
        // rect it is about to leave.
        if (overlayWasOpen.current && !overlayOpen) {
          settle ??= window.setTimeout(() => {
            settle = null;
            update(true);
          }, PICKER_SETTLE_MS);
          return;
        }
        if (settle !== null) return;
      }
      overlayWasOpen.current = overlayOpen;
      const candidate =
        rootRef.current?.querySelector<HTMLElement>(selector) ?? null;
      const visible =
        candidate !== null &&
        candidate.getClientRects().length > 0 &&
        candidate.closest('[inert], [aria-hidden="true"]') === null;
      const obscured = Array.from(
        document.querySelectorAll(OPEN_OVERLAY_SELECTOR),
      ).some((overlay) => !overlay.contains(candidate));
      const target = !obscured && visible ? candidate : null;
      setResolved((previous) =>
        previous.selector === selector && previous.target === target
          ? previous
          : { selector, target },
      );
    };
    const remeasure = (): void => update(false);
    // The picker's own closing transition is the authoritative "it has landed".
    const onTransitionEnd = (event: TransitionEvent): void => {
      if (
        !(event.target instanceof Element) ||
        !event.target.matches(CLOSING_OVERLAY_SELECTOR)
      )
        return;
      if (settle !== null) {
        window.clearTimeout(settle);
        settle = null;
      }
      update(true);
    };
    update(false);
    const observer = new MutationObserver(remeasure);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-state", "aria-hidden", "inert", "hidden"],
    });
    window.addEventListener("resize", remeasure);
    document.addEventListener("transitionend", onTransitionEnd, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", remeasure);
      document.removeEventListener("transitionend", onTransitionEnd, true);
      if (settle !== null) clearTimeout(settle);
    };
  }, [rootRef, selector]);
  return resolved.selector === selector ? resolved.target : null;
}

function setGliding(
  elements: ReadonlyArray<HTMLElement | null>,
  gliding: boolean,
): void {
  for (const element of elements) {
    if (element === null) continue;
    element.dataset.glide = gliding ? "true" : "false";
  }
}

/** Lays the halo, and the dim's cutout, over the target's current rect. */
function paintSpotlight(
  target: HTMLElement,
  halo: HTMLElement | null,
  cutout: SVGRectElement | null,
  portal: HTMLElement,
): void {
  const rect = target.getBoundingClientRect();
  const left = rect.left - HALO_INSET;
  const top = rect.top - HALO_INSET;
  const width = rect.width + HALO_INSET * 2;
  const height = rect.height + HALO_INSET * 2;
  const radius =
    Number.parseFloat(getComputedStyle(target).borderTopLeftRadius) || 0;
  if (halo !== null) {
    // `position: fixed` resolves against a transformed portal container, not
    // the viewport - the same correction Floating UI makes for the card.
    const origin =
      portal === document.body
        ? { left: 0, top: 0 }
        : portal.getBoundingClientRect();
    halo.style.left = `${left - origin.left}px`;
    halo.style.top = `${top - origin.top}px`;
    halo.style.width = `${width}px`;
    halo.style.height = `${height}px`;
    halo.style.borderRadius = `${radius + HALO_INSET}px`;
  }
  // The dim only ever renders outside a picker, so it is portalled to the body
  // and its cutout is in viewport coordinates. Written as CSS geometry
  // properties rather than attributes so the hole can transition with the card.
  if (cutout === null) return;
  cutout.style.setProperty("x", `${left}px`);
  cutout.style.setProperty("y", `${top}px`);
  cutout.style.setProperty("width", `${width}px`);
  cutout.style.setProperty("height", `${height}px`);
  cutout.style.setProperty("rx", `${radius + HALO_INSET}px`);
}
