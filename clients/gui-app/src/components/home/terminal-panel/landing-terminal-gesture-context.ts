import { createContext, use } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import type { HomeWorkspaceSource } from "@/components/home/host-workspace-selector/use-home-workspace-source";
import type { LandingTerminalAvailability } from "./landing-terminal-availability";

/** The provider keeps reading folder metadata from that captured draft so an open chooser tracks pin/add/remove
 * changes without following newly focused draft or host state. */
export interface LandingTerminalTarget {
  readonly draftId: string | null;
  readonly hostId: string | null;
  readonly primaryWorkspacePath: string | null;
  readonly workspacePaths: ReadonlyArray<string>;
  readonly launchWorkspacePath: string | null;
  readonly availability: LandingTerminalAvailability;
  readonly generation: number;
  readonly client: HostClient<HostRpcRegistry> | null;
}

export interface LandingTerminalGestureValue {
  readonly focusedLandingPageId: string | null;
  /** The effective routing target (captured snapshot while pending, else live). */
  readonly target: LandingTerminalTarget;
  readonly pending: boolean;
  readonly pendingGeneration: number | null;
  /** The draft the current open episode belongs to. The empty-panel auto-spawn is pinned to it so navigating to a
   * different draft never spawns there. */
  readonly openEpisodeDraftId: string | null;
  /** The workspace source for the effective draft (captured draft while pending). Consumers (the folder picker)
   * write through this so a folder lands in the captured draft, not the focused partner. */
  readonly workspace: HomeWorkspaceSource;
  /** Capture a fresh opening gesture from current live focus and return it. Consumers never capture; they read
   * `target`. */
  readonly capture: () => LandingTerminalTarget;
  readonly selectWorkspacePath: (
    workspacePath: string,
  ) => LandingTerminalTarget | null;
  readonly clearPending: () => void;
}

export const LandingTerminalGestureContext =
  createContext<LandingTerminalGestureValue | null>(null);

/** Throws outside the provider so a consumer can never silently fall back to reading live state. */
export function useLandingTerminalGesture(): LandingTerminalGestureValue {
  const value = use(LandingTerminalGestureContext);
  if (value === null) {
    throw new Error(
      "useLandingTerminalGesture must be used within a LandingTerminalGestureProvider",
    );
  }
  return value;
}

export function useCapturedTerminalTarget(): LandingTerminalTarget {
  return useLandingTerminalGesture().target;
}
