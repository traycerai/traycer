import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { cancelDeferredJsonWrites } from "@/lib/persist/deferred-json-storage";
import {
  composerDraftRowPrefix,
  composerDraftStorageKey,
} from "@/lib/persist/keys";
import * as stripModule from "@/lib/composer/strip-base64-image-nodes";
import { useComposerDraftStore } from "../composer-draft-store";
import {
  ANON_NAME,
  draftWith,
  rawRows,
  readDraftRow,
  readStoredRow,
  resetComposerDraftPersistence,
  rowKey,
  rowKeys,
  seedRow,
  textDoc,
} from "./composer-draft-rows";

const DEBOUNCE_MS = 100;
const ROW_PREFIX = composerDraftRowPrefix(ANON_NAME);

function pendingB64Doc(): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "imageAttachment",
            attrs: {
              id: "pending-node-1",
              fileName: "shot.png",
              mimeType: "image/png",
              size: 12,
              byHashEligible: true,
              b64content: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            },
          },
        ],
      },
    ],
  };
}

function containsB64String(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsB64String);
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).some(([key, v]) => {
      if (key === "b64content" && typeof v === "string" && v.length > 0) {
        return true;
      }
      return containsB64String(v);
    });
  }
  return false;
}

// Some environments run the jsdom setup's `installMockLocalStorage()`
// fallback (own-property methods on the `window.localStorage` instance
// itself, not inherited from `Storage.prototype` - see
// `__tests__/test-browser-apis.ts`), so a spy must target whichever one is
// actually live rather than assuming the prototype.
function storageSpyTarget(): Storage {
  return Object.hasOwn(window.localStorage, "setItem")
    ? window.localStorage
    : Storage.prototype;
}

describe("composer draft store: deferred, coalesced localStorage persistence", () => {
  let setItemSpy: MockInstance<typeof Storage.prototype.setItem>;
  let stringifySpy: MockInstance<typeof JSON.stringify>;
  let stripSpy: MockInstance<
    typeof stripModule.stripBase64ImageNodesWithSelection
  >;

  /** Row-key writes only: the number of drafts a flush actually serialized. */
  function storeWrites(): number {
    return writtenRowKeys().length;
  }

  function writtenRowKeys(): string[] {
    return setItemSpy.mock.calls
      .map(([key]) => key)
      .filter((key) => key.startsWith(ROW_PREFIX));
  }

  function resetStore(): void {
    useComposerDraftStore.setState({
      drafts: {},
      pendingSubmittedDraftDeletes: {},
    });
  }

  beforeEach(async () => {
    // Fake timers FIRST: anything committed through the real persist
    // middleware schedules a deferred write, and it must land on the fake
    // clock so `cancelDeferredJsonWrites()` actually reaches it - otherwise it
    // arms a real 100ms timeout that fires mid a LATER test.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // Rehydrates onto the anonymous namespace, which also re-baselines the
    // storage adapter against the emptied disk.
    await resetComposerDraftPersistence();
    setItemSpy = vi.spyOn(storageSpyTarget(), "setItem");
    stringifySpy = vi.spyOn(JSON, "stringify");
    stripSpy = vi.spyOn(stripModule, "stripBase64ImageNodesWithSelection");
  });

  afterEach(() => {
    // Reset (which schedules) BEFORE cancel (which wipes it), and both while
    // still on fake timers - only then is it safe to switch back to real
    // ones with nothing left armed. See the `beforeEach` note above.
    resetStore();
    cancelDeferredJsonWrites();
    vi.useRealTimers();
    setItemSpy.mockRestore();
    stringifySpy.mockRestore();
    stripSpy.mockRestore();
    window.localStorage.clear();
  });

  it("N typed snapshots touch localStorage zero times synchronously - no stringify, no base64 strip - and coalesce into exactly one flush with the latest content", () => {
    const chatId = "chat-typing";
    for (let i = 0; i < 5; i += 1) {
      useComposerDraftStore
        .getState()
        .setSnapshot(chatId, textDoc(`draft v${i}`), null);
    }
    // Every keystroke landed in the in-memory store immediately...
    expect(useComposerDraftStore.getState().drafts[chatId]?.content).toEqual(
      textDoc("draft v4"),
    );
    // ...but none of them did any of the persistence-boundary work yet.
    expect(storeWrites()).toBe(0);
    expect(stringifySpy).not.toHaveBeenCalled();
    expect(stripSpy).not.toHaveBeenCalled();
    expect(rowKeys(ANON_NAME)).toEqual([]);

    vi.advanceTimersByTime(DEBOUNCE_MS);

    expect(storeWrites()).toBe(1);
    expect(stripSpy).toHaveBeenCalledTimes(1);
    expect(readDraftRow(chatId, ANON_NAME)?.content).toEqual(
      textDoc("draft v4"),
    );
  });

  it("an edit to one of several drafts serializes and writes only that draft's row", () => {
    const store = useComposerDraftStore.getState();
    store.setSnapshot("chat-a", textDoc("a v0"), null);
    store.setSnapshot("chat-b", textDoc("b v0"), null);
    store.setSnapshot("chat-c", textDoc("c v0"), null);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(storeWrites()).toBe(3);
    const untouchedBefore = {
      a: window.localStorage.getItem(rowKey("draft", "chat-a", ANON_NAME)),
      c: window.localStorage.getItem(rowKey("draft", "chat-c", ANON_NAME)),
    };
    setItemSpy.mockClear();
    stripSpy.mockClear();

    store.setSnapshot("chat-b", textDoc("b v1"), null);
    vi.advanceTimersByTime(DEBOUNCE_MS);

    expect(writtenRowKeys()).toEqual([rowKey("draft", "chat-b", ANON_NAME)]);
    expect(stripSpy).toHaveBeenCalledTimes(1);
    expect(readDraftRow("chat-b", ANON_NAME)?.content).toEqual(textDoc("b v1"));
    // Byte-identical, revision included: nothing rewrote the other rows.
    expect(
      window.localStorage.getItem(rowKey("draft", "chat-a", ANON_NAME)),
    ).toBe(untouchedBefore.a);
    expect(
      window.localStorage.getItem(rowKey("draft", "chat-c", ANON_NAME)),
    ).toBe(untouchedBefore.c);
  });

  it("an unchanged caret is a genuine no-op: it never schedules a write", () => {
    const chatId = "chat-caret-noop";
    useComposerDraftStore
      .getState()
      .setSnapshot(chatId, textDoc("hello"), { from: 2, to: 2 });
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(storeWrites()).toBe(1);
    setItemSpy.mockClear();

    useComposerDraftStore
      .getState()
      .setSelection(chatId, { from: 2, to: 2 }, "host-a");
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(storeWrites()).toBe(0);
  });

  it("replaceDraft is durable the instant it returns - a crash with no lifecycle event right after loses nothing", () => {
    const chatId = "chat-restore-crash";
    useComposerDraftStore
      .getState()
      .replaceDraft(chatId, textDoc("restored prompt"), null);

    // No pagehide, no timer advance, no explicit flush - `replaceDraft` runs
    // `persistNowOrThrow` before it returns, so a restorer's caller (which
    // acknowledges the source right after) never races a still-queued write.
    expect(storeWrites()).toBe(1);
    expect(readDraftRow(chatId, ANON_NAME)?.content).toEqual(
      textDoc("restored prompt"),
    );
  });

  it("a changed caret alone still schedules a deferred write, not silently dropped", () => {
    const chatId = "chat-caret-change";
    useComposerDraftStore
      .getState()
      .setSnapshot(chatId, textDoc("hello"), { from: 2, to: 2 });
    vi.advanceTimersByTime(DEBOUNCE_MS);
    setItemSpy.mockClear();

    useComposerDraftStore
      .getState()
      .setSelection(chatId, { from: 4, to: 4 }, "host-a");
    expect(storeWrites()).toBe(0);

    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(storeWrites()).toBe(1);
    expect(readDraftRow(chatId, ANON_NAME)?.selection).toEqual({
      from: 4,
      to: 4,
    });
  });

  it("pagehide flushes every pending row immediately, each stripped of its pending base64 node", () => {
    const chatId = "chat-pagehide";
    useComposerDraftStore.getState().setSnapshot(chatId, pendingB64Doc(), null);
    useComposerDraftStore
      .getState()
      .setSnapshot("chat-pagehide-other", textDoc("plain"), null);
    expect(storeWrites()).toBe(0);

    window.dispatchEvent(new Event("pagehide"));

    expect(storeWrites()).toBe(2);
    expect(containsB64String(readDraftRow(chatId, ANON_NAME))).toBe(false);
    expect(readDraftRow("chat-pagehide-other", ANON_NAME)?.content).toEqual(
      textDoc("plain"),
    );
    // The live in-memory draft still carries the pending node: it is the
    // background ingest job's work token, not something the flush may drop.
    expect(
      containsB64String(
        useComposerDraftStore.getState().drafts[chatId]?.content,
      ),
    ).toBe(true);
  });

  it("an explicit rehydrate stays disk-authoritative: it adopts the stored rows and drops a still-queued local edit rather than flushing it over them", async () => {
    useComposerDraftStore
      .getState()
      .setSnapshot("local-chat", textDoc("STALE-LOCAL"), null);
    seedRow(
      "draft",
      "ext-chat",
      { value: draftWith("EXTERNAL-NEWER"), revision: "rev-ext" },
      ANON_NAME,
    );

    await useComposerDraftStore.persist.rehydrate();

    expect(
      useComposerDraftStore.getState().drafts["local-chat"],
    ).toBeUndefined();
    expect(useComposerDraftStore.getState().drafts["ext-chat"]).toBeDefined();

    vi.advanceTimersByTime(DEBOUNCE_MS * 2);

    expect(readStoredRow("draft", "local-chat", ANON_NAME)).toBeNull();
    expect(readDraftRow("ext-chat", ANON_NAME)?.content).toEqual(
      textDoc("EXTERNAL-NEWER"),
    );
  });

  it("retargeting the persist key cancels a pending write on the outgoing key", () => {
    useComposerDraftStore
      .getState()
      .setSnapshot("chat-retarget", textDoc("about to move"), null);

    useComposerDraftStore.persist.setOptions({
      name: composerDraftStorageKey("other-account"),
    });
    try {
      vi.advanceTimersByTime(DEBOUNCE_MS * 2);

      expect(rowKeys(ANON_NAME)).toEqual([]);
      expect(rowKeys(composerDraftStorageKey("other-account"))).toEqual([]);
    } finally {
      // The reset between tests keeps the ACTIVE namespace; put it back.
      useComposerDraftStore.persist.setOptions({ name: ANON_NAME });
    }
  });

  it("clearStorage cancels a pending write and removes every stored row through the same removeItem path", () => {
    const store = useComposerDraftStore.getState();
    store.setSnapshot("chat-flushed", textDoc("already on disk"), null);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(rawRows(ANON_NAME)).not.toBeNull();
    store.setSnapshot("chat-clear", textDoc("about to be cleared"), null);

    useComposerDraftStore.persist.clearStorage();

    vi.advanceTimersByTime(DEBOUNCE_MS * 2);
    expect(rowKeys(ANON_NAME)).toEqual([]);
    expect(window.localStorage.getItem(ANON_NAME)).toBeNull();
  });
});
