import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ReasoningLevel,
  ReasoningLevelOption,
} from "@/components/home/data/landing-options";
import { usePaneFocused } from "@/components/epic-tabs/pane-visibility-context";
import { usePortalConcealed } from "@/components/ui/portal-concealment-context";
import { useReducedMotion } from "@/lib/animation/status-animation-clock";
import { useLayoutStore } from "@/stores/settings/layout-store";

/**
 * One captured max-effort cue: a monotonic generation, and the world it was
 * captured in. The generation is what lets a finishing animation retire its
 * OWN bloom and only that one.
 */
export interface ReasoningMaxCue {
  readonly generation: number;
  /** Host + harness/model + the ordered catalog ids, as one comparable string. */
  readonly contextKey: string;
}

/**
 * The footer's half of the max cue: what to draw and how to report it done.
 * Capturing and invalidating live in `useReasoningMaxCue`, above the footer,
 * because the ⌥-digit chord changes the level without going near this
 * component.
 */
export interface ReasoningMaxCueConfig {
  /** The cue to draw, or `null` at rest. */
  readonly cue: ReasoningMaxCue | null;
  /** The world as it is NOW, compared against the cue's own. */
  readonly contextKey: string;
  /** The picker's `visibleOpen` - false while the popover plays its exit. */
  readonly open: boolean;
  readonly onCueEnd: (generation: number) => void;
}

/**
 * Whether the selected level is the catalog's LAST one, read off the full
 * unsorted catalog the harness reported.
 *
 * A zero-effort id (`off` / `none`) counts at its catalog position rather than
 * being filtered out the way the chip's ladder filters it: the slider's stops
 * ARE the catalog, so "the last stop" is the only thing max can mean here. An
 * unknown id indexes at `-1` and is never max, and a one-level catalog has no
 * max at all - its single stop is the whole range, so arriving at it is not an
 * arrival.
 */
export function isMaxReasoningLevel(
  value: ReasoningLevel,
  options: ReadonlyArray<ReasoningLevelOption>,
): boolean {
  if (options.length < 2) return false;
  return (
    options.findIndex((option) => option.id === value) === options.length - 1
  );
}

export interface ReasoningMaxCueInput {
  readonly value: ReasoningLevel;
  readonly options: ReadonlyArray<ReasoningLevelOption>;
  readonly disabled: boolean;
  /** The picker's `visibleOpen`, NOT the popover's mounted state. */
  readonly open: boolean;
  readonly hostId: string | null;
  readonly harnessId: string;
  readonly modelSlug: string;
  /** The real setter. Called with the same id for every change, cue or not. */
  readonly onSelect: (next: ReasoningLevel) => void;
}

export interface ReasoningMaxCueResult {
  readonly config: ReasoningMaxCueConfig;
  /**
   * The ONE acknowledgement path. Every route that changes the level - the
   * slider's stops and keys, the list's buttons, the ⌥-digit chord through
   * `usePickerLeaderScope` - reaches the setter through
   * `ReasoningFooterConfig.onChange`, so wrapping it here is what makes "the
   * user did this" a fact rather than a guess about which component called.
   */
  readonly onChange: (next: ReasoningLevel) => void;
}

/**
 * The max-effort cue: one 640ms bloom when a person moves the slider to its
 * last stop, and nothing else.
 *
 * The cue is CAPTURED on the change and RENDERED only while it still applies,
 * which are two different questions. Capturing takes a gesture - arriving at
 * max by hydration, a catalog refresh or a model swap is not an arrival, and
 * a value that walks to max on its own must not celebrate. Rendering takes the
 * world still being the one the gesture happened in: the same host, harness,
 * model and catalog, still at max, still open, still enabled, still on the
 * slider, still not under reduced motion. A gate that closes CLEARS the cue
 * rather than hiding it, so re-opening the gate cannot replay it.
 *
 * No clock, no timer, no `requestAnimationFrame`: the animation is finite CSS
 * and its own `animationend` retires it, the same lifecycle the dock chip's
 * pulse uses. `useStatusAnimation` is for continuous motion and is deliberately
 * not used here.
 */
export function useReasoningMaxCue(
  input: ReasoningMaxCueInput,
): ReasoningMaxCueResult {
  const { value, options, disabled, open, hostId, harnessId, modelSlug } =
    input;
  const control = useLayoutStore(
    (state) => state.composer.reasoningFooterControl,
  );
  const reducedMotion = useReducedMotion();
  const [cue, setCue] = useState<ReasoningMaxCue | null>(null);
  const generationRef = useRef(0);
  // The selection as of the last thing that happened, gesture or not. A ref
  // rather than the `value` prop because two callbacks can land in one batch -
  // a drag reaching the endpoint reports it more than once - and the second
  // would still read the pre-render value and capture a second cue.
  const selectedRef = useRef(value);
  const onSelect = input.onSelect;

  const contextKey = useMemo(
    () =>
      // One comparable string rather than an object, so the comparison is a
      // plain `===` wherever it is made. Level ids and the three names before
      // them carry no `|`, and the parts before the catalog are positional, so
      // two different worlds cannot render the same key.
      [hostId ?? "", harnessId, modelSlug, ...options.map((o) => o.id)].join(
        "|",
      ),
    [hostId, harnessId, modelSlug, options],
  );

  // The two signals `PopoverContent` itself un-presents on (`paneFocused`,
  // `concealed`): its content unmounts while the picker's root stays OPEN, and
  // this state lives above the portal, so without them a cue captured before a
  // pane lost focus would still be here to play when it came back.
  const paneFocused = usePaneFocused();
  const concealed = usePortalConcealed();
  const presented = paneFocused && !concealed;
  const cueAllowed =
    open && presented && !disabled && control === "slider" && !reducedMotion;

  useEffect(() => {
    selectedRef.current = value;
  }, [value]);

  const cueIsLive =
    cue !== null &&
    cueAllowed &&
    cue.contextKey === contextKey &&
    isMaxReasoningLevel(value, options);

  // Invalidation, not suppression: a cue the world moved out from under is
  // DROPPED, so nothing reappears when the gate opens again. Adjusted during
  // render rather than from an effect - the same pattern the dock chip's pulse
  // uses - because the cue belongs to the commit that paints the new state.
  if (cue !== null && !cueIsLive) setCue(null);

  const onChange = useCallback(
    (next: ReasoningLevel) => {
      const previous = selectedRef.current;
      selectedRef.current = next;
      // From a level the catalog LISTS: a value that named nothing (one
      // remembered from another model, before normalization catches up) is not
      // a rung someone climbed off, so landing on max out of it is a correction
      // rather than an arrival.
      const fromKnownLevel = options.some((option) => option.id === previous);
      if (
        previous !== next &&
        fromKnownLevel &&
        cueAllowed &&
        isMaxReasoningLevel(next, options)
      ) {
        generationRef.current += 1;
        setCue({ generation: generationRef.current, contextKey });
      }
      onSelect(next);
    },
    [contextKey, cueAllowed, onSelect, options],
  );

  const onCueEnd = useCallback((generation: number) => {
    // Only the generation that finished: an animation that ends after the user
    // has already left max and come back must not erase the new bloom.
    setCue((current) =>
      current !== null && current.generation === generation ? null : current,
    );
  }, []);

  const config = useMemo<ReasoningMaxCueConfig>(
    () => ({ cue: cueIsLive ? cue : null, contextKey, open, onCueEnd }),
    [cue, cueIsLive, contextKey, open, onCueEnd],
  );

  return { config, onChange };
}
