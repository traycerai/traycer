import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { interviewDraftKey } from "@/lib/persist";
import {
  readInterviewDraftSnapshot,
  rehydrateInterviewDraftsFromStorage,
  selectInterviewDraft,
  useInterviewDraftStore,
} from "../interview-draft-store";

const LEGACY_SINGLE_KEY = "traycer-gui-app:interview-drafts";

const sampleDraft = {
  pageIndex: 1,
  answers: [
    {
      selected: ["Alpha"],
      otherText: "",
      otherSelected: false,
    },
    {
      selected: [],
      otherText: "A longer answer",
      otherSelected: true,
    },
  ],
};

beforeEach(() => {
  window.localStorage.clear();
  useInterviewDraftStore.setState({ draftsByChat: {} });
});

afterEach(() => {
  useInterviewDraftStore.setState({ draftsByChat: {} });
  window.localStorage.clear();
});

describe("interview draft store", () => {
  it("persists and rehydrates drafts by chat and interview block", () => {
    useInterviewDraftStore
      .getState()
      .saveDraft("chat-1", "block-1", sampleDraft);

    const perKey = interviewDraftKey("chat-1", "block-1");
    const persisted = window.localStorage.getItem(perKey);
    expect(persisted).not.toBeNull();
    expect(window.localStorage.getItem(LEGACY_SINGLE_KEY)).toBeNull();
    expect(JSON.parse(persisted ?? "null")).toEqual(sampleDraft);

    useInterviewDraftStore.setState({ draftsByChat: {} });
    rehydrateInterviewDraftsFromStorage();

    expect(readInterviewDraftSnapshot("chat-1", "block-1")).toEqual(
      sampleDraft,
    );
  });

  it("removes the per-key entry and chat bucket after its last interview draft is cleared", () => {
    const store = useInterviewDraftStore.getState();
    store.saveDraft("chat-1", "block-1", {
      pageIndex: 0,
      answers: [],
    });
    expect(
      window.localStorage.getItem(interviewDraftKey("chat-1", "block-1")),
    ).not.toBeNull();

    store.clearDraft("chat-1", "block-1");

    expect(
      window.localStorage.getItem(interviewDraftKey("chat-1", "block-1")),
    ).toBeNull();
    expect(useInterviewDraftStore.getState().draftsByChat).toEqual({});
  });

  it("drops malformed persisted drafts during hydration", () => {
    window.localStorage.setItem(
      interviewDraftKey("chat-1", "broken"),
      JSON.stringify({ pageIndex: "first", answers: "not-an-array" }),
    );

    rehydrateInterviewDraftsFromStorage();

    expect(useInterviewDraftStore.getState().draftsByChat).toEqual({});
  });

  it("a write from a stale second store context does not erase another chat's draft", () => {
    const draftA = {
      pageIndex: 0,
      answers: [{ selected: ["A"], otherText: "", otherSelected: false }],
    };
    const draftB = {
      pageIndex: 1,
      answers: [{ selected: ["B"], otherText: "kept", otherSelected: true }],
    };

    useInterviewDraftStore.getState().saveDraft("chatA", "block", draftA);
    // Simulate a stale second writer that only knows about chatB.
    window.localStorage.setItem(
      interviewDraftKey("chatB", "block"),
      JSON.stringify(draftB),
    );
    useInterviewDraftStore.getState().saveDraft("chatB", "block", draftB);

    expect(
      window.localStorage.getItem(interviewDraftKey("chatA", "block")),
    ).not.toBeNull();
    expect(
      window.localStorage.getItem(interviewDraftKey("chatB", "block")),
    ).not.toBeNull();
    expect(
      JSON.parse(
        window.localStorage.getItem(interviewDraftKey("chatA", "block")) ??
          "null",
      ),
    ).toEqual(draftA);
    expect(
      JSON.parse(
        window.localStorage.getItem(interviewDraftKey("chatB", "block")) ??
          "null",
      ),
    ).toEqual(draftB);
  });

  it("rehydrates from a storage event when another window seeds a per-key entry", () => {
    const draft = {
      pageIndex: 0,
      answers: [{ selected: ["X"], otherText: "", otherSelected: false }],
    };
    const key = interviewDraftKey("chatX", "blockX");
    window.localStorage.setItem(key, JSON.stringify(draft));

    window.dispatchEvent(new StorageEvent("storage", { key }));

    expect(
      useInterviewDraftStore.getState().draftsByChat["chatX"]?.["blockX"],
    ).toEqual(draft);
  });

  it("ignores storage events for unrelated keys without wiping in-memory drafts", () => {
    const draft = {
      pageIndex: 0,
      answers: [{ selected: ["Keep"], otherText: "", otherSelected: false }],
    };
    // Memory-only row: if rehydrate ran against empty storage it would wipe.
    useInterviewDraftStore.setState({
      draftsByChat: {
        "chat-keep": {
          block: draft,
        },
      },
    });
    window.localStorage.clear();

    window.dispatchEvent(
      new StorageEvent("storage", { key: "traycer-gui-app:settings" }),
    );

    expect(
      useInterviewDraftStore.getState().draftsByChat["chat-keep"]?.block,
    ).toEqual(draft);
  });

  it("pruneChatDrafts removes non-kept blocks from memory and localStorage", () => {
    const draftA = {
      pageIndex: 0,
      answers: [{ selected: ["A"], otherText: "", otherSelected: false }],
    };
    const draftB = {
      pageIndex: 1,
      answers: [{ selected: ["B"], otherText: "", otherSelected: false }],
    };
    const store = useInterviewDraftStore.getState();
    store.saveDraft("chat-1", "blockA", draftA);
    store.saveDraft("chat-1", "blockB", draftB);

    store.pruneChatDrafts("chat-1", new Set(["blockA"]));

    expect(readInterviewDraftSnapshot("chat-1", "blockA")).toEqual(draftA);
    expect(readInterviewDraftSnapshot("chat-1", "blockB")).toBeNull();
    expect(
      window.localStorage.getItem(interviewDraftKey("chat-1", "blockA")),
    ).not.toBeNull();
    expect(
      window.localStorage.getItem(interviewDraftKey("chat-1", "blockB")),
    ).toBeNull();
  });

  it("pruneChatDrafts with an empty keep set drops the chat bucket", () => {
    const store = useInterviewDraftStore.getState();
    store.saveDraft("chat-1", "blockA", {
      pageIndex: 0,
      answers: [],
    });
    store.saveDraft("chat-1", "blockB", {
      pageIndex: 0,
      answers: [],
    });

    store.pruneChatDrafts("chat-1", new Set());

    expect(useInterviewDraftStore.getState().draftsByChat).toEqual({});
    expect(
      window.localStorage.getItem(interviewDraftKey("chat-1", "blockA")),
    ).toBeNull();
    expect(
      window.localStorage.getItem(interviewDraftKey("chat-1", "blockB")),
    ).toBeNull();
  });

  it("pruneChatDrafts is a no-op when every draft is kept", () => {
    const draft = {
      pageIndex: 0,
      answers: [{ selected: ["Keep"], otherText: "", otherSelected: false }],
    };
    const store = useInterviewDraftStore.getState();
    store.saveDraft("chat-1", "blockA", draft);
    const before = useInterviewDraftStore.getState().draftsByChat;

    store.pruneChatDrafts("chat-1", new Set(["blockA"]));

    expect(useInterviewDraftStore.getState().draftsByChat).toBe(before);
    expect(readInterviewDraftSnapshot("chat-1", "blockA")).toEqual(draft);
  });

  it("does not pollute Object.prototype when chatId or blockId is __proto__", () => {
    const draft = {
      pageIndex: 0,
      answers: [{ selected: ["Safe"], otherText: "", otherSelected: false }],
    };
    useInterviewDraftStore.getState().saveDraft("__proto__", "b", draft);

    expect(Object.hasOwn(Object.prototype, "b")).toBe(false);
    const probe: Record<string, unknown> = {};
    expect(probe.b).toBeUndefined();
    expect(readInterviewDraftSnapshot("__proto__", "b")).toEqual(draft);
    expect(
      selectInterviewDraft(
        useInterviewDraftStore.getState().draftsByChat,
        "__proto__",
        "b",
      ),
    ).toEqual(draft);
    expect(readInterviewDraftSnapshot("normal-chat", "b")).toBeNull();
    expect(
      window.localStorage.getItem(interviewDraftKey("__proto__", "b")),
    ).not.toBeNull();

    useInterviewDraftStore.getState().clearDraft("__proto__", "b");
    expect(readInterviewDraftSnapshot("__proto__", "b")).toBeNull();
    expect(Object.hasOwn(Object.prototype, "b")).toBe(false);
    expect(probe.b).toBeUndefined();
  });

  it("does not pollute Object.prototype when chatId is constructor", () => {
    const draft = {
      pageIndex: 0,
      answers: [
        { selected: ["Constructor"], otherText: "", otherSelected: false },
      ],
    };
    useInterviewDraftStore.getState().saveDraft("constructor", "block", draft);

    expect(Object.hasOwn(Object.prototype, "block")).toBe(false);
    expect(readInterviewDraftSnapshot("constructor", "block")).toEqual(draft);
    expect(readInterviewDraftSnapshot("other", "block")).toBeNull();
  });

  it("hydrates special ids from per-key storage without prototype pollution", () => {
    const draft = {
      pageIndex: 2,
      answers: [
        { selected: ["Hydrated"], otherText: "", otherSelected: false },
      ],
    };
    window.localStorage.setItem(
      interviewDraftKey("__proto__", "__proto__"),
      JSON.stringify(draft),
    );

    rehydrateInterviewDraftsFromStorage();

    // Pollution would put a draft-shaped own property on every plain object.
    // `Object.prototype` always exposes `__proto__` as a language accessor, so
    // we probe a fresh object instead of asserting on the prototype key name.
    const probe: Record<string, unknown> = {};
    expect(Object.hasOwn(probe, "__proto__")).toBe(false);
    expect(probe["__proto__"]).not.toEqual(draft);
    expect(readInterviewDraftSnapshot("__proto__", "__proto__")).toEqual(draft);
    expect(
      selectInterviewDraft(
        useInterviewDraftStore.getState().draftsByChat,
        "__proto__",
        "__proto__",
      ),
    ).toEqual(draft);
    expect(
      Object.hasOwn(
        useInterviewDraftStore.getState().draftsByChat,
        "__proto__",
      ),
    ).toBe(true);
    // A different chat id must not resolve through the prototype chain.
    expect(readInterviewDraftSnapshot("other-chat", "__proto__")).toBeNull();
  });
});
