import { ChevronRight } from "lucide-react";
import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { BrowserDeviceGroupModel } from "./use-browser-list-model";

export function BrowserDeviceGroup(props: {
  readonly group: BrowserDeviceGroupModel;
  readonly onExpandedChange: (hostId: string, expanded: boolean) => void;
  readonly mobile: boolean;
  readonly children: ReactNode;
}) {
  const { group } = props;
  const contentId = useId();
  return (
    <section
      className="min-w-0"
      aria-label={`Browsers on ${group.name}`}
      data-testid={`browser-device-group-${group.hostId}`}
    >
      <button
        type="button"
        aria-expanded={group.expanded}
        aria-controls={contentId}
        className={cn(
          "flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-left text-ui-xs text-muted-foreground outline-none hover:bg-accent/70 focus-visible:ring-2 focus-visible:ring-ring",
          props.mobile ? "min-h-11" : "h-7",
        )}
        onClick={() => props.onExpandedChange(group.hostId, !group.expanded)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          props.onExpandedChange(group.hostId, event.key === "ArrowRight");
        }}
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 transition-transform motion-reduce:transition-none",
            group.expanded && "rotate-90",
          )}
        />
        <span className="min-w-0 flex-1 truncate font-medium">
          {group.name}
        </span>
        {group.isLocal ? (
          <span className="shrink-0 text-ui-xs">Local</span>
        ) : null}
        {group.offline ? (
          <span className="shrink-0 text-ui-xs">Offline</span>
        ) : null}
        <span
          className="shrink-0 tabular-nums"
          aria-label={`${group.rows.length} ${group.rows.length === 1 ? "tab" : "tabs"}`}
        >
          {group.rows.length}
        </span>
      </button>
      <div id={contentId} hidden={!group.expanded}>
        {props.children}
      </div>
    </section>
  );
}
