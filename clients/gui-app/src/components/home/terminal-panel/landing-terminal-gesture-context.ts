import { createContext, use } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import type { HomeWorkspaceSource } from "@/components/home/host-workspace-selector/use-home-workspace-source";
import type { LandingTerminalAvailability } from "./landing-terminal-availability";

/**
 * The routing target every landing-terminal consumer acts on. It is the ONLY
 * shape a consumer may read host/client/workspace/availability from: the
 * provider is the single reader of live focus/probe/runtime state, so a
 * consumer literally has no live value in scope to accidentally use. That is
 * what makes the terminal-gesture snapshot leak-proof by construction rather
 * than by auditing each consumer.
 *
 * - While a gesture is PENDING (panel opened / `+`): the fields are the frozen
 *   captured snapshot — the draft/host/folder/availability captured at
 *   panel-open, a `generation` for settlement matching, and a `client` PINNED
 *   to the captured host (or `null` = fail-closed, no pinned client).
 * - While NO gesture is pending: the fields are live focus (normal non-gesture
 *   operation), with `client` the app-wide default client and `generation` 0 —
 *   nothing outside a gesture changes.
 */
export interface LandingTerminalTarget {
  readonly draftId: string | null;
  readonly hostId: string | null;
  readonly primaryWorkspacePath: string | null;
  readonly availability: LandingTerminalAvailability;
  readonly generation: number;
  readonly client: HostClient<HostRpcRegistry> | null;
}

export interface LandingTerminalGestureValue {
  /** The effective routing target (captured snapshot while pending, else live). */
  readonly target: LandingTerminalTarget;
  /** Whether an opening gesture is currently pinning the target. */
  readonly pending: boolean;
  /** The pending gesture's generation (for settlement matching), else `null`. */
  readonly pendingGeneration: number | null;
  /**
   * The draft the current open episode belongs to. The empty-panel auto-spawn
   * is pinned to it so navigating to a different draft never spawns there.
   */
  readonly openEpisodeDraftId: string | null;
  /**
   * The workspace source for the EFFECTIVE draft (captured draft while pending).
   * Consumers (the folder picker) write through this so a folder lands in the
   * captured draft, not the focused partner.
   */
  readonly workspace: HomeWorkspaceSource;
  /**
   * Capture a fresh opening gesture from current live focus and return it. The
   * only path that reads live host/folder/client — used by panel-open and the
   * reveal-and-create chord. Consumers never capture; they read `target`.
   */
  readonly capture: () => LandingTerminalTarget;
  /** Clear the pending gesture (settlement, collapse, or user tab pick). */
  readonly clearPending: () => void;
}

export const LandingTerminalGestureContext =
  createContext<LandingTerminalGestureValue | null>(null);

/**
 * Read the landing-terminal gesture routing. Throws outside the provider so a
 * consumer can never silently fall back to reading live state.
 */
export function useLandingTerminalGesture(): LandingTerminalGestureValue {
  const value = use(LandingTerminalGestureContext);
  if (value === null) {
    throw new Error(
      "useLandingTerminalGesture must be used within a LandingTerminalGestureProvider",
    );
  }
  return value;
}

/** The effective routing target — the value every host/client/folder read goes through. */
export function useCapturedTerminalTarget(): LandingTerminalTarget {
  return useLandingTerminalGesture().target;
}
