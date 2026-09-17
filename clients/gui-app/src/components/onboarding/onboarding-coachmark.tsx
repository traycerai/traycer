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
import { useSafeAreaCollisionPadding } from "@/components/ui/safe-area-collision-padding";
import { focusGuideTarget, interactWithGuideTarget } from "./guide-target";
// The card wears the acts' own button. `.onboarding-button` is global, but it
// ships in the onboarding page's chunk - which never loads when the app starts
// straight into the first-task guide, so the import has to be here too.
import "./onboarding.css";
import "./first-task-guide.css";

interface CoachmarkProgress {
  readonly step: number;
  readonly total: number;
}

interface CoachmarkProps {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly progress: CoachmarkProgress | null;
  readonly rootRef: RefObject<HTMLElement | null>;
  readonly selector: string;
  readonly onClose: () => void;
  readonly onTarget: ((target: HTMLElement, keyboard: boolean) => void) | null;
  readonly back: (() => void) | null;
  readonly action: {
    readonly label: string;
    readonly onClick: () => void;
  } | null;
}

/** The surfaces that own attention while they are open. */
const OVERLAY_SLOTS = [
  "dialog-content",
  "popover-content",
  "dropdown-menu-content",
  "sheet-content",
] as const;
const OVERLAY_SELECTOR = OVERLAY_SLOTS.map(
  (slot) => `[data-slot="${slot}"]`,
).join(", ");
const OPEN_OVERLAY_SELECTOR = OVERLAY_SLOTS.map(
  (slot) => `[data-slot="${slot}"][data-state="open"]`,
).join(", ");
const CLOSING_OVERLAY_SELECTOR = OVERLAY_SLOTS.map(
  (slot) => `[data-slot="${slot}"][data-state="closed"]`,
).join(", ");

/**
 * The surfaces that answer Escape for themselves. Wider than the overlay slots
 * above, which are about who owns the SCREEN: the composer's mention/slash
 * picker sits over the composer without obscuring it, mounts only while it is
 * open, and closes on the very Escape this card used to swallow - which
 * finished the guide for the session. The rest is the shape every Radix
 * dismissable layer shares (`select`, `context-menu`, `drawer`, and the four
 * slots above), so a new one is covered the day it ships.
 */
const ESCAPE_OWNER_SELECTOR = [
  OPEN_OVERLAY_SELECTOR,
  '[data-slot="composer-menu"]',
  '[data-state="open"]:is([role="menu"], [role="listbox"], [role="dialog"])',
].join(", ");

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

/**
 * Escape belongs to the surface the user is in. The guide takes it only when
 * it was aimed at the card or at the step's own target, and only when no other
 * dismissable surface is open to answer it - a surface the card or the target
 * LIVES in is not another one, so a step inside a settings dialog still
 * dismisses on Escape.
 */
function guideOwnsEscape(
  event: KeyboardEvent,
  target: HTMLElement,
  card: Element | null,
  cardElement: HTMLElement | null,
): boolean {
  const aimedAtTarget =
    event.target instanceof Node && target.contains(event.target);
  if (card === null && !aimedAtTarget) return false;
  return !escapeOwnedElsewhere(target, cardElement);
}

/** An open dismissable surface that holds neither the target nor the card. */
function escapeOwnedElsewhere(
  target: HTMLElement,
  card: HTMLElement | null,
): boolean {
  return Array.from(document.querySelectorAll(ESCAPE_OWNER_SELECTOR)).some(
    (surface) =>
      !surface.contains(target) && (card === null || !surface.contains(card)),
  );
}

/** The card's exit, the text crossfade's first half, and the anchor glide. */
const EXIT_MS = 160;
const TEXT_OUT_MS = 120;
const GLIDE_MS = 320;
/** How long a just-closed picker is given to finish collapsing. */
const PICKER_SETTLE_MS = 120;
/** The spotlight's bleed around the target, in px on every side. */
const HALO_INSET = 4;

export function OnboardingCoachmark(props: CoachmarkProps) {
  const { onClose, onTarget } = props;
  const [keyboardNavigation, setKeyboardNavigation] = useState(false);
  const target = useGuideTarget(props.rootRef, props.selector);
  const held = useHeldTarget(target);
  const copy = useCrossfadedCopy(props);
  const safeArea = useSafeAreaCollisionPadding();
  const cardRef = useRef<HTMLDivElement>(null);
  const floaterRef = useRef<HTMLDivElement>(null);
  const haloRef = useRef<HTMLDivElement>(null);
  const dimRef = useRef<HTMLDivElement>(null);
  const cutoutRef = useRef<SVGRectElement>(null);
  const maskId = `first-task-coachmark-dim-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const headingId = `${maskId}-title`;
  const descriptionId = `${maskId}-body`;
  const portal =
    held?.closest<HTMLElement>('[data-slot="dialog-content"]') ?? document.body;

  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (target === null || event.defaultPrevented || event.isComposing) return;
    const card = cardOf(event.target);
    if (event.key === "Escape") {
      if (!guideOwnsEscape(event, target, card, cardRef.current)) return;
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
      focused === card.closest('[data-slot="dialog-content"]')
    )
      card.focus({ preventScroll: true });
  }, [keyboardNavigation, props.id]);

  useLayoutEffect(() => {
    const floater = floaterRef.current;
    const halo = haloRef.current;
    if (target === null || floater === null) return;
    const padding = {
      top: Math.max(12, safeArea.top),
      right: Math.max(12, safeArea.right),
      bottom: Math.max(12, safeArea.bottom),
      left: Math.max(12, safeArea.left),
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

    const reposition = (): void => {
      void computePosition(target, floater, {
        strategy: "fixed",
        placement: "bottom-start",
        // No arrow: the halo on the target is the connection, and 10px is
        // close enough to read as one gesture with it.
        middleware: [
          offset(10),
          flip({ padding, boundary }),
          shift({ padding, boundary }),
        ],
      }).then(({ x, y }) => {
        if (!floater.isConnected) return;
        floater.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
        paintSpotlight(target, halo, cutoutRef.current, portal);
      });
    };
    reposition();
    const stop = autoUpdate(target, floater, reposition);
    return () => {
      stop();
      if (settle !== null) window.clearTimeout(settle);
    };
  }, [target, portal, safeArea]);

  if (held === null) return null;
  const exiting = target === null;
  // A picker already owns attention: dimming the app behind it would darken
  // the very surface the step is about.
  const dimmed = held.closest(OVERLAY_SELECTOR) === null;
  // A step inside a popover has to clear that popover's own layer.
  const overPopover = held.closest('[data-slot="popover-content"]') !== null;
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
          data-over-popover={overPopover}
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
        data-over-popover={overPopover}
      >
        <span key={props.id} className="first-task-coachmark-pulse" />
      </div>
      <div
        ref={floaterRef}
        data-state={state}
        className="first-task-coachmark-floater"
        data-over-popover={overPopover}
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
            aria-keyshortcuts="ArrowLeft ArrowRight Enter Escape"
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
                    never fire here. */}
                <ShortcutHint>
                  <Kbd aria-hidden="true" variant="inherit">
                    ↵
                  </Kbd>
                </ShortcutHint>
              </button>
            </div>
          </div>
        </div>
      </div>
    </>,
    portal,
  );
}

/** The card's step-progress row: filled bars for completed and current steps. */
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
