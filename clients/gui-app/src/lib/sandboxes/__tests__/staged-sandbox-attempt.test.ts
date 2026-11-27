import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import { describe, expect, it } from "vitest";
import {
  composerDraftWrite,
  ordinaryComposerDraftWrite,
} from "@/lib/drafts/draft-write-codec";
import type { OrdinaryDraftSnapshot } from "@/lib/drafts/draft-mirror-session";
import {
  pendingSandboxRecoveryDraftId,
  qualifiedStagedSandboxReturnIdentity,
  sealStagedSandboxAttempt,
} from "@/lib/sandboxes/staged-sandbox-attempt";
import type { StagedSandboxTarget } from "@/stores/composer/staged-sandbox-store";
import { MESSAGE_CONTENT, PICKED_SETTINGS } from "./pending-send-fixtures";

const ORIGINAL_DRAFT_ID = "draft-original";
const ORIGINAL_CHAT_ID = "chat-original";
const ORIGINAL_EPIC_ID = "epic-original";
const ORIGINAL_HOST_ID = "host-original";
const STAGED_TARGET: StagedSandboxTarget = {
  kind: "existing",
  hostId: ORIGINAL_HOST_ID,
  sandboxId: "sandbox-picked",
  name: "Picked sandbox",
  configuration: { kind: "personal" },
  verb: "resume",
};

function contentWithText(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function ordinaryDraftSnapshot(input: {
  readonly draftId: string;
  readonly revision: number;
  readonly chatId: string;
  readonly epicId: string;
  readonly content: JsonContent;
}): OrdinaryDraftSnapshot {
  const write = ordinaryComposerDraftWrite(
    composerDraftWrite({
      draftId: input.draftId,
      kind: "chat-composer",
      target: { epicId: input.epicId, chatId: input.chatId, blockId: null },
      revision: input.revision,
      lastTouchedAt: 100 + input.revision,
      content: input.content,
      selection: null,
      runSettings: null,
      composerMode: "chat",
      workspace: null,
      closed: false,
      supersedes: null,
    }),
    [],
    null,
  );
  if (write === null) throw new Error("ordinary chat draft fixture is invalid");
  return {
    write,
    localRevision: input.revision,
    occurrence: `occurrence-${input.revision}`,
    scopeId: "ordinary-draft-scope",
    base: null,
  };
}

function seal(input: {
  readonly draft: OrdinaryDraftSnapshot;
  readonly chatId: string;
  readonly originalHostId: string | null;
  readonly stageTarget: StagedSandboxTarget;
  readonly settings: ChatRunSettings;
}) {
  return sealStagedSandboxAttempt({
    userId: "user-1",
    originalHostId: input.originalHostId,
    draft: input.draft,
    stage: { target: input.stageTarget, clientRequestId: null },
    epicId: ORIGINAL_EPIC_ID,
    chatId: input.chatId,
    settings: input.settings,
  });
}

function originalDraft(): OrdinaryDraftSnapshot {
  return ordinaryDraftSnapshot({
    draftId: ORIGINAL_DRAFT_ID,
    revision: 7,
    chatId: ORIGINAL_CHAT_ID,
    epicId: ORIGINAL_EPIC_ID,
    content: MESSAGE_CONTENT,
  });
}

describe("staged sandbox attempt identity", () => {
  it("seals the ordinary draft, sandbox choice, and run settings before editor changes", () => {
    const draft = originalDraft();
    const originalSnapshot = structuredClone(draft);
    const settings = { ...PICKED_SETTINGS };
    const attempt = seal({
      draft,
      chatId: ORIGINAL_CHAT_ID,
      originalHostId: ORIGINAL_HOST_ID,
      stageTarget: STAGED_TARGET,
      settings,
    });
    if (attempt === null) throw new Error("valid bound attempt was refused");

    const currentEditor = {
      draft: ordinaryDraftSnapshot({
        draftId: ORIGINAL_DRAFT_ID,
        revision: 8,
        chatId: "chat-after-edit",
        epicId: "epic-after-edit",
        content: contentWithText("newer editor revision"),
      }),
      sandbox: {
        ...STAGED_TARGET,
        sandboxId: "sandbox-after-edit",
        name: "New editor choice",
      },
    };

    expect(currentEditor.draft.localRevision).toBe(8);
    expect(currentEditor.draft.write.target).not.toEqual(draft.write.target);
    expect(currentEditor.sandbox).not.toEqual(attempt.sandbox);
    expect(attempt.draft).toEqual(originalSnapshot);
    expect(attempt.draft).not.toBe(draft);
    expect(attempt.sandbox).toEqual(STAGED_TARGET);
    expect(attempt.sandbox).not.toBe(STAGED_TARGET);
    expect(attempt.firstTurn.settings).toEqual(PICKED_SETTINGS);
    expect(attempt.firstTurn.settings).not.toBe(settings);
    expect(attempt.draft.write.portable.runSettings).toBeNull();
    expect(attempt.firstTurn.chatId).toBe(ORIGINAL_CHAT_ID);
  });

  it.each([
    {
      chatId: "chat-after-edit",
      originalHostId: ORIGINAL_HOST_ID,
      stageTarget: STAGED_TARGET,
      mismatch: "chat",
    },
    {
      chatId: ORIGINAL_CHAT_ID,
      originalHostId: ORIGINAL_HOST_ID,
      stageTarget: { ...STAGED_TARGET, hostId: "host-after-edit" },
      mismatch: "sandbox host",
    },
  ])(
    "refuses a bound $mismatch mismatch",
    ({ chatId, originalHostId, stageTarget }) => {
      expect(
        seal({
          draft: originalDraft(),
          chatId,
          originalHostId,
          stageTarget,
          settings: PICKED_SETTINGS,
        }),
      ).toBeNull();
    },
  );

  it("replays stable return identities for a free or newly occupied original row", () => {
    const draft = originalDraft();
    const attempt = seal({
      draft,
      chatId: ORIGINAL_CHAT_ID,
      originalHostId: ORIGINAL_HOST_ID,
      stageTarget: STAGED_TARGET,
      settings: PICKED_SETTINGS,
    });
    if (attempt === null) throw new Error("valid bound attempt was refused");
    const newerDraft = ordinaryDraftSnapshot({
      draftId: ORIGINAL_DRAFT_ID,
      revision: 8,
      chatId: ORIGINAL_CHAT_ID,
      epicId: ORIGINAL_EPIC_ID,
      content: contentWithText("newer edits occupy the original draft row"),
    });
    expect(newerDraft.write.draftId).toBe(attempt.draft.write.draftId);
    expect(newerDraft.localRevision).toBeGreaterThan(
      attempt.draft.localRevision,
    );
    expect(newerDraft.write.portable.content).not.toEqual(
      attempt.draft.write.portable.content,
    );

    const replay = structuredClone(attempt);
    const freeReturn = qualifiedStagedSandboxReturnIdentity(replay, "free");
    const freeReplay = qualifiedStagedSandboxReturnIdentity(
      structuredClone(attempt),
      "free",
    );
    const occupiedReturn = qualifiedStagedSandboxReturnIdentity(
      structuredClone(attempt),
      "occupied-by-newer-draft",
    );
    const occupiedReplay = qualifiedStagedSandboxReturnIdentity(
      structuredClone(attempt),
      "occupied-by-newer-draft",
    );

    expect(replay).toEqual(attempt);
    expect(freeReplay).toEqual(freeReturn);
    expect(freeReturn.originalDraftId).toBe(ORIGINAL_DRAFT_ID);
    expect(freeReturn.draftId).toBe(ORIGINAL_DRAFT_ID);
    expect(occupiedReplay).toEqual(occupiedReturn);
    expect(occupiedReturn.originalDraftId).toBe(ORIGINAL_DRAFT_ID);
    expect(occupiedReturn.draftId).toBe(
      pendingSandboxRecoveryDraftId(attempt.id),
    );
    expect(occupiedReturn.draftId).not.toBe(ORIGINAL_DRAFT_ID);
    expect(occupiedReturn.operationId).not.toBe(freeReturn.operationId);
    expect(attempt.draft).toEqual(draft);
  });
});
