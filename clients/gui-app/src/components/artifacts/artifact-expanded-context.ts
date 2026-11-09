import { createContext, use, useEffectEvent, useLayoutEffect } from "react";

export type ArtifactEscapeHandler = (event: KeyboardEvent) => boolean;

/**
 * The expansion an artifact surface lives in: one per surface, mounted whether
 * or not it is expanded, because the surface itself is what gets raised
 * (`artifact-expansion.tsx`).
 */
export interface ArtifactExpansionControls {
  /** Whether this surface is raised over the task right now. */
  readonly expanded: boolean;
  /** Raise it. Does nothing while something needs the reader. */
  readonly expand: () => void;
  /** Lower it and return focus to the toggle. */
  readonly collapse: () => void;
  /**
   * Registers the surface's Escape veto and returns its release
   * ({@link useArtifactEscape}). A function rather than the slot itself: the
   * slot belongs to the expansion, and a consumer reaching into a context
   * value to mutate it is what `react-hooks/immutability` exists to stop.
   */
  readonly registerEscape: (handler: ArtifactEscapeHandler) => () => void;
}

/**
 * Marks the control that raises the surface, so the expansion can hand focus
 * back to it on the way down without a ref crossing the context (which is
 * what `react-hooks/refs` stops). The toggle unmounts while the surface is up
 * and returns with it, so there is no element to hold on to anyway.
 */
export const EXPAND_TOGGLE_ATTRIBUTE = "data-artifact-expand";

export const ArtifactExpansionContext =
  createContext<ArtifactExpansionControls | null>(null);

export function useArtifactExpansion(): ArtifactExpansionControls | null {
  return use(ArtifactExpansionContext);
}

/**
 * Whether the surrounding artifact surface is raised over the task. One
 * surface changes where it paints rather than a copy being mounted somewhere
 * else, so this is a STATE of the surface, not a place in the tree: `false`
 * while it is inline, and `false` with no expansion above it.
 */
export function useArtifactExpanded(): boolean {
  return use(ArtifactExpansionContext)?.expanded ?? false;
}

/**
 * Gives a local mode inside the surface the first Escape, ahead of the
 * collapse: a canvas tool disarms, a selection clears, a sticky note commits
 * its text. The handler returns `true` when it took the press.
 *
 * Registered whenever an expansion is above and consulted only while that
 * expansion is raised, so an inline surface keeps handling Escape its own way.
 */
export function useArtifactEscape(handler: ArtifactEscapeHandler): void {
  const register = use(ArtifactExpansionContext)?.registerEscape ?? null;
  const handleEscape = useEffectEvent(handler);
  useLayoutEffect(() => {
    if (register === null) return;
    return register((event) => handleEscape(event));
  }, [register]);
}
