import { Zap } from "lucide-react";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { ToolbarIconButton } from "@/components/home/toolbar/toolbar-buttons";
import {
  findUpgradeServiceTierForModel,
  type ModelOption,
  type ServiceTier,
} from "@/components/home/data/landing-options";
import { cn } from "@/lib/utils";

interface ServiceTierToggleProps {
  /**
   * The composer's currently-selected model - used as the source of truth
   * for which (if any) upgrade tier exists. Hosting components pass it in
   * (they already query the model catalog for the model picker / reasoning
   * picker), so the toggle stays a pure prop-driven sibling of
   * PermissionsPicker / AgentModeToggle.
   */
  readonly selectedModel: ModelOption | null;
  readonly value: ServiceTier;
  readonly onChange: (next: ServiceTier) => void;
}

// Lightning-bolt toggle for a model's optional service / speed tier (e.g.
// Codex `priority`/Fast). The toggle:
//
//   - is gated purely on `findUpgradeServiceTierForModel(selectedModel)` -
//     no hard-coded harness id, so any future harness that advertises a tier
//     gets the affordance for free,
//   - skips past the model's declared `defaultServiceTier` to pick the
//     upgrade tier (does NOT rely on `supportedServiceTiers[0]` ordering),
//   - encodes active state with BOTH a color shift (`text-amber-500`) and
//     a fill (`fill-current` on the icon) so users in forced-colors / high-
//     contrast modes still see a non-color cue (WCAG 1.4.1).
function buildTooltipLabel(
  label: string,
  description: string | null,
  isActive: boolean,
): string {
  const base = `${label} mode`;
  const head = isActive ? base : `Switch to ${base}`;
  return description === null ? head : `${head} - ${description}`;
}

export function ServiceTierToggle(props: ServiceTierToggleProps) {
  const { selectedModel, value, onChange } = props;
  const upgrade = findUpgradeServiceTierForModel(selectedModel);
  if (upgrade === null) return null;
  const isActive = value === upgrade.id;
  const tooltipLabel = buildTooltipLabel(
    upgrade.label,
    upgrade.description,
    isActive,
  );
  return (
    <TooltipWrapper
      label={tooltipLabel}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <ToolbarIconButton
        aria-label={tooltipLabel}
        aria-pressed={isActive}
        onClick={() => onChange(isActive ? "" : upgrade.id)}
      >
        <Zap
          className={cn("size-4", isActive && "fill-current text-amber-500")}
          strokeWidth={2}
        />
      </ToolbarIconButton>
    </TooltipWrapper>
  );
}
