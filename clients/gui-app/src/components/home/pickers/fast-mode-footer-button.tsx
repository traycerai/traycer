import { Zap } from "lucide-react";
import type { ServiceTierOption } from "@/components/home/data/landing-options";
import type { ServiceTierFooterConfig } from "@/components/home/pickers/harness-model-picker-footers";
import { PickerLeaderBadge } from "@/components/home/pickers/harness-model-picker-leader-badge";
import { pickerLeaderControlLabel } from "@/components/home/pickers/harness-model-picker-shortcut-hint";
import { toggleServiceTier } from "@/components/home/pickers/model-service-tier";
import { usePickerFastModeLeader } from "@/providers/keybinding-context";
import { cn } from "@/lib/utils";

interface FastModeFooterButtonProps {
  readonly config: ServiceTierFooterConfig;
  readonly upgrade: ServiceTierOption;
  readonly inlineShortcut: boolean;
}

export function FastModeFooterButton(props: FastModeFooterButtonProps) {
  const { config, upgrade, inlineShortcut } = props;
  const leader = usePickerFastModeLeader();
  const active = config.value === upgrade.id;

  return (
    <button
      type="button"
      aria-label={pickerLeaderControlLabel(
        `${upgrade.label} mode`,
        9,
        leader,
        "to toggle",
      )}
      aria-pressed={active}
      className={cn(
        "relative flex min-w-0 max-w-[min(34vw,8rem)] items-center gap-1.5 rounded-md px-2 py-1 text-ui-xs text-muted-foreground transition-colors aria-[pressed=false]:hover:bg-accent/30 aria-[pressed=false]:hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60",
        active && "bg-accent/70 text-foreground",
      )}
      onClick={() => toggleServiceTier(config)}
    >
      <span className="relative size-3.5 shrink-0">
        <Zap
          className={cn(
            "size-full",
            active && "fill-current text-warning-foreground",
            inlineShortcut && leader !== null && "invisible",
          )}
          strokeWidth={2}
        />
        {inlineShortcut ? (
          <PickerLeaderBadge
            modifier={leader}
            index={9}
            testId="model-fast-mode-digit-0"
            placement="center"
          />
        ) : null}
      </span>
      <span className="relative inline-flex min-w-0 items-center">
        <span className="truncate">{upgrade.label}</span>
        <PickerLeaderBadge
          modifier={inlineShortcut ? null : leader}
          index={9}
          testId="model-fast-mode-digit-0"
          placement="trailing"
        />
      </span>
    </button>
  );
}
