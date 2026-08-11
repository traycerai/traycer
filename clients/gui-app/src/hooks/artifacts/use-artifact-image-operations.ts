import { useCallback } from "react";
import type {
  AbortArtifactImageResponse,
  CommitArtifactImageResponse,
  FinishArtifactImageRequest,
  PrepareArtifactImageRequest,
  PrepareArtifactImageResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { useEpicSessionHostId } from "@/hooks/epic/use-epic-session-host-id";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { bytesToBase64 } from "@/lib/composer/image-base64";
import { epicMutationKeys } from "@/lib/query-keys";

export const PREPARE_ARTIFACT_IMAGE_METHOD = "epic.prepareArtifactImage";
export const FINISH_ARTIFACT_IMAGE_METHOD = "epic.finishArtifactImage";

export type ArtifactImagePreparation = Extract<
  PrepareArtifactImageResponse,
  { readonly ok: true }
>;

export interface ArtifactImageOperations {
  readonly supported: boolean;
  readonly prepareBytes: (
    bytes: Uint8Array,
  ) => Promise<ArtifactImagePreparation>;
  readonly prepareRemote: (url: string) => Promise<ArtifactImagePreparation>;
  readonly commit: (
    artifactId: string,
    operationId: string,
  ) => Promise<CommitArtifactImageResponse>;
  readonly abort: (
    artifactId: string,
    operationId: string,
  ) => Promise<AbortArtifactImageResponse>;
}

export function useArtifactImageOperations(
  epicId: string,
): ArtifactImageOperations {
  const client = useEpicSessionHostClient();
  const hostId = useEpicSessionHostId();
  const prepareMutation = useHostMutation({
    client,
    method: PREPARE_ARTIFACT_IMAGE_METHOD,
    mapVariables: (variables: PrepareArtifactImageRequest) => variables,
    options: { mutationKey: epicMutationKeys.prepareArtifactImage() },
  });
  const finishMutation = useHostMutation({
    client,
    method: FINISH_ARTIFACT_IMAGE_METHOD,
    mapVariables: (variables: FinishArtifactImageRequest) => variables,
    options: { mutationKey: epicMutationKeys.finishArtifactImage() },
  });
  const prepareSupported = useHostSupportsMethod(
    hostId,
    PREPARE_ARTIFACT_IMAGE_METHOD,
  );
  const finishSupported = useHostSupportsMethod(
    hostId,
    FINISH_ARTIFACT_IMAGE_METHOD,
  );
  const prepare = useCallback(
    async (
      source: PrepareArtifactImageRequest["source"],
    ): Promise<ArtifactImagePreparation> => {
      const response = await prepareMutation.mutateAsync({ epicId, source });
      if (!response.ok) throw new Error(response.message);
      return response;
    },
    [epicId, prepareMutation],
  );
  const prepareBytes = useCallback(
    (bytes: Uint8Array) =>
      prepare({ kind: "bytes", base64: bytesToBase64(bytes) }),
    [prepare],
  );
  const prepareRemote = useCallback(
    (url: string) => prepare({ kind: "remote", url }),
    [prepare],
  );
  const commit = useCallback(
    async (
      artifactId: string,
      operationId: string,
    ): Promise<CommitArtifactImageResponse> => {
      const response = await finishMutation.mutateAsync({
        epicId,
        artifactId,
        operationId,
        commit: true,
      });
      if ("status" in response && response.status === "aborted") {
        throw new Error("The host returned an abort response for a commit.");
      }
      return response;
    },
    [epicId, finishMutation],
  );
  const abort = useCallback(
    async (
      artifactId: string,
      operationId: string,
    ): Promise<AbortArtifactImageResponse> => {
      const response = await finishMutation.mutateAsync({
        epicId,
        artifactId,
        operationId,
        commit: false,
      });
      if (
        !("status" in response) ||
        (response.status !== "aborted" &&
          response.status !== "unknown-operation")
      ) {
        throw new Error("The host returned a commit response for an abort.");
      }
      return response;
    },
    [epicId, finishMutation],
  );
  return {
    supported: prepareSupported && finishSupported,
    prepareBytes,
    prepareRemote,
    commit,
    abort,
  };
}
