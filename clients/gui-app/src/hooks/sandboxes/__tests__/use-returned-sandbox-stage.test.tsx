/**
 * A message given back to a task's new-agent composer keeps its sandbox on
 * the draft: the composer stages it again after a reload, never over a pick
 * of its own, and a deleted draft takes it along.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { deleteNewChatDraftRow } from "@/lib/drafts/draft-inventory-actions";
import { persistKey, STORE_KEYS } from "@/lib/persist";
import type { ReturnedSandbox } from "@/lib/sandboxes/returned-sandbox";
import {
  readStagedSandbox,
  useStagedSandboxStore,
  type StagedSandboxTarget,
} from "@/stores/composer/staged-sandbox-store";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import { newConversationSurfaceKey } from "@/stores/host/surface-host-selection-store";
import { useNewConversationReturnedSandbox } from "../use-returned-sandbox-stage";

const EPIC_ID = "epic-1";
const SURFACE = newConversationSurfaceKey(EPIC_ID);

const MESSAGE: JsonContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "fix the login bug" }],
    },
  ],
};

const RETURNED: ReturnedSandbox = {
  target: {
    kind: "existing",
    hostId: "sbx-host",
    sandboxId: "sbx-1",
    name: "build-box",
    configuration: { kind: "personal" },
    verb: "resume",
  },
  clientRequestId: null,
};

const LOCAL_PICK: StagedSandboxTarget = {
  kind: "existing",
  hostId: "other-host",
  sandboxId: "sbx-2",
  name: "other-box",
  configuration: { kind: "personal" },
  verb: "start",
};

/** The draft a give-back leaves: the message, with its sandbox. */
function giveBack(): void {
  const drafts = useNewConversationModalStore.getState();
  drafts.setContent(EPIC_ID, MESSAGE);
  drafts.setReturnedSandbox(EPIC_ID, RETURNED);
}

/** A reload: the composer's stage is gone with the window, drafts are read back. */
async function reload(): Promise<void> {
  cleanup();
  const key = persistKey(STORE_KEYS.newConversationDraft);
  const saved = localStorage.getItem(key);
  useStagedSandboxStore.getState().clear(SURFACE);
  useNewConversationModalStore.setState({ draftPatchesByEpicId: {} });
  if (saved === null) localStorage.removeItem(key);
  else localStorage.setItem(key, saved);
  await useNewConversationModalStore.persist.rehydrate();
}

function mountComposer(): void {
  renderHook(() => useNewConversationReturnedSandbox(EPIC_ID, null));
}

function returnedOnDraft(): ReturnedSandbox | undefined {
  return useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID]
    ?.returnedSandbox;
}

beforeEach(() => {
  localStorage.clear();
  useNewConversationModalStore.getState().resetForTests();
  useStagedSandboxStore.setState({ bySurface: {} });
});

afterEach(() => {
  cleanup();
  useNewConversationModalStore.getState().resetForTests();
  useStagedSandboxStore.setState({ bySurface: {} });
  localStorage.clear();
});

describe("useNewConversationReturnedSandbox", () => {
  it("leaves this window's own pick when another window gives a message back to the same draft", () => {
    mountComposer();
    act(() => {
      useStagedSandboxStore.getState().stage(SURFACE, LOCAL_PICK);
    });

    // The other window's give-back reaches this window's draft.
    act(() => {
      giveBack();
    });

    expect(readStagedSandbox(SURFACE)).toMatchObject({
      phase: "staged",
      target: LOCAL_PICK,
      clientRequestId: null,
    });
    expect(returnedOnDraft()).toEqual(RETURNED);
  });

  it("stages nothing after the draft is deleted from Drafts and the window reloads", async () => {
    giveBack();
    const draftId =
      useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID]
        ?.draftId ?? null;
    if (draftId === null) throw new Error("expected a draft id");

    deleteNewChatDraftRow(
      { epicId: EPIC_ID, draftId, ownerHostId: null },
      null,
    );
    await reload();
    mountComposer();

    expect(readStagedSandbox(SURFACE)).toBeNull();
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID],
    ).toBeUndefined();
  });
});
