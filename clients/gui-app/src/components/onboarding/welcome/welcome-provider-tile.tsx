import type { ReactNode } from "react";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { Switch } from "@/components/ui/switch";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import type { WelcomeTileModel } from "@/components/onboarding/welcome/welcome-providers-model";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";
import { cn } from "@/lib/utils";

export const WELCOME_LAST_ENABLED_TOOLTIP =
  "At least one provider must stay enabled.";

/** Tone for the badge and the subtitle; the two share a palette. */
function toneClassName(good: boolean): string {
  return good ? "text-emerald-400/90" : "text-muted-foreground/60";
}

export interface WelcomeProviderTileProps {
  readonly model: WelcomeTileModel;
  /** The switch would turn off the last enabled provider (page-level guard). */
  readonly disablingLastEnabled: boolean;
  /** The shared `providers.setEnabled` mutation is in flight. */
  readonly settingEnabled: boolean;
  /** The element tooltips must stay inside - the dialog's content. */
  readonly collisionBoundary: Element | null;
  readonly onSetEnabled: (providerId: ProviderId, enabled: boolean) => void;
  /** Full-size tile in the grid, or a compact row in the disclosure. */
  readonly layout: "tile" | "row";
}

/**
 * One provider on page 1: identity (icon, name, install badge), the account
 * line when the host has one, and the enable switch.
 *
 * The name is the one thing that never truncates - a tile that reads
 * "Claude…" next to "Codex" is a tile the user has to hover to identify - so
 * it wraps, and the badge follows it onto a second line when the column is
 * narrow. The account line is the opposite case: an email is long and
 * recognisable from its first half, so it truncates and carries the full
 * text in a tooltip.
 *
 * Dimming touches the identity pieces only, never the switch: a wrapper
 * opacity would take the control down with them, and the switch on a dimmed
 * row is precisely the thing the user is here to press (same reasoning as
 * `provider-list.tsx`).
 *
 * Two tooltips, two questions. The TILE's explains the state ("Install X on
 * this machine", "Not signed in"); the SWITCH's explains the one refusal
 * the page makes ("At least one provider must stay enabled") - on a guard
 * span, because a disabled control emits no pointer events.
 */
export function WelcomeProviderTile(
  props: WelcomeProviderTileProps,
): ReactNode {
  const {
    model,
    disablingLastEnabled,
    settingEnabled,
    collisionBoundary,
    onSetEnabled,
    layout,
  } = props;
  const installed = model.install === "detected" || model.install === "builtIn";
  const switchDisabled =
    model.switchDisabled || settingEnabled || disablingLastEnabled;
  // The state tooltip hangs on the identity block, not the whole tile, so it
  // never opens on top of the switch's own guard tooltip: two triggers
  // nested one inside the other would both answer a hover over the switch.
  const identity = (
    <TooltipWrapper
      label={model.tooltip}
      side="top"
      sideOffset={undefined}
      align={undefined}
      collisionBoundary={collisionBoundary}
    >
      <div
        data-testid="welcome-provider-identity"
        className={cn(
          "flex min-w-0 items-center",
          // The tile's identity fills its row and pushes the switch to the
          // far edge; the compact row's does NOT, so its switch sits right
          // after the badge and reads as this row's (QA B10: a switch
          // pinned 180 px from its name read as the neighbour's).
          layout === "tile" ? "flex-1 gap-3" : "gap-2.5",
        )}
      >
        <HarnessIcon
          harnessId={providerIdToGuiHarnessId(model.providerId)}
          // Opacity as well as color: brand icons paint their own colors and
          // ignore `currentColor`, so a dimmed label next to a vivid logo
          // reads as two different rows.
          className={cn(
            "shrink-0",
            layout === "tile" ? "size-7" : "size-4",
            model.dimmed && "opacity-60",
          )}
        />
        <div
          className={cn(
            "flex min-w-0 items-baseline gap-x-2 gap-y-0.5",
            // The tile's name may wrap to a second line and take the badge
            // with it; the row is one line, so its badge stays beside the
            // name and the pair just gets wider.
            layout === "tile" ? "flex-1 flex-wrap" : "shrink-0",
          )}
        >
          <span
            className={cn(
              "min-w-0 text-ui-sm font-medium break-words text-foreground",
              model.dimmed && "opacity-60",
            )}
          >
            {model.name}
          </span>
          <span
            data-testid="welcome-provider-badge"
            className={cn(
              "shrink-0 font-mono text-overline tracking-wider uppercase",
              toneClassName(installed),
              model.dimmed && "opacity-60",
            )}
          >
            {model.badge}
          </span>
        </div>
      </div>
    </TooltipWrapper>
  );
  const control = (
    <TooltipWrapper
      label={disablingLastEnabled ? WELCOME_LAST_ENABLED_TOOLTIP : null}
      side="top"
      sideOffset={undefined}
      align={undefined}
      collisionBoundary={collisionBoundary}
    >
      {/* Guard span: the Switch is `disabled` in exactly the state this
          explains, and a disabled control emits no pointer events. In the
          tile it is as tall as the icon, so the switch centres on the first
          line whether or not the name wraps. */}
      <span
        className={cn(
          "inline-flex shrink-0 items-center",
          layout === "tile" && "ml-auto h-7",
        )}
      >
        <Switch
          checked={model.enabled}
          disabled={switchDisabled}
          // Named for what pressing it DOES, so a screen reader announces
          // "Disable Claude Code, on" rather than "Enable Claude Code, on".
          aria-label={`${model.enabled ? "Disable" : "Enable"} ${model.name}`}
          onCheckedChange={(next) => {
            if (switchDisabled) return;
            onSetEnabled(model.providerId, next);
          }}
        />
      </span>
    </TooltipWrapper>
  );

  if (layout === "tile") {
    return (
      <li
        data-testid="welcome-provider-tile"
        data-provider-id={model.providerId}
        className="flex min-w-0 flex-col gap-2.5 rounded-lg border border-border/60 bg-foreground/[0.03] p-4"
      >
        {/* `items-start`, not `center`: when the name wraps the switch stays
            on the first line, level with the icon, instead of drifting into
            the gap between the lines. */}
        <div className="flex min-w-0 items-start gap-3">
          {identity}
          {control}
        </div>
        {model.subtitle !== null ? (
          // The one tooltip that repeats its trigger: the line truncates,
          // and the tooltip is where the rest of a long email lives.
          <TooltipWrapper
            label={model.subtitle}
            side="bottom"
            sideOffset={undefined}
            align="start"
            collisionBoundary={collisionBoundary}
          >
            <p
              data-testid="welcome-provider-subtitle"
              className={cn(
                // Indented past the icon so the account reads as the name's
                // second line, not the tile's.
                "min-w-0 truncate pl-10 text-ui-xs",
                model.subtitleTone === "good"
                  ? "text-emerald-400/90"
                  : "text-muted-foreground",
              )}
            >
              {model.subtitle}
            </p>
          </TooltipWrapper>
        ) : null}
      </li>
    );
  }
  return (
    <li
      data-testid="welcome-provider-row"
      data-provider-id={model.providerId}
      className="flex min-h-10 min-w-0 items-center gap-3 rounded-md px-2 py-1"
    >
      {identity}
      {control}
    </li>
  );
}
