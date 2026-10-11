import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { legacyComposerDraftId } from "@/lib/drafts/draft-ids";
import { setDraftLocalEditListener } from "@/lib/drafts/draft-local-edits";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  composerDraftIsDirty,
  composerDraftRememberSynced,
  EMPTY_COMPOSER_DRAFT,
  readComposerDraftSnapshot,
  useComposerDraftStore,
  type DraftState,
} from "../composer-draft-store";
import {
  cancelDeferredJsonWrites,
  hasDeferredJsonWrite,
  persistNowOrThrow,
} from "@/lib/persist/deferred-json-storage";
import { composerDraftStorageKey } from "@/lib/persist/keys";
import {
  createComposerDraftStorage,
  type ComposerDraftPersistence,
} from "../composer-draft-storage";
import {
  ANON_NAME,
  draftWith,
  draftWithFields,
  failWritesWhere,
  rawRows,
  readDraftRow,
  readStoredRow,
  rowKey,
  resetComposerDraftPersistence,
  rowKeys,
  seedLegacyBlob,
  seedRow,
  textDoc,
} from "./composer-draft-rows";

// The adapter is driven through the same `PersistStorage` surface the store's
// persist middleware uses, over real localStorage. Two adapters over one
// namespace are two windows; the deferred queue is one module-global slot per
// name, so a two-window scenario always flushes one window before the other
// writes.
const NAME = composerDraftStorageKey("adapter-account");

function draftsState(drafts: ComposerDraftPersistence["drafts"]) {
  return { version: 1, state: { drafts, pendingSubmittedDraftDeletes: {} } };
}

function deletesState(
  pendingSubmittedDraftDeletes: ComposerDraftPersistence["pendingSubmittedDraftDeletes"],
) {
  return { version: 1, state: { drafts: {}, pendingSubmittedDraftDeletes } };
}

/** A window: a fresh adapter that has read (and so baselined) the namespace. */
async function openWindow(name: string) {
  const adapter = createComposerDraftStorage();
  const hydrated = await adapter.getItem(name);
  return { adapter, hydrated };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  cancelDeferredJsonWrites();
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  cancelDeferredJsonWrites();
  vi.useRealTimers();
  window.localStorage.clear();
});

describe("composer draft storage: one row per draft", () => {
  it("two windows editing different drafts both land - neither overwrites the other's row", async () => {
    const a = await openWindow(NAME);
    const b = await openWindow(NAME);

    void a.adapter.setItem(
      NAME,
      draftsState({ "chat-1": draftWith("from A") }),
    );
    persistNowOrThrow(NAME);
    void b.adapter.setItem(
      NAME,
      draftsState({ "chat-2": draftWith("from B") }),
    );
    expect(() => persistNowOrThrow(NAME)).not.toThrow();

    expect(readDraftRow("chat-1", NAME)?.content).toEqual(
      draftWith("from A").content,
    );
    expect(readDraftRow("chat-2", NAME)?.content).toEqual(
      draftWith("from B").content,
    );
  });

  it("a write on a stale baseline throws, keeps the other window's row, and is held for a retry", async () => {
    const a = await openWindow(NAME);
    const b = await openWindow(NAME);

    void a.adapter.setItem(
      NAME,
      draftsState({ "chat-1": draftWith("from A") }),
    );
    persistNowOrThrow(NAME);
    const rowAfterA = rawRows(NAME);

    void b.adapter.setItem(
      NAME,
      draftsState({ "chat-1": draftWith("from B") }),
    );
    expect(() => persistNowOrThrow(NAME)).toThrow();
    expect(rawRows(NAME)).toBe(rowAfterA);
    // Held, not dropped: a second attempt reports the same conflict.
    expect(hasDeferredJsonWrite(NAME)).toBe(true);
    expect(() => persistNowOrThrow(NAME)).toThrow();

    // Re-reading adopts the other window's row; the edit then lands on top.
    const reread = await b.adapter.getItem(NAME);
    expect(reread?.state.drafts["chat-1"]?.content).toEqual(
      draftWith("from A").content,
    );
    void b.adapter.setItem(
      NAME,
      draftsState({ "chat-1": draftWith("merged") }),
    );
    expect(() => persistNowOrThrow(NAME)).not.toThrow();
    expect(readDraftRow("chat-1", NAME)?.content).toEqual(
      draftWith("merged").content,
    );
  });

  it("a removed draft leaves a tombstone: a stale window cannot resurrect it, and hydration skips it", async () => {
    const a = await openWindow(NAME);
    void a.adapter.setItem(NAME, draftsState({ "chat-1": draftWith("sent") }));
    persistNowOrThrow(NAME);
    const stale = await openWindow(NAME);

    void a.adapter.setItem(NAME, draftsState({}));
    persistNowOrThrow(NAME);

    expect(readStoredRow("draft", "chat-1", NAME)?.value).toBeNull();
    void stale.adapter.setItem(
      NAME,
      draftsState({ "chat-1": draftWith("resurrected") }),
    );
    expect(() => persistNowOrThrow(NAME)).toThrow();
    expect(readStoredRow("draft", "chat-1", NAME)?.value).toBeNull();
    const fresh = await openWindow(NAME);
    expect(fresh.hydrated?.state.drafts).toEqual({});
  });

  it("pending submitted-draft deletes are their own rows, keyed by draft id, and tombstone on completion", async () => {
    const a = await openWindow(NAME);
    void a.adapter.setItem(
      NAME,
      deletesState({ "draft-1": { hostId: "host-a", retract: true } }),
    );
    persistNowOrThrow(NAME);

    expect(readStoredRow("delete", "draft-1", NAME)?.value).toEqual({
      hostId: "host-a",
      retract: true,
    });
    const reader = await openWindow(NAME);
    expect(reader.hydrated?.state.pendingSubmittedDraftDeletes).toEqual({
      "draft-1": { hostId: "host-a", retract: true },
    });

    void a.adapter.setItem(NAME, draftsState({}));
    persistNowOrThrow(NAME);
    expect(readStoredRow("delete", "draft-1", NAME)?.value).toBeNull();
    expect(
      (await openWindow(NAME)).hydrated?.state.pendingSubmittedDraftDeletes,
    ).toEqual({});
  });

  it("a quota failure throws from the barrier, leaves durable rows untouched, and the held write lands on retry", async () => {
    const a = await openWindow(NAME);
    const durableDraft = draftWith("durable");
    void a.adapter.setItem(NAME, draftsState({ "chat-0": durableDraft }));
    persistNowOrThrow(NAME);
    const durable = rawRows(NAME);

    void a.adapter.setItem(
      NAME,
      draftsState({ "chat-0": durableDraft, "chat-1": draftWith("too big") }),
    );
    const quota = failWritesWhere(
      (key) => key === rowKey("draft", "chat-1", NAME),
    );
    expect(() => persistNowOrThrow(NAME)).toThrow();
    expect(rawRows(NAME)).toBe(durable);
    expect(hasDeferredJsonWrite(NAME)).toBe(true);

    quota.mockRestore();
    expect(() => persistNowOrThrow(NAME)).not.toThrow();
    expect(readDraftRow("chat-1", NAME)?.content).toEqual(
      draftWith("too big").content,
    );
    expect(hasDeferredJsonWrite(NAME)).toBe(false);
  });

  it("removeItem clears only its own namespace: every row and the legacy blob, plus the queued write", async () => {
    const other = composerDraftStorageKey("other-account");
    seedRow(
      "draft",
      "chat-other",
      { value: draftWith("other's"), revision: "rev-o" },
      other,
    );
    const a = await openWindow(NAME);
    seedLegacyBlob({ drafts: {} }, NAME);
    void a.adapter.setItem(
      NAME,
      draftsState({ "chat-1": draftWith("flushed") }),
    );
    persistNowOrThrow(NAME);
    void a.adapter.setItem(
      NAME,
      draftsState({ "chat-1": draftWith("queued") }),
    );

    await a.adapter.removeItem(NAME);
    vi.advanceTimersByTime(1000);

    expect(rowKeys(NAME)).toEqual([]);
    expect(window.localStorage.getItem(NAME)).toBeNull();
    expect(hasDeferredJsonWrite(NAME)).toBe(false);
    expect(readDraftRow("chat-other", other)).toBeDefined();
  });
});

describe("composer draft storage: legacy blob migration", () => {
  it("copies every legacy row - draft, delete fence, even an invalid entry - before removing the blob", async () => {
    seedLegacyBlob(
      {
        drafts: {
          "chat-1": draftWith("one"),
          "chat-2": draftWith("two"),
          "chat-bad": { content: null },
        },
        pendingSubmittedDraftDeletes: {
          "draft-9": { hostId: "host-a", retract: false },
        },
      },
      NAME,
    );

    const { hydrated } = await openWindow(NAME);

    expect(window.localStorage.getItem(NAME)).toBeNull();
    expect(readDraftRow("chat-1", NAME)?.content).toEqual(
      draftWith("one").content,
    );
    expect(readDraftRow("chat-2", NAME)?.content).toEqual(
      draftWith("two").content,
    );
    // Lossless: validation belongs to the store's merge, not to the copy.
    expect(readStoredRow("draft", "chat-bad", NAME)?.value).toEqual({
      content: null,
    });
    expect(readStoredRow("delete", "draft-9", NAME)?.value).toEqual({
      hostId: "host-a",
      retract: false,
    });
    expect(Object.keys(hydrated?.state.drafts ?? {}).sort()).toEqual([
      "chat-1",
      "chat-2",
      "chat-bad",
    ]);
  });

  it("a quota failure mid-copy keeps the blob, still shows every draft, and a later read completes without rewriting copied rows", async () => {
    seedLegacyBlob(
      {
        drafts: {
          "chat-1": draftWith("one"),
          "chat-2": draftWith("two"),
          "chat-3": draftWith("three"),
        },
      },
      NAME,
    );
    const quota = failWritesWhere(
      (key) => key === rowKey("draft", "chat-2", NAME),
    );

    const first = await openWindow(NAME);

    expect(window.localStorage.getItem(NAME)).not.toBeNull();
    expect(Object.keys(first.hydrated?.state.drafts ?? {}).sort()).toEqual([
      "chat-1",
      "chat-2",
      "chat-3",
    ]);
    const copiedRow = window.localStorage.getItem(
      rowKey("draft", "chat-1", NAME),
    );
    expect(copiedRow).not.toBeNull();

    quota.mockRestore();
    const second = await openWindow(NAME);

    expect(window.localStorage.getItem(NAME)).toBeNull();
    expect(rowKeys(NAME)).toHaveLength(3);
    expect(window.localStorage.getItem(rowKey("draft", "chat-1", NAME))).toBe(
      copiedRow,
    );
    expect(Object.keys(second.hydrated?.state.drafts ?? {}).sort()).toEqual([
      "chat-1",
      "chat-2",
      "chat-3",
    ]);
  });

  it("an existing row - a tombstone included - wins over the blob's copy, so an interrupted migration cannot resurrect a sent draft", async () => {
    seedLegacyBlob(
      {
        drafts: {
          "chat-sent": draftWith("already sent"),
          "chat-live": draftWith("live"),
        },
      },
      NAME,
    );
    seedRow(
      "draft",
      "chat-sent",
      { value: null, revision: "rev-tombstone" },
      NAME,
    );

    const { hydrated } = await openWindow(NAME);

    expect(Object.keys(hydrated?.state.drafts ?? {})).toEqual(["chat-live"]);
    expect(readStoredRow("draft", "chat-sent", NAME)?.value).toBeNull();
    expect(window.localStorage.getItem(NAME)).toBeNull();
  });

  it("an unreadable blob throws from the read and is retained, never deleted", () => {
    window.localStorage.setItem(NAME, "{not json");
    const adapter = createComposerDraftStorage();

    expect(() => adapter.getItem(NAME)).toThrow();

    expect(window.localStorage.getItem(NAME)).toBe("{not json");
  });
});

describe("composer draft storage: anonymous rows adopted by the first account", () => {
  const ACCOUNT_A = composerDraftStorageKey("account-a");
  const ACCOUNT_B = composerDraftStorageKey("account-b");

  function seedAnonymous(): void {
    seedRow(
      "draft",
      "chat-1",
      { value: draftWith("one"), revision: "rev-1" },
      ANON_NAME,
    );
    seedRow(
      "draft",
      "chat-2",
      { value: draftWith("two"), revision: "rev-2" },
      ANON_NAME,
    );
    seedRow(
      "draft",
      "chat-3",
      { value: draftWith("three"), revision: "rev-3" },
      ANON_NAME,
    );
  }

  it("moves the anonymous rows to the account namespace and leaves nothing behind", () => {
    seedAnonymous();

    createComposerDraftStorage().adoptNamespace(ANON_NAME, ACCOUNT_A);

    expect(rowKeys(ANON_NAME)).toEqual([]);
    expect(rowKeys(ACCOUNT_A)).toHaveLength(3);
    expect(readDraftRow("chat-2", ACCOUNT_A)?.content).toEqual(
      draftWith("two").content,
    );
  });

  it("an interrupted copy stays claimed by the first account: the next account sees nothing of it, and the first resumes it", async () => {
    seedAnonymous();
    const quota = failWritesWhere(
      (key) => key === rowKey("draft", "chat-2", ACCOUNT_A),
    );
    const adapter = createComposerDraftStorage();

    expect(() => adapter.adoptNamespace(ANON_NAME, ACCOUNT_A)).toThrow();
    quota.mockRestore();

    // Another account signs in on the same profile: none of A's leftovers.
    adapter.adoptNamespace(ANON_NAME, ACCOUNT_B);
    const asB = await openWindow(ACCOUNT_B);
    expect(asB.hydrated?.state.drafts).toEqual({});
    expect(rowKeys(ACCOUNT_B)).toEqual([]);

    // The claimant picks the copy back up and completes it.
    const asA = await openWindow(ACCOUNT_A);
    expect(Object.keys(asA.hydrated?.state.drafts ?? {}).sort()).toEqual([
      "chat-1",
      "chat-2",
      "chat-3",
    ]);
    expect(rowKeys(ANON_NAME)).toEqual([]);
    expect(rowKeys(ACCOUNT_A)).toHaveLength(3);
  });
});

// ── The store on top of the row storage ─────────────────────────────────────
// Everything above drives the adapter alone. These drive the real store, real
// adapter and real localStorage, for the behavior only the composition has:
// what another window's write does to THIS window's memory, and what an auth
// change does to the namespace.

const DEBOUNCE_MS = 100;

function signIn(userId: string): void {
  useAuthStore.setState({
    status: "signed-in",
    signedOutCause: null,
    signingInAttempt: null,
    profile: { userId, userName: userId, email: `${userId}@example.com` },
    contextMetadata: { userId, username: userId },
  });
}

function signOut(): void {
  useAuthStore.setState({
    status: "signed-out",
    signedOutCause: "retired",
    signingInAttempt: null,
    profile: null,
    contextMetadata: null,
  });
}

/** What another window's flush looks like from here: a row, then the event. */
function otherWindowWrites(
  kind: "draft" | "delete",
  id: string,
  value: unknown,
  name: string,
): void {
  const revision = `other-window-${crypto.randomUUID()}`;
  seedRow(kind, id, { value, revision }, name);
  window.dispatchEvent(
    new StorageEvent("storage", { key: rowKey(kind, id, name) }),
  );
}

function externalDraft(text: string, base: DraftState): DraftState {
  return draftWithFields(text, { draftId: base.draftId });
}

function externalDraftWith(
  text: string,
  base: DraftState,
  overrides: Partial<DraftState>,
): DraftState {
  return draftWithFields(text, { draftId: base.draftId, ...overrides });
}

describe("composer draft store: another window's writes", () => {
  let edits: Mock<(draftId: string) => void>;

  beforeEach(async () => {
    await resetComposerDraftPersistence();
    edits = vi.fn();
    setDraftLocalEditListener(edits);
  });

  afterEach(() => {
    setDraftLocalEditListener(null);
    signOut();
  });

  function typeAndFlush(chatId: string, text: string): DraftState {
    useComposerDraftStore.getState().setSnapshot(chatId, textDoc(text), null);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    return readComposerDraftSnapshot(chatId);
  }

  it("adopts a change to a row this window has no unsaved edit on, tells the editor, and does not write it back", () => {
    const mine = typeAndFlush("chat-1", "mine");

    otherWindowWrites(
      "draft",
      "chat-1",
      externalDraft("theirs", mine),
      ANON_NAME,
    );
    const theirRow = rawRows(ANON_NAME);
    vi.advanceTimersByTime(DEBOUNCE_MS * 2);

    const adopted = readComposerDraftSnapshot("chat-1");
    expect(adopted.content).toEqual(textDoc("theirs"));
    expect(adopted.resetEpoch).toBe(mine.resetEpoch + 1);
    // Adopting is not a local edit: the other window's row is left byte for byte.
    expect(rawRows(ANON_NAME)).toBe(theirRow);

    // The baseline moved with the adoption, so the next local edit lands.
    typeAndFlush("chat-1", "mine again");
    expect(readDraftRow("chat-1", ANON_NAME)?.content).toEqual(
      textDoc("mine again"),
    );
  });

  it("keeps a row's unsaved local text when another window changed it, and the barrier throws instead of overwriting", () => {
    typeAndFlush("chat-1", "mine v1");
    useComposerDraftStore
      .getState()
      .setSnapshot("chat-1", textDoc("mine v2"), null);

    otherWindowWrites("draft", "chat-1", draftWith("theirs"), ANON_NAME);

    expect(readComposerDraftSnapshot("chat-1").content).toEqual(
      textDoc("mine v2"),
    );
    expect(() => persistNowOrThrow(ANON_NAME)).toThrow();
    expect(readDraftRow("chat-1", ANON_NAME)?.content).toEqual(
      textDoc("theirs"),
    );
  });

  it("a row stuck on a conflict does not stop the other drafts' rows from being saved at pagehide", () => {
    typeAndFlush("chat-1", "one v1");
    typeAndFlush("chat-3", "three v1");
    // chat-1 is queued first, so it is the row a sequential flush trips over.
    useComposerDraftStore
      .getState()
      .setSnapshot("chat-1", textDoc("one v2"), null);
    useComposerDraftStore
      .getState()
      .setSnapshot("chat-3", textDoc("three v2"), null);
    otherWindowWrites("draft", "chat-1", draftWith("theirs"), ANON_NAME);

    window.dispatchEvent(new Event("pagehide"));

    expect(readDraftRow("chat-1", ANON_NAME)?.content).toEqual(
      textDoc("theirs"),
    );
    expect(readDraftRow("chat-3", ANON_NAME)?.content).toEqual(
      textDoc("three v2"),
    );
  });

  it("another window's removal empties the draft in place and bumps resetEpoch so mounted editors clear, without publishing", () => {
    const mine = typeAndFlush("chat-1", "mine");
    edits.mockClear();

    otherWindowWrites("draft", "chat-1", null, ANON_NAME);

    const emptied = readComposerDraftSnapshot("chat-1");
    expect(emptied.content).toEqual(EMPTY_COMPOSER_DRAFT.content);
    expect(emptied.resetEpoch).toBe(mine.resetEpoch + 1);
    expect("chat-1" in useComposerDraftStore.getState().drafts).toBe(true);
    expect(edits).not.toHaveBeenCalled();
    expect(emptied.generation).toBe(emptied.syncedGeneration);
  });

  it("another window's localStorage.clear() (a null-key event) does not leave this window's next edit blocked on a stale baseline", () => {
    typeAndFlush("chat-1", "before the clear");

    window.localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    typeAndFlush("chat-1", "after the clear");

    expect(readDraftRow("chat-1", ANON_NAME)?.content).toEqual(
      textDoc("after the clear"),
    );
  });

  it("ignores a row event from another account's namespace and from a non-row key", () => {
    const mine = typeAndFlush("chat-1", "mine");
    const before = useComposerDraftStore.getState().drafts;

    otherWindowWrites(
      "draft",
      "chat-1",
      externalDraft("theirs", mine),
      composerDraftStorageKey("someone-else"),
    );
    window.dispatchEvent(
      new StorageEvent("storage", { key: "traycer-gui-app:unrelated" }),
    );

    expect(useComposerDraftStore.getState().drafts).toBe(before);
  });

  it("adopts a pending submitted-draft delete recorded by another window", () => {
    otherWindowWrites(
      "delete",
      "draft-9",
      { hostId: "host-a", retract: true },
      ANON_NAME,
    );

    expect(
      useComposerDraftStore.getState().pendingSubmittedDraftDeletes["draft-9"],
    ).toEqual({ hostId: "host-a", retract: true });
  });

  it("adoption keeps this window's generation monotonic, so an ACK captured before it cannot clean the adopted or newer content", () => {
    // Three local edits: an ACK collected now names generation 3.
    useComposerDraftStore.getState().setSnapshot("chat-1", textDoc("v1"), null);
    useComposerDraftStore.getState().setSnapshot("chat-1", textDoc("v2"), null);
    const mine = typeAndFlush("chat-1", "v3");
    const collected = mine.generation;
    const draftId = mine.draftId ?? "";

    // The other window's counters are its own and LOWER than ours.
    otherWindowWrites(
      "draft",
      "chat-1",
      externalDraftWith("theirs", mine, { generation: 1, syncedGeneration: 0 }),
      ANON_NAME,
    );
    const adopted = readComposerDraftSnapshot("chat-1");
    expect(adopted.generation).toBeGreaterThan(collected);
    expect(composerDraftIsDirty(draftId)).toBe(true);

    useComposerDraftStore
      .getState()
      .setSnapshot("chat-1", textDoc("edited on top"), null);
    composerDraftRememberSynced(draftId, 5, collected, "host-a");

    expect(composerDraftIsDirty(draftId)).toBe(true);
  });

  it("publishes an adopted change only when this window owes the host something: a metadata-only echo never does, an incoming clean change does only over local debt", () => {
    const mine = typeAndFlush("chat-1", "mine");
    const draftId = mine.draftId ?? "";
    edits.mockClear();

    // Same document, new metadata (an ACK's hostRevision, a title): no edit,
    // even though this window still owes its own edit to the host.
    otherWindowWrites(
      "draft",
      "chat-1",
      externalDraftWith("mine", mine, {
        hostRevision: 4,
        chatTitle: "Titled",
        generation: 9,
        syncedGeneration: 0,
      }),
      ANON_NAME,
    );
    const echoed = readComposerDraftSnapshot("chat-1");
    expect(echoed.content).toEqual(textDoc("mine"));
    expect(echoed.hostRevision).toBe(4);
    expect(echoed.chatTitle).toBe("Titled");
    expect(echoed.generation).toBe(mine.generation);
    expect(echoed.resetEpoch).toBe(mine.resetEpoch);
    expect(edits).not.toHaveBeenCalled();

    // Changed content the other window had already synced, over a local edit
    // the host has not seen: the adopted document replaces it, so it is owed.
    otherWindowWrites(
      "draft",
      "chat-1",
      externalDraftWith("synced elsewhere", mine, {
        generation: 3,
        syncedGeneration: 3,
      }),
      ANON_NAME,
    );
    expect(readComposerDraftSnapshot("chat-1").content).toEqual(
      textDoc("synced elsewhere"),
    );
    expect(edits).toHaveBeenCalledTimes(1);
    expect(edits).toHaveBeenCalledWith(draftId);
    expect(composerDraftIsDirty(draftId)).toBe(true);

    // With the debt settled, the same kind of clean adoption owes nothing.
    composerDraftRememberSynced(
      draftId,
      6,
      readComposerDraftSnapshot("chat-1").generation,
      "host-a",
    );
    expect(composerDraftIsDirty(draftId)).toBe(false);
    // The ACK queued its own metadata write; an event on a row with a queued
    // local write is (correctly) held back, so let it land first.
    vi.advanceTimersByTime(DEBOUNCE_MS);
    edits.mockClear();
    otherWindowWrites(
      "draft",
      "chat-1",
      externalDraftWith("synced again", mine, {
        generation: 4,
        syncedGeneration: 4,
      }),
      ANON_NAME,
    );
    expect(readComposerDraftSnapshot("chat-1").content).toEqual(
      textDoc("synced again"),
    );
    expect(edits).not.toHaveBeenCalled();
    expect(composerDraftIsDirty(draftId)).toBe(false);

    // Changed content the other window still owed the host: now owed here too.
    otherWindowWrites(
      "draft",
      "chat-1",
      externalDraftWith("owed", mine, { generation: 5, syncedGeneration: 2 }),
      ANON_NAME,
    );
    expect(readComposerDraftSnapshot("chat-1").content).toEqual(
      textDoc("owed"),
    );
    expect(edits).toHaveBeenCalledTimes(1);
    expect(composerDraftIsDirty(draftId)).toBe(true);
  });

  it("replaceDraft throws when another window changed the row unseen, keeps the restored text in memory, and never overwrites that row", () => {
    typeAndFlush("chat-1", "mine");
    // Written without a storage event: this window has not been told yet.
    seedRow(
      "draft",
      "chat-1",
      { value: draftWith("theirs"), revision: "rev-unseen" },
      ANON_NAME,
    );

    expect(() =>
      useComposerDraftStore
        .getState()
        .replaceDraft("chat-1", textDoc("restored prompt"), null),
    ).toThrow();

    expect(readComposerDraftSnapshot("chat-1").content).toEqual(
      textDoc("restored prompt"),
    );
    expect(readDraftRow("chat-1", ANON_NAME)?.content).toEqual(
      textDoc("theirs"),
    );
  });

  it("replaceDraft throws on a quota failure and the restored text is saved by the retry once space is back", () => {
    const quota = failWritesWhere((key) => key.includes(":rows:"));

    expect(() =>
      useComposerDraftStore
        .getState()
        .replaceDraft("chat-1", textDoc("restored prompt"), null),
    ).toThrow();
    expect(readComposerDraftSnapshot("chat-1").content).toEqual(
      textDoc("restored prompt"),
    );
    expect(readDraftRow("chat-1", ANON_NAME)).toBeUndefined();

    quota.mockRestore();
    expect(() => persistNowOrThrow(ANON_NAME)).not.toThrow();
    expect(readDraftRow("chat-1", ANON_NAME)?.content).toEqual(
      textDoc("restored prompt"),
    );
  });

  it("a legacy-composer pending delete is stored under its normalized key, and completing it stays complete across a rehydrate", async () => {
    const legacy = "legacy-composer-7f1c1d2a-9b4e-4d8e-8f2a-3c5b6d7e8f90";
    const derived = legacyComposerDraftId(
      "7f1c1d2a-9b4e-4d8e-8f2a-3c5b6d7e8f90",
    );
    seedLegacyBlob(
      {
        drafts: {},
        pendingSubmittedDraftDeletes: {
          [legacy]: { hostId: "host-a", retract: false },
        },
      },
      ANON_NAME,
    );

    await useComposerDraftStore.persist.rehydrate();

    expect(
      useComposerDraftStore.getState().pendingSubmittedDraftDeletes[derived],
    ).toEqual({ hostId: "host-a", retract: false });
    expect(readStoredRow("delete", derived, ANON_NAME)?.value).toEqual({
      hostId: "host-a",
      retract: false,
    });
    expect(readStoredRow("delete", legacy, ANON_NAME)).toBeNull();

    useComposerDraftStore.getState().completeSubmittedDraftDelete(derived);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await useComposerDraftStore.persist.rehydrate();

    expect(
      useComposerDraftStore.getState().pendingSubmittedDraftDeletes,
    ).toEqual({});
  });
});

describe("composer draft store: account scope", () => {
  const ACCOUNT_A = composerDraftStorageKey("account-a");
  const ACCOUNT_B = composerDraftStorageKey("account-b");

  beforeEach(async () => {
    signOut();
    await resetComposerDraftPersistence();
  });

  afterEach(() => {
    signOut();
  });

  function type(chatId: string, text: string): void {
    useComposerDraftStore.getState().setSnapshot(chatId, textDoc(text), null);
    vi.advanceTimersByTime(DEBOUNCE_MS);
  }

  function allStoredText(): string {
    let text = "";
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key !== null)
        text += `${key}=${window.localStorage.getItem(key) ?? ""}\n`;
    }
    return text;
  }

  it("the first account to sign in adopts the anonymous drafts into its own namespace", () => {
    type("chat-1", "typed before signing in");

    signIn("account-a");

    expect(useComposerDraftStore.persist.getOptions().name).toBe(ACCOUNT_A);
    expect(readComposerDraftSnapshot("chat-1").content).toEqual(
      textDoc("typed before signing in"),
    );
    expect(rowKeys(ANON_NAME)).toEqual([]);
    expect(readDraftRow("chat-1", ACCOUNT_A)?.content).toEqual(
      textDoc("typed before signing in"),
    );
  });

  it("sign-out removes the account's rows and its queued edits, so the next account finds no trace of them", () => {
    signIn("account-a");
    type("chat-1", "SECRET-flushed");
    useComposerDraftStore
      .getState()
      .setSnapshot("chat-2", textDoc("SECRET-queued"), null);

    signOut();
    vi.advanceTimersByTime(DEBOUNCE_MS * 2);

    expect(useComposerDraftStore.persist.getOptions().name).toBe(ANON_NAME);
    expect(useComposerDraftStore.getState().drafts).toEqual({});
    expect(rowKeys(ACCOUNT_A)).toEqual([]);

    signIn("account-b");
    expect(useComposerDraftStore.getState().drafts).toEqual({});
    expect(allStoredText()).not.toContain("SECRET");
  });

  it("switching straight from one account to another shows none of the first's drafts and leaves its rows for its return", () => {
    signIn("account-a");
    type("chat-1", "A's draft");

    signIn("account-b");
    vi.advanceTimersByTime(DEBOUNCE_MS * 2);

    expect(useComposerDraftStore.persist.getOptions().name).toBe(ACCOUNT_B);
    expect(useComposerDraftStore.getState().drafts).toEqual({});
    expect(rowKeys(ACCOUNT_B)).toEqual([]);
    expect(readDraftRow("chat-1", ACCOUNT_A)?.content).toEqual(
      textDoc("A's draft"),
    );
  });

  it("an in-flight sign-in or a failed attempt keeps the current account's drafts; only a retired session removes them", () => {
    signIn("account-a");
    type("chat-1", "kept");

    useAuthStore.setState({ status: "signing-in", signedOutCause: null });
    expect(readComposerDraftSnapshot("chat-1").content).toEqual(
      textDoc("kept"),
    );

    useAuthStore.setState({
      status: "signed-out",
      signedOutCause: "attempt-failed",
      profile: null,
      contextMetadata: null,
    });
    expect(useComposerDraftStore.persist.getOptions().name).toBe(ACCOUNT_A);
    expect(readComposerDraftSnapshot("chat-1").content).toEqual(
      textDoc("kept"),
    );

    signOut();
    expect(useComposerDraftStore.getState().drafts).toEqual({});
    expect(rowKeys(ACCOUNT_A)).toEqual([]);
  });

  it("an interrupted anonymous-to-account copy still shows every draft to that account, and signing out removes the claimed anonymous source too", () => {
    type("chat-1", "SECRET-one");
    type("chat-2", "SECRET-two");
    type("chat-3", "SECRET-three");
    const quota = failWritesWhere(
      (key) => key === rowKey("draft", "chat-2", ACCOUNT_A),
    );

    signIn("account-a");
    quota.mockRestore();

    expect(Object.keys(useComposerDraftStore.getState().drafts).sort()).toEqual(
      ["chat-1", "chat-2", "chat-3"],
    );

    signOut();

    expect(useComposerDraftStore.getState().drafts).toEqual({});
    expect(rowKeys(ANON_NAME)).toEqual([]);
    expect(rowKeys(ACCOUNT_A)).toEqual([]);
    signIn("account-b");
    expect(useComposerDraftStore.getState().drafts).toEqual({});
    expect(rowKeys(ACCOUNT_B)).toEqual([]);
    expect(allStoredText()).not.toContain("SECRET");
  });
});
