import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { RefreshIconButton } from "@/components/refresh-icon-button";
import { Settings } from "lucide-react";
import type { HarnessOption } from "@/components/home/data/landing-options";
import type { ProviderId } from "@/components/home/data/landing-options";
import { usePickerProviderLeaderForIndex } from "@/providers/keybinding-context";
import { leaderDigitFor } from "@/components/ui/leader-digit-shortcuts";
import { PickerLeaderBadge } from "@/components/home/pickers/harness-model-picker-leader-badge";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { visibleRailHarnesses } from "@/components/home/pickers/harness-rail-providers";
import { cn } from "@/lib/utils";

const LOCKED_PROVIDER_TOOLTIP =
  "Provider cannot be changed while forking terminal agent";

interface ProviderRailProps {
  readonly harnesses: ReadonlyArray<HarnessOption>;
  readonly fallbackHarnesses: ReadonlyArray<HarnessOption>;
  readonly activeProviderId: ProviderId;
  readonly lockedHarnessId: ProviderId | null;
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
    pending,
    onProviderChange,
    onOpenProviderSettings,
    onRefresh,
  } = props;
  const visibleHarnesses = visibleRailHarnesses(harnesses, fallbackHarnesses);

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
            disabled={
              lockedHarnessId !== null && harness.id !== lockedHarnessId
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
  readonly disabled: boolean;
  readonly onProviderChange: (providerId: ProviderId) => void;
}

// One rail tab. Split out so each can call the leader hook (hooks can't run in
// a `.map`). The ⌘-digit badge masks the icon's right edge while the leader is
// held; switching is pure state (no focus move), so the search box keeps focus.
function ProviderRailButton(props: ProviderRailButtonProps) {
  const { harness, index, active, disabled, onProviderChange } = props;
  const leaderModifier = usePickerProviderLeaderForIndex(index);
  return (
    <TooltipWrapper
      label={disabled ? LOCKED_PROVIDER_TOOLTIP : null}
      side="right"
      sideOffset={6}
      align={undefined}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        aria-disabled={disabled ? true : undefined}
        aria-label={harness.label}
        title={disabled ? LOCKED_PROVIDER_TOOLTIP : harness.label}
        tabIndex={disabled ? -1 : undefined}
        data-active={active}
        className={cn(
          "relative flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 data-[active=true]:bg-accent data-[active=true]:text-foreground",
          "aria-disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground",
        )}
        onClick={() => {
          if (disabled) return;
          onProviderChange(harness.id);
        }}
      >
        <HarnessIcon harnessId={harness.id} />
        <PickerLeaderBadge
          show={leaderModifier !== null && !disabled}
          index={index}
          hintAction="to browse"
          hintTarget={harness.label}
          testId={`model-provider-digit-${leaderDigitFor(index)}`}
          placement="corner"
        />
      </button>
    </TooltipWrapper>
  );
}
