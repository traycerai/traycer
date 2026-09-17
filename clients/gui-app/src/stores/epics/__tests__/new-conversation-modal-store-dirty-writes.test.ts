/**
 * T4's race rule, the new-conversation modal's half:
 * `collectNewChatDirtyWrites` must withhold a draft while its content still
 * holds a PENDING inline image node (`b64content` surviving, its hash rewrite
 * not yet landed) - publishing now would put the whole base64 snapshot on the
 * wire, the exact megabyte-draft failure this ticket removes. The rewrite's
 * own document change re-dirties the patch moments later, so it is collected
 * on the very next pass. Same rule, same shape as
 * `collectComposerDirtyWrites`'s coverage in `composer-draft-mirror.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import {
  collectNewChatDirtyWrites,
  useNewConversationModalStore,
  type NewConversationModalDraftPatch,
} from "@/stores/epics/new-conversation-modal-store";

const WITH_PENDING_IMAGE: JsonContent = {
  type: "doc",
  content: [
    {
      type: "imageAttachment",
      attrs: {
        id: "pending-1",
        fileName: "shot.png",
        b64content: "aGVsbG8=",
        mimeType: "image/png",
        size: 5,
      },
    },
  ],
};

const WITH_HASH_ONLY_IMAGE: JsonContent = {
  type: "doc",
  content: [
    {
      type: "imageAttachment",
      attrs: {
        id: "pending-1",
        fileName: "shot.png",
        hash: "a".repeat(64),
        mimeType: "image/png",
        size: 5,
      },
    },
  ],
};

function patchWith(content: JsonContent): NewConversationModalDraftPatch {
  return {
    content,
    selection: null,
    settings: null,
    composerMode: null,
    workspace: null,
    revision: 1,
    draftId: "draft-new-chat-pending",
    hostRevision: 0,
    lastTouchedAt: 1,
    generation: 1,
    syncedGeneration: 0,
  };
}

beforeEach(() => {
  useNewConversationModalStore.getState().resetForTests();
});

afterEach(() => {
  useNewConversationModalStore.getState().resetForTests();
});

describe("collectNewChatDirtyWrites: pending inline image node race rule", () => {
  it("does not collect a patch while it still holds a pending (b64content) image node", () => {
    useNewConversationModalStore.setState({
      draftPatchesByEpicId: { "epic-pending": patchWith(WITH_PENDING_IMAGE) },
    });

    expect(collectNewChatDirtyWrites()).toEqual([]);
  });

  it("collects the same patch once the rewrite has landed (hash-only)", () => {
    useNewConversationModalStore.setState({
      draftPatchesByEpicId: {
        "epic-pending": patchWith(WITH_HASH_ONLY_IMAGE),
      },
    });

    const dirty = collectNewChatDirtyWrites();
    expect(dirty).toHaveLength(1);
    expect(dirty[0]?.epicId).toBe("epic-pending");
  });
});
