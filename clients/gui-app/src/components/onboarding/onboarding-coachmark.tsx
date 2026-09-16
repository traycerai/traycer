import {
  createContext,
  useContext,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useMemo,
  useState,
  type RefObject,
} from "react";
import {
  Joyride,
  ACTIONS,
  type TooltipRenderProps,
  type ArrowRenderProps,
} from "react-joyride";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useSafeAreaCollisionPadding } from "@/components/ui/safe-area-collision-padding";
import { focusGuideTarget } from "./guide-target";
import "./first-task-guide.css";

interface CoachmarkProps {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly progress: string | null;
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
const CoachmarkContext = createContext<
  | (CoachmarkProps & {
      readonly target: HTMLElement;
      readonly keyboardNavigation: boolean;
      readonly setKeyboardNavigation: (value: boolean) => void;
    })
  | null
>(null);

export function OnboardingCoachmark(props: CoachmarkProps) {
  const { onClose, onTarget } = props;
  const [keyboardNavigation, setKeyboardNavigation] = useState(false);
  const target = useGuideTarget(props.rootRef, props.selector);
  const safeArea = useSafeAreaCollisionPadding();
  const collisionPadding = {
    top: Math.max(12, safeArea.top),
    right: Math.max(12, safeArea.right),
    bottom: Math.max(12, safeArea.bottom),
    left: Math.max(12, safeArea.left),
  };
  const steps = useMemo(
    () => [
      {
        id: props.id,
        // Joyride compares callbacks by source, so resolve the live node per read.
        target: () => {
          const root = props.rootRef.current;
          return root?.isConnected
            ? root.querySelector<HTMLElement>(props.selector)
            : null;
        },
        title: props.title,
        content: props.content,
        placement: "bottom-start" as const,
      },
    ],
    [props.id, props.title, props.content, props.rootRef, props.selector],
  );

  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (target === null || event.defaultPrevented || event.isComposing) return;
    const card =
      event.target instanceof Element
        ? event.target.closest(".first-task-coachmark")
        : null;
    if (event.key === "Escape") {
      event.preventDefault();
      if (card) focusGuideTarget(target);
      onClose();
      return;
    }
    if (
      !card ||
      [
        event.repeat,
        event.metaKey,
        event.ctrlKey,
        event.altKey,
        event.shiftKey,
      ].includes(true)
    )
      return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setKeyboardNavigation(true);
      props.back?.();
    } else if (
      event.key === "ArrowRight" ||
      (event.key === "Enter" && event.target === card)
    ) {
      event.preventDefault();
      setKeyboardNavigation(true);
      if (props.action !== null) props.action.onClick();
      else focusGuideTarget(target);
    }
  });
  useEffect(() => {
    if (target === null) return;
    const leaveCard = (event: FocusEvent): void => {
      if (
        event.target instanceof Element &&
        event.target.closest(".first-task-coachmark") &&
        event.relatedTarget instanceof Element &&
        !event.relatedTarget.closest(".first-task-coachmark")
      )
        setKeyboardNavigation(false);
    };
    // Capture before a picker can close and remount Joyride in the same event.
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    window.addEventListener("focusout", leaveCard);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
      window.removeEventListener("focusout", leaveCard);
    };
  }, [target]);

  const revealTarget = useEffectEvent((element: HTMLElement) =>
    onTarget?.(element, keyboardNavigation),
  );
  useEffect(() => {
    if (target !== null) revealTarget(target);
  }, [target, onTarget]);

  if (target === null) return null;
  const portalElement =
    target.closest<HTMLElement>('[data-slot="dialog-content"]') ?? undefined;
  return (
    <CoachmarkContext.Provider
      value={{ ...props, target, keyboardNavigation, setKeyboardNavigation }}
    >
      <Joyride
        portalElement={portalElement}
        arrowComponent={CoachmarkArrow}
        key={props.id}
        run
        steps={steps}
        tooltipComponent={CoachmarkTooltip}
        styles={{
          floater: { transition: "none", filter: "none" },
          arrow: { pointerEvents: "none" },
        }}
        floatingOptions={{
          strategy: "fixed",
          hideArrow: false,
          flipOptions: { padding: collisionPadding, boundary: portalElement },
          shiftOptions: { padding: collisionPadding, boundary: portalElement },
        }}
        options={{
          hideOverlay: true,
          disableFocusTrap: true,
          blockTargetInteraction: false,
          skipBeacon: true,
          skipScroll: true,
          dismissKeyAction: false,
          closeButtonAction: "skip",
          buttons: ["close"],
          offset: 8,
          arrowColor: "var(--popover)",
          arrowBase: 16,
          arrowSize: 8,
          zIndex: target.closest('[data-slot="popover-content"]') ? 60 : 40,
        }}
        onEvent={({ action }) => {
          if (action === ACTIONS.CLOSE || action === ACTIONS.SKIP) onClose();
        }}
      />
    </CoachmarkContext.Provider>
  );
}

function CoachmarkTooltip({ step, tooltipProps }: TooltipRenderProps) {
  const headingId = useId();
  const descriptionId = useId();
  const tooltipRef = useRef<HTMLDivElement>(null);
  const context = useContext(CoachmarkContext);
  const keyboardNavigation = context?.keyboardNavigation ?? false;
  useLayoutEffect(() => {
    const tooltip = tooltipRef.current;
    const focused = document.activeElement;
    if (
      (keyboardNavigation && tooltip?.contains(focused)) ||
      focused === document.body ||
      focused === tooltip?.closest('[data-slot="dialog-content"]')
    )
      tooltip?.focus({ preventScroll: true });
  }, [keyboardNavigation]);
  if (context === null) return null;
  const next = (): void => {
    if (context.action !== null) context.action.onClick();
    else focusGuideTarget(context.target);
  };
  return (
    <div
      {...tooltipProps}
      ref={tooltipRef}
      tabIndex={-1}
      role="dialog"
      aria-modal={false}
      aria-labelledby={headingId}
      aria-describedby={descriptionId}
      aria-keyshortcuts="ArrowLeft ArrowRight Enter Escape"
      data-keyboard-navigation={keyboardNavigation || undefined}
      className="first-task-coachmark w-[min(20rem,calc(100vw-2rem))] max-w-safe-dvw rounded-xl bg-popover p-4 text-popover-foreground shadow-lg ring-1 ring-foreground/10 outline-none"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 id={headingId} className="text-balance text-ui-sm font-medium">
          {step.title}
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Dismiss getting started guide"
          className="-mr-1.5 -mt-1.5 shrink-0 text-muted-foreground"
          onClick={() => {
            focusGuideTarget(context.target);
            context.onClose();
          }}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <p
        id={descriptionId}
        className="mt-1.5 text-pretty text-ui-sm leading-relaxed text-muted-foreground"
        aria-live="polite"
      >
        {step.content}
      </p>
      <div
        className={cn(
          "mt-4 flex min-h-9 items-center gap-4",
          context.progress === null ? "justify-end" : "justify-between",
        )}
      >
        {context.progress === null ? null : (
          <span className="text-ui-xs tabular-nums text-muted-foreground">
            {context.progress}
          </span>
        )}
        <div className="flex items-center gap-1">
          {context.back !== null ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={(event) => {
                context.setKeyboardNavigation(event.detail === 0);
                context.back?.();
              }}
            >
              Back
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            className="min-h-9 rounded-lg bg-foreground px-3 text-background hover:bg-foreground/90"
            onClick={(event) => {
              context.setKeyboardNavigation(event.detail === 0);
              next();
            }}
          >
            {context.action?.label ?? "Try it"}
          </Button>
        </div>
      </div>
    </div>
  );
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
  useEffect(() => {
    const update = (): void => {
      const overlays = document.querySelectorAll(
        '[data-slot="dialog-content"][data-state="open"], [data-slot="popover-content"][data-state="open"], [data-slot="dropdown-menu-content"][data-state="open"], [data-slot="sheet-content"][data-state="open"]',
      );
      const candidate =
        rootRef.current?.querySelector<HTMLElement>(selector) ?? null;
      const visible =
        candidate !== null &&
        candidate.getClientRects().length > 0 &&
        candidate.closest('[inert], [aria-hidden="true"]') === null;
      const obscured = Array.from(overlays).some(
        (overlay) => !overlay.contains(candidate),
      );
      const target = !obscured && visible ? candidate : null;
      setResolved((previous) =>
        previous.selector === selector && previous.target === target
          ? previous
          : { selector, target },
      );
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-state", "aria-hidden", "inert", "hidden"],
    });
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [rootRef, selector]);
  return resolved.selector === selector ? resolved.target : null;
}

function CoachmarkArrow({ placement, base, size }: ArrowRenderProps) {
  const side = placement.split("-")[0];
  const vertical = side === "top" || side === "bottom";
  let path: string;
  switch (side) {
    case "bottom":
      path = `M 0 ${size + 1} L ${base / 2} 0 L ${base} ${size + 1}`;
      break;
    case "top":
      path = `M 0 -1 L ${base / 2} ${size} L ${base} -1`;
      break;
    case "left":
      path = `M -1 0 L ${size} ${base / 2} L -1 ${base}`;
      break;
    case "right":
      path = `M ${size + 1} 0 L 0 ${base / 2} L ${size + 1} ${base}`;
      break;
    default:
      return null;
  }
  return (
    <svg
      aria-hidden="true"
      width={vertical ? base : size}
      height={vertical ? size : base}
      overflow="visible"
    >
      <path d={`${path} Z`} fill="var(--popover)" />
      <path
        d={path}
        fill="none"
        stroke="color-mix(in srgb, var(--foreground) 10%, transparent)"
        strokeLinejoin="round"
      />
    </svg>
  );
}
