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
  railEntryKey,
  visibleRailEntries,
  type RailEntry,
} from "@/components/home/pickers/harness-rail-providers";
import { ProfileAvatarBadge } from "@/components/providers/profile-avatar-badge";
import { cn } from "@/lib/utils";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";

const LOCKED_PROVIDER_TOOLTIP =
  "Provider cannot be changed while forking terminal agent";

interface ProviderRailProps {
  readonly harnesses: ReadonlyArray<HarnessOption>;
  readonly fallbackHarnesses: ReadonlyArray<HarnessOption>;
  readonly profilesByHarnessId: ReadonlyMap<
    GuiHarnessId,
    ReadonlyArray<ProviderProfile>
  >;
  readonly activeProviderId: ProviderId;
  readonly activeProfileId: string | null;
  readonly lockedHarnessId: ProviderId | null;
  readonly degradedHarnessIds: ReadonlySet<GuiHarnessId>;
  readonly pending: boolean;
  readonly onEntryChange: (
    providerId: ProviderId,
    profileId: string | null,
  ) => void;
  readonly onOpenProviderSettings: () => void;
  readonly onRefresh: () => Promise<void>;
}

export function ProviderRail(props: ProviderRailProps) {
  const {
    harnesses,
    fallbackHarnesses,
    profilesByHarnessId,
    activeProviderId,
    activeProfileId,
    lockedHarnessId,
    degradedHarnessIds,
    pending,
    onEntryChange,
    onOpenProviderSettings,
    onRefresh,
  } = props;
  const entries = visibleRailEntries(
    harnesses,
    fallbackHarnesses,
    degradedHarnessIds,
    profilesByHarnessId,
  );
  const activeEntryKey = railEntryKey(activeProviderId, activeProfileId);

  return (
    // The settings gear is a sibling of the tablist, not a child - only tab
    // elements belong inside `role="tablist"` for correct screen-reader nav.
    <div className="flex min-h-0 flex-col items-center border-r bg-muted/20 p-1">
      <div
        role="tablist"
        aria-label="Model providers"
        className="no-scrollbar flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto overscroll-contain px-1"
      >
        {pending && entries.length === 0 ? (
          <span className="mt-1 flex size-8 items-center justify-center rounded-lg text-muted-foreground">
            <MutedAgentSpinner />
          </span>
        ) : null}
        {entries.map((entry, index) => (
          <ProviderRailButton
            key={railEntryKey(entry.harness.id, entry.profileId)}
            entry={entry}
            index={index}
            active={
              railEntryKey(entry.harness.id, entry.profileId) === activeEntryKey
            }
            disabled={
              (lockedHarnessId !== null &&
                entry.harness.id !== lockedHarnessId) ||
              entry.harness.availabilityPending
            }
            onEntryChange={onEntryChange}
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
  readonly entry: RailEntry;
  readonly index: number;
  readonly active: boolean;
  readonly disabled: boolean;
  readonly onEntryChange: (
    providerId: ProviderId,
    profileId: string | null,
  ) => void;
}

// Hover/AT title for a rail tab: surfaces the probe-in-flight state, then the
// fork-lock reason, else the plain label. A function (not a nested ternary) so
// it stays lint-clean and the three states read top to bottom.
function railButtonTitle(entry: RailEntry, disabled: boolean): string {
  if (entry.harness.availabilityPending) {
    return `${entry.label} — checking availability…`;
  }
  if (disabled) return LOCKED_PROVIDER_TOOLTIP;
  return entry.label;
}

// One rail tab. Split out so each can call the leader hook (hooks can't run in
// a `.map`). The ⌘-digit badge masks the icon's right edge while the leader is
// held; switching is pure state (no focus move), so the search box keeps focus.
function ProviderRailButton(props: ProviderRailButtonProps) {
  const { entry, index, active, disabled, onEntryChange } = props;
  const leaderModifier = usePickerProviderLeaderForIndex(index);
  const degradedDescriptionId = useId();
  const harness = entry.harness;
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
            ? `${entry.label} — loading…`
            : entry.label
        }
        aria-describedby={
          entry.degraded && !harness.availabilityPending
            ? degradedDescriptionId
            : undefined
        }
        title={railButtonTitle(entry, disabled)}
        tabIndex={disabled ? -1 : undefined}
        data-active={active}
        data-degraded={entry.degraded ? true : undefined}
        className={cn(
          "relative flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 data-[active=true]:bg-accent data-[active=true]:text-foreground",
          entry.degraded
            ? "opacity-60 hover:opacity-80 data-[active=true]:opacity-75"
            : "",
          "aria-disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground",
        )}
        onClick={() => {
          if (disabled) return;
          onEntryChange(harness.id, entry.profileId);
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
            {entry.profileBadge !== null ? (
              <ProfileAvatarBadge
                profileId={entry.profileBadge.profileId}
                label={entry.profileBadge.label}
                email={entry.profileBadge.email}
                accentColor={entry.profileBadge.accentColor}
                size="sm"
                className={undefined}
              />
            ) : (
              <HarnessIcon harnessId={harness.id} />
            )}
            {entry.degraded ? (
              <span id={degradedDescriptionId} className="sr-only">
                Setup required
              </span>
            ) : null}
            <PickerLeaderBadge
              show={leaderModifier !== null && !disabled}
              index={index}
              // Degraded providers stay browse-only (the leader digit browses,
              // it does not commit), so the hint must not over-promise "switch".
              hintAction={entry.degraded ? "to browse" : "to switch"}
              hintTarget={entry.label}
              testId={`model-provider-digit-${leaderDigitFor(index)}`}
              placement="corner"
            />
          </>
        )}
      </button>
    </TooltipWrapper>
  );
}
