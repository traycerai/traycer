import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import type { TerminalScope } from "@traycer/protocol/host/terminal/unary-schemas";
import { useHostDirectory } from "@/lib/host";
import { buildTransientHostClient } from "@/hooks/host/use-host-client-for";
import { useComposerPlacement } from "@/hooks/host/use-composer-placement";
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
  // The COMPOSER'S placement - this window's surface pin, or the effective
  // host while it follows - not the app-wide selection. Every other surface on
  // the landing page moved to that pin (the composer, the hero, the folder
  // picker); this one still read `useAddressableHostId()` / `useHostClient()`,
  // so a landing page pinned to host B kept listing, dialing and CREATING
  // terminals on host A - bound to A for life - under a chip that said B, and
  // its folder picker staged under `{landing, A, draft}` while the composer's
  // staged under `{landing, B, draft}`: two pickers on one page describing two
  // machines. The FROZEN submit client throughout: this provider both lists
  // and creates through one client, and a create must provably land on the
  // host the chip resolved (`useComposerPlacement`); a derivation move
  // re-resolves the placement and hands this provider a new client.
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
  // ...and the EFFECTIVE host, for the same reason: folder paths are
  // host-local and now bucketed by host, so a pinned gesture's chooser must
  // list the folders of the host its terminal will actually launch on, not
  // the bucket of a host the landing picker has since switched to. Outside a
  // gesture the landing surface follows the app-wide active host. The staged
  // slot is keyed by the same pair, so a pick made under the gesture's host
  // cannot surface on the one the picker moved to.
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
    // The placement's submit client is itself null while its target is still
    // resolving - the same fail-closed answer.
    const pinnedClient =
      entry === null || defaultClient === null
        ? null
        : buildTransientHostClient(defaultClient, entry);
    // `workspace` above tracks a pinned gesture's captured host, and the one
    // path that captures while another gesture pins (`togglePanel` on a start
    // page whose own panel is closed) can be capturing a DIFFERENT host. Those
    // folders are then another machine's, so the new gesture starts folderless
    // instead of inheriting paths its host may not even have.
    const ownWorkspace = workspaceHostId === activeHostId;
    const capturedPath = ownWorkspace ? liveWorkspacePath : null;
    const gesture: LandingTerminalTarget = {
      draftId,
      hostId: activeHostId,
      primaryWorkspacePath: capturedPath,
      workspacePaths: ownWorkspace ? [...liveWorkspacePaths] : [],
      launchWorkspacePath: capturedPath,
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
    workspaceHostId,
  ]);

  const selectWorkspacePath = useCallback(
    (workspacePath: string): LandingTerminalTarget | null => {
      if (
        pendingGesture === null ||
        // The live list belongs to `workspaceHostId`. A gesture whose page has
        // since closed no longer pins the source, so it can be pinned to a
        // different host than the one these paths came from - and a path the
        // gesture's host may not have must never become its launch directory.
        pendingGesture.hostId !== workspaceHostId ||
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
    [liveWorkspacePath, liveWorkspacePaths, pendingGesture, workspaceHostId],
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
