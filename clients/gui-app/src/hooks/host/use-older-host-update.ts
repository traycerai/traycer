import { useRunnerApplyStaged } from "@/hooks/runner/use-runner-apply-staged-mutation";
import { useUpdateHostVersionPolicy } from "@/hooks/auth/use-update-host-version-mutation";
import { useReactiveLocalHostId } from "@/hooks/host/use-reactive-local-host-id";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { isRemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { MINIMUM_HOST_VERSION } from "@traycer-clients/shared/host-client/minimum-host-version";

export interface OlderHostUpdate {
  readonly update: () => void;
  readonly pending: boolean;
  readonly remotePending: boolean;
  readonly failure: {
    readonly message: string;
    readonly code: string | null;
  } | null;
}

/** Neither update path opens an authenticated connection to the old host. */
export function useOlderHostUpdate(hostId: string): OlderHostUpdate {
  const localHostId = useReactiveLocalHostId();
  const entry = useHostDirectoryEntry(hostId);
  const localUpdate = useRunnerApplyStaged();
  const remoteUpdate = useUpdateHostVersionPolicy(hostId);
  const local = hostId === localHostId;
  const target = resolveOlderHostUpdateTarget();
  const outcome = localUpdate.data;
  let failure: OlderHostUpdate["failure"] = null;
  if (local && outcome !== undefined && outcome.kind !== "ok") {
    failure = {
      message: outcome.message,
      code: outcome.kind === "failed" ? outcome.errorCode : null,
    };
  }
  const error = local ? localUpdate.error : remoteUpdate.error;
  if (error !== null) failure = { message: error.message, code: null };
  const remotePending =
    !local &&
    entry !== null &&
    isRemoteHostDirectoryEntry(entry) &&
    entry.remoteStatus.updateState === "pending";
  return {
    update: () => {
      if (local) {
        localUpdate.mutate({ trigger: "manual", force: false });
      } else {
        remoteUpdate.mutate({
          desiredVersion: target,
          updatePolicy: undefined,
          force: undefined,
        });
      }
    },
    pending: local ? localUpdate.isPending : remoteUpdate.isPending,
    remotePending,
    failure,
  };
}

// The paired release asks for the first host version this app can use.
function resolveOlderHostUpdateTarget(): string {
  return MINIMUM_HOST_VERSION;
}
