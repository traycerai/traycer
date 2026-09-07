import type { ReactNode } from "react";
import { HostGlyph } from "@/components/settings/host-scope/host-glyph";
import {
  hostOptionKindLabel,
  hostOptionStatusWord,
  hostOptionUpdateBadge,
  type HostPickIntent,
  type HostRowSurfaceState,
} from "@/components/settings/host-scope/host-option-model";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import type { FleetUpdateView } from "@/lib/host/fleet-update/fleet-update-view";
import { cn } from "@/lib/utils";

/** What must not differ is this: three pickers each inventing their own icon set and their own word for
 * "offline" is exactly what this replaced. */
export function HostOptionRow(props: {
  readonly host: HostScopeOption;
  readonly picked: boolean;
  readonly active: boolean;
  readonly intent: HostPickIntent;
  /** A union so "inert" and "refused with a word" cannot both be true of one row. */
  readonly surfaceState: HostRowSurfaceState;
  /** A `showUpdateBadge: boolean` would have been the obvious shape and the wrong one: it can be flipped true
   * without wiring a source, and the natural source to reach for would be a per-row query. */
  readonly updateView: FleetUpdateView | null;
}): ReactNode {
  const { host } = props;
  // When another host can serve the window that setup is not a window-wide event - the global modal deliberately
  // stays away, and this row plus Settings' progress banner are where it shows instead.
  const statusWord = hostOptionStatusWord(host, props.surfaceState);
  // It must never be substituted with a fabricated view: doing so badges every row of the three pickers that
  // deliberately pass `null`, which is the exact leak the opt-in exists to prevent.
  const updateBadge =
    props.updateView === null || props.surfaceState.kind === "inert"
      ? null
      : hostOptionUpdateBadge(props.updateView);
  // Under `bind` they are the same fact by definition, so the tag would restate the check it sits next to.
  const showActiveTag = props.intent === "view" && props.active;
  return (
    <>
      <HostGlyph
        host={host}
        className="size-4 shrink-0 text-muted-foreground"
      />
      <span className="sr-only">{hostOptionKindLabel(host)}</span>
      <span className="min-w-0 flex-1 truncate text-start">{host.name}</span>
      {props.picked && props.intent === "view" ? (
        <span className="sr-only">Currently viewing</span>
      ) : null}
      {showActiveTag ? <ActiveTag /> : null}
      {updateBadge === null ? null : (
        <span
          className="shrink-0 text-ui-xs text-muted-foreground"
          data-testid={`host-option-update-badge-${host.hostId}`}
        >
          {updateBadge}
        </span>
      )}
      {statusWord === null ? null : (
        <span className="shrink-0 text-ui-xs text-muted-foreground">
          {statusWord}
        </span>
      )}
    </>
  );
}

/** It never marks the viewing selection, so the two can always be told apart at a glance even when they happen
 * to be the same host. */
function ActiveTag(): ReactNode {
  return (
    <span
      className={cn(
        "shrink-0 rounded-sm bg-primary/15 px-1 py-px",
        "text-[0.625rem] font-medium uppercase tracking-wide text-primary",
      )}
    >
      Active
    </span>
  );
}
