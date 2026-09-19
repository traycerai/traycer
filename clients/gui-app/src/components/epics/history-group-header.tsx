import { useLayoutEffect, type ReactNode, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useMeasuredElementHeight } from "@/hooks/ui/use-measured-element-height";
import { cn } from "@/lib/utils";

/** Both headers are siblings of their regions in the ONE scrolling flow. */
export function HistoryGroupHeader(props: {
  readonly kind: "tasks" | "messages";
  readonly id: string;
  readonly hostLabel: string | null;
  readonly targetRef: RefObject<HTMLElement | null>;
  readonly pinBottom: boolean;
  readonly actions: ReactNode;
}): ReactNode {
  const { targetRef } = props;
  const messages = props.kind === "messages";
  const Heading = messages ? "h3" : "h2";
  const { setElement, element, height } = useMeasuredElementHeight();
  const heightProperty = `--history-${props.kind}-header-height`;
  useLayoutEffect(() => {
    if (element === null || height === 0) return;
    // The header is a direct child of the scroller. Resize writes only CSS:
    // neither a measurement nor a message count re-renders the task list.
    const scroller = element.parentElement;
    scroller?.style.setProperty(heightProperty, `${height}px`);
    return () => {
      scroller?.style.removeProperty(heightProperty);
    };
  }, [element, height, heightProperty]);
  return (
    <div
      ref={setElement}
      className={cn(
        "sticky top-0 z-10 flex min-h-12 items-center gap-2 bg-[var(--history-surface,var(--canvas))] px-3.5 py-1.5",
        messages ? "z-20 border-t border-border" : "has-focus-visible:z-30",
        props.pinBottom && "bottom-0 mt-6",
      )}
    >
      <Heading id={props.id} className={cn("min-w-0", messages && "flex-1")}>
        <TooltipWrapper
          label={props.hostLabel}
          side="top"
          sideOffset={undefined}
          align="start"
        >
          <Button
            type="button"
            variant="section-label"
            size="section-label"
            onClick={() => {
              targetRef.current?.scrollIntoView({
                block: "start",
                behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
                  .matches
                  ? "instant"
                  : "smooth",
              });
            }}
          >
            <span className="shrink-0">
              {messages ? "Message matches" : "Tasks"}
            </span>
            {props.hostLabel === null ? null : (
              <>
                <span aria-hidden="true">·</span>{" "}
                <span className="min-w-0 truncate font-normal tracking-normal text-foreground normal-case">
                  {props.hostLabel}
                </span>
              </>
            )}
          </Button>
        </TooltipWrapper>
      </Heading>
      {props.actions}
    </div>
  );
}
