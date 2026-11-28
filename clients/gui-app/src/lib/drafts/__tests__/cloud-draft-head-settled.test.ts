import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftDocument } from "@traycer/protocol/host";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import {
  type CloudDraftHeadAbandonCause,
  abandonCloudDraftHeadRead,
  acquireDraftMirrorSession,
  applyIncomingDraftDocument,
  beginCloudDraftHeadRead,
  cloudDraftHeadKey,
  cloudDraftHeadReading,
  cloudDraftHeadSettled,
  cloudDraftIngestSeq,
  ingestCloudDraftSummary,
  noteCloudDraftHeadHost,
  releaseCloudDraftHeadRead,
  resetDraftMirrorCoordinatorForTests,
  settleCloudDraftHeadWithoutApply,
  subscribeCloudDraftHeadAbandoned,
  sweepAbsentCloudDraftMirrors,
} from "@/lib/drafts/draft-mirror-coordinator";
import {
  cloudDraftImageSourcesRecorded,
  cloudDraftImageSourceVersion,
  resetCloudDraftImageRecoveryForTests,
  subscribeCloudDraftImageSources,
} from "@/lib/drafts/cloud-draft-image-recovery";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import { fakeDraftStreamClient } from "@/lib/drafts/__tests__/draft-mirror-test-stream";
import {
  resetLandingDraftRetirementsForTests,
  retireLandingDraft,
} from "@/lib/drafts/landing-draft-retirement";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useAuthStore } from "@/stores/auth/auth-store";

type AbandonListener = (
  abandoned: CloudChatSummary,
  cause: CloudDraftHeadAbandonCause,
) => void;

const HOST_ID = "host-a";
const OWNER_HOST_ID = "host-b";
const DRAFT_ID = "draft-settled-1";
const HEAD_ONE = "ab".repeat(32);
const HEAD_TWO = "cd".repeat(32);
const OTHER_DRAFT_ID = "draft-settled-2";

function typed(text: string) {
  return {
    type: "doc" as const,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function summaryFor(
  draftId: string,
  ownerHostId: string,
  headSha256: string,
): CloudChatSummary {
  return {
    identity: {
      taskId: "scp_TESTDRAFTSSCOPEID000001",
      chatId: draftId,
      ownerUserId: "user-1",
    },
    ownerHostId,
    createdAt: 1,
    visibility: "private",
    title: null,
    isTitleEditedByUser: false,
    parentChatId: null,
    isArchived: false,
    runSettingsSummary: null,
    metadataUpdatedAt: 1,
    headSha256,
    publishedAt: 1,
    throughRecordSeq: 1,
    isOwnedByViewer: true,
  };
}

/** The same listing row pinned at another publication time (`null` is an unpublished row). */
function withPublishedAt(
  summary: CloudChatSummary,
  publishedAt: number | null,
): CloudChatSummary {
  return { ...summary, publishedAt };
}

/** The same listing row pinned at another record sequence. */
function withThroughRecordSeq(
  summary: CloudChatSummary,
  throughRecordSeq: number | null,
): CloudChatSummary {
  return { ...summary, throughRecordSeq };
}

function cloudDocument(
  draftId: string,
  ownerHostId: string,
  kind: "landing" | "chat-composer",
): DraftDocument {
  return {
    draftId,
    kind,
    target:
      kind === "landing"
        ? { epicId: null, chatId: null, blockId: null }
        : { epicId: "epic-1", chatId: "chat-1", blockId: null },
    revision: 1,
    lastTouchedAt: 2,
    workspace: null,
    supersedes: null,
    ownerHostId,
    origin: "replica",
    adoption: { state: "adopted", hostId: ownerHostId },
    publication: {
      status: "current",
      lastPublishedAt: 1,
      publishedRevision: 1,
      halted: null,
    },
    portable: {
      content: typed("cloud body"),
      selection: null,
      runSettings: null,
      composerMode: "chat",
      blobHashes: [],
      closed: false,
    },
  };
}

/** A landing document whose portable body names `hashes`, as a published head with images does. */
function landingDocumentWithImages(
  draftId: string,
  ownerHostId: string,
  hashes: readonly string[],
): DraftDocument {
  const document = cloudDocument(draftId, ownerHostId, "landing");
  if (document.kind !== "landing") {
    throw new Error("expected a landing document");
  }
  return {
    ...document,
    portable: { ...document.portable, blobHashes: [...hashes] },
  };
}

function landingIds(): readonly string[] {
  return useLandingDraftStore.getState().drafts.map((draft) => draft.id);
}

async function ingest(
  hostId: string,
  summary: CloudChatSummary,
  document: DraftDocument,
): Promise<void> {
  await ingestCloudDraftSummary({
    hostId,
    summary,
    document,
    readOwner: null,
  });
}

afterEach(() => {
  resetDraftMirrorCoordinatorForTests();
  resetCloudDraftImageRecoveryForTests();
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  resetLandingDraftRetirementsForTests();
  useAuthStore.setState({ contextMetadata: null });
});

describe("cloudDraftHeadSettled", () => {
  it("keys a head by its identity plus headSha256", () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);

    expect(cloudDraftHeadKey(summary)).toBe(
      `["${OWNER_HOST_ID}","scp_TESTDRAFTSSCOPEID000001","user-1","${DRAFT_ID}"]:${HEAD_ONE}`,
    );
    const newer = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO);
    expect(cloudDraftHeadKey(newer)).not.toBe(cloudDraftHeadKey(summary));
  });

  it("settles a host-bound head without touching the landing store", async () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    const document = cloudDocument(DRAFT_ID, OWNER_HOST_ID, "chat-composer");
    expect(cloudDraftHeadSettled(summary)).toBe(false);

    await ingest(HOST_ID, summary, document);

    expect(cloudDraftHeadSettled(summary)).toBe(true);
    expect(landingIds()).toEqual([]);
  });

  it("settles an installed landing head with its mirror and forgets it once the mirror is removed from the store", async () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    const document = cloudDocument(DRAFT_ID, OWNER_HOST_ID, "landing");
    expect(cloudDraftHeadSettled(summary)).toBe(false);

    await ingest(HOST_ID, summary, document);

    expect(landingIds()).toEqual([DRAFT_ID]);
    expect(cloudDraftHeadSettled(summary)).toBe(true);

    const mirrors = useLandingDraftStore.getState().drafts;
    useLandingDraftStore.getState().applyHostDelete(DRAFT_ID);

    expect(landingIds()).toEqual([]);
    expect(cloudDraftHeadSettled(summary)).toBe(false);
    // The record was deleted, not merely masked: a mirror that comes back
    // under the same id does not resurrect the settled head.
    useLandingDraftStore.setState({ drafts: mirrors });
    expect(landingIds()).toEqual([DRAFT_ID]);
    expect(cloudDraftHeadSettled(summary)).toBe(false);
  });

  it("forgets a landing head when the absence sweep drops its mirror", async () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    const document = cloudDocument(DRAFT_ID, OWNER_HOST_ID, "landing");
    await ingest(HOST_ID, summary, document);
    expect(cloudDraftHeadSettled(summary)).toBe(true);

    const dropped = sweepAbsentCloudDraftMirrors(
      HOST_ID,
      new Map(),
      cloudDraftIngestSeq(),
    );

    expect(dropped).toEqual([DRAFT_ID]);
    expect(landingIds()).toEqual([]);
    expect(cloudDraftHeadSettled(summary)).toBe(false);
  });

  it("does not treat a different headSha256 for the same identity as settled", async () => {
    const settled = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    const newer = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO);
    await ingest(
      HOST_ID,
      settled,
      cloudDocument(DRAFT_ID, OWNER_HOST_ID, "chat-composer"),
    );

    expect(cloudDraftHeadSettled(settled)).toBe(true);
    expect(cloudDraftHeadKey(newer)).not.toBe(cloudDraftHeadKey(settled));
    expect(cloudDraftHeadSettled(newer)).toBe(false);
  });

  it("settles nothing for a row the ingesting host owns", async () => {
    const summary = summaryFor(DRAFT_ID, HOST_ID, HEAD_ONE);

    await ingest(HOST_ID, summary, cloudDocument(DRAFT_ID, HOST_ID, "landing"));

    expect(cloudDraftHeadSettled(summary)).toBe(false);
    expect(landingIds()).toEqual([]);
  });

  it("clears a settled head on resetDraftMirrorCoordinatorForTests", async () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    await ingest(
      HOST_ID,
      summary,
      cloudDocument(DRAFT_ID, OWNER_HOST_ID, "chat-composer"),
    );
    expect(cloudDraftHeadSettled(summary)).toBe(true);

    resetDraftMirrorCoordinatorForTests();

    expect(cloudDraftHeadSettled(summary)).toBe(false);
  });

  it("treats a head being read as settled for the same sha only", () => {
    const reading = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    const other = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO);
    expect(cloudDraftHeadSettled(reading)).toBe(false);

    beginCloudDraftHeadRead(reading);

    expect(cloudDraftHeadSettled(reading)).toBe(true);
    expect(cloudDraftHeadSettled(other)).toBe(false);
  });

  it("releases a head still being read, but never a settled one", () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);

    beginCloudDraftHeadRead(summary);
    expect(cloudDraftHeadSettled(summary)).toBe(true);
    releaseCloudDraftHeadRead(summary);
    expect(cloudDraftHeadSettled(summary)).toBe(false);

    settleCloudDraftHeadWithoutApply(summary);
    releaseCloudDraftHeadRead(summary);
    expect(cloudDraftHeadSettled(summary)).toBe(true);
  });

  it("keeps a read in flight for one sha when a release names another sha of the row", () => {
    const original = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    const other = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO);
    beginCloudDraftHeadRead(original);

    releaseCloudDraftHeadRead(other);

    expect(cloudDraftHeadSettled(original)).toBe(true);
    expect(cloudDraftHeadSettled(other)).toBe(false);
  });

  it("settles a head without apply with no mirror in the landing store", () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    expect(cloudDraftHeadSettled(summary)).toBe(false);

    settleCloudDraftHeadWithoutApply(summary);

    expect(landingIds()).toEqual([]);
    expect(cloudDraftHeadSettled(summary)).toBe(true);
    expect(
      cloudDraftHeadSettled(summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO)),
    ).toBe(false);
  });

  it("replaces the row's record when a read of a new sha begins", () => {
    const older = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    const newer = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO);
    settleCloudDraftHeadWithoutApply(older);
    expect(cloudDraftHeadSettled(older)).toBe(true);

    beginCloudDraftHeadRead(newer);

    expect(cloudDraftHeadSettled(older)).toBe(false);
    expect(cloudDraftHeadSettled(newer)).toBe(true);
  });

  it("a refusal of a read started at an earlier publication settles that publication, not the later one the record advanced to, and the later listing is read again", () => {
    const early = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE),
      5,
    );
    const later = withPublishedAt(early, 9);
    beginCloudDraftHeadRead(early);
    // Reading: the later listing of the same digest advances the stamp.
    expect(cloudDraftHeadSettled(later)).toBe(true);
    const listener = vi.fn<AbandonListener>();
    const unsubscribe = subscribeCloudDraftHeadAbandoned(listener);

    settleCloudDraftHeadWithoutApply(early);
    unsubscribe();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toBe(early);
    // The refusal of a publication the record had moved past gives the head
    // back for a reason about the moment, not an exhausted read.
    expect(listener.mock.calls[0][1]).toBe("released");
    // Ask with the earlier listing first: asking with the later one deletes
    // the record.
    expect(cloudDraftHeadSettled(early)).toBe(true);
    expect(cloudDraftHeadSettled(later)).toBe(false);
  });

  it("a refusal of a read whose record was not advanced settles at its own stamp and wakes nobody", () => {
    const early = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE),
      5,
    );
    const listener = vi.fn<AbandonListener>();
    const unsubscribe = subscribeCloudDraftHeadAbandoned(listener);
    beginCloudDraftHeadRead(early);

    settleCloudDraftHeadWithoutApply(early);
    unsubscribe();

    expect(listener).not.toHaveBeenCalled();
    expect(cloudDraftHeadSettled(withPublishedAt(early, 5))).toBe(true);
    // A later listing of a head settled without a mirror is read again.
    expect(cloudDraftHeadSettled(withPublishedAt(early, 9))).toBe(false);
  });

  it("a refusal whose record was advanced wakes a listener that has since unsubscribed no more", () => {
    const early = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE),
      5,
    );
    const later = withPublishedAt(early, 9);
    const gone = vi.fn<AbandonListener>();
    const kept = vi.fn<AbandonListener>();
    const unsubscribeGone = subscribeCloudDraftHeadAbandoned(gone);
    const unsubscribeKept = subscribeCloudDraftHeadAbandoned(kept);
    unsubscribeGone();
    beginCloudDraftHeadRead(early);
    expect(cloudDraftHeadSettled(later)).toBe(true);

    settleCloudDraftHeadWithoutApply(early);
    unsubscribeKept();

    expect(gone).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledTimes(1);
    expect(kept.mock.calls[0][0]).toBe(early);
    expect(kept.mock.calls[0][1]).toBe("released");
  });

  it("a refusal for a row whose record names another head leaves that record alone and wakes nobody", () => {
    const reading = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO),
      9,
    );
    const refused = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE),
      5,
    );
    const listener = vi.fn<AbandonListener>();
    const unsubscribe = subscribeCloudDraftHeadAbandoned(listener);
    beginCloudDraftHeadRead(reading);

    settleCloudDraftHeadWithoutApply(refused);
    unsubscribe();

    expect(listener).not.toHaveBeenCalled();
    expect(cloudDraftHeadReading(reading)).toBe(true);
    expect(cloudDraftHeadSettled(reading)).toBe(true);
  });

  it("a refusal with an unpublished stamp on either side keeps the later stamp as before", () => {
    const unpublished = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE),
      null,
    );
    const listener = vi.fn<AbandonListener>();
    const unsubscribe = subscribeCloudDraftHeadAbandoned(listener);
    beginCloudDraftHeadRead(unpublished);
    // Advances the record's stamp from null to 9.
    expect(cloudDraftHeadSettled(withPublishedAt(unpublished, 9))).toBe(true);

    settleCloudDraftHeadWithoutApply(unpublished);
    unsubscribe();

    expect(listener).not.toHaveBeenCalled();
    expect(cloudDraftHeadReading(unpublished)).toBe(false);
    expect(cloudDraftHeadSettled(withPublishedAt(unpublished, 9))).toBe(true);
  });

  it("releases a read in flight when the apply is refused for a reason about the moment (an older revision than the row holds)", async () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    // The row already holds a newer revision from the same owner, so the
    // cloud head (revision 1) is refused as older: not retired, not about
    // this head.
    await applyIncomingDraftDocument({
      ...cloudDocument(DRAFT_ID, OWNER_HOST_ID, "landing"),
      revision: 5,
    });
    expect(landingIds()).toEqual([DRAFT_ID]);
    beginCloudDraftHeadRead(summary);
    expect(cloudDraftHeadSettled(summary)).toBe(true);

    await ingest(
      HOST_ID,
      summary,
      cloudDocument(DRAFT_ID, OWNER_HOST_ID, "landing"),
    );

    expect(cloudDraftHeadSettled(summary)).toBe(false);
  });

  it("settles a landing head refused because its id is retired here, without a mirror", async () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    retireLandingDraft(DRAFT_ID, null);
    beginCloudDraftHeadRead(summary);

    await ingest(
      HOST_ID,
      summary,
      cloudDocument(DRAFT_ID, OWNER_HOST_ID, "landing"),
    );

    expect(landingIds()).toEqual([]);
    expect(cloudDraftHeadSettled(summary)).toBe(true);
  });

  it("keeps one record per row: two rows install side by side, and a new sha for a row replaces only that row's record", async () => {
    const first = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    const second = summaryFor(OTHER_DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    await ingest(
      HOST_ID,
      first,
      cloudDocument(DRAFT_ID, OWNER_HOST_ID, "landing"),
    );
    await ingest(
      HOST_ID,
      second,
      cloudDocument(OTHER_DRAFT_ID, OWNER_HOST_ID, "landing"),
    );

    expect(cloudDraftHeadSettled(first)).toBe(true);
    expect(cloudDraftHeadSettled(second)).toBe(true);

    const firstNewer = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO);
    // The reader claims the new head before it reads it, which is what
    // replaces the row's record: a settle alone never replaces another head's.
    beginCloudDraftHeadRead(firstNewer);
    await ingest(
      HOST_ID,
      firstNewer,
      cloudDocument(DRAFT_ID, OWNER_HOST_ID, "landing"),
    );

    expect(cloudDraftHeadSettled(firstNewer)).toBe(true);
    expect(cloudDraftHeadSettled(first)).toBe(false);
    expect(cloudDraftHeadSettled(second)).toBe(true);
  });
});

describe("cloudDraftHeadSettled against the mirror's owner", () => {
  const OTHER_OWNER_HOST_ID = "host-z";

  /** Re-owns the mirror the store holds for `DRAFT_ID`, as another owner's row under the same id would. */
  function setMirrorOwner(ownerHostId: string | null): void {
    useLandingDraftStore.setState((state) => ({
      drafts: state.drafts.map((draft) =>
        draft.id === DRAFT_ID ? { ...draft, ownerHostId } : draft,
      ),
    }));
  }

  it("is not settled when the mirror in the store names another owner than the row, and the record is forgotten", async () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    await ingest(
      HOST_ID,
      summary,
      cloudDocument(DRAFT_ID, OWNER_HOST_ID, "landing"),
    );
    expect(landingIds()).toEqual([DRAFT_ID]);
    expect(cloudDraftHeadSettled(summary)).toBe(true);

    setMirrorOwner(OTHER_OWNER_HOST_ID);

    // The mirror is still there, but it is not this row's.
    expect(landingIds()).toEqual([DRAFT_ID]);
    expect(cloudDraftHeadSettled(summary)).toBe(false);
    expect(cloudDraftHeadReading(summary)).toBe(false);

    // The record was deleted, not merely masked: once the mirror names the
    // original owner again, the head is still not settled, and nothing is
    // being read for it.
    setMirrorOwner(OWNER_HOST_ID);
    expect(cloudDraftHeadSettled(summary)).toBe(false);
    expect(cloudDraftHeadReading(summary)).toBe(false);
  });

  it("settles by the listing's owner: the other owner's row under the same id is its own record", async () => {
    const original = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    const other = summaryFor(DRAFT_ID, OTHER_OWNER_HOST_ID, HEAD_ONE);
    await ingest(
      HOST_ID,
      original,
      cloudDocument(DRAFT_ID, OWNER_HOST_ID, "landing"),
    );
    expect(cloudDraftHeadSettled(original)).toBe(true);
    expect(cloudDraftHeadSettled(other)).toBe(false);

    // The mirror now shows the other owner's draft: the other owner's listing
    // matches it, and the original owner's no longer does.
    setMirrorOwner(OTHER_OWNER_HOST_ID);
    await ingest(
      HOST_ID,
      other,
      cloudDocument(DRAFT_ID, OTHER_OWNER_HOST_ID, "landing"),
    );

    expect(cloudDraftHeadSettled(other)).toBe(true);
    expect(cloudDraftHeadSettled(original)).toBe(false);
  });

  it("still counts a mirror with no owner as present, and keeps the record", async () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    await ingest(
      HOST_ID,
      summary,
      cloudDocument(DRAFT_ID, OWNER_HOST_ID, "landing"),
    );

    setMirrorOwner(null);

    expect(landingIds()).toEqual([DRAFT_ID]);
    expect(cloudDraftHeadSettled(summary)).toBe(true);
    // Not forgotten: a second ask answers the same.
    expect(cloudDraftHeadSettled(summary)).toBe(true);
  });
});

describe("a listing older than the record", () => {
  const HEAD_THREE = "12".repeat(32);

  it("is settled, and a read of it leaves a settled newer head in place", () => {
    const newer = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO),
      9,
    );
    const stale = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE),
      5,
    );
    settleCloudDraftHeadWithoutApply(newer);

    expect(cloudDraftHeadSettled(stale)).toBe(true);
    beginCloudDraftHeadRead(stale);

    expect(cloudDraftHeadSettled(newer)).toBe(true);
    expect(cloudDraftHeadReading(stale)).toBe(false);
    expect(cloudDraftHeadReading(newer)).toBe(false);
  });

  it("is settled, and a read of it leaves a newer head still being read in place", () => {
    const newer = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO),
      9,
    );
    const stale = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE),
      5,
    );
    beginCloudDraftHeadRead(newer);

    expect(cloudDraftHeadSettled(stale)).toBe(true);
    beginCloudDraftHeadRead(stale);

    expect(cloudDraftHeadReading(newer)).toBe(true);
    expect(cloudDraftHeadSettled(newer)).toBe(true);
    expect(cloudDraftHeadReading(stale)).toBe(false);
  });

  it("is settled after a newer head was installed through an ingest", async () => {
    const newer = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO),
      9,
    );
    const stale = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE),
      5,
    );
    await ingest(
      HOST_ID,
      newer,
      cloudDocument(DRAFT_ID, OWNER_HOST_ID, "chat-composer"),
    );

    expect(cloudDraftHeadSettled(newer)).toBe(true);
    expect(cloudDraftHeadSettled(stale)).toBe(true);
  });

  it("is not settled when the listing carries a later publication time, and its read replaces the record", () => {
    const settled = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO),
      9,
    );
    const newer = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_THREE),
      12,
    );
    settleCloudDraftHeadWithoutApply(settled);

    expect(cloudDraftHeadSettled(newer)).toBe(false);
    beginCloudDraftHeadRead(newer);

    expect(cloudDraftHeadReading(newer)).toBe(true);
    expect(cloudDraftHeadReading(settled)).toBe(false);
    // The record now names the publishedAt-12 head, so the old one is the stale
    // listing and is settled by that rule, not by holding the record.
    expect(cloudDraftHeadSettled(settled)).toBe(true);
  });

  it("keeps the old behaviour when the listing has no publication time", () => {
    const settled = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO),
      9,
    );
    const unknown = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE),
      null,
    );
    settleCloudDraftHeadWithoutApply(settled);

    expect(cloudDraftHeadSettled(unknown)).toBe(false);
    beginCloudDraftHeadRead(unknown);

    expect(cloudDraftHeadReading(unknown)).toBe(true);
    expect(cloudDraftHeadSettled(settled)).toBe(false);
  });

  it("keeps the old behaviour when the record has no publication time", () => {
    const settled = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO),
      null,
    );
    const other = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE),
      5,
    );
    settleCloudDraftHeadWithoutApply(settled);

    expect(cloudDraftHeadSettled(other)).toBe(false);
    beginCloudDraftHeadRead(other);

    expect(cloudDraftHeadReading(other)).toBe(true);
    expect(cloudDraftHeadSettled(settled)).toBe(false);
  });

  it("orders by publishedAt and not by throughRecordSeq: a later publication with a LOWER sequence is a new head", () => {
    // A fork or a rewrite renumbers the sequence, so the later head can carry
    // the smaller number.
    const settled = withThroughRecordSeq(
      withPublishedAt(summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO), 5),
      9,
    );
    const later = withThroughRecordSeq(
      withPublishedAt(summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_THREE), 8),
      3,
    );
    settleCloudDraftHeadWithoutApply(settled);

    expect(cloudDraftHeadSettled(later)).toBe(false);
    beginCloudDraftHeadRead(later);

    expect(cloudDraftHeadReading(later)).toBe(true);
    expect(cloudDraftHeadReading(settled)).toBe(false);
  });

  it("advances an installed head's stamp when the same digest is listed again later, so an intermediate head delivered late is stale", async () => {
    // The row published A (5), then B (7), then byte-identical A again (9).
    // This renderer installed A first and sees the republication next; B
    // arrives last, from another host's cache. Identical bytes need no
    // re-read: the record only moves its stamp.
    const first = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE),
      5,
    );
    const republished = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE),
      9,
    );
    const intermediate = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO),
      7,
    );
    await ingest(
      HOST_ID,
      first,
      cloudDocument(DRAFT_ID, OWNER_HOST_ID, "landing"),
    );
    expect(landingIds()).toEqual([DRAFT_ID]);

    expect(cloudDraftHeadSettled(republished)).toBe(true);
    expect(cloudDraftHeadSettled(intermediate)).toBe(true);
    beginCloudDraftHeadRead(intermediate);
    expect(cloudDraftHeadReading(intermediate)).toBe(false);
    expect(cloudDraftHeadSettled(first)).toBe(true);
  });

  it("reads a head settled WITHOUT a mirror again when the same digest is listed at a later publication time: the retraction the read met has been undone", () => {
    // The read answered `unpublished` for A (5) because the owner retracted
    // the row before the resolve; the owner then republished the same
    // content (9). The settlement is for the earlier publication only.
    const retracted = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE),
      5,
    );
    const republished = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE),
      9,
    );
    settleCloudDraftHeadWithoutApply(retracted);
    expect(cloudDraftHeadSettled(retracted)).toBe(true);

    expect(cloudDraftHeadSettled(republished)).toBe(false);
    // The record is gone: the earlier listing is not settled either now, and
    // a read of the republication claims the row.
    expect(cloudDraftHeadSettled(retracted)).toBe(false);
    beginCloudDraftHeadRead(republished);
    expect(cloudDraftHeadReading(republished)).toBe(true);
  });

  it("keeps a head settled without a mirror for the same or an earlier publication time", () => {
    const settled = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE),
      9,
    );
    const earlierListing = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE),
      5,
    );
    settleCloudDraftHeadWithoutApply(settled);

    expect(cloudDraftHeadSettled(settled)).toBe(true);
    expect(cloudDraftHeadSettled(earlierListing)).toBe(true);
    expect(cloudDraftHeadSettled(withPublishedAt(settled, null))).toBe(true);
  });

  it("advances the stamp of a head still being read; a refusal of that read settles the publication it started from (the one move back), and a restart keeps the stamp", () => {
    const first = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE),
      5,
    );
    const republished = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE),
      9,
    );
    const intermediate = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO),
      7,
    );
    beginCloudDraftHeadRead(first);
    expect(cloudDraftHeadSettled(republished)).toBe(true);
    expect(cloudDraftHeadReading(republished)).toBe(true);

    // The read that started from the publishedAt-5 listing is refused: the
    // record settles at 5, the publication the refusal answers for, so the
    // intermediate head (7) is no longer stale and the republication (9) is
    // read again.
    settleCloudDraftHeadWithoutApply(first);
    expect(cloudDraftHeadSettled(intermediate)).toBe(false);
    expect(cloudDraftHeadSettled(first)).toBe(true);
    expect(cloudDraftHeadSettled(republished)).toBe(false);

    // A later read of the same digest from the old listing keeps the stamp.
    beginCloudDraftHeadRead(first);
    expect(cloudDraftHeadReading(first)).toBe(true);
    expect(cloudDraftHeadSettled(first)).toBe(true);
  });

  it("does not move the stamp back when the same digest is listed again earlier", () => {
    const later = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE),
      9,
    );
    const earlierListing = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE),
      5,
    );
    const between = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO),
      7,
    );
    settleCloudDraftHeadWithoutApply(later);

    expect(cloudDraftHeadSettled(earlierListing)).toBe(true);
    expect(cloudDraftHeadSettled(between)).toBe(true);
  });

  it("orders by publishedAt and not by throughRecordSeq: an earlier publication with a HIGHER sequence is stale", () => {
    const settled = withThroughRecordSeq(
      withPublishedAt(summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO), 8),
      3,
    );
    const earlier = withThroughRecordSeq(
      withPublishedAt(summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE), 5),
      9,
    );
    settleCloudDraftHeadWithoutApply(settled);

    expect(cloudDraftHeadSettled(earlier)).toBe(true);
    beginCloudDraftHeadRead(earlier);

    expect(cloudDraftHeadSettled(settled)).toBe(true);
    expect(cloudDraftHeadReading(earlier)).toBe(false);
  });
});

describe("a read whose head was displaced while in flight", () => {
  it("does not apply an older head once a newer head of the row has been claimed, and leaves the newer claim standing", async () => {
    const older = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE),
      5,
    );
    const newer = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO),
      9,
    );
    beginCloudDraftHeadRead(older);
    // The newer head's read starts (a second host-scoped directory listed
    // it) while the older read is still in flight.
    beginCloudDraftHeadRead(newer);

    await ingest(
      HOST_ID,
      older,
      cloudDocument(DRAFT_ID, OWNER_HOST_ID, "landing"),
    );

    expect(landingIds()).toEqual([]);
    expect(cloudDraftHeadReading(newer)).toBe(true);
    expect(cloudDraftHeadSettled(older)).toBe(true);
  });

  it("does not apply an older head over a newer head already installed", async () => {
    const older = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE),
      5,
    );
    const newer = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO),
      9,
    );
    beginCloudDraftHeadRead(older);
    beginCloudDraftHeadRead(newer);
    await ingest(
      HOST_ID,
      newer,
      cloudDocument(DRAFT_ID, OWNER_HOST_ID, "landing"),
    );
    const installed = useLandingDraftStore.getState().drafts;
    expect(installed).toHaveLength(1);

    await ingest(
      HOST_ID,
      older,
      cloudDocument(DRAFT_ID, OWNER_HOST_ID, "landing"),
    );

    expect(useLandingDraftStore.getState().drafts).toBe(installed);
    expect(cloudDraftHeadSettled(newer)).toBe(true);
    expect(cloudDraftHeadSettled(older)).toBe(true);
  });

  it("still applies a head whose claim was released and never re-claimed", async () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    beginCloudDraftHeadRead(summary);
    releaseCloudDraftHeadRead(summary);

    await ingest(
      HOST_ID,
      summary,
      cloudDocument(DRAFT_ID, OWNER_HOST_ID, "landing"),
    );

    expect(landingIds()).toEqual([DRAFT_ID]);
    expect(cloudDraftHeadSettled(summary)).toBe(true);
  });
});

describe("cloudDraftHeadReading", () => {
  it("is true while a head is being read, for the same sha only", () => {
    const reading = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    const other = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO);
    expect(cloudDraftHeadReading(reading)).toBe(false);

    beginCloudDraftHeadRead(reading);

    expect(cloudDraftHeadReading(reading)).toBe(true);
    expect(cloudDraftHeadReading(other)).toBe(false);
  });

  it("is false once the read is released", () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    beginCloudDraftHeadRead(summary);

    releaseCloudDraftHeadRead(summary);

    expect(cloudDraftHeadReading(summary)).toBe(false);
  });

  it("is false once the head is settled, although the head still counts as settled", () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    beginCloudDraftHeadRead(summary);

    settleCloudDraftHeadWithoutApply(summary);

    expect(cloudDraftHeadReading(summary)).toBe(false);
    expect(cloudDraftHeadSettled(summary)).toBe(true);
  });

  it("releases, rather than settles, a read whose apply started under another account", async () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    useAuthStore.setState({
      contextMetadata: { userId: "user-b", username: "b" },
    });
    beginCloudDraftHeadRead(summary);
    expect(cloudDraftHeadReading(summary)).toBe(true);

    // The read was issued under user-a; the window now belongs to user-b.
    await ingestCloudDraftSummary({
      hostId: HOST_ID,
      summary,
      document: cloudDocument(DRAFT_ID, OWNER_HOST_ID, "landing"),
      readOwner: "user-a",
    });

    expect(landingIds()).toEqual([]);
    expect(cloudDraftHeadSettled(summary)).toBe(false);
    expect(cloudDraftHeadReading(summary)).toBe(false);
  });

  it("still applies and settles a read whose account matches the window's", async () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    useAuthStore.setState({
      contextMetadata: { userId: "user-a", username: "a" },
    });
    beginCloudDraftHeadRead(summary);

    await ingestCloudDraftSummary({
      hostId: HOST_ID,
      summary,
      document: cloudDocument(DRAFT_ID, OWNER_HOST_ID, "landing"),
      readOwner: "user-a",
    });

    expect(landingIds()).toEqual([DRAFT_ID]);
    expect(cloudDraftHeadSettled(summary)).toBe(true);
    expect(cloudDraftHeadReading(summary)).toBe(false);
  });
});

describe("a settle is guarded by the head", () => {
  it("leaves a newer head's read in flight when an older head of the row settles", () => {
    const older = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    const newer = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO);
    beginCloudDraftHeadRead(newer);

    settleCloudDraftHeadWithoutApply(older);

    expect(cloudDraftHeadReading(newer)).toBe(true);
    expect(cloudDraftHeadSettled(older)).toBe(false);
    expect(cloudDraftHeadSettled(newer)).toBe(true);
  });

  it("settles the head once its own settle arrives, after an older head's was ignored", () => {
    const older = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    const newer = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO);
    beginCloudDraftHeadRead(newer);
    settleCloudDraftHeadWithoutApply(older);

    settleCloudDraftHeadWithoutApply(newer);

    expect(cloudDraftHeadReading(newer)).toBe(false);
    expect(cloudDraftHeadSettled(newer)).toBe(true);
    expect(cloudDraftHeadSettled(older)).toBe(false);
  });

  it("keeps a settled newer head when an older head settles after it", () => {
    const older = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    const newer = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO);
    settleCloudDraftHeadWithoutApply(newer);

    settleCloudDraftHeadWithoutApply(older);

    expect(cloudDraftHeadSettled(newer)).toBe(true);
    expect(cloudDraftHeadSettled(older)).toBe(false);
  });

  it("settles a row that has no record, and re-settles the same head", () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    expect(cloudDraftHeadSettled(summary)).toBe(false);

    settleCloudDraftHeadWithoutApply(summary);
    expect(cloudDraftHeadSettled(summary)).toBe(true);

    settleCloudDraftHeadWithoutApply(summary);
    expect(cloudDraftHeadSettled(summary)).toBe(true);
    expect(cloudDraftHeadReading(summary)).toBe(false);
  });

  it("does not let an install of an older head replace the newer head's claim", async () => {
    const older = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    const newer = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO);
    beginCloudDraftHeadRead(newer);

    await ingest(
      HOST_ID,
      older,
      cloudDocument(DRAFT_ID, OWNER_HOST_ID, "landing"),
    );

    expect(cloudDraftHeadReading(newer)).toBe(true);
    expect(cloudDraftHeadSettled(older)).toBe(false);
  });
});

describe("abandonCloudDraftHeadRead", () => {
  it("clears a read in flight and tells every subscriber which head, once", () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    const first = vi.fn<AbandonListener>();
    const second = vi.fn<AbandonListener>();
    subscribeCloudDraftHeadAbandoned(first);
    subscribeCloudDraftHeadAbandoned(second);
    beginCloudDraftHeadRead(summary);

    abandonCloudDraftHeadRead(summary, "exhausted");

    expect(first).toHaveBeenCalledTimes(1);
    expect(first.mock.calls[0][0]).toBe(summary);
    expect(second).toHaveBeenCalledTimes(1);
    expect(second.mock.calls[0][0]).toBe(summary);
    expect(cloudDraftHeadReading(summary)).toBe(false);
    expect(cloudDraftHeadSettled(summary)).toBe(false);
  });

  it("tells every subscriber why the head was let go: the cause it was abandoned with", () => {
    const exhaustedHead = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    const releasedHead = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO);
    const first = vi.fn<AbandonListener>();
    const second = vi.fn<AbandonListener>();
    subscribeCloudDraftHeadAbandoned(first);
    subscribeCloudDraftHeadAbandoned(second);

    beginCloudDraftHeadRead(exhaustedHead);
    abandonCloudDraftHeadRead(exhaustedHead, "exhausted");
    expect(first).toHaveBeenLastCalledWith(exhaustedHead, "exhausted");
    expect(second).toHaveBeenLastCalledWith(exhaustedHead, "exhausted");

    beginCloudDraftHeadRead(releasedHead);
    abandonCloudDraftHeadRead(releasedHead, "released");
    expect(first).toHaveBeenLastCalledWith(releasedHead, "released");
    expect(second).toHaveBeenLastCalledWith(releasedHead, "released");
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("has already cleared the claim when a subscriber hears of it, so a woken mount can claim the head", () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    const seenSettled: boolean[] = [];
    subscribeCloudDraftHeadAbandoned((abandoned) => {
      seenSettled.push(cloudDraftHeadSettled(abandoned));
      beginCloudDraftHeadRead(abandoned);
    });
    beginCloudDraftHeadRead(summary);

    abandonCloudDraftHeadRead(summary, "released");

    expect(seenSettled).toEqual([false]);
    expect(cloudDraftHeadReading(summary)).toBe(true);
  });

  it("notifies nobody and keeps the record when the head is already settled", () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    const listener = vi.fn<AbandonListener>();
    subscribeCloudDraftHeadAbandoned(listener);
    beginCloudDraftHeadRead(summary);
    settleCloudDraftHeadWithoutApply(summary);

    abandonCloudDraftHeadRead(summary, "released");

    expect(listener).not.toHaveBeenCalled();
    expect(cloudDraftHeadSettled(summary)).toBe(true);
  });

  it("notifies nobody and keeps the claim when it names another head of the row", () => {
    const reading = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    const other = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO);
    const listener = vi.fn<AbandonListener>();
    subscribeCloudDraftHeadAbandoned(listener);
    beginCloudDraftHeadRead(reading);

    abandonCloudDraftHeadRead(other, "released");

    expect(listener).not.toHaveBeenCalled();
    expect(cloudDraftHeadReading(reading)).toBe(true);
  });

  it("notifies nobody when the row has no record", () => {
    const listener = vi.fn<AbandonListener>();
    subscribeCloudDraftHeadAbandoned(listener);

    abandonCloudDraftHeadRead(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE),
      "released",
    );

    expect(listener).not.toHaveBeenCalled();
  });

  it("stops notifying a subscriber once it unsubscribes, and only that one", () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    const gone = vi.fn<AbandonListener>();
    const kept = vi.fn<AbandonListener>();
    const unsubscribeGone = subscribeCloudDraftHeadAbandoned(gone);
    subscribeCloudDraftHeadAbandoned(kept);
    unsubscribeGone();
    beginCloudDraftHeadRead(summary);

    abandonCloudDraftHeadRead(summary, "released");

    expect(gone).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledTimes(1);
  });

  it("is not heard after resetDraftMirrorCoordinatorForTests drops the record", () => {
    // The record, not the subscription, is what an abandon needs: with no
    // read in flight there is nothing to hand over.
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    const listener = vi.fn<AbandonListener>();
    subscribeCloudDraftHeadAbandoned(listener);
    beginCloudDraftHeadRead(summary);
    resetDraftMirrorCoordinatorForTests();

    abandonCloudDraftHeadRead(summary, "released");

    expect(listener).not.toHaveBeenCalled();
  });
});

describe("noteCloudDraftHeadHost", () => {
  const IMAGE_HASH = "ef".repeat(32);
  const SECOND_HOST_ID = "host-c";
  const OWNER_USER_ID = "user-1";

  beforeEach(() => {
    installFreshIndexedDb();
    // A cloud image source carries the account it was minted under, and is
    // refused unless the window serves that account.
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: OWNER_USER_ID, username: OWNER_USER_ID },
    });
  });

  afterEach(() => {
    useAuthStore.setState(useAuthStore.getInitialState(), true);
  });

  function mountSession(hostId: string): void {
    acquireDraftMirrorSession({
      hostId,
      client: {
        request: () =>
          Promise.resolve({
            drafts: [],
            tombstones: [],
            snapshotSeq: 0,
            scopeId: null,
          }),
      } as never,
      streamClient: fakeDraftStreamClient(),
      timing: undefined,
    });
  }

  function ingestWithImage(
    hostId: string,
    summary: CloudChatSummary,
  ): Promise<void> {
    return ingestCloudDraftSummary({
      hostId,
      summary,
      document: landingDocumentWithImages(DRAFT_ID, OWNER_HOST_ID, [
        IMAGE_HASH,
      ]),
      readOwner: OWNER_USER_ID,
    });
  }

  /** Counts every change of the recorded image sources from here on. */
  function countSourceChanges(): { readonly count: () => number } {
    let changes = 0;
    subscribeCloudDraftImageSources(() => {
      changes += 1;
    });
    return { count: () => changes };
  }

  it("is a no-op, and throws nothing, for a settled head that has no images", async () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    mountSession(SECOND_HOST_ID);
    await ingestCloudDraftSummary({
      hostId: HOST_ID,
      summary,
      document: cloudDocument(DRAFT_ID, OWNER_HOST_ID, "landing"),
      readOwner: OWNER_USER_ID,
    });
    expect(cloudDraftHeadSettled(summary)).toBe(true);
    const sources = countSourceChanges();
    const versionBefore = cloudDraftImageSourceVersion();

    expect(() => {
      noteCloudDraftHeadHost(summary, SECOND_HOST_ID);
    }).not.toThrow();

    expect(cloudDraftHeadSettled(summary)).toBe(true);
    expect(cloudDraftImageSourceVersion()).toBe(versionBefore);
    expect(sources.count()).toBe(0);
  });

  it("is a no-op for a row with no record and for a head still being read", () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    mountSession(SECOND_HOST_ID);
    const sources = countSourceChanges();

    noteCloudDraftHeadHost(summary, SECOND_HOST_ID);
    beginCloudDraftHeadRead(summary);
    noteCloudDraftHeadHost(summary, SECOND_HOST_ID);

    expect(cloudDraftHeadReading(summary)).toBe(true);
    expect(sources.count()).toBe(0);
  });

  it("registers a second host's requester as a source for an installed head's images, once", async () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    mountSession(HOST_ID);
    mountSession(SECOND_HOST_ID);
    await Promise.resolve();
    await ingestWithImage(HOST_ID, summary);
    expect(cloudDraftHeadSettled(summary)).toBe(true);
    const sources = countSourceChanges();
    const versionBefore = cloudDraftImageSourceVersion();

    noteCloudDraftHeadHost(summary, SECOND_HOST_ID);

    expect(sources.count()).toBe(1);
    expect(cloudDraftImageSourceVersion()).toBe(versionBefore + 1);

    // The second skip of the same head by a mount on the same host adds
    // nothing: the host is remembered on the record.
    noteCloudDraftHeadHost(summary, SECOND_HOST_ID);

    expect(sources.count()).toBe(1);
    expect(cloudDraftImageSourceVersion()).toBe(versionBefore + 1);
  });

  it("does not register the host that already ingested the head with a mounted session", async () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    mountSession(HOST_ID);
    await Promise.resolve();
    await ingestWithImage(HOST_ID, summary);
    const sources = countSourceChanges();

    noteCloudDraftHeadHost(summary, HOST_ID);

    expect(sources.count()).toBe(0);
  });

  it("registers a host that ingested the head without a mounted session once its session is mounted, and not before", async () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    // The head is installed through a host this window holds no mirror on:
    // no source could be recorded at ingest.
    await ingestWithImage(HOST_ID, summary);
    expect(cloudDraftHeadSettled(summary)).toBe(true);
    const sources = countSourceChanges();

    noteCloudDraftHeadHost(summary, HOST_ID);
    expect(sources.count()).toBe(0);

    mountSession(HOST_ID);
    await Promise.resolve();
    const afterMount = sources.count();

    noteCloudDraftHeadHost(summary, HOST_ID);
    expect(sources.count()).toBe(afterMount + 1);

    noteCloudDraftHeadHost(summary, HOST_ID);
    expect(sources.count()).toBe(afterMount + 1);
  });

  it("does not mark the host while the window serves another account, so the account's return still registers it", async () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    mountSession(HOST_ID);
    mountSession(SECOND_HOST_ID);
    await Promise.resolve();
    await ingestWithImage(HOST_ID, summary);
    expect(cloudDraftHeadSettled(summary)).toBe(true);
    const sources = countSourceChanges();
    const versionBefore = cloudDraftImageSourceVersion();

    useAuthStore.setState({
      contextMetadata: { userId: "user-2", username: "user-2" },
    });
    noteCloudDraftHeadHost(summary, SECOND_HOST_ID);

    expect(sources.count()).toBe(0);
    expect(cloudDraftImageSourceVersion()).toBe(versionBefore);

    useAuthStore.setState({
      contextMetadata: { userId: OWNER_USER_ID, username: OWNER_USER_ID },
    });
    noteCloudDraftHeadHost(summary, SECOND_HOST_ID);

    expect(sources.count()).toBe(1);
    expect(cloudDraftImageSourceVersion()).toBe(versionBefore + 1);
  });

  it("is a no-op for another head of the row than the settled one", async () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    mountSession(HOST_ID);
    mountSession(SECOND_HOST_ID);
    await Promise.resolve();
    await ingestWithImage(HOST_ID, summary);
    const sources = countSourceChanges();

    noteCloudDraftHeadHost(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO),
      SECOND_HOST_ID,
    );

    expect(sources.count()).toBe(0);
  });

  it("does not mark the ingesting host when the account moves between the apply and its settlement, so the account's return still registers it", async () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    mountSession(HOST_ID);
    await Promise.resolve();
    // The apply's own owner check passes (it runs right before the store
    // write); the switch happens inside the store write, so the ingest's
    // continuation is the first thing to see another account.
    const stopSwitching = useLandingDraftStore.subscribe(() => {
      useAuthStore.setState({
        contextMetadata: { userId: "user-2", username: "user-2" },
      });
    });
    await ingestWithImage(HOST_ID, summary);
    stopSwitching();
    useAuthStore.setState({
      contextMetadata: { userId: OWNER_USER_ID, username: OWNER_USER_ID },
    });
    expect(cloudDraftHeadSettled(summary)).toBe(true);
    const sources = countSourceChanges();
    const versionBefore = cloudDraftImageSourceVersion();

    // The ingest recorded no source (the owner check returned before it), and
    // it must not have marked HOST_ID as one either: this skip registers it.
    noteCloudDraftHeadHost(summary, HOST_ID);

    expect(sources.count()).toBe(1);
    expect(cloudDraftImageSourceVersion()).toBe(versionBefore + 1);
  });

  it("registers a host whose stale listing names an OLDER head of the row as a source for the installed head's images, once", async () => {
    const installed = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO),
      9,
    );
    const staleListing = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE),
      5,
    );
    mountSession(HOST_ID);
    mountSession(SECOND_HOST_ID);
    await Promise.resolve();
    await ingestWithImage(HOST_ID, installed);
    expect(cloudDraftHeadSettled(installed)).toBe(true);
    expect(cloudDraftHeadSettled(staleListing)).toBe(true);
    const sources = countSourceChanges();
    const versionBefore = cloudDraftImageSourceVersion();

    noteCloudDraftHeadHost(staleListing, SECOND_HOST_ID);

    expect(sources.count()).toBe(1);
    expect(cloudDraftImageSourceVersion()).toBe(versionBefore + 1);

    // The host is remembered for the record's images: a second note adds nothing.
    noteCloudDraftHeadHost(staleListing, SECOND_HOST_ID);

    expect(sources.count()).toBe(1);
    expect(cloudDraftImageSourceVersion()).toBe(versionBefore + 1);
  });

  it("does nothing for a listing of a NEWER head than the record's", async () => {
    const installed = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO),
      9,
    );
    mountSession(HOST_ID);
    mountSession(SECOND_HOST_ID);
    await Promise.resolve();
    await ingestWithImage(HOST_ID, installed);
    expect(cloudDraftHeadSettled(installed)).toBe(true);
    const sources = countSourceChanges();
    const versionBefore = cloudDraftImageSourceVersion();

    noteCloudDraftHeadHost(
      withPublishedAt(summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE), 12),
      SECOND_HOST_ID,
    );

    expect(sources.count()).toBe(0);
    expect(cloudDraftImageSourceVersion()).toBe(versionBefore);
  });

  it("does nothing for a stale listing when either publication time is unknown", async () => {
    const installed = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO),
      9,
    );
    mountSession(HOST_ID);
    mountSession(SECOND_HOST_ID);
    await Promise.resolve();
    await ingestWithImage(HOST_ID, installed);
    expect(cloudDraftHeadSettled(installed)).toBe(true);
    const sources = countSourceChanges();
    const versionBefore = cloudDraftImageSourceVersion();

    // The listing's own time is unknown.
    noteCloudDraftHeadHost(
      withPublishedAt(summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE), null),
      SECOND_HOST_ID,
    );

    expect(sources.count()).toBe(0);
    expect(cloudDraftImageSourceVersion()).toBe(versionBefore);
  });

  it("does nothing for a stale listing when the record's publication time is unknown", async () => {
    const installed = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO),
      null,
    );
    mountSession(HOST_ID);
    mountSession(SECOND_HOST_ID);
    await Promise.resolve();
    await ingestWithImage(HOST_ID, installed);
    expect(cloudDraftHeadSettled(installed)).toBe(true);
    const sources = countSourceChanges();
    const versionBefore = cloudDraftImageSourceVersion();

    noteCloudDraftHeadHost(
      withPublishedAt(summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE), 5),
      SECOND_HOST_ID,
    );

    expect(sources.count()).toBe(0);
    expect(cloudDraftImageSourceVersion()).toBe(versionBefore);
  });

  describe("a host skipped while the head is still being read", () => {
    /** Mounts both sessions, so each host has a requester to register. */
    async function mountBothSessions(): Promise<void> {
      mountSession(HOST_ID);
      mountSession(SECOND_HOST_ID);
      await Promise.resolve();
    }

    it("control: ingesting an image head through a mounted host records one source change and nothing for another host", async () => {
      const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
      await mountBothSessions();
      const sources = countSourceChanges();
      beginCloudDraftHeadRead(summary);

      await ingestWithImage(HOST_ID, summary);

      expect(cloudDraftHeadSettled(summary)).toBe(true);
      expect(sources.count()).toBe(1);
    });

    it("registers nothing while the read is in flight, then registers the skipped host's requester once when the read settles with images", async () => {
      const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
      await mountBothSessions();
      const sources = countSourceChanges();
      const versionBefore = cloudDraftImageSourceVersion();
      beginCloudDraftHeadRead(summary);

      // Whether the head names images is unknown until the read settles. Noted
      // twice (two mounts on the same host): still one entry on the record.
      noteCloudDraftHeadHost(summary, SECOND_HOST_ID);
      noteCloudDraftHeadHost(summary, SECOND_HOST_ID);

      expect(cloudDraftHeadReading(summary)).toBe(true);
      expect(sources.count()).toBe(0);
      expect(cloudDraftImageSourceVersion()).toBe(versionBefore);

      // The reading host ingests it: its own source (the control above) plus
      // the skipped host's, which is registered at the settle.
      await ingestWithImage(HOST_ID, summary);

      expect(cloudDraftHeadSettled(summary)).toBe(true);
      expect(cloudDraftHeadReading(summary)).toBe(false);
      expect(sources.count()).toBe(2);
      expect(cloudDraftImageSourceVersion()).toBe(versionBefore + 2);

      // The host is marked on the settled record: noting it again adds nothing.
      noteCloudDraftHeadHost(summary, SECOND_HOST_ID);

      expect(sources.count()).toBe(2);
      expect(cloudDraftImageSourceVersion()).toBe(versionBefore + 2);
    });

    it("keeps a host whose stale listing was skipped while the newer head is still being read, and registers it when that read settles with images", async () => {
      const reading = withPublishedAt(
        summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO),
        9,
      );
      const staleListing = withPublishedAt(
        summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE),
        5,
      );
      await mountBothSessions();
      const sources = countSourceChanges();
      const versionBefore = cloudDraftImageSourceVersion();
      beginCloudDraftHeadRead(reading);

      noteCloudDraftHeadHost(staleListing, SECOND_HOST_ID);

      expect(cloudDraftHeadReading(reading)).toBe(true);
      expect(sources.count()).toBe(0);
      expect(cloudDraftImageSourceVersion()).toBe(versionBefore);

      // The reading host ingests the newer head: its own source plus the
      // stale-listing host's, registered at the settle.
      await ingestWithImage(HOST_ID, reading);

      expect(cloudDraftHeadSettled(reading)).toBe(true);
      expect(sources.count()).toBe(2);
      expect(cloudDraftImageSourceVersion()).toBe(versionBefore + 2);

      // The host is marked on the settled record: noting it again adds nothing.
      noteCloudDraftHeadHost(staleListing, SECOND_HOST_ID);

      expect(sources.count()).toBe(2);
      expect(cloudDraftImageSourceVersion()).toBe(versionBefore + 2);
    });

    it("carries a host skipped during one head's read into a newer head's read of the row, and registers it when that newer head settles with images", async () => {
      const HEAD_THREE = "34".repeat(32);
      const headB = withPublishedAt(
        summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO),
        9,
      );
      const staleListing = withPublishedAt(
        summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE),
        5,
      );
      const headC = withPublishedAt(
        summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_THREE),
        12,
      );
      await mountBothSessions();
      const sources = countSourceChanges();
      const versionBefore = cloudDraftImageSourceVersion();
      beginCloudDraftHeadRead(headB);

      // A stale listing skipped while B is read: kept on B's reading record.
      noteCloudDraftHeadHost(staleListing, SECOND_HOST_ID);

      // C displaces B's record; the skip must travel with it.
      beginCloudDraftHeadRead(headC);

      expect(cloudDraftHeadReading(headC)).toBe(true);
      expect(sources.count()).toBe(0);
      expect(cloudDraftImageSourceVersion()).toBe(versionBefore);

      // The reading host ingests C: its own source plus the carried host's.
      await ingestWithImage(HOST_ID, headC);

      expect(cloudDraftHeadSettled(headC)).toBe(true);
      expect(sources.count()).toBe(2);
      expect(cloudDraftImageSourceVersion()).toBe(versionBefore + 2);

      // The host is marked on the settled record: noting it again adds nothing.
      noteCloudDraftHeadHost(headC, SECOND_HOST_ID);

      expect(sources.count()).toBe(2);
      expect(cloudDraftImageSourceVersion()).toBe(versionBefore + 2);
    });

    /** Ingests a head whose document names exactly `hashes`, through a mounted host. */
    function ingestWithHashes(
      hostId: string,
      summary: CloudChatSummary,
      hashes: readonly string[],
    ): Promise<void> {
      return ingestCloudDraftSummary({
        hostId,
        summary,
        document: landingDocumentWithImages(DRAFT_ID, OWNER_HOST_ID, hashes),
        readOwner: OWNER_USER_ID,
      });
    }

    it("registers the host that ingested one head for a later head's images when another host installs it", async () => {
      const LATER_IMAGE_HASH = "12".repeat(32);
      const headA = withPublishedAt(
        summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE),
        9,
      );
      const headB = withPublishedAt(
        summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO),
        12,
      );
      await mountBothSessions();
      const sources = countSourceChanges();

      // The first host ingests A: it is a host of the row from then on, though
      // nothing ever skipped a head on it.
      beginCloudDraftHeadRead(headA);
      await ingestWithHashes(HOST_ID, headA, [IMAGE_HASH]);
      expect(cloudDraftHeadSettled(headA)).toBe(true);
      expect(
        cloudDraftImageSourcesRecorded(headA.identity, HOST_ID, [IMAGE_HASH]),
      ).toBe(true);
      expect(
        cloudDraftImageSourcesRecorded(headB.identity, HOST_ID, [
          LATER_IMAGE_HASH,
        ]),
      ).toBe(false);

      // B is read and installed through the SECOND host, naming other images.
      beginCloudDraftHeadRead(headB);
      await ingestWithHashes(SECOND_HOST_ID, headB, [LATER_IMAGE_HASH]);

      expect(cloudDraftHeadSettled(headB)).toBe(true);
      expect(
        cloudDraftImageSourcesRecorded(headB.identity, HOST_ID, [
          LATER_IMAGE_HASH,
        ]),
      ).toBe(true);
      expect(
        cloudDraftImageSourcesRecorded(headB.identity, SECOND_HOST_ID, [
          LATER_IMAGE_HASH,
        ]),
      ).toBe(true);

      // Both hosts are held for B's hashes now: a repeat note adds nothing.
      const changesAfterSettle = sources.count();
      noteCloudDraftHeadHost(headB, HOST_ID);

      expect(sources.count()).toBe(changesAfterSettle);
    });

    it("does not re-register the ingesting host for the head it ingested", async () => {
      const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
      await mountBothSessions();
      const sources = countSourceChanges();
      beginCloudDraftHeadRead(summary);

      await ingestWithImage(HOST_ID, summary);

      // The same single source change the control above asserts: the note the
      // settle makes for the ingesting host added no second registration.
      expect(cloudDraftHeadSettled(summary)).toBe(true);
      expect(sources.count()).toBe(1);
      expect(
        cloudDraftImageSourcesRecorded(summary.identity, HOST_ID, [IMAGE_HASH]),
      ).toBe(true);
    });

    it("registers a host skipped during one head's read again for a later head's images once that head settles", async () => {
      const HEAD_THREE = "34".repeat(32);
      const LATER_IMAGE_HASH = "12".repeat(32);
      const headB = withPublishedAt(
        summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO),
        9,
      );
      const staleListing = withPublishedAt(
        summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE),
        5,
      );
      const headC = withPublishedAt(
        summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_THREE),
        12,
      );
      await mountBothSessions();
      const sources = countSourceChanges();
      beginCloudDraftHeadRead(headB);
      noteCloudDraftHeadHost(staleListing, SECOND_HOST_ID);

      // B settles: its own source plus the skipped host's, for B's hashes.
      await ingestWithHashes(HOST_ID, headB, [IMAGE_HASH]);

      expect(cloudDraftHeadSettled(headB)).toBe(true);
      expect(sources.count()).toBe(2);
      expect(
        cloudDraftImageSourcesRecorded(headB.identity, SECOND_HOST_ID, [
          IMAGE_HASH,
        ]),
      ).toBe(true);
      expect(
        cloudDraftImageSourcesRecorded(headB.identity, SECOND_HOST_ID, [
          LATER_IMAGE_HASH,
        ]),
      ).toBe(false);

      // C is read after B settled, and names other images: the host, still the
      // row's, is registered for them too when C settles.
      beginCloudDraftHeadRead(headC);
      await ingestWithHashes(HOST_ID, headC, [LATER_IMAGE_HASH]);

      expect(cloudDraftHeadSettled(headC)).toBe(true);
      expect(sources.count()).toBe(4);
      expect(
        cloudDraftImageSourcesRecorded(headC.identity, SECOND_HOST_ID, [
          LATER_IMAGE_HASH,
        ]),
      ).toBe(true);

      // The registry holds the host for C's hashes now: a repeat note adds nothing.
      noteCloudDraftHeadHost(headC, SECOND_HOST_ID);

      expect(sources.count()).toBe(4);
    });

    it("registers a host noted on a settled head again for a later head's images", async () => {
      const HEAD_THREE = "34".repeat(32);
      const LATER_IMAGE_HASH = "12".repeat(32);
      const headB = withPublishedAt(
        summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO),
        9,
      );
      const headC = withPublishedAt(
        summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_THREE),
        12,
      );
      await mountBothSessions();
      const sources = countSourceChanges();
      beginCloudDraftHeadRead(headB);
      await ingestWithHashes(HOST_ID, headB, [IMAGE_HASH]);
      expect(cloudDraftHeadSettled(headB)).toBe(true);
      expect(sources.count()).toBe(1);

      // Noted after B settled: registered for B at once, and kept on the record.
      noteCloudDraftHeadHost(headB, SECOND_HOST_ID);

      expect(sources.count()).toBe(2);
      expect(
        cloudDraftImageSourcesRecorded(headB.identity, SECOND_HOST_ID, [
          IMAGE_HASH,
        ]),
      ).toBe(true);

      beginCloudDraftHeadRead(headC);
      await ingestWithHashes(HOST_ID, headC, [LATER_IMAGE_HASH]);

      expect(cloudDraftHeadSettled(headC)).toBe(true);
      expect(sources.count()).toBe(4);
      expect(
        cloudDraftImageSourcesRecorded(headC.identity, SECOND_HOST_ID, [
          LATER_IMAGE_HASH,
        ]),
      ).toBe(true);
    });

    it("carries the row's hosts through a refusal that settles without a mirror", async () => {
      const headAtFive = withPublishedAt(
        summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO),
        5,
      );
      const headAtNine = withPublishedAt(headAtFive, 9);
      await mountBothSessions();
      const sources = countSourceChanges();
      beginCloudDraftHeadRead(headAtFive);
      noteCloudDraftHeadHost(headAtFive, SECOND_HOST_ID);

      // The same digest is listed again at 9 while the read of 5 is in flight:
      // the record's stamp advances, and the refusal then answers for 5 only.
      expect(cloudDraftHeadSettled(headAtNine)).toBe(true);
      settleCloudDraftHeadWithoutApply(headAtFive);

      expect(cloudDraftHeadSettled(headAtFive)).toBe(true);
      expect(sources.count()).toBe(0);

      // The republication at 9 is read now and names images: the host the
      // refusal's record carried is registered for them.
      beginCloudDraftHeadRead(headAtNine);
      await ingestWithHashes(HOST_ID, headAtNine, [IMAGE_HASH]);

      expect(cloudDraftHeadSettled(headAtNine)).toBe(true);
      expect(sources.count()).toBe(2);
      expect(
        cloudDraftImageSourcesRecorded(headAtNine.identity, SECOND_HOST_ID, [
          IMAGE_HASH,
        ]),
      ).toBe(true);
    });

    it("does not carry a skipped host when a read starts on a row with no record", async () => {
      const summary = withPublishedAt(
        summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO),
        9,
      );
      await mountBothSessions();
      const sources = countSourceChanges();
      const versionBefore = cloudDraftImageSourceVersion();

      // No record, so nothing for the new reading record to inherit.
      beginCloudDraftHeadRead(summary);
      expect(cloudDraftHeadReading(summary)).toBe(true);

      await ingestWithImage(HOST_ID, summary);

      expect(cloudDraftHeadSettled(summary)).toBe(true);
      // Only the reading host's own source: no second-host registration.
      expect(sources.count()).toBe(1);
      expect(cloudDraftImageSourceVersion()).toBe(versionBefore + 1);

      noteCloudDraftHeadHost(summary, HOST_ID);
      expect(sources.count()).toBe(1);
    });

    it("leaves a skipped host with no mounted session unmarked at the settle, and a later note registers it once its session mounts", async () => {
      const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
      mountSession(HOST_ID);
      await Promise.resolve();
      const sources = countSourceChanges();
      beginCloudDraftHeadRead(summary);
      noteCloudDraftHeadHost(summary, SECOND_HOST_ID);

      await ingestWithImage(HOST_ID, summary);

      // Only the reading host's own source: the skipped host had no session.
      expect(sources.count()).toBe(1);

      // Still no session: nothing to register, and nothing marked.
      noteCloudDraftHeadHost(summary, SECOND_HOST_ID);
      expect(sources.count()).toBe(1);

      mountSession(SECOND_HOST_ID);
      await Promise.resolve();
      const afterMount = sources.count();

      noteCloudDraftHeadHost(summary, SECOND_HOST_ID);
      expect(sources.count()).toBe(afterMount + 1);

      noteCloudDraftHeadHost(summary, SECOND_HOST_ID);
      expect(sources.count()).toBe(afterMount + 1);
    });

    it("registers nothing for a skipped host when the head settles without images", async () => {
      const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
      await mountBothSessions();
      const sources = countSourceChanges();
      const versionBefore = cloudDraftImageSourceVersion();
      beginCloudDraftHeadRead(summary);
      noteCloudDraftHeadHost(summary, SECOND_HOST_ID);

      await ingestCloudDraftSummary({
        hostId: HOST_ID,
        summary,
        document: cloudDocument(DRAFT_ID, OWNER_HOST_ID, "landing"),
        readOwner: OWNER_USER_ID,
      });

      expect(cloudDraftHeadSettled(summary)).toBe(true);
      expect(sources.count()).toBe(0);
      expect(cloudDraftImageSourceVersion()).toBe(versionBefore);

      // Nothing was held back on the settled record either.
      noteCloudDraftHeadHost(summary, SECOND_HOST_ID);
      expect(sources.count()).toBe(0);
    });

    it("registers nothing for a skipped host when the head settles without an apply", async () => {
      const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
      await mountBothSessions();
      const sources = countSourceChanges();
      beginCloudDraftHeadRead(summary);
      noteCloudDraftHeadHost(summary, SECOND_HOST_ID);

      settleCloudDraftHeadWithoutApply(summary);

      expect(cloudDraftHeadSettled(summary)).toBe(true);
      expect(sources.count()).toBe(0);
    });

    it("keeps a skipped host through a released read: a later read of the head registers it when it settles with images", async () => {
      const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
      await mountBothSessions();
      const sources = countSourceChanges();
      beginCloudDraftHeadRead(summary);
      noteCloudDraftHeadHost(summary, SECOND_HOST_ID);

      // Released silently: an abandon would also wake whatever subscribers
      // other tests in this file left behind.
      releaseCloudDraftHeadRead(summary);
      expect(cloudDraftHeadReading(summary)).toBe(false);

      // The row's hosts outlive the read: the next read's settle registers the
      // skipped host beside the ingesting host's own source.
      beginCloudDraftHeadRead(summary);
      await ingestWithImage(HOST_ID, summary);

      expect(cloudDraftHeadSettled(summary)).toBe(true);
      expect(sources.count()).toBe(2);
    });

    it("keeps a host noted during a read that is RELEASED, and registers it when the next read of the row settles with images", async () => {
      const headB = withPublishedAt(
        summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO),
        9,
      );
      await mountBothSessions();
      const sources = countSourceChanges();
      beginCloudDraftHeadRead(headB);
      noteCloudDraftHeadHost(headB, SECOND_HOST_ID);

      // Released silently: an abandon would also wake whatever subscribers
      // other tests in this file left behind.
      releaseCloudDraftHeadRead(headB);

      expect(cloudDraftHeadReading(headB)).toBe(false);
      expect(sources.count()).toBe(0);

      // The row's hosts outlive the read: the next read's settle registers the
      // noted host for the head's images, beside the ingesting host's own.
      beginCloudDraftHeadRead(headB);
      await ingestWithImage(HOST_ID, headB);

      expect(cloudDraftHeadSettled(headB)).toBe(true);
      expect(sources.count()).toBe(2);
      expect(
        cloudDraftImageSourcesRecorded(headB.identity, SECOND_HOST_ID, [
          IMAGE_HASH,
        ]),
      ).toBe(true);
    });

    it("keeps a host noted during a read that is ABANDONED, and registers it when the next read of the row settles with images", async () => {
      const headB = withPublishedAt(
        summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO),
        9,
      );
      await mountBothSessions();
      const sources = countSourceChanges();
      beginCloudDraftHeadRead(headB);
      noteCloudDraftHeadHost(headB, SECOND_HOST_ID);

      abandonCloudDraftHeadRead(headB, "released");

      expect(cloudDraftHeadReading(headB)).toBe(false);
      expect(sources.count()).toBe(0);

      beginCloudDraftHeadRead(headB);
      await ingestWithImage(HOST_ID, headB);

      expect(cloudDraftHeadSettled(headB)).toBe(true);
      expect(sources.count()).toBe(2);
      expect(
        cloudDraftImageSourcesRecorded(headB.identity, SECOND_HOST_ID, [
          IMAGE_HASH,
        ]),
      ).toBe(true);
    });

    it("a host whose read of a head settled without an install is registered as an image source when a later head of the row settles with images", async () => {
      const headA = withPublishedAt(
        summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE),
        5,
      );
      const headB = withPublishedAt(
        summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO),
        9,
      );
      await mountBothSessions();
      const sources = countSourceChanges();

      // What the ingest hook does at the start of a read: the reading host is
      // a host of the row, whatever the read goes on to decide.
      beginCloudDraftHeadRead(headA);
      noteCloudDraftHeadHost(headA, SECOND_HOST_ID);
      settleCloudDraftHeadWithoutApply(headA);

      expect(cloudDraftHeadSettled(headA)).toBe(true);
      expect(sources.count()).toBe(0);

      // A later head of the row is read and installed through the other host,
      // naming images: the host whose read settled without an install is
      // registered as a source for them.
      beginCloudDraftHeadRead(headB);
      await ingestWithHashes(HOST_ID, headB, [IMAGE_HASH]);

      expect(cloudDraftHeadSettled(headB)).toBe(true);
      expect(sources.count()).toBe(2);
      expect(
        cloudDraftImageSourcesRecorded(headB.identity, HOST_ID, [IMAGE_HASH]),
      ).toBe(true);
      expect(
        cloudDraftImageSourcesRecorded(headB.identity, SECOND_HOST_ID, [
          IMAGE_HASH,
        ]),
      ).toBe(true);
    });

    it("a host whose read of a head was released on an ambiguous identity is registered as an image source when a later head of the row settles with images", async () => {
      const headA = withPublishedAt(
        summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE),
        5,
      );
      const headB = withPublishedAt(
        summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO),
        9,
      );
      await mountBothSessions();
      const sources = countSourceChanges();

      // The read starts and notes its host; the read then answers an
      // ambiguous identity and is released silently, undecided.
      beginCloudDraftHeadRead(headA);
      noteCloudDraftHeadHost(headA, SECOND_HOST_ID);
      releaseCloudDraftHeadRead(headA);

      expect(cloudDraftHeadReading(headA)).toBe(false);
      expect(cloudDraftHeadSettled(headA)).toBe(false);
      expect(sources.count()).toBe(0);

      beginCloudDraftHeadRead(headB);
      await ingestWithHashes(HOST_ID, headB, [IMAGE_HASH]);

      expect(cloudDraftHeadSettled(headB)).toBe(true);
      expect(sources.count()).toBe(2);
      expect(
        cloudDraftImageSourcesRecorded(headB.identity, SECOND_HOST_ID, [
          IMAGE_HASH,
        ]),
      ).toBe(true);
    });

    it("remembers a host noted for a row with no record yet, and registers it when the row's first head settles with images", async () => {
      const headB = withPublishedAt(
        summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO),
        9,
      );
      await mountBothSessions();
      const sources = countSourceChanges();

      // No record for the row: the host is remembered, nothing registers.
      noteCloudDraftHeadHost(headB, SECOND_HOST_ID);

      expect(cloudDraftHeadReading(headB)).toBe(false);
      expect(sources.count()).toBe(0);

      beginCloudDraftHeadRead(headB);
      await ingestWithImage(HOST_ID, headB);

      expect(cloudDraftHeadSettled(headB)).toBe(true);
      expect(sources.count()).toBe(2);
      expect(
        cloudDraftImageSourcesRecorded(headB.identity, SECOND_HOST_ID, [
          IMAGE_HASH,
        ]),
      ).toBe(true);
    });
  });
});
