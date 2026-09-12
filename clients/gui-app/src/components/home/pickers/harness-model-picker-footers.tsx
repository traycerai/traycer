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
  STATUS_ANIMATION_SMOOTH_CADENCE_MS,
  useReducedMotion,
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
import {
  isMaxReasoningLevel,
  type ReasoningMaxCue,
  type ReasoningMaxCueConfig,
} from "@/components/home/pickers/use-reasoning-max-cue";

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
  /** `null` for a footer mounted without the picker's cue state: no bloom is
   *  ever drawn, and the strip reads as presented. */
  readonly reasoningMax: ReasoningMaxCueConfig | null;
}

export function HarnessModelPickerModelSettingsFooter(
  props: HarnessModelPickerModelSettingsFooterProps,
) {
  const { reasoning, serviceTier, reasoningMax } = props;
  if (reasoning === null && serviceTier === null) return null;
  return (
    <ModelSettingsFooter
      reasoning={reasoning}
      serviceTier={serviceTier}
      reasoningMax={reasoningMax}
    />
  );
}

interface ModelSettingsFooterProps {
  readonly reasoning: ReasoningFooterConfig | null;
  readonly serviceTier: ServiceTierFooterConfig | null;
  readonly reasoningMax: ReasoningMaxCueConfig | null;
}

function ModelSettingsFooter(props: ModelSettingsFooterProps) {
  const { reasoning, serviceTier, reasoningMax } = props;
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
        <ReasoningFooterGroup config={reasoning} maxCue={reasoningMax} />
      )}
    </div>
  );
}

interface ReasoningFooterGroupProps {
  readonly config: ReasoningFooterConfig;
  readonly maxCue: ReasoningMaxCueConfig | null;
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
  const { config, maxCue } = props;
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
        <ReasoningLevelSlider config={config} maxCue={maxCue} />
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
  readonly maxCue: ReasoningMaxCueConfig | null;
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

// The sizers, which are the ONLY things the cell's width is measured from:
// stacked in one grid cell, so the column is as wide as the widest of them.
const REASONING_LEVEL_LABEL_SIZER =
  "col-start-1 row-start-1 invisible truncate";

// The name the user reads, laid over that cell and out of flow, so it cannot
// widen what the sizers reserved. A level the catalog does not list prints its
// raw id here, and a long one would otherwise be the widest thing in the grid -
// the cell would grow for it and SHRINK again on the next real selection, which
// is the exact track movement the sizers exist to prevent. Out of flow it
// truncates inside the reserved width instead.
const REASONING_LEVEL_LABEL_NAME = "absolute inset-0 truncate";

/** One pass of the flowing band, back from the max end. */
const REASONING_MAX_FLOW_PERIOD_MS = 1600;
/**
 * The band's travel, as a share of its OWN width (`w-2/5` of the track, so 100%
 * here is 40% of the track). It starts fully past the right edge and ends fully
 * past the left one, which is what makes the wrap invisible: at either end of a
 * pass there is nothing of the band inside the track to jump.
 */
const REASONING_MAX_FLOW_START_PERCENT = 250;
const REASONING_MAX_FLOW_TRAVEL_PERCENT = 350;

/** Right to left, linear, wrapping once per period. */
function reasoningMaxFlowOffsetPercent(elapsedMs: number): number {
  const progress =
    (elapsedMs % REASONING_MAX_FLOW_PERIOD_MS) / REASONING_MAX_FLOW_PERIOD_MS;
  return (
    REASONING_MAX_FLOW_START_PERCENT -
    progress * REASONING_MAX_FLOW_TRAVEL_PERCENT
  );
}

/**
 * The max treatment's moving half: a soft band of the accent flowing back down
 * the track, right to left, for as long as the highest level is selected. The
 * static halo and tail say "this is the top"; the flow is what makes it read as
 * live rather than as a colour someone chose.
 *
 * It rides the shared 25 Hz status clock and writes one inline `transform` per
 * tick - no CSS `animation`, which for continuous motion costs a main-thread
 * style recalc every display frame for as long as it runs (see
 * `status-animation-clock.ts`). The one-shot bloom keeps its keyframes: a
 * 640 ms animation that retires itself is exactly what that budget is for.
 *
 * Mounted only while the whole gate holds - the component's presence IS the
 * subscription, so "stop flowing" is an unmount and never a paused writer. The
 * clock's own reduced-motion and hidden-pane rules apply on top.
 */
function ReasoningMaxFlow() {
  const ref = useRef<HTMLSpanElement | null>(null);
  const write = useCallback((element: HTMLSpanElement, elapsedMs: number) => {
    element.style.transform = `translateX(${reasoningMaxFlowOffsetPercent(elapsedMs).toFixed(2)}%)`;
  }, []);
  // Back to the stylesheet's own resting position, with no inline style left
  // behind to park a visible band at the left edge.
  const clear = useCallback((element: HTMLSpanElement) => {
    element.style.removeProperty("transform");
  }, []);
  useStatusAnimation(ref, write, clear, STATUS_ANIMATION_SMOOTH_CADENCE_MS);

  return (
    // The lane is mirrored in RTL rather than the band: the writer's
    // percentages are physical, and flipping them about the TRACK's centre is
    // the only place the reflection is the one intended - a `scale` on the band
    // itself would mirror its travel about its own box, which sits at the left
    // edge. The tail flips the same way one rule below it in `index.css`, so
    // the flow still runs back from whichever end max is on.
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 rtl:-scale-x-100"
    >
      <span
        ref={ref}
        aria-hidden="true"
        data-testid="model-reasoning-max-flow"
        className="reasoning-effort-max-flow absolute inset-y-0 left-0 w-2/5"
      />
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
  const maxCue = props.maxCue;
  const selectedIndex = options.findIndex((option) => option.id === value);
  // A level the catalog does not list (remembered from another model, before
  // normalization catches up) parks the thumb at the first stop rather than
  // leaving the slider without a value - `findReasoningLabel` still prints the
  // raw level beside it, so the name and the position disagree visibly instead
  // of the control vanishing.
  const thumbIndex = selectedIndex === -1 ? 0 : selectedIndex;
  const lastIndex = options.length - 1;
  const gesture = useRef<PointerGesture>({ active: false, moved: false });
  const atMax = isMaxReasoningLevel(value, options);
  const open = maxCue === null || maxCue.open;
  // Drawn only while the cue still belongs to what is on screen. The owning
  // hook clears an invalidated cue; this is the second reading of the same
  // question, taken where the DOM is written.
  const cue = drawableMaxCue(maxCue, atMax);
  // The flowing band's gate. Deliberately NOT the cue's: the cue is one
  // arrival, retired the moment its animation ends, while the flow is the
  // state of being at max - it runs for a picker OPENED at max, which
  // celebrates nothing. What it shares with the cue is the presentation half
  // (the two signals `PopoverContent` checks before rendering at all, plus the
  // picker's own `visibleOpen`), because a writer ticking against a popover
  // nobody can see is the one thing the shared clock must never accumulate.
  const paneFocused = usePaneFocused();
  const concealed = usePortalConcealed();
  const reducedMotion = useReducedMotion();
  const flowing =
    atMax && open && !disabled && paneFocused && !concealed && !reducedMotion;

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
    <div className="flex min-w-0 flex-1 items-center gap-2 px-2">
      {/* The label is sized by the catalog, not by the level currently on:
          "Low" and "Medium" are different widths, so a cell that fits only the
          selected name moves the track - and every stop with it - each time the
          level changes, which is exactly what the control is being dragged to
          do. So every label the catalog offers is stacked in ONE grid cell
          (`col-start-1 row-start-1`), invisible and `aria-hidden`, and THEY are
          what the cell is measured from: it is as wide as the widest name this
          harness can show, for the model's whole ladder, with no measurement,
          no layout effect and no second render.

          The name the user reads is laid over that cell rather than being one
          of the stack: a level the catalog does not list prints its raw id
          (see `thumbIndex`), which has no sizer of its own, so in flow it could
          be wider than every one of them - the cell would grow for it and
          shrink again on the next real selection, reintroducing the movement
          from the other end. Out of flow it can only truncate inside what the
          sizers reserved.

          The cap is on the cell and `truncate` on every node alike, so a
          harness with a sentence for a label shortens the cell rather than
          starving the track - and shortens it to the same width whichever
          level is on. */}
      <span className="relative grid max-w-[min(30vw,7rem)] shrink-0 text-ui-xs text-muted-foreground">
        {options.map((option) => (
          <span
            key={option.id}
            aria-hidden="true"
            data-testid="model-reasoning-level-sizer"
            className={REASONING_LEVEL_LABEL_SIZER}
          >
            {option.label}
          </span>
        ))}
        <span
          data-testid="model-reasoning-level-name"
          className={REASONING_LEVEL_LABEL_NAME}
        >
          {findReasoningLabel(value, options)}
        </span>
      </span>
      {/* `py-3` is the bloom's room, not spacing: the ring reaches ~20px from
          the thumb's centre (a 16px thumb, `inset:-4px`, scaled to 1.65), and
          the popover clips it. 12px here plus the footer's own `py-1.5` puts
          the centre exactly 20px above the bottom edge at every width. The
          padding lives on the slider alone, so a footer that also carries the
          service-tier row does not add it twice, and the list keeps its own
          height. */}
      <Slider
        data-testid="model-reasoning-slider"
        className="reasoning-effort-slider min-w-0 flex-1 py-3"
        data-max={atMax ? "true" : undefined}
        data-open={open ? "true" : undefined}
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
        <SliderTrack>
          <SliderRange />
          {/* The end of the track takes the accent at max. Static, and a
              gradient rather than a second solid fill, so the neutral base and
              the stops stay readable under it. */}
          <span
            aria-hidden="true"
            data-testid="model-reasoning-max-tail"
            className="reasoning-effort-max-tail pointer-events-none absolute inset-0 rounded-full"
          />
          {/* Inside the track, so the track's own `overflow-hidden` is what
              clips the band at both ends; over the range and the tail, under
              the stops and the thumb, which are the slider's later siblings. */}
          {flowing ? <ReasoningMaxFlow /> : null}
        </SliderTrack>
        {/* Inset by half the thumb, which is where Radix keeps the thumb's own
            centre at the two ends (`getThumbInBoundsOffset`) - without it the
            first and last dot sit half a thumb outside the thumb's reach. */}
        <div className="pointer-events-none absolute inset-0 px-2">
          <div className="relative h-full">
            {options.map((option, index) => (
              <ReasoningLevelStop
                key={option.id}
                option={option}
                index={index}
                percent={lastIndex === 0 ? 0 : (index / lastIndex) * 100}
                selected={index === selectedIndex}
                disabled={disabled}
                onSelect={selectLevel}
                movedByGesture={gestureMovedValue}
              />
            ))}
          </div>
        </div>
        {/* The thumb keeps its own hit area, focus ring and Radix geometry;
            the visible disc is the core drawn inside it, so the max halo and
            the focus ring are separate channels that cannot displace each
            other. */}
        <SliderThumb
          aria-label="Thinking effort"
          aria-valuetext={findReasoningLabel(value, options)}
          className="border-0 bg-transparent shadow-none"
        >
          <span
            aria-hidden="true"
            data-testid="model-reasoning-thumb-core"
            className="reasoning-effort-thumb-core pointer-events-none absolute inset-0 rounded-full"
          />
          {cue === null ? null : (
            <span
              // Keyed by generation: leaving max and coming straight back is a
              // new node, so the animation restarts instead of being skipped
              // as an unchanged element.
              key={cue.generation}
              aria-hidden="true"
              data-pulse="true"
              data-testid="model-reasoning-max-bloom"
              className="reasoning-effort-bloom pointer-events-none absolute rounded-full"
              onAnimationEnd={(event) => {
                // This element's own bloom, and no other animation that
                // happens to end here - a popover or tooltip playing out
                // nearby must not retire the cue.
                if (event.target !== event.currentTarget) return;
                if (event.animationName !== "reasoning-max-bloom") return;
                maxCue?.onCueEnd(cue.generation);
              }}
            />
          )}
        </SliderThumb>
      </Slider>
    </div>
  );
}

/**
 * The cue to draw, or `null`. A cue survives only while the world it names is
 * still the one on screen: same host, harness, model and catalog, still at the
 * last stop, still presented.
 */
function drawableMaxCue(
  maxCue: ReasoningMaxCueConfig | null,
  atMax: boolean,
): ReasoningMaxCue | null {
  if (maxCue === null || maxCue.cue === null) return null;
  if (!atMax || !maxCue.open) return null;
  return maxCue.cue.contextKey === maxCue.contextKey ? maxCue.cue : null;
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
  readonly disabled: boolean;
  readonly onSelect: (index: number) => void;
  /** Whether the gesture that produced this click already set the level. */
  readonly movedByGesture: () => boolean;
}

// One dot. `pointer-events-auto` restores what the overlay above it gives up,
// so the bare track between two dots still belongs to the slider and a drag
// that crosses a dot is not interrupted.
function ReasoningLevelStop(props: ReasoningLevelStopProps) {
  const { option, index, percent, selected, disabled, onSelect } = props;
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
          "group pointer-events-auto absolute top-1/2 flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full disabled:cursor-not-allowed pointer-coarse:size-6",
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
        <span
          className={cn(
            "size-1.5 rounded-full bg-foreground/30 transition-colors",
            !disabled && "group-hover:bg-foreground/60",
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
