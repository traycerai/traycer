import {
  findReasoningLabel,
  findUpgradeServiceTierForModel,
  type ModelOption,
  type ReasoningLevel,
  type ReasoningLevelOption,
  type ServiceTier,
} from "@/components/home/data/landing-options";
import { cn } from "@/lib/utils";
import { Zap } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { usePaneFocused } from "@/components/epic-tabs/pane-visibility-context";
import { usePortalConcealed } from "@/components/ui/portal-concealment-context";
import {
  STATUS_ANIMATION_PULSE_CADENCE_MS,
  useStatusAnimation,
} from "@/lib/animation/status-animation-clock";
import {
  singleDigitLeaderDigitFor,
  usePickerReasoningLeaderForIndex,
} from "@/providers/keybinding-context";
import { PickerLeaderBadge } from "@/components/home/pickers/harness-model-picker-leader-badge";
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
import { useLayoutStore } from "@/stores/settings/layout-store";

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
        <ReasoningFooterGroup config={reasoning} pickerOpen={pickerOpen} />
      )}
    </div>
  );
}

interface ReasoningFooterGroupProps {
  readonly config: ReasoningFooterConfig;
  readonly pickerOpen: boolean;
}

// Mounted only for a model that reports at least one level - see the gate in
// `ModelSettingsFooter`.
//
// Which control the levels are offered through is Layout ▸ Composer ▸ Reasoning
// control, read here rather than passed in so both surfaces that mount the
// picker follow it and neither has to thread it through. The two strips are
// separate components rather than one branching body: each owns hooks the
// other has no use for (the list's scroll-edge listeners wire from its own
// mount), and `list` has to render exactly the DOM it rendered before this
// setting existed.
//
// A one-level catalog gets the list whatever the setting says: a slider with a
// single stop is a control that cannot be moved, and the level's name alone is
// what that model has to say.
function ReasoningFooterGroup(props: ReasoningFooterGroupProps) {
  const { config, pickerOpen } = props;
  const control = useLayoutStore(
    (state) => state.composer.reasoningFooterControl,
  );
  const stepped = control === "slider" && config.options.length > 1;

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

/** One full twinkle, dim to bright and back: a whole number of writes at the
 *  pulse cadence (30 of them), so the cycle closes on a written frame. */
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
  { left: 8, top: 30, size: 3, phase: 0 },
  { left: 15, top: 64, size: 2, phase: 0.19 },
  { left: 22, top: 22, size: null, phase: 0.42 },
  { left: 34, top: 52, size: 4, phase: 0.12 },
  { left: 41, top: 26, size: 2, phase: 0.62 },
  { left: 49, top: 60, size: null, phase: 0.31 },
  { left: 57, top: 34, size: 3, phase: 0.77 },
  { left: 63, top: 66, size: 2, phase: 0.5 },
  { left: 71, top: 40, size: 4, phase: 0.08 },
  { left: 78, top: 24, size: null, phase: 0.69 },
  { left: 85, top: 58, size: 2, phase: 0.35 },
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
 * the glow say "this is the top" in a still frame; the sparkles are what make
 * it read as live rather than as a colour someone chose.
 *
 * It rides the shared status clock at the slow cadence and writes ONE element
 * per tick - eleven custom properties on the field's own container, which each
 * sparkle reads through `opacity: var(--reasoning-sparkle-N, …)`. Eleven
 * subscriptions would put eleven writers on the clock's map and eleven elements
 * in the tick's style pass; one container keeps it at one of each. There is
 * deliberately no CSS `animation`: for continuous motion that costs a
 * main-thread style recalc every display frame for as long as it runs (see
 * `status-animation-clock.ts`).
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
    for (const index of REASONING_SPARKLES.keys()) {
      element.style.removeProperty(reasoningSparkleProperty(index));
    }
  }, []);
  useStatusAnimation(ref, write, clear, STATUS_ANIMATION_PULSE_CADENCE_MS);

  return (
    <span
      ref={ref}
      aria-hidden="true"
      data-testid="model-reasoning-max-sparkles"
      className="pointer-events-none absolute inset-0"
    >
      {REASONING_SPARKLES.map((sparkle, index) => (
        <span
          key={`${sparkle.left}-${sparkle.top}`}
          aria-hidden="true"
          data-testid="model-reasoning-max-sparkle"
          className={cn(
            "absolute -translate-x-1/2 -translate-y-1/2",
            sparkle.size === null
              ? "reasoning-effort-sparkle-glint"
              : "reasoning-effort-sparkle rounded-full",
          )}
          style={{
            left: `${sparkle.left}%`,
            top: `${sparkle.top}%`,
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
  // raw level above it, so the name and the position disagree visibly instead
  // of the control vanishing.
  const thumbIndex = selectedIndex === -1 ? 0 : selectedIndex;
  const lastIndex = options.length - 1;
  const gesture = useRef<PointerGesture>({ active: false, moved: false });
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

  const selectLevel = (index: number) => {
    const option = options.at(index);
    if (option === undefined || option.id === value) return;
    onChange(option.id);
  };

  // A drag that STARTS on a stop ends with a click on that stop: the browser
  // dispatches it to the element the pointer went down on, however far the
  // pointer travelled and whichever stop it was released over. Radix has
  // already moved the value by then, so an unconditional click here would put
  // the level straight back where the drag began. So a gesture that moved the
  // value answers for itself and the trailing click is dropped; a click with
  // no pointer gesture behind it - a tap that never moved, or an assistive
  // technology activating the button - is untouched.
  const gestureMovedValue = () => {
    if (!gesture.current.active) return false;
    return gesture.current.moved;
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1 px-2">
      {/* The name sits ABOVE the track rather than beside it, which is what
          finally settles the width problem the earlier sizer stack worked
          around: a label on its own line cannot take width from the track, so
          "Low" and "Extra high" leave every stop exactly where it was and no
          reserved-width machinery is needed. Centred, because the row it heads
          is the whole track rather than the thumb's end of it. It truncates
          inside a cap of its own so a harness with a sentence for a label
          cannot widen the popover. */}
      <span
        data-testid="model-reasoning-level-name"
        className="max-w-full truncate text-center text-ui-xs text-muted-foreground"
      >
        {findReasoningLabel(value, options)}
      </span>
      {/* `py-2` is the max glow's room, not spacing: the glow reaches 14px from
          the track's edge (`0 0 12px 2px`) and the popover is
          `overflow-hidden`. 8px here plus the footer's own `py-1.5` is exactly
          that. The padding lives on the slider alone, so a footer that also
          carries the service-tier row does not add it twice, and the list keeps
          its own height. */}
      <Slider
        data-testid="model-reasoning-slider"
        className="reasoning-effort-slider min-w-0 flex-1 py-2"
        data-max={atMax ? "true" : undefined}
        value={[thumbIndex]}
        min={0}
        max={lastIndex}
        step={1}
        disabled={disabled}
        onPointerDown={() => {
          gesture.current = { active: true, moved: false };
        }}
        // Bubbles from the stop AFTER its own handler has read the gesture, and
        // is also where a track drag's trailing click lands - so one gesture
        // never colours the next one, whatever it ended on.
        onClick={() => {
          gesture.current = { active: false, moved: false };
        }}
        onValueChange={(next) => {
          if (gesture.current.active) gesture.current.moved = true;
          selectLevel(next.at(0) ?? thumbIndex);
        }}
      >
        <SliderTrack
          size="pill"
          className={cn(atMax && "reasoning-effort-max-glow")}
        >
          {/* Solid, not the primitive's `/70`: in a pill this wide the fill IS
              the control's read, and a translucent one over the unfilled base
              muddies the boundary the thumb sits on. */}
          <SliderRange
            data-testid="model-reasoning-range"
            className={cn(
              "rounded-full bg-primary",
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
            pill thumb is 28px, so this is `px-3.5`; `py-2` matches the slider's
            own padding, which puts the overlay exactly on the track. */}
        <div className="pointer-events-none absolute inset-0 px-3.5 py-2">
          <div className="relative h-full">
            {options.map((option, index) => (
              <ReasoningLevelStop
                key={option.id}
                option={option}
                index={index}
                percent={lastIndex === 0 ? 0 : (index / lastIndex) * 100}
                selected={index === selectedIndex}
                // The fill runs from the left edge to the thumb's centre, so
                // every stop up to the selected one is painted over it and
                // needs the colour meant to sit ON the fill.
                overFill={index < thumbIndex}
                disabled={disabled}
                onSelect={selectLevel}
                movedByGesture={gestureMovedValue}
              />
            ))}
          </div>
        </div>
        {/* The disc IS the thumb at this size - no core drawn inside it, since
            there is no longer a halo that would have to stay off the focus
            ring's channel. */}
        <SliderThumb
          size="pill"
          aria-label="Thinking effort"
          aria-valuetext={findReasoningLabel(value, options)}
        />
      </Slider>
    </div>
  );
}

/** One pointer gesture on the slider: whether it is in flight, and whether it
 *  has already moved the value. */
interface PointerGesture {
  active: boolean;
  moved: boolean;
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
// The hit target is the track's full HEIGHT (36px, comfortably past the 24px
// coarse-pointer floor on that axis) and stays narrow across: a target as wide
// as it is tall would overlap its neighbour on the narrowest picker with the
// longest ladder, and the thing a finger is aiming at is a column of the track,
// not a square.
function ReasoningLevelStop(props: ReasoningLevelStopProps) {
  const { option, index, percent, selected, overFill, disabled, onSelect } =
    props;
  return (
    <TooltipWrapper
      label={option.label}
      side="top"
      sideOffset={6}
      align="center"
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label={option.label}
        data-testid={`model-reasoning-stop-${index}`}
        disabled={disabled}
        style={{ left: `${percent}%` }}
        className={cn(
          "group pointer-events-auto absolute top-1/2 flex h-full w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full disabled:cursor-not-allowed pointer-coarse:w-6",
          // The selected stop keeps its slot - the thumb is drawn on top of it
          // and takes the pointer, so a visible dot under there would only be
          // a smudge at the edge of the thumb.
          selected && "opacity-0",
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
            "size-1.5 rounded-full transition-colors",
            overFill ? "bg-primary-foreground/35" : "bg-foreground/25",
            !disabled &&
              (overFill
                ? "group-hover:bg-primary-foreground/70"
                : "group-hover:bg-foreground/55"),
          )}
        />
      </button>
    </TooltipWrapper>
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
