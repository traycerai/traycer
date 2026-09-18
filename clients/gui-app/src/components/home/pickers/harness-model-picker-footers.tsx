import {
  findReasoningLabel,
  findUpgradeServiceTierForModel,
  type ModelOption,
  type ReasoningLevel,
  type ReasoningLevelOption,
  type ServiceTier,
} from "@/components/home/data/landing-options";
import { cn } from "@/lib/utils";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { usePaneFocused } from "@/components/epic-tabs/pane-visibility-context";
import { usePortalConcealed } from "@/components/ui/portal-concealment-context";
import {
  STATUS_ANIMATION_SMOOTH_CADENCE_MS,
  useStatusAnimation,
} from "@/lib/animation/status-animation-clock";
import {
  singleDigitLeaderDigitFor,
  usePickerReasoningLeaderForIndex,
} from "@/providers/keybinding-context";
import { PickerLeaderBadge } from "@/components/home/pickers/harness-model-picker-leader-badge";
import { pickerLeaderControlLabel } from "@/components/home/pickers/harness-model-picker-shortcut-hint";
import { useReasoningSliderGesture } from "@/components/home/pickers/use-reasoning-slider-gesture";
import { FastModeFooterButton } from "@/components/home/pickers/fast-mode-footer-button";
import {
  horizontalScrollFadeClass,
  useHorizontalScrollEdges,
} from "@/hooks/ui/use-horizontal-scroll-edges";
import {
  Slider,
  SliderRange,
  SliderThumb,
  SliderTrack,
} from "@/components/ui/slider";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useComposerLayoutValue } from "@/lib/layout-overrides";

/**
 * Whether the selected level is the catalog's LAST one, read off the full
 * unsorted catalog the harness reported.
 *
 * A zero-effort id (`off` / `none`) counts at its catalog position rather than
 * being filtered out the way the chip's ladder filters it: the slider's stops
 * ARE the catalog, so "the last stop" is the only thing max can mean here. An
 * unknown id indexes at `-1` and is never max, and a one-level catalog has no
 * max at all - its single stop is the whole range, so landing on it says
 * nothing about effort.
 */
function isMaxReasoningLevel(
  value: ReasoningLevel,
  options: ReadonlyArray<ReasoningLevelOption>,
): boolean {
  if (options.length < 2) return false;
  return (
    options.findIndex((option) => option.id === value) === options.length - 1
  );
}

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
  /**
   * The picker's `visibleOpen` - false while the popover plays its exit, so a
   * writer never ticks against a surface on its way out. A footer mounted
   * without a picker around it passes `true`.
   */
  readonly pickerOpen: boolean;
}

export function HarnessModelPickerModelSettingsFooter(
  props: HarnessModelPickerModelSettingsFooterProps,
) {
  const { reasoning, serviceTier, pickerOpen } = props;
  if (reasoning === null && serviceTier === null) return null;
  return (
    <ModelSettingsFooter
      reasoning={reasoning}
      serviceTier={serviceTier}
      pickerOpen={pickerOpen}
    />
  );
}

interface ModelSettingsFooterProps {
  readonly reasoning: ReasoningFooterConfig | null;
  readonly serviceTier: ServiceTierFooterConfig | null;
  readonly pickerOpen: boolean;
}

function ModelSettingsFooter(props: ModelSettingsFooterProps) {
  const { reasoning, serviceTier, pickerOpen } = props;
  const sliderControl =
    useComposerLayoutValue("reasoningFooterControl") === "slider";
  const sliderLayout = sliderControl && (reasoning?.options.length ?? 0) > 1;
  const upgradeServiceTier =
    serviceTier === null
      ? null
      : findUpgradeServiceTierForModel(serviceTier.selectedModel);
  const hasReasoningOptions =
    reasoning !== null && reasoning.options.length > 0;
  if (upgradeServiceTier === null && !hasReasoningOptions) return null;
  const showGroupSeparator = upgradeServiceTier !== null && hasReasoningOptions;

  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-t bg-muted/20 px-2 py-1.5">
      {upgradeServiceTier === null || serviceTier === null ? null : (
        <FastModeFooterButton
          config={serviceTier}
          upgrade={upgradeServiceTier}
          inlineShortcut={sliderLayout}
        />
      )}
      {showGroupSeparator ? (
        <div className="h-5 w-px shrink-0 bg-border" aria-hidden="true" />
      ) : null}
      {/* Gated on the option count, not just on `reasoning`: the group owns a
          scroller whose listeners are wired from its own mount, so it must not
          mount without the strip. A model with no levels renders nothing here
          and the next model that has them mounts the group afresh. */}
      {reasoning === null || !hasReasoningOptions ? null : (
        <ReasoningFooterGroup
          config={reasoning}
          pickerOpen={pickerOpen}
          stepped={sliderLayout}
        />
      )}
    </div>
  );
}

interface ReasoningFooterGroupProps {
  readonly stepped: boolean;
  readonly config: ReasoningFooterConfig;
  readonly pickerOpen: boolean;
}

// Mounted only for a model that reports at least one level - see the gate in
// `ModelSettingsFooter`.
//
// The footer resolves the Layout preference once for both alignment and
// control choice. The list and slider remain separate components because each
// owns hooks the other does not need (such as scroll-edge listeners).
//
// A one-level catalog gets the list whatever the setting says: a slider with a
// single stop is a control that cannot be moved, and the level's name alone is
// what that model has to say.
function ReasoningFooterGroup(props: ReasoningFooterGroupProps) {
  const { config, pickerOpen, stepped } = props;

  return (
    <fieldset
      aria-label="Thinking effort"
      className="m-0 flex min-w-0 flex-1 items-center border-0 p-0"
    >
      {stepped ? (
        <ReasoningLevelSlider config={config} pickerOpen={pickerOpen} />
      ) : (
        <ReasoningLevelList config={config} />
      )}
    </fieldset>
  );
}

interface ReasoningLevelStripProps {
  readonly config: ReasoningFooterConfig;
}

interface ReasoningLevelSliderProps {
  readonly config: ReasoningFooterConfig;
  readonly pickerOpen: boolean;
}

function ReasoningLevelList(props: ReasoningLevelStripProps) {
  const { value, options, disabled, onChange } = props.config;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const optionsRef = useRef<HTMLDivElement>(null);
  const edges = useHorizontalScrollEdges(scrollerRef, optionsRef);

  return (
    <>
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
    </>
  );
}

/** One full twinkle, dim to bright and back, on the shared animation clock. */
const REASONING_SPARKLE_PERIOD_MS = 2400;
const REASONING_SPARKLE_MIN_OPACITY = 0.25;
const REASONING_SPARKLE_MAX_OPACITY = 1;
/**
 * What a sparkle sits at with no writer driving it - reduced motion, a hidden
 * pane, the frames before the first tick. Declared as the CSS fallback of the
 * custom property the writer sets, so "static at a mid opacity" needs no second
 * code path and no second class.
 */
const REASONING_SPARKLE_STATIC_OPACITY = 0.6;

/** One sparkle: where it sits in the fill, how big, and where in the cycle. */
interface ReasoningSparkle {
  /** Percent across the track, and down it. */
  readonly left: number;
  readonly top: number;
  /** Pixels for a disc; `null` marks a four-point `✦` glint instead. */
  readonly size: number | null;
  /** 0-1 of the period, so no two sparkles peak together. */
  readonly phase: number;
}

/**
 * The field, authored rather than generated: a random scatter re-rolls on every
 * mount and reads as noise, while eleven placed points read as the same
 * constellation every time the level is chosen. Kept off the stops' own
 * percentages (0 / 25 / 50 / 75 / 100 for a five-level ladder) so a sparkle
 * never looks like a dot that drifted, and inside 8-85% so the pill's rounded
 * ends and the thumb do not clip one mid-twinkle.
 */
const REASONING_SPARKLES: ReadonlyArray<ReasoningSparkle> = [
  { left: 8, top: 30, size: 1.5, phase: 0 },
  { left: 15, top: 64, size: 1, phase: 0.19 },
  { left: 22, top: 22, size: null, phase: 0.42 },
  { left: 34, top: 52, size: 2, phase: 0.12 },
  { left: 41, top: 26, size: 1, phase: 0.62 },
  { left: 49, top: 60, size: null, phase: 0.31 },
  { left: 57, top: 34, size: 1.5, phase: 0.77 },
  { left: 63, top: 66, size: 1, phase: 0.5 },
  { left: 71, top: 40, size: 2, phase: 0.08 },
  { left: 78, top: 24, size: null, phase: 0.69 },
  { left: 85, top: 58, size: 1, phase: 0.35 },
];

/** The custom property sparkle `index` reads its opacity from. */
function reasoningSparkleProperty(index: number): string {
  return `--reasoning-sparkle-${index}`;
}

/** A raised cosine on the sparkle's own phase: dim, bright, dim, no corners. */
function reasoningSparkleOpacity(elapsedMs: number, phase: number): number {
  const progress =
    ((elapsedMs % REASONING_SPARKLE_PERIOD_MS) / REASONING_SPARKLE_PERIOD_MS +
      phase) %
    1;
  const swell = 0.5 - 0.5 * Math.cos(progress * 2 * Math.PI);
  return (
    REASONING_SPARKLE_MIN_OPACITY +
    swell * (REASONING_SPARKLE_MAX_OPACITY - REASONING_SPARKLE_MIN_OPACITY)
  );
}

/**
 * The max treatment's moving half: a fixed constellation twinkling over the
 * gradient fill, for as long as the highest level is selected. The gradient and
 * its fine edge say "this is the top" in a still frame; the sparkles make
 * it read as live rather than as a colour someone chose.
 *
 * It rides the shared status clock and writes ONE element
 * per tick - eleven custom properties on the field's own container, which each
 * sparkle reads through `opacity: var(--reasoning-sparkle-N, …)`. Eleven
 * subscriptions would put eleven writers on the clock's map and eleven elements
 * in the tick's style pass; one container keeps it at one of each. There is
 * no continuous CSS animation: only the entry fade uses a finite transition.
 * The sheen and drift share this writer (see `status-animation-clock.ts`).
 *
 * Unlike the old flowing band, this component is mounted under reduced motion
 * too. `useStatusAnimation` neither subscribes nor writes then, so every
 * property stays unset and the fallback in each `var()` is what paints: the
 * same constellation, still, at a mid opacity. "Static" is the absence of the
 * writer rather than a branch.
 */
function ReasoningMaxSparkles() {
  const ref = useRef<HTMLSpanElement | null>(null);
  const write = useCallback((element: HTMLSpanElement, elapsedMs: number) => {
    const drift = Math.sin((elapsedMs / 6000) * Math.PI * 2);
    element.style.setProperty(
      "--reasoning-drift",
      `${(drift * 3).toFixed(2)}px`,
    );
    element.style.setProperty(
      "--reasoning-sheen-x",
      `${(drift * 20).toFixed(2)}%`,
    );
    for (const [index, sparkle] of REASONING_SPARKLES.entries()) {
      element.style.setProperty(
        reasoningSparkleProperty(index),
        reasoningSparkleOpacity(elapsedMs, sparkle.phase).toFixed(3),
      );
    }
  }, []);
  // Back to the fallbacks, with no inline property left behind to freeze the
  // field at whatever frame the writer stopped on.
  const clear = useCallback((element: HTMLSpanElement) => {
    element.style.removeProperty("--reasoning-drift");
    element.style.removeProperty("--reasoning-sheen-x");
    for (const index of REASONING_SPARKLES.keys()) {
      element.style.removeProperty(reasoningSparkleProperty(index));
    }
  }, []);
  useStatusAnimation(ref, write, clear, STATUS_ANIMATION_SMOOTH_CADENCE_MS);

  return (
    <span
      ref={ref}
      aria-hidden="true"
      data-testid="model-reasoning-max-sparkles"
      className="reasoning-effort-max-sparkles pointer-events-none absolute inset-0"
    >
      {REASONING_SPARKLES.map((sparkle, index) => (
        <span
          key={`${sparkle.left}-${sparkle.top}`}
          aria-hidden="true"
          data-testid="model-reasoning-max-sparkle"
          className={cn(
            "absolute",
            sparkle.size === null
              ? "reasoning-effort-sparkle-glint"
              : "reasoning-effort-sparkle rounded-full",
          )}
          style={{
            left: `${sparkle.left}%`,
            top: `${sparkle.top}%`,
            transform:
              "translate(calc(-50% + var(--reasoning-drift, 0px)), -50%)",
            opacity: `var(${reasoningSparkleProperty(index)}, ${REASONING_SPARKLE_STATIC_OPACITY})`,
            ...(sparkle.size === null
              ? {}
              : { width: sparkle.size, height: sparkle.size }),
          }}
        >
          {sparkle.size === null ? "✦" : null}
        </span>
      ))}
    </span>
  );
}

/**
 * One stop per catalog level, in the catalog's own order and never sorted -
 * including a zero-effort level (`off` / `none`), which is the leftmost stop
 * rather than an excluded one: here the POSITION is the control, so "no
 * thinking" has to be somewhere a thumb can land.
 *
 * The thumb is the RANGE control and the only tab stop (Radix gives it arrows,
 * Home/End and `role="slider"`; `aria-valuetext` says the level's name rather
 * than its index). The dots are direct selection alongside it: each is a real
 * labelled button, so a coarse pointer has something to hit, a hover has
 * something to label, and assistive technology can pick a level by name
 * instead of stepping to it - `tabIndex={-1}` keeps them out of the tab order
 * without taking them out of the accessibility tree. Clicking one writes the
 * same level the track under it would, so the two routes cannot disagree.
 */
function ReasoningLevelSlider(props: ReasoningLevelSliderProps) {
  const { value, options, disabled, onChange } = props.config;
  const open = props.pickerOpen;
  const selectedIndex = options.findIndex((option) => option.id === value);
  // A level the catalog does not list (remembered from another model, before
  // normalization catches up) parks the thumb at the first stop rather than
  // leaving the slider without a value - `findReasoningLabel` still prints the
  // raw level beside it, so the name and the position disagree visibly instead
  // of the control vanishing.
  const thumbIndex = selectedIndex === -1 ? 0 : selectedIndex;
  const lastIndex = options.length - 1;
  const atMax = isMaxReasoningLevel(value, options);
  // The sparkle field's gate. Reduced motion is deliberately NOT in it: the
  // field still renders, still, which is the max treatment's answer to the
  // preference rather than its absence. What IS in it is the presentation half
  // (the two signals `PopoverContent` checks before rendering at all, plus the
  // picker's own `visibleOpen`), because a writer ticking against a popover
  // nobody can see is the one thing the shared clock must never accumulate.
  const paneFocused = usePaneFocused();
  const concealed = usePortalConcealed();
  const sparkling = atMax && open && !disabled && paneFocused && !concealed;

  const selectLevel = useCallback(
    (index: number) => {
      const option = options.at(index);
      if (option === undefined || option.id === value) return;
      onChange(option.id);
    },
    [options, value, onChange],
  );

  const gesture = useReasoningSliderGesture(
    thumbIndex,
    lastIndex,
    disabled,
    selectLevel,
  );

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 px-1">
      {/* Keep a generous pointer target around the slimmer track, with room
          for the thumb and its focus ring beyond the capsule. */}
      <Slider
        data-testid="model-reasoning-slider"
        className="reasoning-effort-slider min-w-0 flex-1 py-1"
        data-max={atMax ? "true" : undefined}
        data-dragging={gesture.dragging ? "true" : undefined}
        data-pressed={gesture.pressed ? "true" : undefined}
        value={[gesture.position]}
        min={0}
        max={lastIndex}
        step={gesture.step}
        disabled={disabled}
        onPointerDown={gesture.onPointerDown}
        onPointerMove={gesture.onPointerMove}
        onPointerUp={gesture.finishPointer}
        onLostPointerCapture={gesture.finishPointer}
        onPointerCancel={gesture.onPointerCancel}
        onClick={gesture.onClick}
        onValueChange={gesture.onValueChange}
      >
        <SliderTrack
          size="pill"
          className={cn(
            "data-[size=pill]:h-4 transition-shadow motion-reduce:transition-none",
            atMax && "reasoning-effort-max-glow",
          )}
        >
          {/* Solid, not the primitive's `/70`: in a pill this wide the fill IS
              the control's read, and a translucent one over the unfilled base
              muddies the boundary the thumb sits on. */}
          <SliderRange
            data-testid="model-reasoning-range"
            // Radix insets the 1.5rem thumb at the endpoints, but leaves its
            // range on raw percentages. Match that inset and keep the covered
            // edge square so low interior stops have no unfilled crescent.
            style={{
              marginInlineEnd: `${((2 * gesture.position) / lastIndex - 1) * 0.75}rem`,
            }}
            className={cn(
              "reasoning-effort-range bg-primary",
              atMax && "reasoning-effort-max-range",
            )}
          />
          {/* Inside the track, so the track's own `overflow-hidden` and rounded
              ends are what clip the field; over the range, under the stops and
              the thumb, which are the slider's later siblings. */}
          {sparkling ? <ReasoningMaxSparkles /> : null}
        </SliderTrack>
        {/* Inset by half the thumb, which is where Radix keeps the thumb's own
            centre at the two ends (`getThumbInBoundsOffset`) - without it the
            first and last dot sit half a thumb outside the thumb's reach. The
            pill thumb is 1.5rem, so this is `px-3`; `py-1` matches the slider's
            own padding. Interactive stops stay below the thumb. */}
        <div className="pointer-events-none absolute inset-0 px-3 py-1">
          <div className="relative h-full">
            {options.map((option, index) => (
              <ReasoningLevelStop
                key={option.id}
                option={option}
                index={index}
                percent={lastIndex === 0 ? 0 : (index / lastIndex) * 100}
                // During a drag the thumb can sit between committed levels.
                // Dots follow the visible thumb, so none disappears ahead of
                // it and the dot colour matches the fill beneath it.
                selected={index === gesture.position}
                overFill={index < gesture.position}
                disabled={disabled}
                onSelect={selectLevel}
                movedByGesture={gesture.movedByGesture}
              />
            ))}
          </div>
        </div>
        {/* The disc IS the thumb at this size - no core drawn inside it, since
            there is no longer a halo that would have to stay off the focus
            ring's channel. */}
        <SliderThumb
          size="pill"
          className="data-[size=pill]:size-6 data-[size=pill]:border"
          aria-label="Thinking effort"
          aria-valuenow={thumbIndex}
          aria-valuetext={findReasoningLabel(value, options)}
        />
      </Slider>
      {/* Fixed width so Low and Extra High leave the track in the same place.
          Right-aligned so the name sits on the footer’s far edge; unused space
          falls between the track and a shorter name. */}
      <TooltipWrapper
        label={findReasoningLabel(value, options)}
        side="top"
        sideOffset={4}
        align="end"
      >
        <span
          data-testid="model-reasoning-level-name"
          data-max={atMax ? "true" : undefined}
          className="reasoning-effort-label w-[9ch] max-w-[40%] shrink-0 truncate text-end text-ui-xs font-medium"
        >
          {findReasoningLabel(value, options)}
        </span>
      </TooltipWrapper>
    </div>
  );
}

interface ReasoningLevelStopProps {
  readonly option: ReasoningLevelOption;
  readonly index: number;
  readonly percent: number;
  readonly selected: boolean;
  /** Whether the fill reaches this stop, which decides the dot's colour. */
  readonly overFill: boolean;
  readonly disabled: boolean;
  readonly onSelect: (index: number) => void;
  /** Whether the gesture that produced this click already set the level. */
  readonly movedByGesture: () => boolean;
}

// One dot. `pointer-events-auto` restores what the overlay above it gives up,
// so the bare track between two dots still belongs to the slider and a drag
// that crosses a dot is not interrupted.
//
// The hit target includes the padding around the slim track and stays narrow
// across: a square target would overlap its neighbour on the narrowest
// picker with the longest ladder, and the thing a finger is aiming at is a column of the track,
// not a square.
const ReasoningLevelStop = memo(function ReasoningLevelStop(
  props: ReasoningLevelStopProps,
) {
  const { option, index, percent, selected, overFill, disabled, onSelect } =
    props;
  const leaderModifier = usePickerReasoningLeaderForIndex(index);
  const showShortcut = !disabled && leaderModifier !== null;
  const [hovered, setHovered] = useState(false);
  return (
    <TooltipWrapper
      label={option.label}
      side="top"
      sideOffset={6}
      align="center"
      open={showShortcut ? false : hovered}
      onOpenChange={setHovered}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label={pickerLeaderControlLabel(
          option.label,
          index,
          disabled ? null : leaderModifier,
          "to set",
        )}
        data-testid={`model-reasoning-stop-${index}`}
        disabled={disabled}
        style={{ left: `${percent}%` }}
        onPointerLeave={() => setHovered(false)}
        className={cn(
          "group pointer-events-auto absolute top-1/2 flex h-6 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full disabled:cursor-not-allowed pointer-coarse:w-6",
          // Only the inert selected stop rises above the thumb to show its
          // shortcut. Neighboring hit targets must stay beneath the thumb.
          selected && "pointer-events-none z-10",
        )}
        onClick={() => {
          if (props.movedByGesture()) return;
          onSelect(index);
        }}
      >
        {/* Two colours, because the dot sits on two different surfaces:
            `--primary-foreground` is by definition the colour that reads on the
            fill, and a foreground alpha is what reads on the unfilled base. A
            single alpha would vanish on one half of every theme. */}
        <span
          data-testid={`model-reasoning-dot-${index}`}
          className={cn(
            "size-1 rounded-full transition-colors",
            selected && "opacity-0",
            showShortcut && "invisible",
            overFill ? "bg-primary-foreground/35" : "bg-foreground/25",
            !disabled &&
              (overFill
                ? "group-hover:bg-primary-foreground/70"
                : "group-hover:bg-foreground/55"),
          )}
        />
        <PickerLeaderBadge
          modifier={disabled ? null : leaderModifier}
          index={index}
          testId={`model-reasoning-digit-${singleDigitLeaderDigitFor(index)}`}
          placement="center"
        />
      </button>
    </TooltipWrapper>
  );
});

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
      aria-label={pickerLeaderControlLabel(
        option.label,
        index,
        disabled ? null : leaderModifier,
        "to set",
      )}
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
          modifier={disabled ? null : leaderModifier}
          index={index}
          testId={`model-reasoning-digit-${singleDigitLeaderDigitFor(index)}`}
          placement="trailing"
        />
      </span>
    </button>
  );
}
