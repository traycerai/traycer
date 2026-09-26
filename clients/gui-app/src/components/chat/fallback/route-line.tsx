import type { ReactNode } from "react";
import { ArrowRight, ChevronDown } from "lucide-react";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { RouteChip } from "@/components/ui/route-chip";
import { cn } from "@/lib/utils";
import {
  routeSegmentEmphasis,
  routeTupleSegments,
  type RouteTuple,
} from "./route-tuple";

/**
 * A tuple's glyph and segments, emphasised against its peer. The content of
 * both chip kinds - the static {@link RouteTupleChip} and the picker trigger a
 * card hands the destination picker. The words and their weights come from
 * `route-tuple.ts`.
 */
export function RouteTupleContent({
  tuple,
  peer,
  end,
}: {
  readonly tuple: RouteTuple;
  /** The other end of the route, or `null` for a lone tuple. */
  readonly peer: RouteTuple | null;
  readonly end: "from" | "to" | "single";
}) {
  const segments = routeTupleSegments(tuple, peer).map((segment) => ({
    ...segment,
    emphasis: routeSegmentEmphasis(segment, peer, end),
  }));
  return (
    <>
      <HarnessIcon harnessId={tuple.harnessId} className="size-3.5" />
      {segments.map((segment, index) => (
        <span key={segment.kind} className="inline-flex items-center gap-1.5">
          {index === 0 ? null : (
            <span aria-hidden className="text-muted-foreground/70">
              ·
            </span>
          )}
          <span
            data-emphasis={segment.emphasis}
            className={cn(
              segment.emphasis === "muted" && "text-muted-foreground",
              segment.emphasis === "strong" && "font-semibold",
            )}
          >
            {segment.text}
          </span>
        </span>
      ))}
    </>
  );
}

/** A trigger chip's content: the tuple, then the chevron that says it opens. */
export function RouteTupleTriggerContent({
  tuple,
  peer,
}: {
  readonly tuple: RouteTuple;
  readonly peer: RouteTuple | null;
}) {
  return (
    <>
      <RouteTupleContent tuple={tuple} peer={peer} end="to" />
      <ChevronDown
        data-icon="inline-end"
        aria-hidden
        className="text-muted-foreground"
      />
    </>
  );
}

/** A label chip's content - "Choose another model…" and its chevron. */
export function RouteLabelTriggerContent({
  label,
}: {
  readonly label: string;
}) {
  return (
    <>
      <span>{label}</span>
      <ChevronDown
        data-icon="inline-end"
        aria-hidden
        className="text-muted-foreground"
      />
    </>
  );
}

/** A tuple that is not a control: the "from" end, a wait's lone tuple. */
export function RouteTupleChip({
  tuple,
  peer,
  end,
  trailing,
}: {
  readonly tuple: RouteTuple;
  readonly peer: RouteTuple | null;
  readonly end: "from" | "to" | "single";
  /** A trailing badge inside the chip (the wait's clock), or `null`. */
  readonly trailing: ReactNode | null;
}) {
  return (
    <RouteChip data-testid={`route-chip-${end}`}>
      <RouteTupleContent tuple={tuple} peer={peer} end={end} />
      {trailing}
    </RouteChip>
  );
}

/**
 * The arrow between two ends. `aria-hidden` for the glyph, with the word said
 * for a screen reader, so the line reads "Fable · Personal 3 to Fable · Surya"
 * rather than two names run together.
 */
export function RouteArrow() {
  return (
    <>
      <ArrowRight
        aria-hidden
        className="size-3.5 shrink-0 text-muted-foreground"
      />
      <span className="sr-only">to</span>
    </>
  );
}

/** The line itself: its ends wrap, never truncate. */
export function RouteLine({ children }: { readonly children: ReactNode }) {
  return (
    <div
      data-testid="route-line"
      className="flex min-w-0 flex-wrap items-center gap-2"
    >
      {children}
    </div>
  );
}
