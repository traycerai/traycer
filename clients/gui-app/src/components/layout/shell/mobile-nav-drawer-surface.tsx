import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  animate,
  m,
  useDragControls,
  useMotionValue,
  useReducedMotion,
  useTransform,
  type AnimationPlaybackControls,
  type PanInfo,
} from "motion/react";
import {
  NAV_DRAWER_SETTLE,
  NAV_DRAWER_TAP_SLOP_PX,
  NAV_DRAWER_SETTLE_REDUCED,
  resolvesToOpen,
} from "@/components/layout/shell/nav-drawer-motion";
import { useNavDrawerClosePull } from "@/components/layout/shell/use-nav-drawer-close-pull";
import { useModalSurfaceContainment } from "@/components/layout/shell/use-modal-surface-containment";
import { cn } from "@/lib/utils";

interface MobileNavDrawerSurfaceProps {
  readonly open: boolean;
  readonly onOpenChange: (next: boolean) => void;
  readonly children: ReactNode;
}

/**
 * The mobile navigation drawer's frame: one motion-owned panel that the finger
 * drags in both directions, plus the modal semantics that attach to it once it
 * has settled open.
 *
 * VISUAL AND SEMANTIC STATE ARE DECOUPLED, and that split is the whole design.
 * The visual state is a continuous `x` the drag engine owns - it tracks the
 * finger 1:1, springs, and can be interrupted mid-flight. The semantic state is
 * the discrete `open` boolean, and it flips only at a settled endpoint. A
 * panel that is 30% out may still spring back, so trapping focus into it would
 * trap focus into something about to disappear; and an assistive-technology
 * user has no "mid-drag" state at all, so what they are told must key off a
 * binary settle rather than off a transform.
 *
 * The panel is mounted for the app's whole life, parked off screen by the
 * wrapper's transform. It has to be: the drag engine's imperative start
 * forwards to components that have already subscribed, so against an unmounted
 * panel it is a silent no-op, and mounting on gesture start cannot work either
 * because the pointer event that would have begun the drag is gone by the time
 * the new subtree has rendered.
 *
 * Both directions are one drag on one element. Opening is the header's
 * hamburger, which asks for a settle rather than a drag; closing is a pointer
 * landing on the panel or on the scrim, either of which is handed to the same
 * drag controls the panel exposes. One engine, one spring, one release rule -
 * so the drawer arrives and leaves with the weight of a single physical
 * object.
 */
export function MobileNavDrawerSurface(
  props: MobileNavDrawerSurfaceProps,
): ReactNode {
  const { open, onOpenChange, children } = props;
  const dragControls = useDragControls();
  // 0 is fully closed, `width` fully open. The wrapper carries the -100% that
  // parks the panel off screen, so this value never has to be seeded from a
  // measurement to render correctly on the very first frame.
  const x = useMotionValue(0);
  const layerRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const settleRef = useRef<AnimationPlaybackControls | null>(null);
  // The endpoint the running settle is travelling to, or null when none is.
  // Kept so a resize mid-flight can re-aim it at the width that now exists.
  const settleTargetRef = useRef<boolean | null>(null);
  // A pointer owns the panel from the instant a gesture claims it, which is
  // EARLIER than motion reports a drag: the engine only calls back once the
  // pointer has travelled past its own threshold. Anything that re-parks the
  // panel has to stand down for that whole window, including the gap - a blur
  // that drops the keyboard resizes the web view right there, and a re-park
  // landing in the gap would snatch the panel out from under the finger.
  const gestureRef = useRef(false);
  const motionDraggingRef = useRef(false);
  const releaseTeardownRef = useRef<(() => void) | null>(null);
  const openAtGestureStartRef = useRef(false);
  const widthRef = useRef(0);
  const [width, setWidth] = useState(0);
  // True from the moment a gesture or a programmatic settle takes the panel off
  // a resting position until it reaches the next one.
  const [inFlight, setInFlight] = useState(false);
  const reducedMotion = useReducedMotion();

  // `open` is the REQUEST - what a tap on the hamburger, a menu row or Escape
  // asked for. `settledOpen` is what is actually true of the surface right now.
  // They agree at rest and differ for the length of a settle, and every
  // semantic consequence keys off the second one: a panel still sliding into
  // place has trapped nothing yet, and one still sliding out is still covering
  // the app. Collapsing the two would announce a dialog to assistive
  // technology while it is off screen, and hand the app back while a drawer is
  // still on top of it.
  const [settledOpen, setSettledOpen] = useState(open);
  const settledOpenRef = useRef(settledOpen);
  const openRef = useRef(open);
  const onOpenChangeRef = useRef(onOpenChange);
  const reducedMotionRef = useRef(reducedMotion);
  useEffect(() => {
    openRef.current = open;
    onOpenChangeRef.current = onOpenChange;
    reducedMotionRef.current = reducedMotion;
  });

  // Written through eagerly rather than left to the next render pass, so a
  // resize arriving before that commit still parks the panel on the right side.
  const commitSettled = useCallback((next: boolean): void => {
    settledOpenRef.current = next;
    setSettledOpen(next);
  }, []);

  /**
   * Total, by design: every path out of a gesture or a request goes through
   * here, including the ones with nowhere to travel. Leaving those to skip the
   * call would strand `inFlight` true, and the scrim is only inert to pointers
   * while it is BOTH closed and at rest - a stuck flag would leave a
   * transparent sheet swallowing the whole screen behind a shut drawer.
   */
  const settle = useCallback(
    (toOpen: boolean): void => {
      settleRef.current?.stop();
      const target = toOpen ? widthRef.current : 0;
      if (x.get() === target) {
        settleRef.current = null;
        settleTargetRef.current = null;
        setInFlight(false);
        commitSettled(toOpen);
        if (openRef.current !== toOpen) onOpenChangeRef.current(toOpen);
        return;
      }
      settleTargetRef.current = toOpen;
      setInFlight(true);
      settleRef.current = animate(x, target, {
        ...(reducedMotionRef.current === true
          ? NAV_DRAWER_SETTLE_REDUCED
          : NAV_DRAWER_SETTLE),
        // Only a settle that ARRIVES flips the semantics. An interrupted one
        // was overtaken - by a new gesture, a new request, or a resize - and
        // whatever overtook it owns the decision now.
        onComplete: () => {
          settleRef.current = null;
          settleTargetRef.current = null;
          setInFlight(false);
          commitSettled(toOpen);
          // A gesture can settle somewhere the request never asked for, so the
          // store is reconciled to what actually happened rather than the
          // other way round.
          if (openRef.current !== toOpen) onOpenChangeRef.current(toOpen);
        },
      });
    },
    [commitSettled, x],
  );

  // Measured, never assumed: the panel is fluid-width, and the same build runs
  // on a phone and on a tablet. A rotation can resize it under a resting panel
  // OR under one mid-settle, and both have to end up at the width that now
  // exists - a settle still aimed at the old one would strand the panel short
  // of its endpoint with nothing left to move it.
  useLayoutEffect(() => {
    const node = panelRef.current;
    if (node === null) return;
    const sync = (): void => {
      widthRef.current = node.offsetWidth;
      setWidth(node.offsetWidth);
      if (gestureRef.current) return;
      const inFlightTarget = settleTargetRef.current;
      if (inFlightTarget !== null) {
        settle(inFlightTarget);
        return;
      }
      x.jump(settledOpenRef.current ? node.offsetWidth : 0);
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [settle, x]);

  // The programmatic path in: the hamburger, a menu row that navigates away,
  // Escape. The request leads and the panel follows, but the SEMANTICS still
  // wait for the panel - so this only ever starts a settle, and that settle's
  // completion is what makes the request true.
  useEffect(() => {
    if (gestureRef.current) return;
    settle(open);
  }, [open, settle]);

  // Claims the panel for a pointer and clears whatever it interrupted. A
  // settle overtaken here decides nothing; the gesture that took it over does.
  const beginPointerGesture = useCallback((): void => {
    gestureRef.current = true;
    settleRef.current?.stop();
    settleRef.current = null;
    settleTargetRef.current = null;
    setInFlight(true);
  }, []);

  /**
   * A gesture can claim the panel and then end without the engine ever
   * reporting a drag, and there are two quite different ways that happens. One
   * is a tap: the pointer genuinely never travelled. The other is a flick fast
   * enough to begin and end inside a single frame - the engine batches moves to
   * the next frame and cancels the pending one the instant the pointer lifts,
   * so the whole gesture evaporates and looks identical to the tap from the
   * outside. Telling them apart cannot be delegated, so this keeps its own
   * coordinates.
   *
   * A cancelled pointer is never a tap either, whatever it travelled: the
   * system took the gesture away, which is not a decision the user made.
   */
  const armPointerRelease = useCallback(
    (
      pointer: {
        /**
         * Which pointer armed this. Every other one is somebody else's finger:
         * a second touch that lands and lifts while the arming one is still on
         * the glass says nothing about this gesture, and reading its release as
         * this gesture's release would retire the tracker with the hand that
         * started it still dragging.
         */
        readonly id: number;
        readonly x: number;
        readonly y: number;
      },
      outcome: {
        /** Released in place, under its own power. */
        readonly onTap: () => void;
        /** Travelled, or taken away. Either way the panel picks a side. */
        readonly onSettle: () => void;
      },
    ): void => {
      // One signal retires all three listeners, which keeps the teardown from
      // having to name the handler that calls it - there is no ordering to get
      // wrong and no listener that can be left behind.
      const controller = new AbortController();
      const listenerOptions = { signal: controller.signal };
      let travelled = false;
      const teardown = (): void => {
        controller.abort();
        releaseTeardownRef.current = null;
      };
      const track = (event: PointerEvent): void => {
        if (event.pointerId !== pointer.id) return;
        const dx = event.clientX - pointer.x;
        const dy = event.clientY - pointer.y;
        if (Math.hypot(dx, dy) > NAV_DRAWER_TAP_SLOP_PX) travelled = true;
      };
      const finish = (event: PointerEvent): void => {
        if (event.pointerId !== pointer.id) return;
        teardown();
        // The engine adopted the gesture, so its own release decides.
        if (motionDraggingRef.current) return;
        gestureRef.current = false;
        if (travelled || event.type === "pointercancel") {
          outcome.onSettle();
          return;
        }
        outcome.onTap();
      };
      releaseTeardownRef.current?.();
      window.addEventListener("pointermove", track, listenerOptions);
      window.addEventListener("pointerup", finish, listenerOptions);
      window.addEventListener("pointercancel", finish, listenerOptions);
      releaseTeardownRef.current = teardown;
    },
    [],
  );

  // A gesture interrupted by unmount never gets its release, so the listeners
  // it armed would outlive the surface holding a stale closure.
  useEffect(() => {
    return () => {
      releaseTeardownRef.current?.();
    };
  }, []);

  const handleDragStart = useCallback((): void => {
    gestureRef.current = true;
    motionDraggingRef.current = true;
    openAtGestureStartRef.current = settledOpenRef.current;
    settleRef.current?.stop();
    settleRef.current = null;
    settleTargetRef.current = null;
    setInFlight(true);
  }, []);

  const handleDragEnd = useCallback(
    (event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo): void => {
      motionDraggingRef.current = false;
      gestureRef.current = false;
      settle(
        resolvesToOpen({
          positionPx: x.get(),
          widthPx: widthRef.current,
          velocityPxPerS: info.velocity.x,
          openAtGestureStart: openAtGestureStartRef.current,
          // Once the engine has adopted a gesture it reports cancellation
          // through this same callback, as an ordinary release carrying a
          // cancel event - so the distinction survives only if it is read off
          // the event here.
          cancelled: event.type === "pointercancel",
        }),
      );
    },
    [settle, x],
  );

  useNavDrawerClosePull({
    onActivate: (event, travelPx) => {
      beginPointerGesture();
      // Meet the finger where the drag declared itself, so what follows is 1:1
      // against the ORIGINAL touch-down rather than against the point 15px
      // later where the classifier made up its mind. Measured from the live
      // position rather than from an endpoint, so a pull that interrupts a
      // settle picks the panel up where it actually is. The drag engine reads
      // that same live value as its origin, so seeding is the whole handoff.
      const seeded = x.get() - travelPx;
      x.jump(Math.min(Math.max(seeded, 0), widthRef.current));
      dragControls.start(event);
      // The classifier already required travel, so neither outcome here can be
      // a tap - both simply put the panel back on a side.
      armPointerRelease(
        { id: event.pointerId, x: event.clientX, y: event.clientY },
        {
          onTap: () => {
            settle(settledOpenRef.current);
          },
          onSettle: () => {
            settle(settledOpenRef.current);
          },
        },
      );
    },
    withinPanel: (target) =>
      target instanceof Node && (panelRef.current?.contains(target) ?? false),
  });

  const dismiss = useCallback((): void => {
    onOpenChangeRef.current(false);
  }, []);

  useModalSurfaceContainment({
    active: settledOpen,
    layerRef,
    focusRef: panelRef,
    onDismiss: dismiss,
  });

  // The scrim is the drag made legible: it is the panel's own position read as
  // opacity, so half a drawer is half a scrim and a spring-back takes the
  // darkening with it. A degenerate range before the first measurement would
  // make the transform undefined rather than merely wrong.
  const scrimOpacity = useTransform(x, [0, Math.max(width, 1)], [0, 1]);

  // Interactive whenever the panel is settled open; also whenever it is moving,
  // so a spring in flight can be caught and dragged the other way. Inert only
  // at rest and closed - which is where a keyboard user could otherwise tab
  // into an off-screen menu.
  const inert = !settledOpen && !inFlight;

  return createPortal(
    <div
      ref={layerRef}
      className="pointer-events-none fixed inset-0 z-50"
      data-testid="mobile-nav-drawer-layer"
    >
      {/* The scrim is part of the drawer, not a backdrop behind it. A hand
          that pulled the panel out expects to be able to push it back from
          anywhere it is covering, so a pointer landing here is handed to the
          panel's own drag rather than being treated as a click target - the
          same handoff the panel's close pull uses, except this one needs no
          classifier to arbitrate it, so there is nothing to seed and the
          tracking is 1:1 from the first pixel.

          Dismissal rides the release rather than a click. A tap and a drag
          enter through the same pointerdown, and only the release can tell them
          apart - by the distance that pointer actually covered, measured here,
          because the engine's silence does not distinguish a press that never
          moved from a flick that outran a frame. Leaving it on `onClick` would
          have fired a second dismissal after every drag that ended here. */}
      <m.div
        aria-hidden
        className={cn(
          "absolute inset-0 bg-black/40 supports-backdrop-filter:backdrop-blur-xs",
          // Interactive for as long as the scrim is showing anything, which
          // includes a settle still in flight - otherwise a drawer caught
          // mid-open could not be pushed back from the side it is uncovering.
          settledOpen || inFlight
            ? "pointer-events-auto"
            : "pointer-events-none",
        )}
        style={{ opacity: scrimOpacity }}
        data-testid="mobile-nav-drawer-scrim"
        onPointerDown={(event) => {
          if (!event.isPrimary) return;
          beginPointerGesture();
          dragControls.start(event);
          armPointerRelease(
            { id: event.pointerId, x: event.clientX, y: event.clientY },
            {
              onTap: dismiss,
              // A flick that the engine never adopted still travelled, and a
              // rightward one asked for the drawer to STAY - dismissing it
              // would be the opposite of what the hand did.
              onSettle: () => {
                settle(settledOpenRef.current);
              },
            },
          );
        }}
      />
      {/* The park. Keeping the closed rest position in CSS rather than in the
          motion value means the very first paint is already correct, with no
          frame at x=0 while a layout effect measures the panel.

          It also owns the top edge. A `fixed` layer resolves against the
          viewport rather than the app root's padding box, so nothing above has
          reserved the status-bar strip on its behalf - the panel starts below
          the bar because this says where it starts, and its own `h-full` then
          resolves against the shortened park. */}
      <div className="absolute top-safe-top bottom-0 left-safe-left w-3/4 -translate-x-full sm:max-w-sm">
        <m.div
          ref={panelRef}
          role="dialog"
          aria-modal={settledOpen}
          aria-label="Menu"
          aria-hidden={!settledOpen}
          inert={inert}
          tabIndex={-1}
          drag="x"
          dragControls={dragControls}
          // The engine's own pointer listener is off, so every pull enters
          // through the recognizer above and meets the same classifier. Left
          // on, it would start a drag after three pixels in ANY direction and
          // then apply the horizontal component of it - which on a scrolling
          // panel means a share of every vertical swipe drags the drawer
          // sideways. Its built-in axis lock is not the answer either: it locks
          // on whichever axis first passes ten pixels, checking Y first, so it
          // both keeps claiming near-vertical drags and starts refusing fast
          // diagonal ones the app means to accept.
          dragListener={false}
          dragConstraints={{ left: 0, right: width }}
          // Rubber-band only at the closed stop, where the give happens off
          // screen. Elasticity at the open stop would pull the panel past its
          // own edge and open a gap at the screen edge behind it.
          dragElastic={{ left: 0.2, right: 0, top: 0, bottom: 0 }}
          // The release rule decides, not inertia - momentum would carry the
          // panel past the endpoint the release just chose.
          dragMomentum={false}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          style={{ x }}
          // `touch-pan-y` and `select-none` are the engine's own doing when it
          // owns the listener; with that off they have to be stated. The first
          // hands vertical scrolling to the browser and keeps the horizontal
          // axis for the drawer; the second stops a long sideways pull over a
          // task title from turning into a text selection.
          className="pointer-events-auto flex h-full w-full touch-pan-y flex-col border-r bg-popover bg-clip-padding pb-safe-bottom text-popover-foreground shadow-lg outline-none select-none"
          data-testid="mobile-nav-drawer"
          data-mobile-shell-touch-scope=""
        >
          {children}
        </m.div>
      </div>
    </div>,
    document.body,
  );
}
