import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activateReadingPositionAccount,
  clearReadingPositionTombstones,
  deactivateReadingPositionAccount,
  deleteReadingPositionView,
  flushLiveReadingPositionViews,
  flushPendingReadingPositionWrites,
  preserveReadingPositionViewsForMove,
  readExactReadingPosition,
  readReadingPosition,
  registerReadingPositionCapture,
  resetReadingPositionServiceForTests,
  saveReadingPosition,
  subscribeReadingPosition,
  tombstoneReadingPositionContent,
  tombstoneReadingPositionEpic,
  tombstoneReadingPositionEpics,
} from "@/lib/reading-position/service";
import type { ReadingPositionIdentity } from "@/lib/reading-position/types";
import { appLogger } from "@/lib/logger";
import { readingPositionKeyPrefix } from "@/lib/persist/keys";
import { useAuthStore } from "@/stores/auth/auth-store";

interface TestAnchor {
  readonly offset: number;
}

function isTestAnchor(value: unknown): value is TestAnchor {
  if (typeof value !== "object" || value === null) return false;
  if (!("offset" in value)) return false;
  return typeof value.offset === "number" && Number.isFinite(value.offset);
}

function identity(viewKey: string): ReadingPositionIdentity {
  const contentKey = "artifact:host-1:artifact-1";
  return {
    viewKey,
    contentKey,
    deletionKey: contentKey,
    epicId: "epic-1",
    hostId: "host-1",
    durability: "durable",
  };
}

function rendererIdentity(viewKey: string): ReadingPositionIdentity {
  return {
    viewKey,
    contentKey: null,
    deletionKey: null,
    epicId: "epic-1",
    hostId: "host-1",
    durability: "renderer-live",
  };
}

describe("reading-position service", () => {
  beforeEach(() => {
    resetReadingPositionServiceForTests();
    window.localStorage.clear();
    activateReadingPositionAccount("account-1");
  });

  afterEach(() => {
    vi.useRealTimers();
    resetReadingPositionServiceForTests();
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("keeps exact views independent and gives a new view the latest content fallback", () => {
    const first = identity("view-1");
    const second = identity("view-2");
    const reopened = identity("view-3");

    saveReadingPosition(first, "native", { offset: 120 });
    saveReadingPosition(second, "native", { offset: 480 });

    expect(readReadingPosition(first, "native", isTestAnchor)).toEqual({
      offset: 120,
    });
    expect(readReadingPosition(second, "native", isTestAnchor)).toEqual({
      offset: 480,
    });
    expect(readReadingPosition(reopened, "native", isTestAnchor)).toEqual({
      offset: 480,
    });
  });

  it("restores durable records after the renderer service is reconstructed", () => {
    const view = identity("restart-view");
    saveReadingPosition(view, "native", { offset: 310 });
    flushPendingReadingPositionWrites();

    resetReadingPositionServiceForTests();
    activateReadingPositionAccount("account-1");

    expect(readReadingPosition(view, "native", isTestAnchor)).toEqual({
      offset: 310,
    });
  });

  it("does not return another account's records", () => {
    const view = identity("account-view");
    saveReadingPosition(view, "native", { offset: 90 });
    flushPendingReadingPositionWrites();

    activateReadingPositionAccount("account-2");
    expect(readReadingPosition(view, "native", isTestAnchor)).toBeNull();

    activateReadingPositionAccount("account-1");
    expect(readReadingPosition(view, "native", isTestAnchor)).toEqual({
      offset: 90,
    });
  });

  it("removes the active account bucket on sign-out", () => {
    const accountOneView = identity("sign-out-view");
    saveReadingPosition(accountOneView, "native", { offset: 91 });
    flushPendingReadingPositionWrites();
    expect(window.localStorage.length).toBe(2);

    activateReadingPositionAccount("account-2");
    const accountTwoView = identity("preserved-account-view");
    saveReadingPosition(accountTwoView, "native", { offset: 92 });
    flushPendingReadingPositionWrites();
    expect(window.localStorage.length).toBe(4);

    activateReadingPositionAccount("account-1");
    deactivateReadingPositionAccount(true);

    expect(window.localStorage.length).toBe(2);
    expect(
      readReadingPosition(accountOneView, "native", isTestAnchor),
    ).toBeNull();
    activateReadingPositionAccount("account-2");
    expect(readReadingPosition(accountTwoView, "native", isTestAnchor)).toEqual(
      { offset: 92 },
    );
  });

  it("publishes a matching storage event to live subscribers", () => {
    const view = identity("external-view");
    saveReadingPosition(view, "native", { offset: 10 });
    flushPendingReadingPositionWrites();
    const key = Object.keys(window.localStorage).find((candidate) =>
      candidate.includes(encodeURIComponent(view.viewKey)),
    );
    expect(key).toBeDefined();
    if (key === undefined) throw new Error("Expected exact-view storage key");
    const current = window.localStorage.getItem(key);
    expect(current).not.toBeNull();
    if (current === null) throw new Error("Expected exact-view record");
    const parsed = JSON.parse(current) as Record<string, unknown>;
    const next = JSON.stringify({
      ...parsed,
      updatedAt: Date.now() + 1_000,
      anchor: { offset: 44 },
    });
    const listener = vi.fn();
    const unsubscribe = subscribeReadingPosition(view, "native", listener);

    window.dispatchEvent(
      new StorageEvent("storage", {
        key,
        oldValue: current,
        newValue: next,
        storageArea: window.localStorage,
      }),
    );

    expect(listener).toHaveBeenCalledOnce();
    expect(readReadingPosition(view, "native", isTestAnchor)).toEqual({
      offset: 44,
    });
    unsubscribe();
  });

  it("rebinds live subscribers when the active account changes", () => {
    const view = identity("account-switch-subscriber");
    const listener = vi.fn();
    const unsubscribe = subscribeReadingPosition(view, "native", listener);

    deactivateReadingPositionAccount(false);
    activateReadingPositionAccount("account-2");
    saveReadingPosition(view, "native", { offset: 45 });
    flushPendingReadingPositionWrites();
    const key = Object.keys(window.localStorage).find(
      (candidate) =>
        candidate.includes(encodeURIComponent("account-2")) &&
        candidate.includes(encodeURIComponent(view.viewKey)),
    );
    expect(key).toBeDefined();
    if (key === undefined) throw new Error("Expected account-2 exact-view key");

    window.dispatchEvent(
      new StorageEvent("storage", {
        key,
        newValue: window.localStorage.getItem(key),
        storageArea: window.localStorage,
      }),
    );

    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it("self-heals a malformed persisted envelope", () => {
    const view = identity("malformed-view");
    saveReadingPosition(view, "native", { offset: 22 });
    flushPendingReadingPositionWrites();
    const keys = Object.keys(window.localStorage);
    expect(keys).toHaveLength(2);
    keys.forEach((key) =>
      window.localStorage.setItem(key, '{"schemaVersion":999}'),
    );

    resetReadingPositionServiceForTests();
    activateReadingPositionAccount("account-1");

    expect(readReadingPosition(view, "native", isTestAnchor)).toBeNull();
    keys.forEach((key) => expect(window.localStorage.getItem(key)).toBeNull());
  });

  it("keeps renderer-live surfaces out of durable browser storage", () => {
    const view = rendererIdentity("live-view");
    saveReadingPosition(view, "managed-command", { offset: 77 });

    expect(readReadingPosition(view, "managed-command", isTestAnchor)).toEqual({
      offset: 77,
    });
    expect(window.localStorage.length).toBe(0);

    resetReadingPositionServiceForTests();
    activateReadingPositionAccount("account-1");
    expect(
      readReadingPosition(view, "managed-command", isTestAnchor),
    ).toBeNull();
  });

  it("keeps in-memory restoration and warns once when durable storage is unavailable", () => {
    const view = identity("quota-view");
    const warning = vi
      .spyOn(appLogger, "warn")
      .mockImplementation(() => undefined);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });

    saveReadingPosition(view, "native", { offset: 11 });
    flushPendingReadingPositionWrites();
    saveReadingPosition(view, "native", { offset: 12 });
    flushPendingReadingPositionWrites();

    expect(readReadingPosition(view, "native", isTestAnchor)).toEqual({
      offset: 12,
    });
    expect(warning).toHaveBeenCalledOnce();
  });

  it("fences late durable writes after epic deletion", () => {
    const view = identity("deleted-view");
    saveReadingPosition(view, "native", { offset: 18 });
    flushPendingReadingPositionWrites();
    tombstoneReadingPositionEpic("epic-1");

    saveReadingPosition(view, "native", { offset: 29 });
    flushPendingReadingPositionWrites();
    expect(readReadingPosition(view, "native", isTestAnchor)).toEqual({
      offset: 29,
    });
    expect(window.localStorage.length).toBe(0);

    clearReadingPositionTombstones(view);
    saveReadingPosition(view, "native", { offset: 35 });
    flushPendingReadingPositionWrites();
    expect(window.localStorage.length).toBe(2);
  });

  it("fences late exact and fallback writes after backing content deletion", () => {
    const view = identity("deleted-content-view");
    saveReadingPosition(view, "native", { offset: 17 });
    flushPendingReadingPositionWrites();
    tombstoneReadingPositionContent(view);

    saveReadingPosition(view, "native", { offset: 28 });
    flushPendingReadingPositionWrites();

    expect(window.localStorage.length).toBe(0);
    expect(readReadingPosition(view, "native", isTestAnchor)).toEqual({
      offset: 28,
    });
  });

  it("keeps every tombstone in one oversized access-loss batch fenced", () => {
    const epicIds = Array.from({ length: 501 }, (_, index) => `epic-${index}`);
    tombstoneReadingPositionEpics(epicIds);
    const last = { ...identity("batch-view"), epicId: epicIds[500] };

    saveReadingPosition(last, "native", { offset: 41 });
    flushPendingReadingPositionWrites();

    expect(window.localStorage.length).toBe(0);
  });

  it("expires unused move preservation without deleting a newer token", () => {
    vi.useFakeTimers();
    const view = identity("expiring-move-view");
    saveReadingPosition(view, "native", { offset: 65 });

    preserveReadingPositionViewsForMove([view.viewKey]);
    vi.advanceTimersByTime(4_000);
    preserveReadingPositionViewsForMove([view.viewKey]);
    vi.advanceTimersByTime(1_000);

    // The first token's timeout must not consume the newer move token.
    deleteReadingPositionView(view.viewKey);
    expect(readExactReadingPosition(view, "native", isTestAnchor)).toEqual({
      offset: 65,
    });

    preserveReadingPositionViewsForMove([view.viewKey]);
    vi.advanceTimersByTime(5_000);
    deleteReadingPositionView(view.viewKey);
    expect(readExactReadingPosition(view, "native", isTestAnchor)).toBeNull();
  });

  it("flushes captures by structural tile key, independent of storage view key", () => {
    const capture = vi.fn();
    const unregister = registerReadingPositionCapture({
      captureKey: "tile-instance",
      identity: rendererIdentity("session-specific-view"),
      capture,
    });

    flushLiveReadingPositionViews(["tile-instance"]);
    expect(capture).toHaveBeenCalledOnce();
    flushLiveReadingPositionViews(["session-specific-view"]);
    expect(capture).toHaveBeenCalledOnce();

    unregister();
  });

  it("preserves exact state for one successful move removal only", () => {
    const view = identity("moved-view");
    saveReadingPosition(view, "native", { offset: 64 });
    preserveReadingPositionViewsForMove([view.viewKey]);

    deleteReadingPositionView(view.viewKey);
    expect(readReadingPosition(view, "native", isTestAnchor)).toEqual({
      offset: 64,
    });

    deleteReadingPositionView(view.viewKey);
    expect(readReadingPosition(view, "native", isTestAnchor)).toEqual({
      offset: 64,
    });
    // The second read uses content fallback; the exact view has been removed.
    const another = identity("another-view");
    saveReadingPosition(another, "native", { offset: 80 });
    expect(readReadingPosition(view, "native", isTestAnchor)).toEqual({
      offset: 80,
    });
  });

  // T4: `currentAuthAccountId()` moved from `status === "signed-in"` to
  // `admitsLocalPlane(status)`. Reading positions are a purely local,
  // `window.localStorage` fact about this device's own rendering - no
  // account server is ever consulted - so `unverified` (a stored session
  // identity with no held `/api/v3/user` verdict) must bind to the same
  // durable, account-prefixed storage a `signed-in` session gets. Before the
  // fix every durable write for that cohort was refused by `saveSlot`'s
  // `accountPrefix` guard (no account ever activated) and every read missed,
  // so every epic reopened scrolled to the top for the whole `unverified`
  // session. These tests drive `useAuthStore` directly and go through
  // `ensureCurrentAccount()` (via `saveReadingPosition`/`readReadingPosition`)
  // rather than calling `activateReadingPositionAccount` themselves, so the
  // admission predicate is actually exercised rather than bypassed.
  describe("account admission (admitsLocalPlane)", () => {
    afterEach(() => {
      useAuthStore.getState().setSignedOut();
    });

    it("binds an unverified session to durable, account-prefixed storage", () => {
      deactivateReadingPositionAccount(false);
      useAuthStore.getState().setUnverifiedSession(
        {
          userId: "unverified-user",
          userName: "Unverified User",
          email: "unverified@example.com",
        },
        { userId: "unverified-user", username: "Unverified User" },
      );

      const view = identity("unverified-view");
      saveReadingPosition(view, "native", { offset: 51 });
      flushPendingReadingPositionWrites();

      const prefix = readingPositionKeyPrefix("unverified-user");
      const keys = Object.keys(window.localStorage);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.every((key) => key.startsWith(prefix))).toBe(true);

      // Survives a fresh service instance the same way a signed-in account's
      // durable records do (see "restores durable records after the
      // renderer service is reconstructed" above) - proving the write landed
      // in durable storage, not just this instance's in-memory map.
      resetReadingPositionServiceForTests();
      activateReadingPositionAccount("unverified-user");
      expect(readReadingPosition(view, "native", isTestAnchor)).toEqual({
        offset: 51,
      });
    });

    it("keeps a signed-out session on in-memory session keys with no durable write", () => {
      deactivateReadingPositionAccount(false);
      useAuthStore.getState().setSignedOut();

      const view = identity("signed-out-view");
      saveReadingPosition(view, "native", { offset: 61 });
      flushPendingReadingPositionWrites();

      expect(window.localStorage.length).toBe(0);
      expect(readReadingPosition(view, "native", isTestAnchor)).toEqual({
        offset: 61,
      });
    });
  });
});
