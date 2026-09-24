/**
 * Docs: see ../SETTINGS.md (Host ▸ Overview ▸ The live update pill).
 * Update that file whenever this settings surface changes.
 */
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useHostOverviewSelectTab } from "@/components/settings/panels/host-overview-tab-state";
import type {
  HostOverviewUpdatePill,
  HostOverviewUpdatePillTone,
} from "@/components/settings/panels/host-overview-update-pill-model";
import { cn } from "@/lib/utils";

const PILL_BADGE_VARIANT: Record<
  HostOverviewUpdatePillTone,
  "info" | "warning" | "destructive" | "success" | "muted"
> = {
  info: "info",
  warning: "warning",
  destructive: "destructive",
  success: "success",
  muted: "muted",
};

const STRIP_TONE: Record<HostOverviewUpdatePillTone, string> = {
  info: "border-info/30 bg-info/10 text-info-foreground",
  warning: "border-warning/30 bg-warning/10 text-warning-foreground",
  destructive: "border-destructive/30 bg-destructive/10 text-destructive",
  success: "border-success/30 bg-success/10 text-success-foreground",
  // `bg-foreground/5`, never `bg-muted`: the strip sits on the Overview card.
  muted: "border-border/60 bg-foreground/5 text-muted-foreground",
};

/**
 * The live update pill on the header's health line. Clicking it selects
 * Status, where the update card and its controls are. It performs no action
 * of its own.
 */
export function HostOverviewUpdatePillButton(props: {
  readonly pill: HostOverviewUpdatePill;
}): ReactNode {
  const selectTab = useHostOverviewSelectTab();
  return (
    <Badge
      asChild
      variant={PILL_BADGE_VARIANT[props.pill.tone]}
      className="rounded-full"
    >
      <button
        type="button"
        data-testid="host-overview-update-pill"
        data-tone={props.pill.tone}
        aria-label={`${props.pill.label}, show Status`}
        onClick={() => selectTab?.("status")}
      >
        {props.pill.label}
      </button>
    </Badge>
  );
}

/**
 * The same pill on a phone: a slim full-width strip directly above the
 * section dropdown, while a section other than Status is selected. Tapping it
 * selects Status. It sits in the page's flow, so it scrolls with the header.
 */
export function HostOverviewUpdateStrip(props: {
  readonly pill: HostOverviewUpdatePill;
}): ReactNode {
  const selectTab = useHostOverviewSelectTab();
  return (
    <button
      type="button"
      className={cn(
        "flex min-h-9 w-full min-w-0 items-center gap-2 rounded-md border px-3 py-1.5 text-left text-ui-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        STRIP_TONE[props.pill.tone],
      )}
      data-testid="host-overview-update-strip"
      data-tone={props.pill.tone}
      aria-label={`${props.pill.label}, show Status`}
      onClick={() => selectTab?.("status")}
    >
      <span className="min-w-0 flex-1 truncate">{props.pill.label}</span>
      <span className="flex shrink-0 items-center gap-0.5 text-ui-xs">
        Status
        <ChevronRight className="size-3.5" aria-hidden />
      </span>
    </button>
  );
}
