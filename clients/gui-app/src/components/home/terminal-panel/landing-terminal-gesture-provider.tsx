import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import type { TerminalScope } from "@traycer/protocol/host/terminal/unary-schemas";
import { useHostClient, useHostDirectory } from "@/lib/host";
import { buildTransientHostClient } from "@/hooks/host/use-host-client-for";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useTerminalListFor } from "@/hooks/terminal/use-terminal-list-for-query";
import { useHomeWorkspaceSource } from "@/components/home/host-workspace-selector/use-home-workspace-source";
import type { WorktreeStagingKey } from "@/stores/worktree/worktree-intent-staging-store";
import {
  landingTerminalLayoutFor,
  useLandingTerminalStore,
} from "@/stores/home/landing-terminal-store";
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
 * While a gesture pins the panel, host/client/availability stay captured while
 * the workspace source remains live for that captured draft. Otherwise the
 * target is live focus, so ordinary (non-gesture) operation is unchanged.
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
  const [pendingGesture, setPendingGesture] =
    useState<LandingTerminalTarget | null>(null);
  const gestureGenerationRef = useRef(0);
  // The draft the current open episode belongs to; the empty-panel auto-spawn
  // is pinned to it (see the settlement handler's folderless guard). It is set
  // on capture (which already re-renders) and survives the gesture clear, so it
  // is state rather than a render-read ref.
  const [openEpisodeDraftId, setOpenEpisodeDraftId] = useState(draftId);

  const capturedLandingPageId =
    pendingGesture?.draftId ?? "unbound-landing-page";
  const capturedPanelOpen = useLandingTerminalStore((state) =>
    pendingGesture === null
      ? false
      : landingTerminalLayoutFor(state, capturedLandingPageId).panelOpen,
  );

  // A gesture only pins while the page it opened is still open. Its terminal
  // reconciliation can therefore complete after focus moves to another start
  // page, whose visible panel may be collapsed and independently laid out.
  const openGesture = capturedPanelOpen ? pendingGesture : null;

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
  const liveWorkspacePaths = workspace.folders;

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
      workspacePaths: [...liveWorkspacePaths],
      launchWorkspacePath: liveWorkspacePath,
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
    liveWorkspacePaths,
  ]);

  const selectWorkspacePath = useCallback(
    (workspacePath: string): LandingTerminalTarget | null => {
      if (
        pendingGesture === null ||
        !liveWorkspacePaths.includes(workspacePath)
      ) {
        return null;
      }
      const next: LandingTerminalTarget = {
        ...pendingGesture,
        primaryWorkspacePath: liveWorkspacePath,
        workspacePaths: [...liveWorkspacePaths],
        launchWorkspacePath: workspacePath,
        generation: gestureGenerationRef.current + 1,
      };
      gestureGenerationRef.current = next.generation;
      setPendingGesture(next);
      return next;
    },
    [liveWorkspacePath, liveWorkspacePaths, pendingGesture],
  );

  const clearPending = useCallback(() => {
    setPendingGesture(null);
  }, []);

  // While no gesture pins, the target is live focus (default client, generation
  // 0) so nothing outside a gesture changes. While a gesture pins, it is the
  // captured routing snapshot with a pinned-or-null client; the chooser reads
  // current folder metadata separately from `workspace` above.
  const target = useMemo<LandingTerminalTarget>(
    () =>
      openGesture === null
        ? {
            draftId,
            hostId: activeHostId,
            primaryWorkspacePath: liveWorkspacePath,
            workspacePaths: liveWorkspacePaths,
            launchWorkspacePath: liveWorkspacePath,
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
      liveWorkspacePaths,
      openGesture,
    ],
  );

  const value = useMemo<LandingTerminalGestureValue>(
    () => ({
      focusedLandingPageId: draftId,
      target,
      pending: openGesture !== null,
      pendingGeneration: openGesture === null ? null : openGesture.generation,
      openEpisodeDraftId,
      workspace,
      capture,
      selectWorkspacePath,
      clearPending,
    }),
    [
      capture,
      clearPending,
      draftId,
      openEpisodeDraftId,
      openGesture,
      selectWorkspacePath,
      target,
      workspace,
    ],
  );

  return (
    <LandingTerminalGestureContext value={value}>
      {props.children}
    </LandingTerminalGestureContext>
  );
}
