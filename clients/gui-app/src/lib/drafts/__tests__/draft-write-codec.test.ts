import { describe, expect, it } from "vitest";
import {
  blobHashesFromContent,
  composerDraftWrite,
  requiredChatTarget,
  stashDraftWrite,
} from "@/lib/drafts/draft-write-codec";
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
