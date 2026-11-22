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
 * - The idempotency key is the put's whole identity
 *   ({@link filePutIdempotencyKey}), so a replay reuses it and another put of
 *   the same bytes does not collide with it.
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
    idempotencyKey: (variables) => filePutIdempotencyKey(variables.request),
    requiredHostMethodVersion: () => PUT_BLOB_FILE_FLOOR,
    mapVariables: (variables) => variables.request,
    options: {
      mutationKey: draftsMutationKeys.putFileBlob(),
      gcTime: 0,
    },
  });
}

/** The host's ceiling on a retained idempotency key, in characters. */
const HOST_IDEMPOTENCY_KEY_MAX_LENGTH = 512;

/**
 * The key for one file put: kind, digest, type and name. The host refuses a
 * reused key whose params differ, so a digest alone collided with a second
 * file of the same bytes under another name, or with the image path's put of
 * them, and the second attachment was removed. Null past the host's ceiling
 * (a very long name): the put is content-addressed, so an unkeyed replay only
 * stores the same bytes again.
 */
export function filePutIdempotencyKey(
  request: PutFileBlobVariables["request"],
): string | null {
  const key = JSON.stringify([
    "file",
    request.sha256,
    request.mediaType,
    request.fileName,
  ]);
  return key.length <= HOST_IDEMPOTENCY_KEY_MAX_LENGTH ? key : null;
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
