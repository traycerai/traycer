import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryObserver, type QueryClient } from "@tanstack/react-query";
import { createAppQueryClient } from "@/lib/query-client";
import { hostQueryKeys } from "@/lib/query-keys";
import {
  EPIC_CREATE_SEED_HOLD_TIMEOUT_MS,
  armEpicCreateSeedHoldTimer,
  bindingsQueryEpicId,
  clearEpicCreateSeedPending,
  clearUnheldEpicCreateSeed,
  invalidateBindingListingsExceptHeld,
  isEpicCreateHeld,
  isEpicCreateSeedPending,
  markEpicCreateSeedPending,
  readEpicCreateSeed,
  releaseEpicCreateSeed,
  type EpicCreateSeedEntry,
} from "@/lib/worktree/pending-epic-create-seeds";

const HOST_A = "host-a";
const HOST_B = "host-b";
const EPIC = "epic-seeds";
const OTHER_EPIC = "epic-other";
const LANDING_CHAT = "chat-landing";
const MODAL_CHAT = "chat-modal";
const SIBLING_CHAT = "chat-sibling";

const ALL_PAIRS: ReadonlyArray<{
  readonly epicId: string;
  readonly chatId: string | null;
}> = [
  { epicId: EPIC, chatId: LANDING_CHAT },
  { epicId: EPIC, chatId: MODAL_CHAT },
  { epicId: EPIC, chatId: SIBLING_CHAT },
  { epicId: EPIC, chatId: null },
  { epicId: OTHER_EPIC, chatId: LANDING_CHAT },
  { epicId: OTHER_EPIC, chatId: null },
];

afterEach(() => {
  vi.useRealTimers();
  for (const pair of ALL_PAIRS) {
    clearEpicCreateSeedPending(pair.epicId, pair.chatId);
  }
});

function entry(overrides: Partial<EpicCreateSeedEntry>): EpicCreateSeedEntry {
  return {
    hostId: HOST_A,
    seededMessageId: "msg-seed",
    seedRows: false,
    heldForDeferredCreate: false,
    release: () => undefined,
    ...overrides,
  };
}

function bindingsKey(hostId: string, epicId: string) {
  return hostQueryKeys.method(hostId, "worktree.listBindingsForEpic", {
    epicId,
  });
}

async function waitUntil(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  throw new Error("timed out waiting for the binding listing to settle");
}

function mountBindingsObserver(
  queryClient: QueryClient,
  hostId: string,
  epicId: string,
  onFetch: () => void,
): { readonly stop: () => void } {
  const key = bindingsKey(hostId, epicId);
  queryClient.setQueryData(key, { rows: [] });
  const observer = new QueryObserver(queryClient, {
    queryKey: key,
    queryFn: () => {
      onFetch();
      return Promise.resolve({ rows: [] });
    },
  });
  const stop = observer.subscribe(() => undefined);
  return { stop };
}

describe("pending-epic-create-seeds", () => {
  it("keys entries per (epic, chat) pair so two chats in one epic do not clobber each other", () => {
    markEpicCreateSeedPending(
      EPIC,
      LANDING_CHAT,
      entry({ seededMessageId: "landing-msg", seedRows: true }),
    );
    markEpicCreateSeedPending(
      EPIC,
      MODAL_CHAT,
      entry({ seededMessageId: "modal-msg", seedRows: false }),
    );

    expect(readEpicCreateSeed(EPIC, LANDING_CHAT)?.seededMessageId).toBe(
      "landing-msg",
    );
    expect(readEpicCreateSeed(EPIC, MODAL_CHAT)?.seededMessageId).toBe(
      "modal-msg",
    );
    expect(readEpicCreateSeed(EPIC, SIBLING_CHAT)).toBeNull();
  });

  it("clearUnheldEpicCreateSeed deletes an unheld pair and leaves a held one", () => {
    markEpicCreateSeedPending(
      EPIC,
      LANDING_CHAT,
      entry({ heldForDeferredCreate: true, seedRows: true }),
    );
    markEpicCreateSeedPending(
      EPIC,
      MODAL_CHAT,
      entry({ heldForDeferredCreate: false, seedRows: false }),
    );

    clearUnheldEpicCreateSeed(EPIC, LANDING_CHAT);
    clearUnheldEpicCreateSeed(EPIC, MODAL_CHAT);

    expect(readEpicCreateSeed(EPIC, LANDING_CHAT)).not.toBeNull();
    expect(readEpicCreateSeed(EPIC, MODAL_CHAT)).toBeNull();
  });

  it("clearEpicCreateSeedPending deletes a held pair as well as an unheld one", () => {
    markEpicCreateSeedPending(
      EPIC,
      LANDING_CHAT,
      entry({ heldForDeferredCreate: true }),
    );
    clearEpicCreateSeedPending(EPIC, LANDING_CHAT);
    expect(readEpicCreateSeed(EPIC, LANDING_CHAT)).toBeNull();
  });

  it("releaseEpicCreateSeed on an unheld modal pair while a landing pair is held calls no release; the later landing release calls its own", () => {
    const released: string[] = [];
    markEpicCreateSeedPending(
      EPIC,
      LANDING_CHAT,
      entry({
        heldForDeferredCreate: true,
        seedRows: true,
        release: () => {
          released.push("landing");
        },
      }),
    );
    markEpicCreateSeedPending(
      EPIC,
      MODAL_CHAT,
      entry({
        heldForDeferredCreate: false,
        seedRows: false,
        release: () => {
          released.push("modal");
        },
      }),
    );

    releaseEpicCreateSeed(EPIC, MODAL_CHAT);
    expect(released).toEqual([]);
    expect(readEpicCreateSeed(EPIC, MODAL_CHAT)).toBeNull();
    expect(readEpicCreateSeed(EPIC, LANDING_CHAT)).not.toBeNull();

    releaseEpicCreateSeed(EPIC, LANDING_CHAT);
    expect(released).toEqual(["landing"]);
    expect(readEpicCreateSeed(EPIC, LANDING_CHAT)).toBeNull();
  });

  it("isEpicCreateSeedPending and isEpicCreateHeld are host-aware", () => {
    markEpicCreateSeedPending(
      EPIC,
      LANDING_CHAT,
      entry({
        hostId: HOST_A,
        seedRows: true,
        heldForDeferredCreate: true,
      }),
    );

    expect(isEpicCreateSeedPending(HOST_A, EPIC)).toBe(true);
    expect(isEpicCreateHeld(HOST_A, EPIC)).toBe(true);
    expect(isEpicCreateSeedPending(HOST_B, EPIC)).toBe(false);
    expect(isEpicCreateHeld(HOST_B, EPIC)).toBe(false);
    expect(isEpicCreateSeedPending(HOST_A, OTHER_EPIC)).toBe(false);
    expect(isEpicCreateHeld(HOST_A, OTHER_EPIC)).toBe(false);
  });

  it("isEpicCreateSeedPending requires seedRows; isEpicCreateHeld requires heldForDeferredCreate", () => {
    markEpicCreateSeedPending(
      EPIC,
      MODAL_CHAT,
      entry({ seedRows: false, heldForDeferredCreate: false }),
    );
    expect(isEpicCreateSeedPending(HOST_A, EPIC)).toBe(false);
    expect(isEpicCreateHeld(HOST_A, EPIC)).toBe(false);

    markEpicCreateSeedPending(
      EPIC,
      LANDING_CHAT,
      entry({ seedRows: true, heldForDeferredCreate: false }),
    );
    expect(isEpicCreateSeedPending(HOST_A, EPIC)).toBe(true);
    expect(isEpicCreateHeld(HOST_A, EPIC)).toBe(false);
  });

  it("bindingsQueryEpicId reads the { epicId } a binding-list key ends in", () => {
    expect(bindingsQueryEpicId(bindingsKey(HOST_A, EPIC))).toBe(EPIC);
    expect(
      bindingsQueryEpicId(["host", HOST_A, "worktree.listAllForHost"]),
    ).toBe(null);
    expect(
      bindingsQueryEpicId(["host", HOST_A, "worktree.listBindingsForEpic"]),
    ).toBe(null);
  });
});

describe("armEpicCreateSeedHoldTimer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is a no-op without an entry, and the same timeout does fire a release when an entry exists", () => {
    vi.useFakeTimers();
    const released: string[] = [];
    armEpicCreateSeedHoldTimer(EPIC, LANDING_CHAT);
    vi.advanceTimersByTime(EPIC_CREATE_SEED_HOLD_TIMEOUT_MS);
    expect(released).toEqual([]);

    markEpicCreateSeedPending(
      EPIC,
      LANDING_CHAT,
      entry({
        heldForDeferredCreate: true,
        release: () => {
          released.push("landing");
        },
      }),
    );
    armEpicCreateSeedHoldTimer(EPIC, LANDING_CHAT);
    vi.advanceTimersByTime(EPIC_CREATE_SEED_HOLD_TIMEOUT_MS - 1);
    expect(released).toEqual([]);
    expect(readEpicCreateSeed(EPIC, LANDING_CHAT)).not.toBeNull();

    vi.advanceTimersByTime(1);
    expect(released).toEqual(["landing"]);
    expect(readEpicCreateSeed(EPIC, LANDING_CHAT)).toBeNull();
  });

  it("is cancelled by clearEpicCreateSeedPending and by releaseEpicCreateSeed", () => {
    vi.useFakeTimers();
    const released: string[] = [];
    markEpicCreateSeedPending(
      EPIC,
      LANDING_CHAT,
      entry({
        heldForDeferredCreate: true,
        release: () => {
          released.push("landing");
        },
      }),
    );
    armEpicCreateSeedHoldTimer(EPIC, LANDING_CHAT);
    clearEpicCreateSeedPending(EPIC, LANDING_CHAT);
    vi.advanceTimersByTime(EPIC_CREATE_SEED_HOLD_TIMEOUT_MS);
    expect(released).toEqual([]);

    markEpicCreateSeedPending(
      EPIC,
      MODAL_CHAT,
      entry({
        heldForDeferredCreate: false,
        release: () => {
          released.push("modal");
        },
      }),
    );
    armEpicCreateSeedHoldTimer(EPIC, MODAL_CHAT);
    releaseEpicCreateSeed(EPIC, MODAL_CHAT);
    expect(released).toEqual(["modal"]);
    vi.advanceTimersByTime(EPIC_CREATE_SEED_HOLD_TIMEOUT_MS);
    expect(released).toEqual(["modal"]);
  });

  it("is not cancelled by a clearUnheldEpicCreateSeed that leaves a held pair", () => {
    vi.useFakeTimers();
    const released: string[] = [];
    markEpicCreateSeedPending(
      EPIC,
      LANDING_CHAT,
      entry({
        heldForDeferredCreate: true,
        release: () => {
          released.push("landing");
        },
      }),
    );
    armEpicCreateSeedHoldTimer(EPIC, LANDING_CHAT);
    clearUnheldEpicCreateSeed(EPIC, LANDING_CHAT);
    expect(readEpicCreateSeed(EPIC, LANDING_CHAT)).not.toBeNull();
    vi.advanceTimersByTime(EPIC_CREATE_SEED_HOLD_TIMEOUT_MS);
    expect(released).toEqual(["landing"]);
  });

  it("a timer firing for a pair already gone is a silent no-op", () => {
    vi.useFakeTimers();
    const released: string[] = [];
    markEpicCreateSeedPending(
      EPIC,
      LANDING_CHAT,
      entry({
        heldForDeferredCreate: true,
        release: () => {
          released.push("landing");
        },
      }),
    );
    armEpicCreateSeedHoldTimer(EPIC, LANDING_CHAT);
    clearEpicCreateSeedPending(EPIC, LANDING_CHAT);
    vi.advanceTimersByTime(EPIC_CREATE_SEED_HOLD_TIMEOUT_MS);
    expect(released).toEqual([]);
    expect(readEpicCreateSeed(EPIC, LANDING_CHAT)).toBeNull();
  });
});

describe("invalidateBindingListingsExceptHeld", () => {
  it("refetches every epic's binding listing on that host except a held one, and does not mark the held key invalidated", async () => {
    const queryClient = createAppQueryClient();
    let heldFetches = 0;
    let otherFetches = 0;
    const held = mountBindingsObserver(queryClient, HOST_A, EPIC, () => {
      heldFetches += 1;
    });
    const other = mountBindingsObserver(queryClient, HOST_A, OTHER_EPIC, () => {
      otherFetches += 1;
    });

    markEpicCreateSeedPending(
      EPIC,
      LANDING_CHAT,
      entry({
        hostId: HOST_A,
        heldForDeferredCreate: true,
        seedRows: true,
      }),
    );

    invalidateBindingListingsExceptHeld(queryClient, HOST_A);

    await waitUntil(() => otherFetches === 1);
    expect(heldFetches).toBe(0);
    expect(
      queryClient.getQueryState(bindingsKey(HOST_A, EPIC))?.isInvalidated,
    ).toBe(false);

    held.stop();
    other.stop();
  });

  it("does not touch another host's listing of the same epic", async () => {
    const queryClient = createAppQueryClient();
    let hostAFetches = 0;
    let hostBFetches = 0;
    const onA = mountBindingsObserver(queryClient, HOST_A, EPIC, () => {
      hostAFetches += 1;
    });
    const onB = mountBindingsObserver(queryClient, HOST_B, EPIC, () => {
      hostBFetches += 1;
    });

    markEpicCreateSeedPending(
      EPIC,
      LANDING_CHAT,
      entry({
        hostId: HOST_A,
        heldForDeferredCreate: true,
        seedRows: true,
      }),
    );

    invalidateBindingListingsExceptHeld(queryClient, HOST_B);

    await waitUntil(() => hostBFetches === 1);
    expect(hostAFetches).toBe(0);
    expect(
      queryClient.getQueryState(bindingsKey(HOST_A, EPIC))?.isInvalidated,
    ).toBe(false);

    onA.stop();
    onB.stop();
  });
});
