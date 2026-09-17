import type { JsonContent } from "@traycer/protocol/common/registry";
import { afterEach, describe, expect, it } from "vitest";

import {
  draftInventoryOwnerHostIds,
  listDraftInventory,
  type DraftInventoryFilter,
  type DraftInventoryRow,
  type DraftInventoryScope,
} from "@/lib/drafts/draft-inventory";
import {
  bindNewChatDraftHost,
  unbindNewChatDraftHost,
} from "@/lib/drafts/draft-mirror-coordinator";
import { setLandingPlacementHostReader } from "@/lib/drafts/draft-local-edits";
import type { DraftState } from "@/stores/composer/composer-draft-store";
import type { NewConversationModalDraftPatch } from "@/stores/epics/new-conversation-modal-store";
import type {
  LandingDraftTab,
  LandingDraftWorkspaceSnapshot,
} from "@/stores/home/landing-draft-store";

const EMPTY_WORKSPACE: LandingDraftWorkspaceSnapshot = {
  folders: [],
  folderInfoByPath: {},
  primaryPath: null,
};

function doc(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

const EMPTY_DOC: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

/** A real draft with no derived text - the per-kind title fallback's case. */
const IMAGE_ONLY_DOC: JsonContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "imageAttachment", attrs: { hash: "abc" } }],
    },
  ],
};

function landingTab(
  overrides: Partial<LandingDraftTab> & { readonly id: string },
): LandingDraftTab {
  return {
    content: doc(`landing ${overrides.id}`),
    selection: null,
    lastTouchedAt: 1_000,
    settings: null,
    composerMode: "chat",
    workspace: EMPTY_WORKSPACE,
    adoption: { state: "unadopted" },
    hostRevision: 0,
    generation: 1,
    syncedGeneration: 0,
    ownerHostId: null,
    origin: null,
    supersedes: null,
    publication: null,
    confirmedHostBlobHashes: [],
    closed: false,
    ...overrides,
  };
}

function chatDraft(overrides: Partial<DraftState>): DraftState {
  return {
    content: doc("chat draft"),
    selection: null,
    browserAnnotations: [],
    resetEpoch: 0,
    revision: 1,
    draftId: "draft-chat",
    hostRevision: 1,
    targetEpicId: "epic-1",
    lastTouchedAt: 2_000,
    generation: 1,
    syncedGeneration: 1,
    ownerHostId: "host-a",
    origin: "own",
    supersedes: null,
    publication: null,
    chatTitle: "Refactor the parser",
    epicTitle: "Parser work",
    ...overrides,
  };
}

function newChatPatch(
  overrides: Partial<NewConversationModalDraftPatch>,
): NewConversationModalDraftPatch {
  return {
    content: doc("new chat draft"),
    selection: null,
    settings: null,
    composerMode: "chat",
    workspace: null,
    revision: 1,
    draftId: "draft-new-chat",
    hostRevision: 1,
    lastTouchedAt: 3_000,
    generation: 1,
    syncedGeneration: 1,
    epicTitle: "Parser work",
    ownerHostId: "host-a",
    ...overrides,
  };
}

const LANDING_SCOPE: DraftInventoryScope = {
  surface: "landing",
  activeDraftId: "landing-active",
};
const CHAT_SCOPE: DraftInventoryScope = {
  surface: "chat",
  epicId: "epic-1",
  chatId: "chat-own",
};
const NEW_CHAT_SCOPE: DraftInventoryScope = {
  surface: "new-chat",
  epicId: "epic-1",
};

function list(input: {
  readonly scope: DraftInventoryScope;
  readonly filter: DraftInventoryFilter;
  readonly landing?: ReadonlyArray<LandingDraftTab>;
  readonly composer?: Partial<Record<string, DraftState>>;
  readonly newChat?: Readonly<
    Record<string, NewConversationModalDraftPatch | undefined>
  >;
  readonly openChatIds?: ReadonlySet<string>;
  readonly liveSessionHostIds?: ReadonlySet<string>;
}): ReadonlyArray<DraftInventoryRow> {
  return listDraftInventory({
    scope: input.scope,
    filter: input.filter,
    landing: input.landing ?? [],
    composer: input.composer ?? {},
    newChat: input.newChat ?? {},
    openChatIds: input.openChatIds ?? new Set(),
    liveSessionHostIds: input.liveSessionHostIds ?? new Set(["host-a"]),
  });
}

afterEach(() => {
  setLandingPlacementHostReader(null);
});

describe("landing rows", () => {
  it("lists every non-empty draft but the one being edited", () => {
    const rows = list({
      scope: LANDING_SCOPE,
      filter: "current",
      landing: [
        landingTab({ id: "landing-active" }),
        landingTab({ id: "landing-kept" }),
        landingTab({ id: "landing-blank", content: EMPTY_DOC }),
      ],
    });
    expect(rows.map((row) => row.id)).toEqual(["landing-kept"]);
  });

  it("badges a draft still open in the tab strip", () => {
    const rows = list({
      scope: LANDING_SCOPE,
      filter: "current",
      landing: [
        landingTab({ id: "open-one" }),
        landingTab({ id: "put-away", closed: true }),
      ],
    });
    expect(Object.fromEntries(rows.map((row) => [row.id, row.open]))).toEqual({
      "open-one": true,
      "put-away": false,
    });
  });

  it("marks a replica and an own row adopted off the placement host foreign", () => {
    setLandingPlacementHostReader(() => "host-a");
    const rows = list({
      scope: LANDING_SCOPE,
      filter: "current",
      landing: [
        landingTab({ id: "mine", origin: "own" }),
        landingTab({ id: "replica", origin: "replica" }),
        landingTab({
          id: "elsewhere",
          origin: "own",
          adoption: { state: "adopted", hostId: "host-b" },
        }),
      ],
    });
    expect(
      Object.fromEntries(rows.map((row) => [row.id, row.foreign])),
    ).toEqual({ mine: false, replica: true, elsewhere: true });
  });

  it("carries the row's owner host", () => {
    const [row] = list({
      scope: LANDING_SCOPE,
      filter: "current",
      landing: [landingTab({ id: "adopted", ownerHostId: "host-b" })],
    });
    expect(row.ownerHostId).toBe("host-b");
  });
});

describe("chat rows", () => {
  it("excludes the scope's own chat, incomplete rows and empty content", () => {
    const rows = list({
      scope: CHAT_SCOPE,
      filter: "current",
      composer: {
        "chat-own": chatDraft({ draftId: "draft-own" }),
        "chat-sibling": chatDraft({ draftId: "draft-sibling" }),
        "chat-unsynced": chatDraft({ draftId: null }),
        "chat-no-epic": chatDraft({
          draftId: "draft-no-epic",
          targetEpicId: null,
        }),
        "chat-blank": chatDraft({
          draftId: "draft-blank",
          content: EMPTY_DOC,
        }),
      },
    });
    expect(rows.map((row) => row.id)).toEqual(["draft-sibling"]);
  });

  it("keeps only this epic under `current` and every epic under `all`", () => {
    const composer = {
      "chat-here": chatDraft({ draftId: "draft-here" }),
      "chat-there": chatDraft({
        draftId: "draft-there",
        targetEpicId: "epic-2",
      }),
    };
    expect(
      list({ scope: CHAT_SCOPE, filter: "current", composer }).map(
        (row) => row.id,
      ),
    ).toEqual(["draft-here"]);
    expect(
      new Set(
        list({ scope: CHAT_SCOPE, filter: "all", composer }).map(
          (row) => row.id,
        ),
      ),
    ).toEqual(new Set(["draft-here", "draft-there"]));
  });

  it("hides a row whose owner host has no draft mirror session", () => {
    const composer = {
      "chat-live": chatDraft({ draftId: "draft-live", ownerHostId: "host-a" }),
      "chat-gone": chatDraft({ draftId: "draft-gone", ownerHostId: "host-b" }),
      "chat-unowned": chatDraft({
        draftId: "draft-unowned",
        ownerHostId: null,
      }),
    };
    expect(
      list({ scope: CHAT_SCOPE, filter: "all", composer }).map((row) => row.id),
    ).toEqual(["draft-live"]);
    expect(
      new Set(
        list({
          scope: CHAT_SCOPE,
          filter: "all",
          composer,
          liveSessionHostIds: new Set(["host-a", "host-b"]),
        }).map((row) => row.id),
      ),
    ).toEqual(new Set(["draft-live", "draft-gone"]));
  });

  it("badges an open chat and marks a replica foreign", () => {
    const rows = list({
      scope: CHAT_SCOPE,
      filter: "current",
      composer: {
        "chat-open": chatDraft({ draftId: "draft-open" }),
        "chat-closed": chatDraft({ draftId: "draft-closed" }),
        "chat-replica": chatDraft({
          draftId: "draft-replica",
          origin: "replica",
        }),
      },
      openChatIds: new Set(["chat-open"]),
    });
    expect(
      Object.fromEntries(
        rows.map((row) => [row.id, { open: row.open, foreign: row.foreign }]),
      ),
    ).toEqual({
      "draft-open": { open: true, foreign: false },
      "draft-closed": { open: false, foreign: false },
      "draft-replica": { open: false, foreign: true },
    });
  });

  it("falls back to Chat / Epic for a row no local composer has named", () => {
    const [row] = list({
      scope: CHAT_SCOPE,
      filter: "current",
      composer: {
        "chat-remote": chatDraft({
          draftId: "draft-remote",
          chatTitle: null,
          epicTitle: null,
        }),
      },
    });
    expect(row.kind).toBe("chat");
    expect(row).toMatchObject({ chatTitle: "Chat", epicTitle: "Epic" });
  });
});

describe("new-chat rows", () => {
  it("excludes the scope epic's own modal draft", () => {
    const rows = list({
      scope: NEW_CHAT_SCOPE,
      filter: "all",
      newChat: {
        "epic-1": newChatPatch({ draftId: "draft-own-modal" }),
        "epic-2": newChatPatch({ draftId: "draft-other-modal" }),
      },
    });
    expect(rows.map((row) => row.id)).toEqual(["draft-other-modal"]);
  });

  it("lists this epic's modal draft from a chat composer under `current`", () => {
    const newChat = {
      "epic-1": newChatPatch({ draftId: "draft-here" }),
      "epic-2": newChatPatch({ draftId: "draft-there" }),
    };
    expect(
      list({ scope: CHAT_SCOPE, filter: "current", newChat }).map(
        (row) => row.id,
      ),
    ).toEqual(["draft-here"]);
    expect(
      new Set(
        list({ scope: CHAT_SCOPE, filter: "all", newChat }).map(
          (row) => row.id,
        ),
      ),
    ).toEqual(new Set(["draft-here", "draft-there"]));
  });

  it("drops a patch with no draft id and one with empty content", () => {
    const rows = list({
      scope: CHAT_SCOPE,
      filter: "all",
      newChat: {
        "epic-2": newChatPatch({ draftId: null }),
        "epic-3": newChatPatch({ draftId: "draft-blank", content: null }),
        "epic-4": newChatPatch({ draftId: "draft-empty", content: EMPTY_DOC }),
      },
    });
    expect(rows).toEqual([]);
  });

  it("falls back to the epic's bound mirror host, and hides a patch with neither", () => {
    bindNewChatDraftHost("epic-2", "host-a");
    try {
      const rows = list({
        scope: CHAT_SCOPE,
        filter: "all",
        newChat: {
          "epic-2": newChatPatch({
            draftId: "draft-bound",
            ownerHostId: null,
          }),
          "epic-3": newChatPatch({
            draftId: "draft-unbound",
            ownerHostId: null,
          }),
        },
      });
      expect(rows.map((row) => row.id)).toEqual(["draft-bound"]);
      expect(rows[0]?.ownerHostId).toBe("host-a");
    } finally {
      unbindNewChatDraftHost("epic-2", "host-a");
    }
  });

  it("is never open and never foreign", () => {
    const [row] = list({
      scope: CHAT_SCOPE,
      filter: "current",
      newChat: { "epic-1": newChatPatch({ draftId: "draft-modal" }) },
    });
    expect(row).toMatchObject({ open: false, foreign: false });
  });

  it("falls back to Epic when no modal has recorded a title", () => {
    const [row] = list({
      scope: CHAT_SCOPE,
      filter: "current",
      newChat: {
        "epic-1": newChatPatch({ draftId: "draft-modal", epicTitle: null }),
      },
    });
    expect(row).toMatchObject({ epicTitle: "Epic" });
  });
});

describe("filters and ordering", () => {
  it("lists landing rows only under `current` on the start page", () => {
    const input = {
      landing: [landingTab({ id: "landing-one" })],
      composer: { "chat-one": chatDraft({ draftId: "draft-chat" }) },
      newChat: { "epic-1": newChatPatch({ draftId: "draft-modal" }) },
    };
    expect(
      list({ scope: LANDING_SCOPE, filter: "current", ...input }).map(
        (row) => row.kind,
      ),
    ).toEqual(["landing"]);
    expect(
      new Set(
        list({ scope: LANDING_SCOPE, filter: "all", ...input }).map(
          (row) => row.kind,
        ),
      ),
    ).toEqual(new Set(["landing", "chat", "new-chat"]));
  });

  it("omits landing rows from an in-epic `current` list", () => {
    const rows = list({
      scope: CHAT_SCOPE,
      filter: "current",
      landing: [landingTab({ id: "landing-one" })],
      composer: { "chat-one": chatDraft({ draftId: "draft-chat" }) },
    });
    expect(rows.map((row) => row.kind)).toEqual(["chat"]);
  });

  it("sorts newest first, breaking ties by id", () => {
    const rows = list({
      scope: LANDING_SCOPE,
      filter: "all",
      landing: [
        landingTab({ id: "b-tied", lastTouchedAt: 500 }),
        landingTab({ id: "a-tied", lastTouchedAt: 500 }),
        landingTab({ id: "newest", lastTouchedAt: 900 }),
      ],
      composer: {
        "chat-one": chatDraft({ draftId: "mid-chat", lastTouchedAt: 700 }),
      },
    });
    expect(rows.map((row) => row.id)).toEqual([
      "newest",
      "mid-chat",
      "a-tied",
      "b-tied",
    ]);
  });
});

describe("row text", () => {
  it("titles from the first line and flattens the preview onto one", () => {
    const [row] = list({
      scope: LANDING_SCOPE,
      filter: "current",
      landing: [
        landingTab({
          id: "wordy",
          content: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "  Fix   the parser  " }],
              },
              {
                type: "paragraph",
                content: [{ type: "text", text: "then ship it" }],
              },
            ],
          },
        }),
      ],
    });
    expect(row.title).toBe("Fix   the parser");
    expect(row.preview).toBe("Fix the parser then ship it");
  });

  it("cuts the preview at 160 characters", () => {
    const [row] = list({
      scope: LANDING_SCOPE,
      filter: "current",
      landing: [landingTab({ id: "long", content: doc("x".repeat(400)) })],
    });
    expect(row.preview).toHaveLength(160);
  });

  it("falls back to the start-page title for an untyped landing draft", () => {
    const [row] = list({
      scope: LANDING_SCOPE,
      filter: "current",
      landing: [landingTab({ id: "image-only", content: IMAGE_ONLY_DOC })],
    });
    expect(row.title).toBe("Start Page");
    expect(row.preview).toBe("");
  });

  it("falls back to the chat's own name for an untyped chat draft", () => {
    const [named] = list({
      scope: CHAT_SCOPE,
      filter: "current",
      composer: {
        "chat-named": chatDraft({
          draftId: "draft-named",
          content: IMAGE_ONLY_DOC,
          chatTitle: "Refactor the parser",
        }),
      },
    });
    expect(named.title).toBe("Refactor the parser");
    // Unnamed rows land on the chip fallback, not on "Start Page".
    const [unnamed] = list({
      scope: CHAT_SCOPE,
      filter: "current",
      composer: {
        "chat-remote": chatDraft({
          draftId: "draft-remote",
          content: IMAGE_ONLY_DOC,
          chatTitle: null,
        }),
      },
    });
    expect(unnamed.title).toBe("Chat");
  });

  it("falls back to New agent for an untyped modal draft", () => {
    const [row] = list({
      scope: CHAT_SCOPE,
      filter: "current",
      newChat: {
        "epic-1": newChatPatch({
          draftId: "draft-modal",
          content: IMAGE_ONLY_DOC,
        }),
      },
    });
    expect(row.title).toBe("New agent");
  });
});

describe("draftInventoryOwnerHostIds", () => {
  it("collects owner hosts the rows would route through, fallback included", () => {
    bindNewChatDraftHost("epic-9", "host-c");
    try {
      const hostIds = draftInventoryOwnerHostIds(
        {
          "chat-a": chatDraft({ ownerHostId: "host-a" }),
          "chat-b": chatDraft({ ownerHostId: "host-b" }),
          "chat-none": chatDraft({ ownerHostId: null }),
        },
        {
          "epic-9": newChatPatch({ ownerHostId: null }),
          "epic-8": newChatPatch({ ownerHostId: "host-a" }),
        },
      );
      expect(new Set(hostIds)).toEqual(new Set(["host-a", "host-b", "host-c"]));
    } finally {
      unbindNewChatDraftHost("epic-9", "host-c");
    }
  });
});
