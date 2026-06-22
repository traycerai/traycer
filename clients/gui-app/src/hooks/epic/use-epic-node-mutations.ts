import { useHostMutation } from "@/hooks/host/use-host-query";
import { useHostClient } from "@/lib/host/runtime";
import { toastFromHostError } from "@/lib/host-error-toast";

/**
 * Mutation hook for epic.createArtifact.
 * Pending state is on the affordance; success is silent (the Y.Doc
 * stream delivers the new row); failure shows a toast.
 */
export function useEpicCreateArtifact() {
  const client = useHostClient();
  return useHostMutation({
    client,
    method: "epic.createArtifact",
    mapVariables: (variables) => variables,
    options: {
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
  const client = useHostClient();
  return useHostMutation({
    client,
    method: "epic.deleteArtifact",
    mapVariables: (variables) => variables,
    options: {
      onError: (error) => {
        toastFromHostError(error, "Couldn't delete artifact.");
      },
    },
  });
}

/**
 * Mutation hook for epic.updateArtifactStatus.
 * Only valid for ticket and story artifacts.
 * Pill enters pending state; success is silent.
 */
export function useEpicUpdateArtifactStatus() {
  const client = useHostClient();
  return useHostMutation({
    client,
    method: "epic.updateArtifactStatus",
    mapVariables: (variables) => variables,
    options: {
      onError: (error) => {
        toastFromHostError(error, "Couldn't update status.");
      },
    },
  });
}

/**
 * Mutation hook for epic.renameArtifact.
 * Input/title enters pending (read-only) state; success is silent.
 */
export function useEpicRenameArtifact() {
  const client = useHostClient();
  return useHostMutation({
    client,
    method: "epic.renameArtifact",
    mapVariables: (variables) => variables,
    options: {
      onError: (error) => {
        toastFromHostError(error, "Couldn't rename artifact.");
      },
    },
  });
}
