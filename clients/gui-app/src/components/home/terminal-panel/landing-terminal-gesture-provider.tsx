import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import type { TerminalScope } from "@traycer/protocol/host/terminal/unary-schemas";
import { useHostClient, useHostDirectory } from "@/lib/host";
import { buildTransientHostClient } from "@/hooks/host/use-host-client-for";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useTerminalListFor } from "@/hooks/terminal/use-terminal-list-for-query";
import { useHomeWorkspaceSource } from "@/components/home/host-workspace-selector/use-home-workspace-source";
import type { WorktreeStagingKey } from "@/stores/worktree/worktree-intent-staging-store";
import { useLandingTerminalStore } from "@/stores/home/landing-terminal-store";
import {
  LandingTerminalGestureContext,
  type LandingTerminalGestureValue,
  type LandingTerminalTarget,
} from "./landing-terminal-gesture-context";
import { resolveLandingTerminalAvailability } from "./landing-terminal-availability";

const INDEPENDENT_SCOPE: TerminalScope = { kind: "independent" };

/**
 * The SINGLE reader of live landing-terminal state (active host, default
 * client, host directory, the capability probe, and the workspace source). It
 * owns the opening-gesture snapshot and projects one `LandingTerminalTarget`
 * that every consumer reads through `useCapturedTerminalTarget()`. Because the
 * live hooks are called only here, no consumer has a live value in scope to
 * accidentally read instead of the captured target — the terminal-gesture leak
 * class is closed by construction.
 *
 * While a gesture pins the panel the target is frozen to the captured
 * host/folder/client/availability; otherwise it is live focus, so ordinary
 * (non-gesture) operation is unchanged.
 */
export function LandingTerminalGestureProvider(props: {
  readonly draftId: string | null;
  readonly children: ReactNode;
}): ReactNode {
  const { draftId } = props;
  const activeHostId = useReactiveActiveHostId();
  const defaultClient = useHostClient();
  const hostDirectory = useHostDirectory();
  const probe = useTerminalListFor(defaultClient, INDEPENDENT_SCOPE);
  const availability = resolveLandingTerminalAvailability(
    activeHostId,
    probe.data,
    probe.error,
  );
  const panelOpen = useLandingTerminalStore((state) => state.panelOpen);

  const [pendingGesture, setPendingGesture] =
    useState<LandingTerminalTarget | null>(null);
  const gestureGenerationRef = useRef(0);
  // The draft the current open episode belongs to; the empty-panel auto-spawn
  // is pinned to it (see the settlement handler's folderless guard). It is set
  // on capture (which already re-renders) and survives the gesture clear, so it
  // is state rather than a render-read ref.
  const [openEpisodeDraftId, setOpenEpisodeDraftId] = useState(draftId);

  // A gesture only pins while the panel is open; a closed panel projects live
  // focus even if a stale gesture lingers.
  const openGesture = panelOpen ? pendingGesture : null;

  // The workspace source follows the EFFECTIVE draft (the captured draft while a
  // gesture pins), so the folder picker writes the captured draft's workspace,
  // not the focused partner's.
  const effectiveDraftId = openGesture === null ? draftId : openGesture.draftId;
  const stagingKey = useMemo<WorktreeStagingKey>(
    () => ({ surface: "landing", draftId: effectiveDraftId }),
    [effectiveDraftId],
  );
  const workspace = useHomeWorkspaceSource(stagingKey, null);
  const liveWorkspacePath = workspace.primaryWorkspacePath;

  // Downgrade memory: keep the pending gesture's availability in step with the
  // captured host's LATEST observed verdict while that host stays selected. A
  // same-host downgrade is then remembered after focus moves away and back,
  // instead of reverting to the initial captured verdict; a DIFFERENT live host
  // never writes here, so it can never gate the captured host. Adjusting the
  // snapshot during render (React's "store info from previous renders" pattern,
  // not an effect) converges because the guard is false once availability is
  // mirrored.
  if (
    pendingGesture !== null &&
    activeHostId === pendingGesture.hostId &&
    pendingGesture.availability !== availability
  ) {
    setPendingGesture({ ...pendingGesture, availability });
  }

  const capture = useCallback((): LandingTerminalTarget => {
    const entry =
      activeHostId === null ? null : hostDirectory.findById(activeHostId);
    // Pin a transient client to the CAPTURED host. No default-client fallback:
    // the default client's endpoint follows live runtime selection, so a
    // fallback would let a later host switch reconcile the wrong host. A gesture
    // that cannot pin its host is fail-closed (null client -> disabled action).
    const pinnedClient =
      entry === null ? null : buildTransientHostClient(defaultClient, entry);
    const gesture: LandingTerminalTarget = {
      draftId,
      hostId: activeHostId,
      primaryWorkspacePath: liveWorkspacePath,
      availability,
      generation: gestureGenerationRef.current + 1,
      client: pinnedClient,
    };
    gestureGenerationRef.current = gesture.generation;
    setOpenEpisodeDraftId(draftId);
    setPendingGesture(gesture);
    return gesture;
  }, [
    activeHostId,
    availability,
    defaultClient,
    draftId,
    hostDirectory,
    liveWorkspacePath,
  ]);

  const clearPending = useCallback(() => {
    setPendingGesture(null);
  }, []);

  // While no gesture pins, the target is live focus (default client, generation
  // 0) so nothing outside a gesture changes. While a gesture pins, it is the
  // frozen snapshot with a pinned-or-null client.
  const target = useMemo<LandingTerminalTarget>(
    () =>
      openGesture === null
        ? {
            draftId,
            hostId: activeHostId,
            primaryWorkspacePath: liveWorkspacePath,
            availability,
            generation: 0,
            client: defaultClient,
          }
        : openGesture,
    [
      activeHostId,
      availability,
      defaultClient,
      draftId,
      liveWorkspacePath,
      openGesture,
    ],
  );

  const value = useMemo<LandingTerminalGestureValue>(
    () => ({
      target,
      pending: openGesture !== null,
      pendingGeneration: openGesture === null ? null : openGesture.generation,
      openEpisodeDraftId,
      workspace,
      capture,
      clearPending,
    }),
    [capture, clearPending, openEpisodeDraftId, openGesture, target, workspace],
  );

  return (
    <LandingTerminalGestureContext value={value}>
      {props.children}
    </LandingTerminalGestureContext>
  );
}
