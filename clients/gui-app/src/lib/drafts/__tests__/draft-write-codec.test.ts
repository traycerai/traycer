import { describe, expect, it } from "vitest";
import {
  blobHashesFromContent,
  composerDraftWrite,
  interviewDraftWrite,
  requiredChatTarget,
  stashDraftWrite,
} from "@/lib/drafts/draft-write-codec";
import { applyInterviewHostDocument } from "@/stores/composer/interview-draft-store";
import { readInterviewDraftSnapshot } from "@/stores/composer/interview-draft-store";
import type { DraftDocument } from "@traycer/protocol/host";
import type { JsonContent } from "@traycer/protocol/common/registry";

const HASH = "ab".repeat(32);

function imageDoc(hash: string): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "imageAttachment",
        attrs: {
          id: "img-1",
          fileName: "shot.png",
          hash,
          mimeType: "image/png",
        },
      },
    ],
  };
}

describe("interview answers across the host round-trip", () => {
  it("keeps questionIdentity and selectedOptionIndices on both legs", () => {
    const target = requiredChatTarget({
      epicId: "epic-1",
      chatId: "chat-rt",
      blockId: "block-rt",
    });
    const write = interviewDraftWrite({
      draftId: "draft-rt",
      target,
      revision: 0,
      lastTouchedAt: 7,
      draft: {
        draftId: "draft-rt",
        hostRevision: 0,
        targetEpicId: "epic-1",
        lastTouchedAt: 7,
        generation: 1,
        syncedGeneration: 0,
        pageIndex: 1,
        answers: [
          {
            questionIdentity: "q-1",
            selected: ["Beta"],
            selectedOptionIndices: [1],
            otherText: "",
            otherSelected: false,
          },
          // A genuinely legacy answer: labels only. It must come back legacy,
          // not with manufactured indices.
          {
            selected: ["Gamma"],
            otherText: "",
            otherSelected: false,
          },
        ],
      },
    });
    expect(write.kind).toBe("interview");
    if (write.kind !== "interview") return;
    expect(write.portable.answers).toEqual([
      {
        questionIdentity: "q-1",
        selected: ["Beta"],
        selectedOptionIndices: [1],
        otherText: "",
        otherSelected: false,
      },
      {
        questionIdentity: undefined,
        selected: ["Gamma"],
        selectedOptionIndices: undefined,
        otherText: "",
        otherSelected: false,
      },
    ]);

    const document: DraftDocument = {
      ...write,
      revision: 3,
      ownerHostId: "host-a",
      origin: "own",
      adoption: { state: "adopted", hostId: "host-a" },
      publication: {
        status: "unpublished",
        lastPublishedAt: null,
        publishedRevision: null,
        halted: null,
      },
    };
    applyInterviewHostDocument(document);
    const restored = readInterviewDraftSnapshot("chat-rt", "block-rt");
    expect(restored?.answers[0]).toEqual({
      questionIdentity: "q-1",
      selected: ["Beta"],
      selectedOptionIndices: [1],
      otherText: "",
      otherSelected: false,
    });
    expect(restored?.answers[1]?.selectedOptionIndices).toBeUndefined();
  });
});

describe("draft write codec", () => {
  it("requires targetEpicId whenever targetChatId is set", () => {
    const write = composerDraftWrite({
      draftId: "d1",
      kind: "chat-composer",
      target: requiredChatTarget({
        epicId: "epic-1",
        chatId: "chat-1",
        blockId: null,
      }),
      revision: 0,
      lastTouchedAt: 1,
      content: imageDoc(HASH),
      selection: null,
      runSettings: null,
      composerMode: "chat",
      workspace: null,
      closed: false,
    });
    expect(write.target.chatId).toBe("chat-1");
    expect(write.target.epicId).toBe("epic-1");
    expect(write.kind).toBe("chat-composer");
    if (write.kind !== "chat-composer") return;
    expect(write.portable.blobHashes).toEqual([HASH]);
  });

  it("collects sha256 image refs without inlining bytes", () => {
    expect(blobHashesFromContent(imageDoc(HASH))).toEqual([HASH]);
  });

  it("encodes an immutable stash-entry write", () => {
    const write = stashDraftWrite({
      draftId: "stash-1",
      content: { type: "doc", content: [{ type: "paragraph" }] },
      blobHashes: [HASH],
      createdAt: 42,
    });
    expect(write.kind).toBe("stash-entry");
    if (write.kind !== "stash-entry") return;
    expect(write.revision).toBe(0);
    expect(write.portable.createdAt).toBe(42);
    expect(write.portable.blobHashes).toEqual([HASH]);
  });
});
