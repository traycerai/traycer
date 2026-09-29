import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { useRender } from "@base-ui/react/use-render";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  focusAtPath,
  focusPathWithin,
} from "@/components/epic-canvas/sidebar/row-focus-path";

/**
 * Mounts an overlay's root around its trigger on first use, and leaves the
 * opening to the overlay.
 *
 * The root mounts closed, in a task after the pointer first enters: an opening
 * gesture must finish against the node it started on, and mounting inside the
 * pointerenter would replace that node before the ensuing contextmenu or drag
 * sensor sees it. Then a pointer still over the trigger is replayed to the new
 * node as a pointermove and a mousemove, and focus inside it is carried over,
 * so the overlay opens through its own trigger: the provider's delay, its skip-delay
 * window, and the event that closes any other open tooltip all apply as they
 * do to an eager tooltip. Mounting with `defaultOpen` would skip all three.
 */
function LazySidebarHover(props: {
  readonly trigger: ReactElement;
  readonly renderOverlay: (trigger: ReactElement) => ReactNode;
}) {
  const [mounted, setMounted] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const focusPathRef = useRef<readonly number[] | null>(null);
  const pointerFocusedRef = useRef(false);
  // A tooltip trigger does not reopen after a press until the pointer leaves,
  // so a press before the root exists spends this hover too.
  const hoverRef = useRef<"outside" | "hovering" | "pressed">("outside");

  const cancelPendingHover = (): void => {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  };
  useEffect(() => cancelPendingHover, []);
  // Before paint, so the new node is focused in the frame that shows it.
  useLayoutEffect(() => {
    if (!mounted) return;
    const path = focusPathRef.current;
    focusPathRef.current = null;
    if (path !== null) focusAtPath(triggerRef.current, path);
  }, [mounted]);
  // The hover replay waits a task: the tooltip's hover listeners attach in an
  // effect after its trigger registers, so a replay in the mounting commit
  // lands before anything listens.
  useEffect(() => {
    if (!mounted) return undefined;
    const timer = window.setTimeout(() => {
      if (hoverRef.current !== "hovering") return;
      const node = triggerRef.current;
      // Base's hover opening needs the pointer to ENTER the new node first,
      // then reads its movement.
      node?.dispatchEvent(
        new window.PointerEvent("pointerenter", {
          cancelable: true,
          pointerType: "mouse",
          isPrimary: true,
        }),
      );
      node?.dispatchEvent(new window.MouseEvent("mouseenter"));
      node?.dispatchEvent(
        new window.PointerEvent("pointermove", {
          bubbles: true,
          cancelable: true,
          pointerType: "mouse",
          isPrimary: true,
        }),
      );
      node?.dispatchEvent(
        new window.MouseEvent("mousemove", { bubbles: true, cancelable: true }),
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, [mounted]);
  // Mounting replaces the trigger's DOM, so focus anywhere inside it - a
  // keyboard user's, or the one that caused this mount - is carried over.
  const mount = (): void => {
    focusPathRef.current = focusPathWithin(triggerRef.current);
    setMounted(true);
  };

  const beginHover = (event: PointerEvent<HTMLElement>): void => {
    if (event.pointerType === "touch" || event.buttons !== 0) return;
    if (hoverRef.current === "outside") hoverRef.current = "hovering";
    if (
      mounted ||
      timerRef.current !== null ||
      hoverRef.current === "pressed"
    ) {
      return;
    }
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      mount();
    }, 0);
  };
  const trigger = useRender({
    render: props.trigger,
    ref: triggerRef,
    props: {
      onPointerEnter: beginHover,
      onPointerMove: beginHover,
      onPointerLeave: () => {
        cancelPendingHover();
        hoverRef.current = "outside";
        pointerFocusedRef.current = false;
      },
      onPointerDown: () => {
        cancelPendingHover();
        hoverRef.current = "pressed";
        pointerFocusedRef.current = true;
      },
      onFocus: () => {
        // A pointer press focuses a button before its contextmenu/click event.
        // Mounting here would replace that event's target mid-gesture.
        if (mounted || pointerFocusedRef.current) return;
        cancelPendingHover();
        mount();
      },
      onBlur: () => {
        pointerFocusedRef.current = false;
      },
    },
  });
  return mounted ? props.renderOverlay(trigger) : trigger;
}

type TooltipProps = Omit<ComponentProps<typeof TooltipWrapper>, "children"> & {
  readonly children: ReactElement;
};

export function LazySidebarTooltipWrapper(props: TooltipProps) {
  const { children, ...tooltipProps } = props;
  return (
    <LazySidebarHover
      trigger={children}
      renderOverlay={(trigger) => (
        <TooltipWrapper {...tooltipProps}>{trigger}</TooltipWrapper>
      )}
    />
  );
}
