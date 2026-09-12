import { tryReserveLandingImageBudget } from "@/lib/composer/landing-image-budget";
import { scheduleLandingImageReconcile } from "@/lib/composer/landing-image-gc";
import type { DraftDocument } from "@traycer/protocol/host";
import type { DraftBlobClient } from "@/lib/drafts/draft-blob-transport";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { HostRpcRegistry } from "@/lib/host";
import { getHostBindingSnapshot } from "@/lib/host/runtime";
import { resolveNamedHostClient } from "@/lib/host/binding-host-client";
import { queryClient } from "@/lib/query-client";
import { hostQueryKeys } from "@/lib/query-keys";
import {
  applyLandingHostDocument,
  rememberLandingBlobsOnHost,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";
import { blobHashesOfDocument } from "@/lib/drafts/draft-write-codec";
import { readDraftBlobsForRecovery } from "@/lib/drafts/draft-blob-transport";
import { putImageBytesAtHash } from "@/lib/composer/landing-image-store";
import type { ClosedHeaderTab } from "./history";

/** Keep future live-byte accounting consistent with the bytes actually read. */
function contentWithImageSizes(
  node: JsonContent,
  sizes: ReadonlyMap<string, number>,
): JsonContent {
  const size =
    node.type === "imageAttachment" && typeof node.attrs?.hash === "string"
      ? sizes.get(node.attrs.hash)
      : undefined;
  return {
    ...node,
    ...(size === undefined ? {} : { attrs: { ...node.attrs, size } }),
    ...(node.content === undefined
      ? {}
      : {
          content: node.content.map((child) =>
            contentWithImageSizes(child, sizes),
          ),
        }),
  };
}

/** Resolve a saved draft without recreating content that was permanently deleted. */
export async function prepareSavedDraft(
  item: Extract<ClosedHeaderTab, { kind: "draft" }>,
  stillCurrent: () => boolean,
): Promise<boolean> {
  if (!stillCurrent()) return false;
  if (
    useLandingDraftStore
      .getState()
      .drafts.some((draft) => draft.id === item.draftId)
  )
    return true;
  // Unadopted drafts are retained locally and never LRU-evicted. No row means
  // there is no saved draft to reopen. Adopted mirrors may need a host read.
  if (item.hostId === null) return false;
  const client = resolveNamedHostClient(getHostBindingSnapshot(), item.hostId);
  if (client === null) throw new Error("The draft's host is unavailable.");
  const listed = await queryClient.fetchQuery({
    queryKey: hostQueryKeys.method<HostRpcRegistry, "drafts.list">(
      item.hostId,
      "drafts.list",
      {},
    ),
    queryFn: () => client.request("drafts.list", {}),
    staleTime: 0,
    retry: false,
  });
  if (!stillCurrent()) return false;
  // A local edit or another reopen that raced the read wins over the host copy.
  if (
    useLandingDraftStore
      .getState()
      .drafts.some((draft) => draft.id === item.draftId)
  )
    return true;
  const document = listed.drafts.find(
    (draft) => draft.draftId === item.draftId,
  );
  if (document === undefined) {
    if (listed.tombstones.some((entry) => entry.draftId === item.draftId))
      return false;
    throw new Error("The draft is not available from its host yet.");
  }
  if (document.kind !== "landing") return false;
  return prepareHostDraft(document, item.hostId, client, stillCurrent);
}

async function prepareHostDraft(
  document: Extract<DraftDocument, { kind: "landing" }>,
  hostId: string,
  client: DraftBlobClient,
  stillCurrent: () => boolean,
): Promise<boolean> {
  const hashes = blobHashesOfDocument(document);
  const images = await readDraftBlobsForRecovery(hostId, client, hashes);
  if (!stillCurrent()) return false;
  if (
    useLandingDraftStore
      .getState()
      .drafts.some((draft) => draft.id === document.draftId)
  )
    return true;
  if (hashes.some((hash) => !images.has(hash)))
    throw new Error("The draft's images are not available yet.");
  const reservation = tryReserveLandingImageBudget(
    [...images].map(([hash, image]) => ({
      hash,
      bytes: image.bytes.byteLength,
    })),
  );
  if (reservation === null)
    throw new Error(
      "There is not enough image capacity to reopen this draft yet.",
    );
  try {
    for (const [hash, image] of images) {
      if (!stillCurrent()) return false;
      if (!(await putImageBytesAtHash(hash, image.bytes)))
        throw new Error("The draft's image could not be verified.");
    }
    if (!stillCurrent()) return false;
    if (
      !useLandingDraftStore
        .getState()
        .drafts.some((draft) => draft.id === document.draftId)
    ) {
      // Loading the host record prepares a local mirror; the coordinator still
      // owns reopening its tab. The host's open state is not local tab presence.
      const sizes = new Map(
        [...images].map(([hash, image]) => [hash, image.bytes.byteLength]),
      );
      applyLandingHostDocument(
        { ...document, portable: { ...document.portable, closed: true } },
        contentWithImageSizes(document.portable.content, sizes),
      );
      rememberLandingBlobsOnHost(document.draftId, [...images.keys()]);
    }
    return true;
  } finally {
    reservation.release();
    scheduleLandingImageReconcile();
  }
}
