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
import {
  emptyLandingDraftWorkspaceSnapshot,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";
import {
  useLandingReturnedSandbox,
  useNewConversationReturnedSandbox,
} from "../use-returned-sandbox-stage";

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

describe("a restored stage leaves with its draft", () => {
  it("clears the task composer's restored stage when it closes, and restores it with its key when it reopens", () => {
    const keyed: ReturnedSandbox = { ...RETURNED, clientRequestId: "key-1" };
    act(() => {
      const drafts = useNewConversationModalStore.getState();
      drafts.setContent(EPIC_ID, MESSAGE);
      drafts.setReturnedSandbox(EPIC_ID, keyed);
    });
    const composer = renderHook(() =>
      useNewConversationReturnedSandbox(EPIC_ID, null),
    );
    expect(readStagedSandbox(SURFACE)?.clientRequestId).toBe("key-1");

    composer.unmount();

    expect(readStagedSandbox(SURFACE)).toBeNull();
    expect(returnedOnDraft()).toEqual(keyed);

    mountComposer();

    expect(readStagedSandbox(SURFACE)).toMatchObject({
      target: keyed.target,
      clientRequestId: "key-1",
    });
  });
});

describe("a restored stage a send has taken up", () => {
  it.each(["creating", "handoff"] as const)(
    "stays on the surface when the composer closes in %s",
    (phase) => {
      act(() => {
        const drafts = useNewConversationModalStore.getState();
        drafts.setContent(EPIC_ID, MESSAGE);
        drafts.setReturnedSandbox(EPIC_ID, RETURNED);
      });
      const composer = renderHook(() =>
        useNewConversationReturnedSandbox(EPIC_ID, null),
      );
      act(() => {
        const staged = useStagedSandboxStore.getState();
        staged.begin(SURFACE, false, Date.now(), true);
        if (phase === "handoff") staged.report(SURFACE, { phase: "handoff" });
      });
      expect(readStagedSandbox(SURFACE)?.phase).toBe(phase);

      composer.unmount();

      expect(readStagedSandbox(SURFACE)).toMatchObject({
        phase,
        target: RETURNED.target,
      });
      expect(returnedOnDraft()).toEqual(RETURNED);
    },
  );
});

describe("useLandingReturnedSandbox", () => {
  const WINDOW_SURFACE = "landing:window-test";

  function installReturnedDraft(id: string, returned: ReturnedSandbox): void {
    const drafts = useLandingDraftStore.getState();
    drafts.installLandingDraft({
      id,
      content: MESSAGE,
      selection: null,
      lastTouchedAt: Date.now(),
      settings: null,
      composerMode: "chat",
      workspace: emptyLandingDraftWorkspaceSnapshot(),
      closed: false,
    });
    drafts.setDraftReturnedSandbox(id, returned);
  }

  beforeEach(() => {
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  });

  afterEach(() => {
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  });

  it("stages only the shown draft's sandbox when a hidden draft's composer is also mounted", () => {
    const shown: ReturnedSandbox = {
      target: {
        kind: "existing",
        hostId: "sbx-shown-host",
        sandboxId: "sbx-shown",
        name: "shown-box",
        configuration: { kind: "personal" },
        verb: "resume",
      },
      clientRequestId: null,
    };
    installReturnedDraft("draft-hidden", RETURNED);
    installReturnedDraft("draft-shown", shown);

    renderHook(() =>
      useLandingReturnedSandbox(WINDOW_SURFACE, "draft-hidden", false),
    );
    renderHook(() =>
      useLandingReturnedSandbox(WINDOW_SURFACE, "draft-shown", true),
    );

    expect(readStagedSandbox(WINDOW_SURFACE)?.target).toEqual(shown.target);
  });

  // The landing composer either changes its draft, or a retained composer
  // hides while another shows.
  it.each<LandingShape>([
    "one composer changing its draft",
    "two composers trading places",
  ])(
    "stages each draft's own sandbox as the shown draft changes: %s",
    (shape) => {
      const first: ReturnedSandbox = { ...RETURNED, clientRequestId: "key-a" };
      const second: ReturnedSandbox = {
        target: {
          kind: "existing",
          hostId: "sbx-b-host",
          sandboxId: "sbx-b",
          name: "b-box",
          configuration: { kind: "personal" },
          verb: "start",
        },
        clientRequestId: null,
      };
      installReturnedDraft("draft-a", first);
      installReturnedDraft("draft-b", second);
      const show = mountLanding(shape, WINDOW_SURFACE);

      show("draft-a");
      expect(readStagedSandbox(WINDOW_SURFACE)).toMatchObject({
        target: first.target,
        clientRequestId: "key-a",
      });

      show("draft-b");
      expect(readStagedSandbox(WINDOW_SURFACE)).toMatchObject({
        target: second.target,
        clientRequestId: null,
      });
      expect(landingReturned("draft-a")).toEqual(first);
      expect(landingReturned("draft-b")).toEqual(second);

      show("draft-a");
      expect(readStagedSandbox(WINDOW_SURFACE)).toMatchObject({
        target: first.target,
        clientRequestId: "key-a",
      });
      expect(landingReturned("draft-b")).toEqual(second);
    },
  );
});

/**
 * Mounts the window's landing composer(s) and returns a way to show a draft:
 * one composer whose draft changes, or one retained composer per draft with
 * only the shown one active.
 */
type LandingShape =
  | "one composer changing its draft"
  | "two composers trading places";

function mountLanding(
  shape: LandingShape,
  surfaceKey: string,
): (draftId: "draft-a" | "draft-b") => void {
  if (shape === "one composer changing its draft") {
    const composer = renderHook<void, { readonly draftId: string | null }>(
      (props) => useLandingReturnedSandbox(surfaceKey, props.draftId, true),
      { initialProps: { draftId: null } },
    );
    return (draftId) => composer.rerender({ draftId });
  }
  const composers = renderHook<void, { readonly shown: string | null }>(
    (props) => {
      useLandingReturnedSandbox(
        surfaceKey,
        "draft-a",
        props.shown === "draft-a",
      );
      useLandingReturnedSandbox(
        surfaceKey,
        "draft-b",
        props.shown === "draft-b",
      );
    },
    { initialProps: { shown: null } },
  );
  return (draftId) => composers.rerender({ shown: draftId });
}

function landingReturned(draftId: string): ReturnedSandbox | null | undefined {
  return useLandingDraftStore
    .getState()
    .drafts.find((draft) => draft.id === draftId)?.returnedSandbox;
}
