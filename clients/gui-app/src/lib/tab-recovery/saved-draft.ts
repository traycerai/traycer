import { tryReserveLandingImageResidency } from "@/lib/composer/landing-image-budget";
import { scheduleLandingImageReconcile } from "@/lib/composer/landing-image-gc";
import {
  holdPendingIngestImageHash,
  mintPendingIngestHolderId,
  releasePendingIngestImageHashes,
} from "@/lib/composer/pending-ingest-image-roots";
import type { DraftDocument } from "@traycer/protocol/host";
import type {
  DraftAuthorityActor,
  DraftAuthorityReference,
  DraftAuthorityVersion,
} from "@/lib/drafts/draft-authority-types";
import type { DraftBlobClient } from "@/lib/drafts/draft-blob-transport";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { HostRpcRegistry } from "@/lib/host";
import { getHostBindingSnapshot } from "@/lib/host/runtime";
import { resolveNamedHostClient } from "@/lib/host/binding-host-client";
import { queryClient } from "@/lib/query-client";
import { hostQueryKeys } from "@/lib/query-keys";
import {
  admitCanonicalLandingHistoryDraft,
  applyLandingHostDocument,
  readCanonicalLandingDraft,
  readLegacyCanonicalLandingHistory,
  rememberLandingBlobsOnHost,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";
import { verifyDurableLandingImageBytes } from "@/lib/drafts/draft-authority";
import { blobHashesOfDocument } from "@/lib/drafts/draft-write-codec";
import { readDraftBlobsForRecovery } from "@/lib/drafts/draft-blob-transport";
import { putImageBytesAtHash } from "@/lib/composer/landing-image-store";
import { landingDraftIsRetired } from "@/lib/drafts/landing-draft-retirement";
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

type SavedLandingItem = Extract<ClosedHeaderTab, { kind: "draft" }>;

type SavedDraftDestination =
  | { readonly kind: "legacy" }
  | { readonly kind: "desktop"; readonly actor: DraftAuthorityActor | null };

/** Resolve a saved draft without recreating content that was permanently deleted. */
export async function prepareSavedDraft(
  item: SavedLandingItem,
  stillCurrent: () => boolean,
): Promise<boolean> {
  return await readSavedDraft(item, stillCurrent, { kind: "legacy" }) === true;
}

export async function prepareDesktopHistoryDraft(input: {
  readonly item: SavedLandingItem;
  readonly actor: DraftAuthorityActor | null;
  readonly isCurrent: () => boolean;
}): Promise<DraftAuthorityVersion | null> {
  const { item, actor, isCurrent } = input;
  if (!isCurrent() || landingDraftIsRetired(item.draftId)) return null;

  const saved = item.draftReference;
  if (saved !== undefined) {
    if (saved === null || saved.slotId !== item.draftId) return null;
    return verifyCanonicalHistoryDraft(
      {
        slot: { kind: "landing", id: saved.slotId },
        occurrence: saved.occurrence,
      },
      isCurrent,
    );
  }

  const legacy = await readLegacyCanonicalLandingHistory({
    draftId: item.draftId,
    actor,
    isCurrent,
  });
  if (!isCurrent()) return null;
  if (legacy.kind === "live") {
    return verifyCanonicalHistoryDraft(legacy.draft, isCurrent);
  }
  if (legacy.kind !== "absent" || item.hostId === null) return null;

  const imported = await readSavedDraft(item, isCurrent, {
    kind: "desktop",
    actor,
  });
  if (typeof imported === "boolean") return null;
  const verified = await verifyCanonicalHistoryDraft(imported, isCurrent);
  return verified?.version === imported.version ? verified : null;
}

async function verifyCanonicalHistoryDraft(
  reference: DraftAuthorityReference,
  isCurrent: () => boolean,
): Promise<DraftAuthorityVersion | null> {
  const read = await readCanonicalLandingDraft(reference);
  if (read.kind !== "live" || !isCurrent()) return null;
  if (!(await verifyDurableLandingImageBytes(read.manifest.digests))) return null;
  if (!isCurrent()) return null;
  const verified = await readCanonicalLandingDraft(reference);
  return verified.kind === "live" &&
    verified.draft.version === read.draft.version && isCurrent()
    ? verified.draft
    : null;
}

async function readSavedDraft(
  item: SavedLandingItem,
  stillCurrent: () => boolean,
  destination: SavedDraftDestination,
): Promise<boolean | DraftAuthorityVersion> {
  const canRestore = (): boolean =>
    stillCurrent() && !landingDraftIsRetired(item.draftId);
  if (!canRestore()) return false;
  if (
    useLandingDraftStore
      .getState()
      .drafts.some((draft) => draft.id === item.draftId)
  )
    return destination.kind === "legacy";
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
  if (!canRestore()) return false;
  // A local edit or another reopen that raced the read wins over the host copy.
  if (
    useLandingDraftStore
      .getState()
      .drafts.some((draft) => draft.id === item.draftId)
  )
    return destination.kind === "legacy";
  const document = listed.drafts.find(
    (draft) => draft.draftId === item.draftId,
  );
  if (document === undefined) {
    if (listed.tombstones.some((entry) => entry.draftId === item.draftId))
      return false;
    throw new Error("The draft is not available from its host yet.");
  }
  if (document.kind !== "landing") return false;
  return prepareHostDraft(
    item.draftId,
    document,
    item.hostId,
    client,
    canRestore,
    destination,
  );
}

async function prepareHostDraft(
  draftId: string,
  document: Extract<DraftDocument, { kind: "landing" }>,
  hostId: string,
  client: DraftBlobClient,
  stillCurrent: () => boolean,
  destination: SavedDraftDestination,
): Promise<boolean | DraftAuthorityVersion> {
  const hashes = blobHashesOfDocument(document);
  const images = await readDraftBlobsForRecovery(hostId, client, hashes);
  if (!stillCurrent()) return false;
  if (
    useLandingDraftStore
      .getState()
      .drafts.some((draft) => draft.id === document.draftId)
  )
    return destination.kind === "legacy";
  if (hashes.some((hash) => !images.has(hash)))
    throw new Error("The draft's images are not available yet.");
  // RESIDENCY admission, for the same reason the landing stash import needs
  // it: these bytes are about to be written into the partition, and ordinary
  // admission charges nothing for a candidate whose hash is already a live
  // root. That is right for a root whose bytes are here and wrong for one
  // that is rooted while ABSENT - a closed draft's own record still names the
  // hash - so this recovery wrote megabytes for free and the partition
  // finished above its budget. Nothing is settled below: the document that
  // will root these hashes is not installed until every write has landed, so
  // the slots stay charged for the whole batch.
  const reservation = tryReserveLandingImageResidency(
    [...images].map(([hash, image]) => ({
      hash,
      bytes: image.bytes.byteLength,
    })),
  );
  if (reservation === null)
    throw new Error(
      "There is not enough image capacity to reopen this draft yet.",
    );
  const holder =
    destination.kind === "desktop"
      ? mintPendingIngestHolderId("desktop-history")
      : null;
  try {
    if (holder !== null) {
      for (const hash of hashes) holdPendingIngestImageHash(holder, hash);
    }
    for (const [hash, image] of images) {
      if (!stillCurrent()) return false;
      if (!(await putImageBytesAtHash(hash, image.bytes))) {
        throw new Error("The draft's image could not be verified.");
      }
    }
    if (!stillCurrent()) return false;
    if (
      destination.kind === "desktop" &&
      !(await verifyDurableLandingImageBytes(hashes))
    ) return false;
    if (!stillCurrent()) return false;
    const localRowExists = useLandingDraftStore.getState().drafts.some(
      (draft) => draft.id === draftId,
    );
    if (localRowExists) return destination.kind === "legacy";

    const sizes = new Map(
      [...images].map(([hash, image]) => [hash, image.bytes.byteLength]),
    );
    const content = contentWithImageSizes(document.portable.content, sizes);
    const verifiedHashes = [...images.keys()];
    if (destination.kind === "desktop") {
      const result = await admitCanonicalLandingHistoryDraft({
        actor: destination.actor,
        hostId,
        draftId,
        document,
        content,
        verifiedHashes,
        isCurrent: stillCurrent,
      });
      // Acknowledgment includes the durable same-window roots. Keep the
      // temporary reservation until that transaction has been acknowledged.
      return result.kind === "committed" && stillCurrent()
        ? result.draft
        : false;
    }

    // The legacy coordinator still owns opening the prepared closed mirror.
    applyLandingHostDocument(
      { ...document, portable: { ...document.portable, closed: true } },
      content,
    );
    rememberLandingBlobsOnHost(document.draftId, verifiedHashes);
    return true;
  } finally {
    reservation.release();
    if (holder !== null) releasePendingIngestImageHashes(holder);
    scheduleLandingImageReconcile();
  }
}
