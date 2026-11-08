import { useCallback } from "react";
import type { UseMutationResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { DraftsPutBlobResponseV12 } from "@traycer/protocol/host/drafts/schemas";

import { useHostMutationWithResponseTimeout } from "@/hooks/host/use-host-query";
import type { HostRpcRegistry } from "@/lib/host";
import { DRAFT_BLOB_PUT_RESPONSE_TIMEOUT_MS } from "@/lib/drafts/draft-blob-transport-budget";
import {
  PUT_BLOB_FILE_FLOOR,
  type PutFileBlob,
  type PutFileBlobVariables,
} from "@/lib/composer/file-attachment-upload";
import { draftsMutationKeys } from "@/lib/query-keys";

/**
 * One file's `drafts.putBlob`, on the host the variables name.
 *
 * - The digest is the idempotency key: a transport replay of the same body
 *   stores the same bytes under the same address.
 * - The `@1.2` floor refuses the frame on an older host before it is sent,
 *   rather than letting that host strip `kind` and keep the bytes as an image.
 * - The two-minute budget is the one the policy table declares for the
 *   method; up to 22 MB of base64 rides one request.
 * - The caller's signal abandons the upload when the person removes the chip.
 *
 * No toast here: the upload queue (`lib/composer/file-attachment-upload.ts`)
 * owns what a failure says, because the same failure reads differently at
 * attach and at send.
 */
export function useDraftsPutFileBlob(): UseMutationResult<
  DraftsPutBlobResponseV12,
  HostRpcError,
  PutFileBlobVariables
> {
  return useHostMutationWithResponseTimeout<
    HostRpcRegistry,
    "drafts.putBlob",
    unknown,
    PutFileBlobVariables
  >({
    client: (variables) => variables.target.client,
    method: "drafts.putBlob",
    responseTimeoutMs: DRAFT_BLOB_PUT_RESPONSE_TIMEOUT_MS,
    signalFor: (variables) => variables.signal,
    idempotencyKey: (variables) => variables.request.sha256,
    requiredHostMethodVersion: () => PUT_BLOB_FILE_FLOOR,
    mapVariables: (variables) => variables.request,
    options: {
      mutationKey: draftsMutationKeys.putFileBlob(),
      gcTime: 0,
    },
  });
}

/**
 * The mutation as the upload queue calls it. Reset after every upload: the
 * mutation's variables hold the body, up to 22 MB of base64, which nothing
 * needs once the host has answered.
 */
export function usePutFileBlob(
  mutation: UseMutationResult<
    DraftsPutBlobResponseV12,
    HostRpcError,
    PutFileBlobVariables
  >,
): PutFileBlob {
  const { mutateAsync, reset } = mutation;
  return useCallback<PutFileBlob>(
    (variables) =>
      mutateAsync(variables).finally(() => {
        reset();
      }),
    [mutateAsync, reset],
  );
}
