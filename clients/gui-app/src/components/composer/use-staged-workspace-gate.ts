import {
  workspaceComposerCanStart,
  type WorkspaceComposerAvailability,
} from "@/lib/composer/workspace-composer-availability";
import { useStagedSandboxStore } from "@/stores/composer/staged-sandbox-store";

export interface StagedWorkspaceGate {
  readonly canStart: boolean;
  readonly disabledHint: string | null;
  /**
   * Whether a staged sandbox takes this send ahead of the handoff. The
   * source host's provider checks (its profile, its provider pack) gate
   * nothing then: the send runs again on the sandbox, under that host's.
   */
  readonly stagedAhead: boolean;
}

const EMPTY_SANDBOX_GATE: StagedWorkspaceGate = {
  canStart: true,
  disabledHint: null,
  stagedAhead: true,
};

/**
 * The workspace gate of a send or a Start. While a sandbox is staged and
 * has not handed off, it is the stage's: the sandbox starts empty, so the
 * folders this host resolves gate nothing. From the handoff on, the host's
 * own workspace gates the resubmit there.
 */
export function useStagedWorkspaceGate(
  surfaceKey: string | null,
  availability: WorkspaceComposerAvailability,
): StagedWorkspaceGate {
  const stagedAhead = useStagedSandboxStore((s) => {
    const stage = surfaceKey === null ? undefined : s.bySurface[surfaceKey];
    return stage !== undefined && stage.phase !== "handoff";
  });
  if (stagedAhead) return EMPTY_SANDBOX_GATE;
  return {
    canStart: workspaceComposerCanStart(availability),
    disabledHint: availability.disabledHint,
    stagedAhead: false,
  };
}
