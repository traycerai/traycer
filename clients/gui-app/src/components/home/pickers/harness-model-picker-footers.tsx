import {
  findUpgradeServiceTierForModel,
  type ModelOption,
  type ReasoningLevel,
  type ReasoningLevelOption,
  type ServiceTier,
} from "@/components/home/data/landing-options";
import { cn } from "@/lib/utils";
import { Zap } from "lucide-react";
import { useEffect, useRef } from "react";
import {
  singleDigitLeaderDigitFor,
  usePickerReasoningLeaderForIndex,
} from "@/providers/keybinding-context";
import { PickerLeaderBadge } from "@/components/home/pickers/harness-model-picker-leader-badge";
import {
  horizontalScrollFadeClass,
  useHorizontalScrollEdges,
} from "@/hooks/ui/use-horizontal-scroll-edges";

export interface ReasoningFooterConfig {
  readonly value: ReasoningLevel;
  readonly options: ReadonlyArray<ReasoningLevelOption>;
  readonly disabled: boolean;
  readonly onChange: (next: ReasoningLevel) => void;
}

export interface ServiceTierFooterConfig {
  readonly selectedModel: ModelOption | null;
  readonly value: ServiceTier;
  readonly onChange: (next: ServiceTier) => void;
}

interface HarnessModelPickerModelSettingsFooterProps {
  readonly reasoning: ReasoningFooterConfig | null;
  readonly serviceTier: ServiceTierFooterConfig | null;
}

export function HarnessModelPickerModelSettingsFooter(
  props: HarnessModelPickerModelSettingsFooterProps,
) {
  const { reasoning, serviceTier } = props;
  if (reasoning === null && serviceTier === null) return null;
  return (
    <ModelSettingsFooter reasoning={reasoning} serviceTier={serviceTier} />
  );
}

interface ModelSettingsFooterProps {
  readonly reasoning: ReasoningFooterConfig | null;
  readonly serviceTier: ServiceTierFooterConfig | null;
}

function ModelSettingsFooter(props: ModelSettingsFooterProps) {
  const { reasoning, serviceTier } = props;
  const upgradeServiceTier =
    serviceTier === null
      ? null
      : findUpgradeServiceTierForModel(serviceTier.selectedModel);
  const hasReasoningOptions =
    reasoning !== null && reasoning.options.length > 0;
  if (upgradeServiceTier === null && !hasReasoningOptions) return null;
  const showGroupSeparator = upgradeServiceTier !== null && hasReasoningOptions;

  const serviceTierActive =
    serviceTier !== null &&
    upgradeServiceTier !== null &&
    serviceTier.value === upgradeServiceTier.id;

  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-t bg-muted/20 px-2 py-1.5">
      {upgradeServiceTier === null || serviceTier === null ? null : (
        <button
          type="button"
          aria-label={`${upgradeServiceTier.label} mode`}
          aria-pressed={serviceTierActive}
          className={cn(
            "flex max-w-[min(34vw,8rem)] items-center gap-1.5 truncate rounded-md px-2 py-1 text-ui-xs text-muted-foreground transition-colors aria-[pressed=false]:hover:bg-accent/30 aria-[pressed=false]:hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60",
            serviceTierActive && "bg-accent/70 text-foreground",
          )}
          onClick={() =>
            serviceTier.onChange(serviceTierActive ? "" : upgradeServiceTier.id)
          }
        >
          <Zap
            className={cn(
              "size-3.5 shrink-0",
              serviceTierActive && "fill-current text-amber-500",
            )}
            strokeWidth={2}
          />
          <span className="truncate">{upgradeServiceTier.label}</span>
        </button>
      )}
      {showGroupSeparator ? (
        <div className="h-5 w-px shrink-0 bg-border" aria-hidden="true" />
      ) : null}
      {/* Gated on the option count, not just on `reasoning`: the group owns a
          scroller whose listeners are wired from its own mount, so it must not
          mount without the strip. A model with no levels renders nothing here
          and the next model that has them mounts the group afresh. */}
      {reasoning === null || !hasReasoningOptions ? null : (
        <ReasoningFooterGroup config={reasoning} />
      )}
    </div>
  );
}

interface ReasoningFooterGroupProps {
  readonly config: ReasoningFooterConfig;
}

// Mounted only for a model that reports at least one level - see the gate in
// `ModelSettingsFooter`.
function ReasoningFooterGroup(props: ReasoningFooterGroupProps) {
  const { value, options, disabled, onChange } = props.config;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const optionsRef = useRef<HTMLDivElement>(null);
  const edges = useHorizontalScrollEdges(scrollerRef, optionsRef);

  return (
    <fieldset
      aria-label="Thinking effort"
      className="m-0 flex min-w-0 flex-1 items-center border-0 p-0"
    >
      {/* Levels are harness-reported per model, so their number is unbounded:
          the strip scrolls rather than clipping the tail off-screen, and the
          mask fades whichever edge still hides a level so the overflow reads
          as "there is more" instead of a silent cut. */}
      <div
        ref={scrollerRef}
        data-testid="model-reasoning-scroller"
        className={cn(
          "no-scrollbar flex min-w-0 flex-1 items-center overflow-x-auto overscroll-x-contain",
          horizontalScrollFadeClass(edges),
        )}
      >
        {/* `w-max min-w-full` keeps the even spread while the levels fit and
            switches to natural width once they overflow - `justify-around` on
            an overflowing scroller splits the deficit across both ends, and
            content pushed past the start edge cannot be scrolled back to. */}
        <div
          ref={optionsRef}
          className="flex w-max min-w-full items-center justify-around gap-1"
        >
          {options.map((option, index) => (
            <ReasoningLevelButton
              key={option.id}
              option={option}
              index={index}
              selected={option.id === value}
              disabled={disabled}
              onChange={onChange}
            />
          ))}
        </div>
      </div>
    </fieldset>
  );
}

interface ReasoningLevelButtonProps {
  readonly option: ReasoningLevelOption;
  readonly index: number;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onChange: (next: ReasoningLevel) => void;
}

// One thinking-level pill. Split out so each can call the leader hook. The
// ⌥-digit badge floats just past the label (absolute, out of flow) so revealing
// it never reflows the footer; changing the level is pure state, so the search
// box keeps focus.
function ReasoningLevelButton(props: ReasoningLevelButtonProps) {
  const { option, index, selected, disabled, onChange } = props;
  const leaderModifier = usePickerReasoningLeaderForIndex(index);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Keep the selected level on screen. A level past the scroller's right edge
  // mounts already-selected when the picker opens, so this runs on open too -
  // without it, a level set on a previous visit would be invisible, and seeing
  // the strip already scrolled is itself the hint that it scrolls. `nearest`
  // on both axes makes it a no-op once the pill is fully visible.
  useEffect(() => {
    if (!selected) return;
    buttonRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected]);

  return (
    <button
      ref={buttonRef}
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      className={cn(
        "inline-flex max-w-[min(22vw,6.5rem)] shrink-0 items-center rounded-md px-2 py-1 text-ui-xs text-muted-foreground transition-colors aria-[pressed=false]:hover:bg-accent/30 aria-[pressed=false]:hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-muted-foreground",
        selected && "bg-accent/70 text-foreground",
      )}
      onClick={() => onChange(option.id)}
    >
      <span className="relative inline-flex min-w-0 items-center">
        <span className="truncate">{option.label}</span>
        <PickerLeaderBadge
          show={leaderModifier !== null}
          index={index}
          hintAction="to set"
          hintTarget={option.label}
          testId={`model-reasoning-digit-${singleDigitLeaderDigitFor(index)}`}
          placement="trailing"
        />
      </span>
    </button>
  );
}
