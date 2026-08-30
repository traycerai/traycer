import { useHostMutation } from "@/hooks/host/use-host-query";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { toastFromHostError } from "@/lib/host-error-toast";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { epicMutationKeys } from "@/lib/query-keys";

/**
 * EVERY MUTATION HERE ADDRESSES THE EPIC SESSION'S HOST, never the app-wide
 * one, because an artifact is a row IN an Epic and the Epic is projected from
 * exactly one machine.
 *
 * These used to resolve `useHostClient()`. That is the ambient effective host,
 * and it and the session host disagree for a bounded but entirely reachable
 * window: `EpicSessionProvider` keeps the previous handle registered and
 * RENDERED while its replacement establishes, and after a re-point that
 * failed. Only the canvas is made inert for that window (`epic-shell.tsx`
 * passes `readOnly` to the tile subtree alone) - the sidebar is hoisted beside
 * it and stays fully interactive. So a Delete clicked on a row projected from
 * host A was sent to host B: at best a not-found failure, at worst a delete
 * applied to whatever B has under that id.
 *
 * Every call site of these four hooks is inside the Epic shell (sidebar tree,
 * artifact tiles, the canvas tab rename), so there is no consumer for which
 * "the surrounding session" is the wrong question - checked rather than
 * assumed.
 *
 * A null client (no surrounding session) is REFUSED by `useHostMutation`
 * rather than silently redirected, which is the difference that matters here:
 * `useHostClientForHostId(null)` would have followed the effective host and
 * reproduced the defect on the exact render where the session is absent.
 */

/**
 * Mutation hook for epic.createArtifact.
 * Pending state is on the affordance; success is silent (the Y.Doc
 * stream delivers the new row); failure shows a toast.
 */
export function useEpicCreateArtifact() {
  const client = useEpicSessionHostClient();
  return useHostMutation({
    client,
    method: "epic.createArtifact",
    mapVariables: (variables) => variables,
    options: {
      onSuccess: (_data, variables) => {
        Analytics.getInstance().track(AnalyticsEvent.ArtifactCreated, {
          kind: variables.artifactType,
        });
      },
      onError: (error) => {
        toastFromHostError(error, "Couldn't create artifact.");
      },
    },
  });
}

/**
 * Mutation hook for epic.deleteArtifact.
 * Caller opens a confirm dialog first; on Delete the button enters
 * pending state; success is silent.
 */
export function useEpicDeleteArtifact() {
  const client = useEpicSessionHostClient();
  return useHostScopedMutationForClient(client, {
    method: "epic.deleteArtifact",
    mutationKey: epicMutationKeys.deleteArtifact(),
    errorMessage: "Couldn't delete artifact.",
    invalidateMethods: ["epic.deletedArtifacts.list"],
    onSuccess: () => {
      Analytics.getInstance().track(AnalyticsEvent.ArtifactDeleted, null);
    },
  });
}

/**
 * Mutation hook for epic.updateArtifactStatus.
 * Only valid for ticket and story artifacts.
 * Pill enters pending state; success is silent.
 */
export function useEpicUpdateArtifactStatus() {
  const client = useEpicSessionHostClient();
  return useHostMutation({
    client,
    method: "epic.updateArtifactStatus",
    mapVariables: (variables) => variables,
    options: {
      onSuccess: (_data, variables) => {
        Analytics.getInstance().track(AnalyticsEvent.ArtifactStatusChanged, {
          kind: variables.artifactType,
          status: analyticsTicketStatus(variables.status),
        });
      },
      onError: (error) => {
        toastFromHostError(error, "Couldn't update status.");
      },
    },
  });
}

function analyticsTicketStatus(status: number): 0 | 1 | 2 {
  if (status === 1) return 1;
  if (status === 2) return 2;
  return 0;
}

/**
 * Mutation hook for epic.renameArtifact.
 * Input/title enters pending (read-only) state; success is silent.
 */
export function useEpicRenameArtifact(trackUserIntent: boolean) {
  const client = useEpicSessionHostClient();
  return useHostMutation({
    client,
    method: "epic.renameArtifact",
    mapVariables: (variables) => variables,
    options: {
      onSuccess: () => {
        if (trackUserIntent) {
          Analytics.getInstance().track(AnalyticsEvent.ArtifactRenamed, null);
        }
      },
      onError: (error) => {
        toastFromHostError(error, "Couldn't rename artifact.");
      },
    },
  });
}
