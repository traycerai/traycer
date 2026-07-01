import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import {
  AgentSpinningDots,
  MutedAgentSpinner,
} from "@/components/ui/agent-spinning-dots";
import { RefreshIconButton } from "@/components/refresh-icon-button";
import { Settings } from "lucide-react";
import { useId } from "react";
import type {
  HarnessOption,
  ProviderId,
} from "@/components/home/data/landing-options";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import { usePickerProviderLeaderForIndex } from "@/providers/keybinding-context";
import { leaderDigitFor } from "@/components/ui/leader-digit-shortcuts";
import { PickerLeaderBadge } from "@/components/home/pickers/harness-model-picker-leader-badge";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  railHarnessDegraded,
  visibleRailHarnesses,
} from "@/components/home/pickers/harness-rail-providers";
import { cn } from "@/lib/utils";

const LOCKED_PROVIDER_TOOLTIP =
  "Provider cannot be changed while forking terminal agent";

interface ProviderRailProps {
  readonly harnesses: ReadonlyArray<HarnessOption>;
  readonly fallbackHarnesses: ReadonlyArray<HarnessOption>;
  readonly activeProviderId: ProviderId;
  readonly lockedHarnessId: ProviderId | null;
  readonly degradedHarnessIds: ReadonlySet<GuiHarnessId>;
  readonly pending: boolean;
  readonly onProviderChange: (providerId: ProviderId) => void;
  readonly onOpenProviderSettings: () => void;
  readonly onRefresh: () => Promise<void>;
}

export function ProviderRail(props: ProviderRailProps) {
  const {
    harnesses,
    fallbackHarnesses,
    activeProviderId,
    lockedHarnessId,
    degradedHarnessIds,
    pending,
    onProviderChange,
    onOpenProviderSettings,
    onRefresh,
  } = props;
  const visibleHarnesses = visibleRailHarnesses(
    harnesses,
    fallbackHarnesses,
    degradedHarnessIds,
  );

  return (
    // The settings gear is a sibling of the tablist, not a child - only tab
    // elements belong inside `role="tablist"` for correct screen-reader nav.
    <div className="flex min-h-0 flex-col items-center border-r bg-muted/20 p-1">
      <div
        role="tablist"
        aria-label="Model providers"
        className="no-scrollbar flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto overscroll-contain px-1"
      >
        {pending && visibleHarnesses.length === 0 ? (
          <span className="mt-1 flex size-8 items-center justify-center rounded-lg text-muted-foreground">
            <MutedAgentSpinner />
          </span>
        ) : null}
        {visibleHarnesses.map((harness, index) => (
          <ProviderRailButton
            key={harness.id}
            harness={harness}
            index={index}
            active={harness.id === activeProviderId}
            degraded={railHarnessDegraded(harness, degradedHarnessIds)}
            disabled={
              (lockedHarnessId !== null && harness.id !== lockedHarnessId) ||
              harness.availabilityPending
            }
            onProviderChange={onProviderChange}
          />
        ))}
      </div>
      <RefreshIconButton
        onRefresh={onRefresh}
        label="Refresh providers & models"
        className="mt-1"
      />
      <button
        type="button"
        aria-label="Provider CLI settings"
        title="Provider CLI settings"
        onClick={onOpenProviderSettings}
        className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <Settings className="size-4" />
      </button>
    </div>
  );
}

interface ProviderRailButtonProps {
  readonly harness: HarnessOption;
  readonly index: number;
  readonly active: boolean;
  readonly degraded: boolean;
  readonly disabled: boolean;
  readonly onProviderChange: (providerId: ProviderId) => void;
}

// Hover/AT title for a rail tab: surfaces the probe-in-flight state, then the
// fork-lock reason, else the plain label. A function (not a nested ternary) so
// it stays lint-clean and the three states read top to bottom.
function railButtonTitle(harness: HarnessOption, disabled: boolean): string {
  if (harness.availabilityPending) {
    return `${harness.label} — checking availability…`;
  }
  if (disabled) return LOCKED_PROVIDER_TOOLTIP;
  return harness.label;
}

// One rail tab. Split out so each can call the leader hook (hooks can't run in
// a `.map`). The ⌘-digit badge masks the icon's right edge while the leader is
// held; switching is pure state (no focus move), so the search box keeps focus.
function ProviderRailButton(props: ProviderRailButtonProps) {
  const { harness, index, active, degraded, disabled, onProviderChange } =
    props;
  const leaderModifier = usePickerProviderLeaderForIndex(index);
  const degradedDescriptionId = useId();
  return (
    <TooltipWrapper
      label={
        disabled && !harness.availabilityPending
          ? LOCKED_PROVIDER_TOOLTIP
          : null
      }
      side="right"
      sideOffset={6}
      align={undefined}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        aria-disabled={disabled ? true : undefined}
        aria-label={
          harness.availabilityPending
            ? `${harness.label} — loading…`
            : harness.label
        }
        aria-describedby={
          degraded && !harness.availabilityPending
            ? degradedDescriptionId
            : undefined
        }
        title={railButtonTitle(harness, disabled)}
        tabIndex={disabled ? -1 : undefined}
        data-active={active}
        data-degraded={degraded ? true : undefined}
        className={cn(
          "relative flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 data-[active=true]:bg-accent data-[active=true]:text-foreground",
          degraded
            ? "opacity-60 hover:opacity-80 data-[active=true]:opacity-75"
            : "",
          "aria-disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground",
        )}
        onClick={() => {
          if (disabled) return;
          onProviderChange(harness.id);
        }}
      >
        {harness.availabilityPending ? (
          <>
            <span className="opacity-25">
              <HarnessIcon harnessId={harness.id} />
            </span>
            <span className="absolute inset-0 flex items-center justify-center">
              <AgentSpinningDots
                className="text-muted-foreground"
                testId={undefined}
                variant={undefined}
              />
            </span>
          </>
        ) : (
          <>
            <HarnessIcon harnessId={harness.id} />
            {degraded ? (
              <span id={degradedDescriptionId} className="sr-only">
                Setup required
              </span>
            ) : null}
            <PickerLeaderBadge
              show={leaderModifier !== null && !disabled}
              index={index}
              // Degraded providers stay browse-only (the leader digit browses,
              // it does not commit), so the hint must not over-promise "switch".
              hintAction={degraded ? "to browse" : "to switch"}
              hintTarget={harness.label}
              testId={`model-provider-digit-${leaderDigitFor(index)}`}
              placement="corner"
            />
          </>
        )}
      </button>
    </TooltipWrapper>
  );
}
