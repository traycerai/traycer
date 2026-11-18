import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { persistKey, STORE_KEYS } from "@/lib/persist";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import { emptyLandingDraftWorkspaceSnapshot } from "@/stores/home/landing-draft-store";

const KEY = persistKey(STORE_KEYS.newConversationDraft);
const EPIC_ID = "epic-persist";

function typed(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPersistedPatches(): Record<string, unknown> {
  const raw = window.localStorage.getItem(KEY);
  if (raw === null) throw new Error(`nothing persisted under ${KEY}`);
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || !isRecord(parsed.state)) {
    throw new Error("persisted payload is not a zustand envelope");
  }
  const patches = parsed.state.draftPatchesByEpicId;
  if (!isRecord(patches)) throw new Error("no persisted patch map");
  return patches;
}

function reset(): void {
  useNewConversationModalStore.getState().resetForTests();
  window.localStorage.removeItem(KEY);
}

describe("new-conversation modal store: persistence", () => {
  beforeEach(reset);
  afterEach(reset);

  it("persists a patch and rehydrates it without re-dirtying the row", async () => {
    useNewConversationModalStore.getState().setContent(EPIC_ID, typed("later"));
    useNewConversationModalStore
      .getState()
      .setNewChatEpicTitle(EPIC_ID, "Epic");
    const written =
      useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID];
    if (written === undefined) throw new Error("no patch written");

    // Simulate the reload: keep the bytes the middleware just wrote, drop the
    // in-memory map (which writes over them), put them back, and let the
    // middleware read its own output.
    const persistedBytes = window.localStorage.getItem(KEY);
    if (persistedBytes === null) throw new Error("nothing persisted");
    useNewConversationModalStore.setState({ draftPatchesByEpicId: {} });
    window.localStorage.setItem(KEY, persistedBytes);
    await useNewConversationModalStore.persist.rehydrate();

    const restored =
      useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID];
    if (restored === undefined) throw new Error("patch did not rehydrate");
    expect(restored.content).toEqual(typed("later"));
    expect(restored.epicTitle).toBe("Epic");
    expect(restored.draftId).toBe(written.draftId);
    expect(restored.lastTouchedAt).toBe(written.lastTouchedAt);
    // The sync bookkeeping survives verbatim: a reload that marked every
    // clean row dirty would re-publish rows the host already holds.
    expect(restored.generation).toBe(written.generation);
    expect(restored.syncedGeneration).toBe(written.syncedGeneration);
    expect(restored.hostRevision).toBe(written.hostRevision);
  });

  it("strips a still-pending base64 image node on write, keeping the hash-only one", () => {
    useNewConversationModalStore.getState().setContent(EPIC_ID, {
      type: "doc",
      content: [
        {
          type: "attachmentGroup",
          content: [
            { type: "imageAttachment", attrs: { hash: "a".repeat(64) } },
            {
              type: "imageAttachment",
              attrs: { b64content: "data:image/png;base64,AAAA" },
            },
          ],
        },
      ],
    });

    const persisted = readPersistedPatches()[EPIC_ID];
    expect(JSON.stringify(persisted)).not.toContain("b64content");
    expect(JSON.stringify(persisted)).toContain("a".repeat(64));
    // The in-memory document is canonical and keeps the pending node until
    // its ingest flips it to a hash.
    const live =
      useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID];
    expect(JSON.stringify(live)).toContain("b64content");
  });

  it("drops a persisted patch whose content is not editor JSON", async () => {
    // Deliberately not typed as a patch: the point is a payload whose
    // `content` never was editor JSON, which no `Partial<Patch>` can express.
    const broken: unknown = { content: "not a document", draftId: "d-broken" };
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        version: 1,
        state: { draftPatchesByEpicId: { [EPIC_ID]: broken } },
      }),
    );

    await useNewConversationModalStore.persist.rehydrate();

    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID],
    ).toBeUndefined();
  });

  it("restores a null workspace as null rather than an empty snapshot", async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        version: 1,
        state: {
          draftPatchesByEpicId: {
            [EPIC_ID]: {
              content: typed("later"),
              workspace: null,
              composerMode: "nonsense",
              draftId: "d-1",
            },
          },
        },
      }),
    );

    await useNewConversationModalStore.persist.rehydrate();

    const restored =
      useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID];
    if (restored === undefined) throw new Error("patch did not rehydrate");
    // `null` means "no workspace of its own yet, use the seed"; the empty
    // snapshot would mean "the user emptied it".
    expect(restored.workspace).toBeNull();
    expect(restored.composerMode).toBeNull();
    expect(restored.workspace).not.toEqual(
      emptyLandingDraftWorkspaceSnapshot(),
    );
  });
});
