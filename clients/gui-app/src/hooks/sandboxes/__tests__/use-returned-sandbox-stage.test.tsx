/**
 * A message given back to a task's new-agent composer keeps its sandbox on
 * the draft: the composer stages it again after a reload, never over a pick
 * of its own, and a deleted draft takes it along.
 */
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { DraftDocument } from "@traycer/protocol/host";
import {
  deleteLandingDraftRow,
  deleteNewChatDraftRow,
} from "@/lib/drafts/draft-inventory-actions";
import { useAuthStore } from "@/stores/auth/auth-store";
import { persistKey, STORE_KEYS } from "@/lib/persist";
import {
  markReturnedSandboxRestored,
  type ReturnedSandbox,
  type StoredReturnedSandbox,
} from "@/lib/sandboxes/returned-sandbox";
import { EpicSessionLifecycleBridge } from "@/providers/auth-lifecycle-bridge";
import {
  readStagedSandbox,
  useStagedSandboxStore,
  type StagedSandboxTarget,
} from "@/stores/composer/staged-sandbox-store";
import {
  applyNewChatHostDocument,
  useNewConversationModalStore,
} from "@/stores/epics/new-conversation-modal-store";
import {
  newConversationSurfaceKey,
  useSurfaceHostSelectionStore,
} from "@/stores/host/surface-host-selection-store";
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

/** As a draft keeps it: under the account that was signed in. */
function stored(returned: ReturnedSandbox): StoredReturnedSandbox {
  return { ...returned, userId: "user-a" };
}

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

function returnedOnDraft(): StoredReturnedSandbox | undefined {
  return useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID]
    ?.returnedSandbox;
}

beforeEach(() => {
  localStorage.clear();
  useNewConversationModalStore.getState().resetForTests();
  useStagedSandboxStore.setState({ bySurface: {} });
  signInAs("user-a");
});

afterEach(() => {
  cleanup();
  useNewConversationModalStore.getState().resetForTests();
  useStagedSandboxStore.setState({ bySurface: {} });
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
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
    expect(returnedOnDraft()).toEqual(stored(RETURNED));
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
    expect(returnedOnDraft()).toEqual(stored(keyed));

    mountComposer();

    expect(readStagedSandbox(SURFACE)).toMatchObject({
      target: keyed.target,
      clientRequestId: "key-1",
    });
  });
});

describe("a task draft deleted while its composer shows it", () => {
  it("takes its restored stage with it", () => {
    act(() => {
      const drafts = useNewConversationModalStore.getState();
      drafts.setContent(EPIC_ID, MESSAGE);
      drafts.setReturnedSandbox(EPIC_ID, {
        ...RETURNED,
        clientRequestId: "key-1",
      });
    });
    mountComposer();
    const draftId =
      useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID]
        ?.draftId ?? null;
    if (draftId === null) throw new Error("expected a draft id");
    expect(readStagedSandbox(SURFACE)?.clientRequestId).toBe("key-1");

    act(() => {
      deleteNewChatDraftRow(
        { epicId: EPIC_ID, draftId, ownerHostId: null },
        null,
      );
    });

    expect(readStagedSandbox(SURFACE)).toBeNull();
  });
});

describe("a task draft the host replaces with another line while its composer shows it", () => {
  it("takes its restored stage with it, so the new line holds none", () => {
    act(() => {
      const drafts = useNewConversationModalStore.getState();
      drafts.setContent(EPIC_ID, MESSAGE);
      drafts.setReturnedSandbox(EPIC_ID, {
        ...RETURNED,
        clientRequestId: "key-1",
      });
      // The draft's text has reached the host: its next document lands.
      useNewConversationModalStore.setState((state) => {
        const patch = state.draftPatchesByEpicId[EPIC_ID];
        if (patch === undefined) throw new Error("expected the draft");
        return {
          draftPatchesByEpicId: {
            [EPIC_ID]: { ...patch, syncedGeneration: patch.generation },
          },
        };
      });
    });
    mountComposer();
    expect(readStagedSandbox(SURFACE)?.clientRequestId).toBe("key-1");

    act(() => {
      applyNewChatHostDocument(newLineDocument("draft-other-line"));
    });

    expect(returnedOnDraft()).toBeUndefined();
    expect(readStagedSandbox(SURFACE)).toBeNull();
  });
});

describe("a draft's record written while no composer shows it", () => {
  it("is staged when the composer opens, and leaves when it closes", () => {
    giveBack();
    expect(readStagedSandbox(SURFACE)).toBeNull();

    const composer = renderHook(() =>
      useNewConversationReturnedSandbox(EPIC_ID, null),
    );
    expect(readStagedSandbox(SURFACE)?.target).toEqual(RETURNED.target);

    composer.unmount();
    expect(readStagedSandbox(SURFACE)).toBeNull();
    expect(returnedOnDraft()).toEqual(stored(RETURNED));
  });

  it("stages nothing when the draft is deleted before its composer ever opens", () => {
    giveBack();
    const draftId =
      useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID]
        ?.draftId ?? null;
    if (draftId === null) throw new Error("expected a draft id");
    deleteNewChatDraftRow(
      { epicId: EPIC_ID, draftId, ownerHostId: null },
      null,
    );

    mountComposer();

    expect(readStagedSandbox(SURFACE)).toBeNull();
  });
});

describe("a newer destination marked while an older one is shown", () => {
  it("keeps the newer mark when the older stage is released, so the newer one leaves with its draft", () => {
    giveBack();
    const composer = renderHook(() =>
      useNewConversationReturnedSandbox(EPIC_ID, null),
    );
    expect(readStagedSandbox(SURFACE)?.target).toEqual(RETURNED.target);
    const stopped: ReturnedSandbox = {
      target: {
        kind: "existing",
        hostId: "sbx-host",
        sandboxId: "sbx-1",
        name: "build-box",
        configuration: { kind: "personal" },
        verb: "start",
      },
      clientRequestId: null,
    };

    // The draft's destination moves to the same sandbox, now stopped, and
    // the newer one is on the surface and marked before the older releases.
    act(() => {
      useNewConversationModalStore
        .getState()
        .setReturnedSandbox(EPIC_ID, stopped);
      useStagedSandboxStore.getState().stage(SURFACE, stopped.target);
      markReturnedSandboxRestored(SURFACE, stopped);
    });
    expect(readStagedSandbox(SURFACE)?.target).toEqual(stopped.target);

    composer.unmount();

    expect(readStagedSandbox(SURFACE)).toBeNull();
  });
});

describe("a teardown that clears every stage", () => {
  it("puts the shown draft's stage back, and never forgets its record", () => {
    mountComposer();
    act(() => giveBack());
    expect(readStagedSandbox(SURFACE)?.target).toEqual(RETURNED.target);

    act(() => useStagedSandboxStore.getState().clearAll());

    expect(returnedOnDraft()).toEqual(stored(RETURNED));
    expect(readStagedSandbox(SURFACE)?.target).toEqual(RETURNED.target);
  });
});

describe("a returned sandbox across an account switch", () => {
  it("is never restored into the next account's task composer", () => {
    signInAs("user-a");
    giveBack();
    // The switch clears every stage (`auth-lifecycle-bridge`); the draft stays.
    signInAs("user-b");
    useStagedSandboxStore.getState().clearAll();

    mountComposer();

    expect(readStagedSandbox(SURFACE)).toBeNull();
    act(() => signInAs("user-a"));
    expect(readStagedSandbox(SURFACE)?.target).toEqual(RETURNED.target);
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
      expect(returnedOnDraft()).toEqual(stored(RETURNED));
    },
  );
});

describe("useLandingReturnedSandbox", () => {
  const WINDOW_SURFACE = "landing:window-test";

  function installReturnedDraft(
    id: string,
    returned: ReturnedSandbox | null,
  ): void {
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

  it("takes a deleted draft's restored stage off the composer, so the next draft shown holds none", () => {
    installReturnedDraft("draft-a", { ...RETURNED, clientRequestId: "key-a" });
    installReturnedDraft("draft-b", null);
    const composer = renderHook<void, { readonly draftId: string }>(
      (props) => useLandingReturnedSandbox(WINDOW_SURFACE, props.draftId, true),
      { initialProps: { draftId: "draft-a" } },
    );
    expect(readStagedSandbox(WINDOW_SURFACE)?.clientRequestId).toBe("key-a");
    const shown = useLandingDraftStore
      .getState()
      .drafts.find((draft) => draft.id === "draft-a");
    if (shown === undefined) throw new Error("expected draft A");

    act(() => {
      deleteLandingDraftRow(shown, null, null);
    });
    composer.rerender({ draftId: "draft-b" });

    expect(readStagedSandbox(WINDOW_SURFACE)).toBeNull();
    expect(
      Object.values(useStagedSandboxStore.getState().bySurface).map(
        (stage) => stage?.clientRequestId,
      ),
    ).not.toContain("key-a");
  });

  it("never restores another account's returned sandbox into this window's composer", () => {
    signInAs("user-a");
    installReturnedDraft("draft-a", RETURNED);
    signInAs("user-b");
    useStagedSandboxStore.getState().clearAll();

    renderHook(() =>
      useLandingReturnedSandbox(WINDOW_SURFACE, "draft-a", true),
    );

    expect(readStagedSandbox(WINDOW_SURFACE)).toBeNull();
  });

  it("restores the owner's stage through the real identity teardown, and keeps the record across the switch", () => {
    installReturnedDraft("draft-a", RETURNED);
    function Composer(): null {
      useLandingReturnedSandbox(WINDOW_SURFACE, "draft-a", true);
      return null;
    }
    render(
      <EpicSessionLifecycleBridge>
        <Composer />
      </EpicSessionLifecycleBridge>,
    );
    expect(readStagedSandbox(WINDOW_SURFACE)?.target).toEqual(RETURNED.target);

    act(() => signInAs("user-b"));
    expect(readStagedSandbox(WINDOW_SURFACE)).toBeNull();
    expect(landingReturned("draft-a")).toEqual(stored(RETURNED));

    act(() => signInAs("user-a"));
    expect(readStagedSandbox(WINDOW_SURFACE)?.target).toEqual(RETURNED.target);

    act(() =>
      useAuthStore.setState({ status: "signed-out", contextMetadata: null }),
    );
    expect(readStagedSandbox(WINDOW_SURFACE)).toBeNull();
    expect(landingReturned("draft-a")).toEqual(stored(RETURNED));
  });

  it("never writes the window's host pin when it restores", () => {
    installReturnedDraft("draft-a", RETURNED);
    const before = useSurfaceHostSelectionStore.getState().selections;

    renderHook(() =>
      useLandingReturnedSandbox(WINDOW_SURFACE, "draft-a", true),
    );

    expect(readStagedSandbox(WINDOW_SURFACE)?.target).toEqual(RETURNED.target);
    expect(useSurfaceHostSelectionStore.getState().selections).toBe(before);
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
      expect(landingReturned("draft-a")).toEqual(stored(first));
      expect(landingReturned("draft-b")).toEqual(stored(second));

      show("draft-a");
      expect(readStagedSandbox(WINDOW_SURFACE)).toMatchObject({
        target: first.target,
        clientRequestId: "key-a",
      });
      expect(landingReturned("draft-b")).toEqual(stored(second));
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

function landingReturned(
  draftId: string,
): StoredReturnedSandbox | null | undefined {
  return useLandingDraftStore
    .getState()
    .drafts.find((draft) => draft.id === draftId)?.returnedSandbox;
}

function signInAs(userId: string): void {
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId, username: userId },
  });
}

/** The host's document for another draft line in this task's composer. */
function newLineDocument(draftId: string): DraftDocument {
  return {
    draftId,
    kind: "new-chat",
    target: { epicId: EPIC_ID, chatId: null, blockId: null },
    revision: 1,
    lastTouchedAt: 1,
    workspace: null,
    ownerHostId: "owner-host",
    origin: "own",
    adoption: { state: "adopted", hostId: "owner-host" },
    publication: {
      status: "unpublished",
      lastPublishedAt: null,
      publishedRevision: null,
      halted: null,
    },
    supersedes: null,
    portable: {
      content: MESSAGE,
      selection: null,
      runSettings: null,
      composerMode: "chat",
      blobHashes: [],
      closed: false,
    },
  };
}
