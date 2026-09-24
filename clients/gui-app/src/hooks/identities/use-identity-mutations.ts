/**
 * Write hooks for the `agentIdentity.*` family, all `…ForClient` for the
 * reason `use-identity-queries.ts` gives.
 *
 * Every response in this family carries its own `refused` arm, so a mutation
 * resolving is not the same as the write having happened. Surfaces read the
 * response kind; these hooks only own the transport, the key, the toast on a
 * transport-class failure, and which reads a success invalidates.
 *
 * `invalidateMethods` names the LIST and the HISTORY reads. The open
 * identity's own rows do not need invalidating: they ride the index lane,
 * which the host pushes after every committed write.
 */
import type { UseMutationResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { identityMutationKeys } from "@/lib/query-keys";

type IdentityMutation<Method extends keyof HostRpcRegistry & string> =
  UseMutationResult<
    ResponseOfMethod<HostRpcRegistry, Method>,
    HostRpcError,
    RequestOfMethod<HostRpcRegistry, Method>,
    { readonly hostId: string | null }
  >;

const LIST_INVALIDATIONS: ReadonlyArray<keyof HostRpcRegistry & string> = [
  "agentIdentity.list",
];
const HISTORY_INVALIDATIONS: ReadonlyArray<keyof HostRpcRegistry & string> = [
  "agentIdentity.history.list",
];
const NO_INVALIDATIONS: ReadonlyArray<keyof HostRpcRegistry & string> = [];

export function useIdentityCreateForClient(
  client: HostClient<HostRpcRegistry> | null,
): IdentityMutation<"agentIdentity.create"> {
  return useHostScopedMutationForClient(client, {
    method: "agentIdentity.create",
    mutationKey: identityMutationKeys.create(),
    errorMessage: "Couldn't create the identity.",
    invalidateMethods: LIST_INVALIDATIONS,
  });
}

export function useIdentityUpdateForClient(
  client: HostClient<HostRpcRegistry> | null,
): IdentityMutation<"agentIdentity.update"> {
  return useHostScopedMutationForClient(client, {
    method: "agentIdentity.update",
    mutationKey: identityMutationKeys.update(),
    errorMessage: "Couldn't save the identity.",
    invalidateMethods: LIST_INVALIDATIONS,
  });
}

export function useIdentityDeleteForClient(
  client: HostClient<HostRpcRegistry> | null,
): IdentityMutation<"agentIdentity.delete"> {
  return useHostScopedMutationForClient(client, {
    method: "agentIdentity.delete",
    mutationKey: identityMutationKeys.delete(),
    errorMessage: "Couldn't delete the identity.",
    invalidateMethods: LIST_INVALIDATIONS,
  });
}

export function useIdentityFileAddForClient(
  client: HostClient<HostRpcRegistry> | null,
): IdentityMutation<"agentIdentity.files.add"> {
  return useHostScopedMutationForClient(client, {
    method: "agentIdentity.files.add",
    mutationKey: identityMutationKeys.addFile(),
    errorMessage: "Couldn't add the file.",
    invalidateMethods: NO_INVALIDATIONS,
  });
}

export function useIdentityFileRenameForClient(
  client: HostClient<HostRpcRegistry> | null,
): IdentityMutation<"agentIdentity.files.rename"> {
  return useHostScopedMutationForClient(client, {
    method: "agentIdentity.files.rename",
    mutationKey: identityMutationKeys.renameFile(),
    errorMessage: "Couldn't rename the file.",
    invalidateMethods: HISTORY_INVALIDATIONS,
  });
}

export function useIdentityFileDeleteForClient(
  client: HostClient<HostRpcRegistry> | null,
): IdentityMutation<"agentIdentity.files.delete"> {
  return useHostScopedMutationForClient(client, {
    method: "agentIdentity.files.delete",
    mutationKey: identityMutationKeys.deleteFile(),
    errorMessage: "Couldn't delete the file.",
    invalidateMethods: HISTORY_INVALIDATIONS,
  });
}

/**
 * One CHUNK of a blob upload. The policy table runs this method `fifo`, so a
 * caller that awaits `mutateAsync` per chunk in sequence order gets the
 * chunks delivered in that order under one `uploadId`; see
 * `lib/identities/upload-blob.ts` for the loop.
 */
export function useIdentityUploadBlobChunkForClient(
  client: HostClient<HostRpcRegistry> | null,
): IdentityMutation<"agentIdentity.files.uploadBlob"> {
  return useHostScopedMutationForClient(client, {
    method: "agentIdentity.files.uploadBlob",
    mutationKey: identityMutationKeys.uploadBlob(),
    errorMessage: "Couldn't upload the file.",
    invalidateMethods: NO_INVALIDATIONS,
  });
}

export function useIdentityHistoryLoadOlderForClient(
  client: HostClient<HostRpcRegistry> | null,
): IdentityMutation<"agentIdentity.history.list"> {
  return useHostScopedMutationForClient(client, {
    method: "agentIdentity.history.list",
    mutationKey: identityMutationKeys.loadOlderHistory(),
    errorMessage: "Couldn't load older versions.",
    invalidateMethods: NO_INVALIDATIONS,
  });
}

export function useIdentityHistoryRestoreForClient(
  client: HostClient<HostRpcRegistry> | null,
): IdentityMutation<"agentIdentity.history.restore"> {
  return useHostScopedMutationForClient(client, {
    method: "agentIdentity.history.restore",
    mutationKey: identityMutationKeys.restoreHistory(),
    errorMessage: "Couldn't restore this version.",
    invalidateMethods: HISTORY_INVALIDATIONS,
  });
}

/**
 * The skill installer's two calls. Both are rendered inline by the skill
 * composer (`provider-skill-composer-dialog.tsx`), which shows the host's own
 * message for a failed clone or an invalid source, so an `RPC_ERROR` is not
 * toasted a second time.
 */
export function useIdentitySkillsInspectForClient(
  client: HostClient<HostRpcRegistry> | null,
): IdentityMutation<"agentIdentity.skills.inspect"> {
  return useHostScopedMutationForClient(client, {
    method: "agentIdentity.skills.inspect",
    mutationKey: identityMutationKeys.inspectSkills(),
    errorMessage: "Couldn't read that skill source.",
    invalidateMethods: NO_INVALIDATIONS,
    silentCodes: ["RPC_ERROR"],
  });
}

/**
 * Answers once the host's projection holds the installed files, so the new
 * rows arrive on the index lane before the dialog closes; nothing to
 * invalidate.
 */
export function useIdentitySkillsImportForClient(
  client: HostClient<HostRpcRegistry> | null,
): IdentityMutation<"agentIdentity.skills.import"> {
  return useHostScopedMutationForClient(client, {
    method: "agentIdentity.skills.import",
    mutationKey: identityMutationKeys.importSkills(),
    errorMessage: "Couldn't install the skill.",
    invalidateMethods: NO_INVALIDATIONS,
    silentCodes: ["RPC_ERROR"],
  });
}

/**
 * The Hermes profile importer's two calls. `scan` is a read, but it is a
 * mutation here because it runs on demand over a directory the user typed,
 * not over a key a query could cache by. A run may create an identity, so it
 * invalidates the list.
 */
export function useIdentityHermesScanForClient(
  client: HostClient<HostRpcRegistry> | null,
): IdentityMutation<"agentIdentity.import.hermes.scan"> {
  return useHostScopedMutationForClient(client, {
    method: "agentIdentity.import.hermes.scan",
    mutationKey: identityMutationKeys.scanHermesProfile(),
    errorMessage: "Couldn't read that Hermes profile.",
    invalidateMethods: NO_INVALIDATIONS,
    silentCodes: ["RPC_ERROR"],
  });
}

export function useIdentityHermesRunForClient(
  client: HostClient<HostRpcRegistry> | null,
): IdentityMutation<"agentIdentity.import.hermes.run"> {
  return useHostScopedMutationForClient(client, {
    method: "agentIdentity.import.hermes.run",
    mutationKey: identityMutationKeys.runHermesImport(),
    errorMessage: "Couldn't import the Hermes profile.",
    invalidateMethods: LIST_INVALIDATIONS,
    silentCodes: ["RPC_ERROR"],
  });
}
