import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { SimulatorStatusResponse } from "@traycer/protocol/host/simulator/schemas";
import { useHostLeases } from "@/hooks/host/use-host-lease";
import { useSelectionAuthorityAttached } from "@/hooks/host/use-selection-authority-attached";
import { mintDraftId } from "@/lib/drafts/draft-ids";
import { simulatorSetupPromptContent } from "@/lib/simulator-view/simulator-setup-agent";
import { activateTabIntent, draftTabIntent } from "@/lib/tab-navigation";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import {
  emptyLandingDraftWorkspaceSnapshot,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { isSurfacePinDeposed } from "@/stores/host/surface-host-selection-store";

/**
 * Settings ▸ Mobile simulators' "Set up with an agent": a new start-page
 * draft for a chat agent on `hostId`, seeded with the setup prompt, opened
 * as the person's next task. Nothing is sent; the person reads and sends it.
 *
 * The host is the one Settings is showing, never the app's, and the draft
 * row names it (`LandingDraftTab.namedHostId`): its composer cannot be
 * pointed elsewhere and refuses Send while that host is offline. A host whose
 * lease is already gone is refused here (`hostReachable` false, `start`
 * writes nothing). The draft is always minted fresh, so a draft the person
 * already has - the installed mobile app's one composer included - is never
 * written into.
 */
export function useStartSimulatorSetupAgent(hostId: string | null): {
  readonly hostReachable: boolean;
  readonly start: (input: {
    readonly hostName: string;
    readonly status: SimulatorStatusResponse;
  }) => void;
} {
  const navigate = useNavigate();
  const leases = useHostLeases();
  const authorityAttached = useSelectionAuthorityAttached();
  const hostReachable =
    hostId !== null &&
    !isSurfacePinDeposed(hostId, { authorityAttached, leases });
  const start = useCallback(
    (input: {
      readonly hostName: string;
      readonly status: SimulatorStatusResponse;
    }): void => {
      if (hostId === null) return;
      // Asked again at the gesture, from the fleet the pin resolves against,
      // so a lease lost since the last render cannot place the draft.
      const authority = useSelectionAuthorityStore.getState();
      if (
        isSurfacePinDeposed(hostId, {
          authorityAttached: authority.attached,
          leases: authority.leases,
        })
      ) {
        return;
      }
      const draftId = mintDraftId();
      const drafts = useLandingDraftStore.getState();
      try {
        drafts.installLandingDraft({
          id: draftId,
          content: simulatorSetupPromptContent({
            hostId,
            hostName: input.hostName,
            status: input.status,
          }),
          selection: null,
          lastTouchedAt: Date.now(),
          settings: useComposerRunSettingsStore
            .getState()
            .getGlobalRunSettings(hostId),
          // A chat agent, whatever mode the person last used: only a chat
          // agent gets the simulator tools on a host where they are not on
          // yet, and can ask the person to turn them on.
          composerMode: "chat",
          workspace: emptyLandingDraftWorkspaceSnapshot(),
          closed: false,
          returnedSandbox: null,
          // Named in the same write that creates the row, so no render of the
          // draft ever resolves the window's placement instead. The window's
          // own pin is left alone.
          namedHostId: hostId,
          // The button can make the draft again, but a row storage refused is
          // still the one the person is about to read and send.
          durability: "in-memory",
        });
      } catch {
        // Storage refused the row; it stays readable until the window closes.
      }
      drafts.restoreDraftWorkspaceForHost(draftId, hostId);
      activateTabIntent(navigate, draftTabIntent(draftId), undefined);
    },
    [hostId, navigate],
  );
  return { hostReachable, start };
}
