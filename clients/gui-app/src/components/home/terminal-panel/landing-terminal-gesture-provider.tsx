import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import type { TerminalScope } from "@traycer/protocol/host/terminal/unary-schemas";
import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";
import { useHostDirectory } from "@/lib/host";
import { buildDialableHostClient } from "@/hooks/host/use-host-client-for";
import { useComposerPlacement } from "@/hooks/host/use-composer-placement";
import { useTerminalListFor } from "@/hooks/terminal/use-terminal-list-for-query";
import { useHomeWorkspaceSource } from "@/components/home/host-workspace-selector/use-home-workspace-source";
import type { WorktreeStagingKey } from "@/stores/worktree/worktree-intent-staging-store";
import {
  UNBOUND_LANDING_PAGE_ID,
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

function resolveWorkspaceLaunchPath(
  workspacePath: string | null,
  intent: WorktreeIntent | null,
): string | null {
  const entry = intent?.entries.find(
    (entry) => entry.workspacePath === workspacePath,
  );
  // Folder identity stays the repository path. Only an import already names
  // another directory; a new worktree is materialized when an agent launches.
  return entry?.kind === "import" ? entry.worktreePath : workspacePath;
}

/** Because the live hooks are called only here, no consumer has a live value in scope to accidentally read
 * instead of the captured target - the terminal-gesture leak class is closed by construction. */
export function LandingTerminalGestureProvider(props: {
  readonly draftId: string | null;
  readonly children: ReactNode;
}): ReactNode {
  const { draftId } = props;
  // The composer'S placement - this window's surface pin, or the effective host while it follows - not the
  // app-wide selection.
  const placement = useComposerPlacement(null);
  const activeHostId = placement.target.resolvedHostId;
  const defaultClient = placement.submitTarget.client;
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
  // It is set on capture (which already re-renders) and survives the gesture clear, so it is state rather than a
  // render-read ref.
  const [openEpisodeDraftId, setOpenEpisodeDraftId] = useState(draftId);

  const capturedLandingPageId =
    pendingGesture?.draftId ?? UNBOUND_LANDING_PAGE_ID;
  const capturedPanelOpen = useLandingTerminalStore((state) =>
    pendingGesture === null
      ? false
      : landingTerminalLayoutFor(state, capturedLandingPageId).panelOpen,
  );

  // A gesture only pins while the page it opened is still open.
  const openGesture = capturedPanelOpen ? pendingGesture : null;

  // The workspace source follows the effective draft (the captured draft while a gesture pins), so the folder
  // picker writes the captured draft's workspace, not the focused partner's.
  const effectiveDraftId = openGesture === null ? draftId : openGesture.draftId;
  // ...and the effective host, for the same reason.
  const workspaceHostId =
    openGesture === null ? activeHostId : openGesture.hostId;
  const stagingKey = useMemo<WorktreeStagingKey>(
    () => ({
      surface: "landing",
      hostId: workspaceHostId,
      draftId: effectiveDraftId,
    }),
    [effectiveDraftId, workspaceHostId],
  );
  const workspace = useHomeWorkspaceSource(stagingKey, null, workspaceHostId);
  const liveWorkspacePath = workspace.primaryWorkspacePath;
  const liveWorkspacePaths = workspace.folders;
  const capturedIntent = workspace.capturedIntent;
  const liveLaunchWorkspacePath = resolveWorkspaceLaunchPath(
    liveWorkspacePath,
    capturedIntent,
  );

  // A same-host downgrade is then remembered after focus moves away and back, instead of reverting to the
  // initial captured verdict; a different live host never writes here, so it can never gate the captured host.
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
    // No default-client fallback: the default client's endpoint follows live runtime selection, so a fallback
    // would let a later host switch reconcile the wrong host.
    const pinnedClient =
      entry === null || defaultClient === null
        ? null
        : buildDialableHostClient(defaultClient, entry);
    // `workspace` above tracks a pinned gesture's captured host, and the one path that captures while another
    // gesture pins (`togglePanel` on a start page whose own panel is closed) can be capturing a different host.
    const ownWorkspace = workspaceHostId === activeHostId;
    const capturedPath = ownWorkspace ? liveWorkspacePath : null;
    const gesture: LandingTerminalTarget = {
      draftId,
      hostId: activeHostId,
      primaryWorkspacePath: capturedPath,
      workspacePaths: ownWorkspace ? [...liveWorkspacePaths] : [],
      launchWorkspacePath: ownWorkspace ? liveLaunchWorkspacePath : null,
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
    liveLaunchWorkspacePath,
    liveWorkspacePath,
    liveWorkspacePaths,
    workspaceHostId,
  ]);

  const selectWorkspacePath = useCallback(
    (workspacePath: string): LandingTerminalTarget | null => {
      if (
        pendingGesture === null ||
        // A gesture whose page has since closed no longer pins the source, so it can be pinned to a different host
        // than the one these paths came from.
        pendingGesture.hostId !== workspaceHostId ||
        !liveWorkspacePaths.includes(workspacePath)
      ) {
        return null;
      }
      const next: LandingTerminalTarget = {
        ...pendingGesture,
        primaryWorkspacePath: liveWorkspacePath,
        workspacePaths: [...liveWorkspacePaths],
        launchWorkspacePath: resolveWorkspaceLaunchPath(
          workspacePath,
          capturedIntent,
        ),
        generation: gestureGenerationRef.current + 1,
      };
      gestureGenerationRef.current = next.generation;
      setPendingGesture(next);
      return next;
    },
    [
      capturedIntent,
      liveWorkspacePath,
      liveWorkspacePaths,
      pendingGesture,
      workspaceHostId,
    ],
  );

  const clearPending = useCallback(() => {
    setPendingGesture(null);
  }, []);

  // While a gesture pins, it is the captured routing snapshot with a pinned-or-null client; the chooser reads
  // current folder metadata separately from `workspace` above.
  const target = useMemo<LandingTerminalTarget>(
    () =>
      openGesture === null
        ? {
            draftId,
            hostId: activeHostId,
            primaryWorkspacePath: liveWorkspacePath,
            workspacePaths: liveWorkspacePaths,
            launchWorkspacePath: liveLaunchWorkspacePath,
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
      liveLaunchWorkspacePath,
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
