import { Zap } from "lucide-react";
import type { ServiceTierOption } from "@/components/home/data/landing-options";
import type { ServiceTierFooterConfig } from "@/components/home/pickers/harness-model-picker-footers";
import { PickerLeaderBadge } from "@/components/home/pickers/harness-model-picker-leader-badge";
import { toggleServiceTier } from "@/components/home/pickers/model-service-tier";
import { usePickerFastModeLeader } from "@/providers/keybinding-context";
import { cn } from "@/lib/utils";

interface FastModeFooterButtonProps {
  readonly config: ServiceTierFooterConfig;
  readonly upgrade: ServiceTierOption;
  readonly alignWithSlider: boolean;
}

export function FastModeFooterButton(props: FastModeFooterButtonProps) {
  const { config, upgrade, alignWithSlider } = props;
  const leader = usePickerFastModeLeader();
  const active = config.value === upgrade.id;

  return (
    <button
      type="button"
      aria-label={`${upgrade.label} mode`}
      aria-pressed={active}
      className={cn(
        "relative flex min-w-0 max-w-[min(34vw,8rem)] items-center gap-1.5 rounded-md px-2 py-1 text-ui-xs text-muted-foreground transition-colors aria-[pressed=false]:hover:bg-accent/30 aria-[pressed=false]:hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60",
        active && "bg-accent/70 text-foreground",
        alignWithSlider && "mb-2",
      )}
      onClick={() => toggleServiceTier(config)}
    >
      <Zap
        className={cn(
          "size-3.5 shrink-0",
          active && "fill-current text-warning-foreground",
        )}
        strokeWidth={2}
      />
      <span
        className={cn(
          "inline-flex min-w-0 items-center",
          !alignWithSlider && "relative",
        )}
      >
        <span className="truncate">{upgrade.label}</span>
        <PickerLeaderBadge
          show={leader !== null}
          index={9}
          hintAction="to toggle"
          hintTarget={`${upgrade.label} mode`}
          testId="model-fast-mode-digit-0"
          placement={alignWithSlider ? "above" : "trailing"}
        />
      </span>
    </button>
  );
}
