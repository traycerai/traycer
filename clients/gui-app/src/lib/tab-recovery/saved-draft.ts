import type { ImageBytes } from "@/lib/attachments/image-bytes";
import { tryReserveLandingImageBudget } from "@/lib/composer/landing-image-budget";
import { scheduleLandingImageReconcile } from "@/lib/composer/landing-image-gc";
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
import { readDraftBlobsIntoLocalStore } from "@/lib/drafts/draft-blob-transport";
import { base64ToBytes } from "@/lib/composer/image-base64";
import { putImage } from "@/lib/composer/landing-image-store";
import type { ClosedHeaderTab } from "./history";

/** Decode the entire legacy batch before admission or writes can change storage. */
function pendingInlineImages(
  node: JsonContent,
  images: Map<JsonContent, ImageBytes>,
): void {
  if (
    node.type === "imageAttachment" &&
    typeof node.attrs?.b64content === "string"
  ) {
    const bytes = base64ToBytes(node.attrs.b64content);
    if (bytes === null)
      throw new Error("The draft image could not be decoded.");
    images.set(node, bytes);
  }
  for (const child of node.content ?? []) pendingInlineImages(child, images);
}
async function durableDraftContent(
  node: JsonContent,
  images: ReadonlyMap<JsonContent, ImageBytes>,
): Promise<JsonContent> {
  const bytes = images.get(node);
  if (bytes !== undefined) {
    const hash = await putImage(bytes);
    const attrs = Object.fromEntries(
      Object.entries(node.attrs ?? {}).filter(([key]) => key !== "b64content"),
    );
    return { ...node, attrs: { ...attrs, hash, size: bytes.byteLength } };
  }
  if (node.content === undefined) return node;
  // Settle every started write before releasing the batch reservation, even
  // if one image fails. Serial writes make that boundary explicit.
  const content: JsonContent[] = [];
  for (const child of node.content)
    content.push(await durableDraftContent(child, images));
  return { ...node, content };
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
  if (item.legacyDraft !== undefined) {
    const images = new Map<JsonContent, ImageBytes>();
    pendingInlineImages(item.legacyDraft.content, images);
    const reservation = tryReserveLandingImageBudget(
      [...images.values()].map((bytes) => ({
        hash: null,
        bytes: bytes.byteLength,
      })),
    );
    if (reservation === null)
      throw new Error(
        "There is not enough image capacity to reopen this draft yet.",
      );
    try {
      const content = await durableDraftContent(
        item.legacyDraft.content,
        images,
      );
      if (!stillCurrent()) return false;
      useLandingDraftStore
        .getState()
        .importLegacyDraftForRecovery({ ...item.legacyDraft, content });
      return true;
    } finally {
      reservation.release();
      scheduleLandingImageReconcile();
    }
  }
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
  if (document === undefined || document.kind !== "landing") return false;
  const hashes = blobHashesOfDocument(document);
  const images = await readDraftBlobsIntoLocalStore(
    item.hostId,
    client,
    hashes,
  );
  if (!stillCurrent()) return false;
  if (hashes.some((hash) => !images.has(hash)))
    throw new Error("The draft's images are not available yet.");
  if (
    !useLandingDraftStore
      .getState()
      .drafts.some((draft) => draft.id === item.draftId)
  ) {
    // Loading the host record prepares a local mirror; the coordinator still
    // owns reopening its tab. The host's open state is not local tab presence.
    applyLandingHostDocument(
      { ...document, portable: { ...document.portable, closed: true } },
      document.portable.content,
    );
    rememberLandingBlobsOnHost(item.draftId, [...images.keys()]);
  }
  return true;
}
