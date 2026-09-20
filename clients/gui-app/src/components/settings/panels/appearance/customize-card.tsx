import { useEffect, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { APPEARANCE } from "@/components/settings/panels/appearance-settings.definitions";
import { LayoutThumbnail } from "@/components/settings/panels/appearance/layout-thumbnail";
import { Button } from "@/components/ui/button";
import { useSettingsAvailabilityContext } from "@/hooks/settings/use-settings-availability-context";
import {
  customizeLayoutAction,
  openSampleWorkspaceAction,
} from "@/lib/commands/actions/customize-layout";
import { watchCustomizeLease } from "@/lib/customize/lease";
import { cn } from "@/lib/utils";
import { useSettingsDensity } from "@/providers/settings-density-context";
import { useCustomizeStore } from "@/stores/customize/customize-store";

/**
 * The lease only needs WATCHING here so `lockedBy` stays live while the card is
 * on screen; this window's own session (if any) has its own watcher in the
 * overlay, which is the one that exits it.
 */
const IGNORE_LEASE_LOSS = (): void => undefined;

/**
 * The front door to the editor: a picture of the layout as it is now, and the
 * two ways in - edit the real app in place, or practise on the sample
 * workspace.
 *
 * Drawn only where the editor exists (`isCustomizeAvailable`), as the Layout
 * page's replacement. The buttons are the command palette's own functions
 * (`customizeLayoutAction`, `openSampleWorkspaceAction`), so the card, the
 * palette and the context menus are three ways to press one button; the sample
 * button in particular never navigates or enters a session itself - the action
 * captures where Settings was and the sample tab starts its own session.
 */
export function CustomizeCard(): ReactNode {
  const availability = useSettingsAvailabilityContext();
  if (!APPEARANCE.definitions.customizeCard.availableWhen(availability)) {
    return null;
  }
  return <AvailableCustomizeCard />;
}

function AvailableCustomizeCard(): ReactNode {
  const row = APPEARANCE.definitions.customizeCard;
  const compact = useSettingsDensity() === "compact";
  const navigate = useNavigate();
  const lockedElsewhere = useCustomizeStore(
    (state) => state.lockedBy === "other-window",
  );
  useEffect(() => watchCustomizeLease(IGNORE_LEASE_LOSS), []);
  return (
    <div
      data-settings-anchor={row.anchor ?? undefined}
      className={cn(
        "flex flex-col border-b border-border/40 last:border-b-0",
        compact ? "gap-2.5 px-4 py-2.5" : "gap-3 px-5 py-4",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-[50%] flex-1 space-y-1">
          <div className="font-medium text-foreground">{row.label}</div>
          <p className="max-w-[72ch] text-pretty text-ui-sm text-muted-foreground">
            {row.description}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            size="sm"
            disabled={lockedElsewhere}
            onClick={() => customizeLayoutAction("direct_ui")}
          >
            Customize layout
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={lockedElsewhere}
            onClick={() => openSampleWorkspaceAction(navigate)}
          >
            Open sample workspace
          </Button>
        </div>
      </div>
      {lockedElsewhere ? (
        <p role="status" className="text-ui-sm text-warning-foreground">
          Customize is open in another window. Finish there, and your layout is
          saved as you go.
        </p>
      ) : null}
      {/* The picture only: it is a decorative echo of the layout, so it is out
          of the tab order and the accessibility tree. The buttons above stay
          live. */}
      <div
        inert
        aria-hidden
        className="pointer-events-none w-full rounded-md border border-border/60 bg-background p-2"
      >
        <LayoutThumbnail />
      </div>
    </div>
  );
}
