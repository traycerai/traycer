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
import { Slot } from "radix-ui";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  focusAtPath,
  focusPathWithin,
} from "@/components/epic-canvas/sidebar/row-focus-path";

/**
 * An opening pointer gesture must finish against the original row DOM node.
 * Mounting a Radix root during pointerenter replaces that node before the
 * ensuing contextmenu or drag sensor sees it. Wait out hover intent instead,
 * then mount the root already open for a stationary pointer.
 */
function LazySidebarHover(props: {
  readonly trigger: ReactElement;
  readonly delayMs: number;
  readonly renderOverlay: (trigger: ReactElement) => ReactNode;
}) {
  const [mounted, setMounted] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const focusPathRef = useRef<readonly number[] | null>(null);
  const pointerFocusedRef = useRef(false);

  const cancelPendingHover = (): void => {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  };
  useEffect(() => cancelPendingHover, []);
  useLayoutEffect(() => {
    if (!mounted || focusPathRef.current === null) return;
    const path = focusPathRef.current;
    focusPathRef.current = null;
    focusAtPath(triggerRef.current, path);
  }, [mounted]);
  // Mounting replaces the trigger's DOM, so focus anywhere inside it - a
  // keyboard user's, or the one that caused this mount - is carried over.
  const mount = (): void => {
    focusPathRef.current = focusPathWithin(triggerRef.current);
    setMounted(true);
  };

  const beginHover = (event: PointerEvent<HTMLElement>): void => {
    if (
      mounted ||
      timerRef.current !== null ||
      event.pointerType === "touch" ||
      event.buttons !== 0
    ) {
      return;
    }
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      mount();
    }, props.delayMs);
  };
  const trigger = (
    <Slot.Root
      ref={triggerRef}
      {...(!mounted ? { "data-state": "closed" } : {})}
      onPointerEnter={beginHover}
      onPointerMove={beginHover}
      onPointerLeave={() => {
        cancelPendingHover();
        pointerFocusedRef.current = false;
      }}
      onPointerDown={() => {
        cancelPendingHover();
        pointerFocusedRef.current = true;
      }}
      onFocus={() => {
        // A pointer press focuses a button before its contextmenu/click event.
        // Mounting here would replace that event's target mid-gesture.
        if (mounted || pointerFocusedRef.current) return;
        cancelPendingHover();
        mount();
      }}
      onBlur={() => {
        pointerFocusedRef.current = false;
      }}
    >
      {props.trigger}
    </Slot.Root>
  );
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
      delayMs={150}
      renderOverlay={(trigger) => (
        <TooltipWrapper {...tooltipProps} defaultOpen>
          {trigger}
        </TooltipWrapper>
      )}
    />
  );
}
