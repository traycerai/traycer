import { useCallback, useEffect, useRef, useState } from "react";
import type { StatusBarDensity } from "@/components/layout/status-bar/status-bar-density";

/**
 * How much of each reading the usage cluster is currently drawing.
 *
 * An ordered ladder, most detail first. The strip drops one rung at a time
 * until what it holds fits the room it has, which is a different response from
 * the width thresholds beside it: those describe how much room the strip HAS,
 * and whether that is enough depends entirely on how much there is to draw. A
 * Claude account on a large plan reports five-plus windows from one provider,
 * so a bar wide enough to stay `full` can still be unable to show every
 * provider at once.
 *
 * Each rung takes away exactly one thing, in the order the user judged least
 * to most useful:
 *
 * - `full` — `57% used 6d 4h`, with the mini bar.
 * - `no-mode-word` — the `used` / `remaining` word goes. The number and the
 *   setting that chose it already say which way it reads.
 * - `no-bars` — the mini bar goes. It duplicates the percentage beside it.
 * - `no-timers` — the countdown gives way to the window's static name.
 * - `percent-only` — icon and coloured percentage, nothing else, and one
 *   reading per provider regardless of "show all windows": several bare
 *   numbers under one icon say which limits exist but not which is which.
 * - `icon-only` — the icon alone. Below this the cluster folds whole providers
 *   into a `+N` chip rather than inventing a shorter rung.
 */
export type StatusBarUsageDetail =
  | "full"
  | "no-mode-word"
  | "no-bars"
  | "no-timers"
  | "percent-only"
  | "icon-only";

/** The ladder, most detail first. */
const USAGE_DETAIL_ORDER: ReadonlyArray<StatusBarUsageDetail> = [
  "full",
  "no-mode-word",
  "no-bars",
  "no-timers",
  "percent-only",
  "icon-only",
];

/**
 * What a level draws, as five independent answers rather than a rank the render
 * path would have to compare against.
 *
 * `percent` is what separates `icon-only` from everything above it, and `label`
 * covers the countdown AND the static name it falls back to - `no-timers`
 * removes the countdown, `percent-only` removes what is left.
 */
export interface StatusBarUsageDetailParts {
  readonly modeWord: boolean;
  readonly bar: boolean;
  readonly timer: boolean;
  readonly label: boolean;
  readonly percent: boolean;
}

export function statusBarUsageDetailParts(
  detail: StatusBarUsageDetail,
): StatusBarUsageDetailParts {
  switch (detail) {
    case "full":
      return {
        modeWord: true,
        bar: true,
        timer: true,
        label: true,
        percent: true,
      };
    case "no-mode-word":
      return {
        modeWord: false,
        bar: true,
        timer: true,
        label: true,
        percent: true,
      };
    case "no-bars":
      return {
        modeWord: false,
        bar: false,
        timer: true,
        label: true,
        percent: true,
      };
    case "no-timers":
      return {
        modeWord: false,
        bar: false,
        timer: false,
        label: true,
        percent: true,
      };
    case "percent-only":
      return {
        modeWord: false,
        bar: false,
        timer: false,
        label: false,
        percent: true,
      };
    case "icon-only":
      return {
        modeWord: false,
        bar: false,
        timer: false,
        label: false,
        percent: false,
      };
  }
}

/**
 * The display preferences a rung can be a no-op for.
 *
 * A rung that takes away something already switched off in Settings changes
 * nothing on screen, so stepping onto it would cost a measurement and a render
 * and leave the cluster exactly as wide as it was. The ladder skips those.
 */
export interface StatusBarUsagePreferences {
  readonly showModeWord: boolean;
  readonly showBar: boolean;
  readonly showTimer: boolean;
}

export function statusBarUsageLadderLevels(
  preferences: StatusBarUsagePreferences,
): ReadonlyArray<StatusBarUsageDetail> {
  return USAGE_DETAIL_ORDER.filter((detail) => {
    if (detail === "no-mode-word") return preferences.showModeWord;
    if (detail === "no-bars") return preferences.showBar;
    if (detail === "no-timers") return preferences.showTimer;
    return true;
  });
}

/**
 * The most detail the responsive density will allow, before the ladder has
 * measured anything.
 *
 * The two mechanisms are not rivals: density is what the strip knows from its
 * own width at first paint, and the ladder is what it learns from what it is
 * holding. Density therefore sets the ceiling and the ladder is free to go
 * further down from it - never back above it.
 */
export function statusBarUsageDetailCeiling(
  density: StatusBarDensity,
): StatusBarUsageDetail {
  switch (density) {
    case "full":
      return "full";
    case "compact":
      return "no-timers";
    case "icon-only":
      return "icon-only";
  }
}

/** One rung, plus how many providers are folded away at it. */
export interface StatusBarUsageStop {
  readonly detail: StatusBarUsageDetail;
  readonly foldedCount: number;
}

/**
 * Every state the cluster can settle in, in the order it walks them.
 *
 * The rungs at or below the ceiling first, then one stop per provider that can
 * be folded into the `+N` chip. The last provider never folds: a chip alone
 * would name no reading at all, and the panel is what the whole trigger is for.
 *
 * The ceiling is honoured through the ACTIVE levels rather than by rank, which
 * matters when a preference has already removed the rung it names: with the
 * timer switched off, `no-bars` renders exactly what `no-timers` would, so a
 * `compact` strip starts there instead of skipping to `percent-only`.
 */
export function statusBarUsageLadderStops(input: {
  readonly ceiling: StatusBarUsageDetail;
  readonly levels: ReadonlyArray<StatusBarUsageDetail>;
  readonly segmentCount: number;
}): ReadonlyArray<StatusBarUsageStop> {
  const ceilingRank = USAGE_DETAIL_ORDER.indexOf(input.ceiling);
  const startIndex = input.levels.reduce(
    (start, detail, index) =>
      USAGE_DETAIL_ORDER.indexOf(detail) <= ceilingRank ? index : start,
    0,
  );
  const foldableCount = Math.max(0, input.segmentCount - 1);
  return [
    ...input.levels
      .slice(startIndex)
      .map((detail) => ({ detail, foldedCount: 0 })),
    ...Array.from({ length: foldableCount }, (_unused, index) => ({
      detail: "icon-only" as const,
      foldedCount: index + 1,
    })),
  ];
}

/**
 * A `scrollWidth`/`clientWidth` comparison is integer-rounded on both sides, so
 * a box holding subpixel content reports a phantom pixel of overflow.
 */
const OVERFLOW_SLACK_PX = 1;

/**
 * How much wider than the width that forced a step down the container has to
 * get before that step is given back.
 *
 * Without it the ladder oscillates by construction: the width at which detail
 * was dropped is, within a pixel, the width at which restoring it overflows
 * again. A whole word of the smallest text on the strip is around this wide, so
 * a step back up is only ever attempted with room for the thing being restored.
 */
const STEP_UP_SLACK_PX = 24;

/**
 * The next set of recorded step-down widths, given one measurement.
 *
 * The state IS the record: one entry per step taken, holding the AVAILABLE
 * WIDTH at which it was taken. Its LENGTH says how far down the ladder the
 * cluster is, and its last entry is the width that has to be beaten - by
 * `STEP_UP_SLACK_PX` - before that step comes back.
 *
 * "Available" is load-bearing and is why the hook measures two boxes rather
 * than one. Both branches below assume this number answers *how much room is
 * there*, and a shrink-to-fit box answers *how wide is my content* instead -
 * which is the same number only while it is overflowing. Feed it the latter and
 * the ladder becomes a one-way ratchet: after a step down settles, the content
 * fits by definition, so the recorded width can never be beaten and the strip
 * stays collapsed for the rest of the session however wide the window gets.
 *
 * Returns the same array when nothing changes, so a measurement that agrees
 * with the current state cannot schedule a render.
 */
export function nextStatusBarUsageSteps(
  steps: ReadonlyArray<number>,
  measurement: {
    readonly availableWidth: number;
    readonly overflowing: boolean;
    readonly maxSteps: number;
  },
): ReadonlyArray<number> {
  if (measurement.overflowing) {
    // At the last stop there is nothing left to drop; recording more widths
    // would only make the walk back up longer than the walk down.
    if (steps.length >= measurement.maxSteps) return steps;
    return [...steps, measurement.availableWidth];
  }
  const recorded = steps.at(-1);
  if (recorded === undefined) return steps;
  if (measurement.availableWidth <= recorded + STEP_UP_SLACK_PX) return steps;
  return steps.slice(0, -1);
}

/**
 * The record of a cluster that has nothing to step. One shared instance, so
 * resetting a ladder that is already inert is a no-op rather than a render.
 */
const NO_STEPS: ReadonlyArray<number> = [];

export interface StatusBarUsageLadder {
  readonly stop: StatusBarUsageStop;
  /**
   * The box that holds however much ROOM the cluster has, and grows with the
   * window rather than with what is inside it. Its `clientWidth` is the number
   * the hysteresis records, so it must be a stretching box - a shrink-to-fit
   * one reports its own content the moment that content fits, and the ladder
   * can then never step back up.
   */
  readonly roomRef: (node: HTMLElement | null) => (() => void) | undefined;
  /**
   * Whatever sits inside the room that is NOT the readings - the refresh
   * control and the gap before it. Its width is taken off the room before the
   * verdict, because the readings may only have what it leaves; skip it and the
   * ladder settles one notch too generous and the strip clips by exactly this
   * box at the trigger's `overflow-hidden` edge.
   *
   * Read rather than observed: it is a fixed-size control, so its box changes
   * only when the code around it does, and a third observer would fire for
   * nothing. A `null` node reserves nothing, which is the honest answer for a
   * cluster that is not drawing one.
   */
  readonly reservedRef: (node: HTMLElement | null) => (() => void) | undefined;
  /**
   * The readings themselves, at their natural width. Its `scrollWidth` against
   * what the room leaves them is the overflow verdict, and it is observed as
   * well as the room because the two events are disjoint: a countdown ticking
   * from `4h 15m` to `4h` changes this box and not the room, and a window
   * resize changes the room without re-rendering anything.
   */
  readonly contentRef: (node: HTMLElement | null) => (() => void) | undefined;
}

/**
 * Which stop the cluster is standing on, stepped by measurement alone.
 *
 * **Driven from the observer callbacks, never from an effect.** A measurement
 * taken in a `useLayoutEffect` could only publish its verdict by writing the
 * DOM - the repo's `react-hooks/set-state-in-effect` rule is enforced, and the
 * clip-fade this replaces was reshaped by exactly that constraint - and a DOM
 * write cannot change what is RENDERED, which is the whole of what this
 * decides. `ResizeObserver` callbacks are not effects, so the state lives where
 * it belongs and the feedback loop closes through the observers themselves:
 * stepping down changes the content, the content observer sees it, and the next
 * verdict is taken against what is actually on screen.
 *
 * That loop terminates. Down is bounded by the stop list; up is bounded by the
 * recorded width plus a slack that is re-recorded, larger, every time the same
 * step is retaken - so the same width can never step down and back up forever.
 *
 * It also costs ONE RUNG PER DELIVERY, which is a real and accepted limit: a
 * narrow first paint walks down over several frames of visibly shrinking text.
 * Converging inside a single callback is not merely unimplemented - it is
 * unmeasurable, because the width of a rung the DOM is not currently rendering
 * is not a number anything here can read. The only way to close that gap is a
 * `flushSync` re-render per rung from inside a `ResizeObserver` callback, which
 * buys a frame by forcing synchronous layout in the one place the browser most
 * dislikes it. If the cascade ever needs to go, that is the trade to weigh.
 *
 * The walk can also make Chrome log `ResizeObserver loop completed with
 * undelivered notifications` while it descends - a warning about a loop that
 * did not settle within one frame, not an error, and this one settles on the
 * next. It is worth knowing because Vite's dev overlay surfaces it as a red
 * error box in development, where it reads as a crash and is neither.
 *
 * Both refs are CALLBACK refs with cleanups, and both are stable for a given
 * `enabled`. One of the nodes below is inside the subtree Radix replaces after
 * its first commit (`PopoverAnchor` publishes itself in an effect, so
 * `PopoverTrigger` wraps its child in a Popper anchor only from the second
 * commit onward), and an effect-attached observer would sit on the discarded
 * node forever. Stability matters as much: React detaches and re-attaches an
 * unstable ref callback on every render, which would rebuild both observers
 * each time the countdown ticked - so `enabled` is the ONLY reactive input
 * here, and it is reactive on purpose, since flipping it is exactly when the
 * observers have to come and go.
 */
export function useStatusBarUsageLadder(input: {
  readonly ceiling: StatusBarUsageDetail;
  readonly levels: ReadonlyArray<StatusBarUsageDetail>;
  readonly segmentCount: number;
  /**
   * Whether there is anything a rung could change. A cluster showing one
   * sentence - no provider configured, or every one hidden - renders the same
   * string at every rung, so measuring it would record widths against steps
   * that free no space, and those widths would then be applied to the first
   * frame of the real segments that arrive next.
   */
  readonly enabled: boolean;
}): StatusBarUsageLadder {
  const enabled = input.enabled;
  const stops = statusBarUsageLadderStops(input);
  const [steps, setSteps] = useState<ReadonlyArray<number>>(NO_STEPS);
  // Read inside a callback that must never change identity, so it travels by
  // ref rather than by closure. Seeded with the first render's value because
  // the room's ref callback measures before any effect has run.
  const maxStepsRef = useRef(stops.length - 1);
  useEffect(() => {
    maxStepsRef.current = stops.length - 1;
  }, [stops.length]);

  const roomNodeRef = useRef<HTMLElement | null>(null);
  const reservedNodeRef = useRef<HTMLElement | null>(null);
  const contentNodeRef = useRef<HTMLElement | null>(null);
  const evaluate = useCallback(() => {
    const room = roomNodeRef.current;
    const content = contentNodeRef.current;
    if (room === null || content === null) return;
    // One question per box. How much room there is comes from the box that
    // stretches, less whatever shares it with the readings; whether the
    // readings fit comes from their natural width, which only the box that is
    // never squeezed can report. Asking one box both questions is what the
    // ratchet was, and forgetting the second subtraction is a clip.
    const availableWidth =
      room.clientWidth - (reservedNodeRef.current?.offsetWidth ?? 0);
    setSteps((current) =>
      nextStatusBarUsageSteps(current, {
        availableWidth,
        overflowing: content.scrollWidth > availableWidth + OVERFLOW_SLACK_PX,
        maxSteps: maxStepsRef.current,
      }),
    );
  }, []);

  const reservedRef = useCallback(
    (node: HTMLElement | null) => {
      reservedNodeRef.current = node !== null && enabled ? node : null;
      // No observer and no cleanup to return: nothing here changes size on its
      // own, and the node is dropped by the next call either way.
      return undefined;
    },
    [enabled],
  );

  const roomRef = useCallback(
    (node: HTMLElement | null) => {
      roomNodeRef.current = null;
      // React runs the cleanup instead of a `null` call for a ref that returns
      // one, so that arm is the type's older contract rather than a path taken.
      if (node === null || !enabled) {
        // Nothing to step means nothing to remember. Same reference, so a
        // cluster that was already inert does not re-render for this.
        setSteps(NO_STEPS);
        return undefined;
      }
      roomNodeRef.current = node;
      evaluate();
      const observer = new ResizeObserver(evaluate);
      observer.observe(node);
      return () => {
        observer.disconnect();
        roomNodeRef.current = null;
      };
    },
    [enabled, evaluate],
  );

  const contentRef = useCallback(
    (node: HTMLElement | null) => {
      contentNodeRef.current = null;
      if (node === null || !enabled) return undefined;
      contentNodeRef.current = node;
      // No measurement on attach: refs are attached child-first, so the room
      // is not recorded yet. Its own attach measures for both.
      const observer = new ResizeObserver(evaluate);
      observer.observe(node);
      return () => {
        observer.disconnect();
        contentNodeRef.current = null;
      };
    },
    [enabled, evaluate],
  );

  return {
    // Clamped rather than reset when the stop list shrinks - a provider
    // dropping out of the strip must not throw away the hysteresis that the
    // remaining ones are standing on. The stop list also moves when the
    // responsive density changes the CEILING, and `steps` counts rungs below
    // whatever the ceiling currently is: a strip two rungs down that narrows
    // past 900px stays two rungs below the new, lower ceiling. That is
    // deliberate - position relative to the ceiling is the thing worth
    // preserving, and it unwinds symmetrically when the window widens again.
    stop: stops[Math.min(steps.length, stops.length - 1)],
    roomRef,
    reservedRef,
    contentRef,
  };
}
