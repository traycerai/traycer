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
import * as stripModule from "@/lib/composer/strip-base64-image-nodes";
import {
  LANDING_DRAFT_PERSIST_KEY,
  emptyLandingDraftWorkspaceSnapshot,
  setLandingDraftDesktopProjectionBridge,
  useLandingDraftStore,
} from "../landing-draft-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useWorkspaceFoldersStore } from "@/stores/workspace/workspace-folders-store";
import type { DesktopPerWindowProjectionBridge } from "@/lib/windows/per-window-projection-debounce";
import type { DesktopPerWindowStatePatch } from "@/lib/windows/types";

const DEBOUNCE_MS = 100;
const HOST_A = "host-a";

function textContent(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function pendingB64Content(): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "A" },
          {
            type: "imageAttachment",
            attrs: {
              id: "pending-b64",
              fileName: "pending.png",
              b64content: "YWJj",
              mimeType: "image/png",
              size: 3,
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

interface PersistedLandingShape {
  readonly state: {
    readonly drafts: ReadonlyArray<{
      readonly id: string;
      readonly content: JsonContent;
      readonly selection: unknown;
    }>;
  };
}

function readPersisted(): PersistedLandingShape | null {
  const raw = window.localStorage.getItem(LANDING_DRAFT_PERSIST_KEY);
  return raw === null ? null : (JSON.parse(raw) as PersistedLandingShape);
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

describe("landing draft store: deferred, gated localStorage persistence", () => {
  let setItemSpy: MockInstance<typeof Storage.prototype.setItem>;
  let realSetItem: Storage["setItem"];
  let stringifySpy: MockInstance<typeof JSON.stringify>;
  let stripSpy: MockInstance<
    typeof stripModule.stripBase64ImageNodesWithSelection
  >;

  function storeWrites(): number {
    return setItemSpy.mock.calls.filter(
      ([key]) => key === LANDING_DRAFT_PERSIST_KEY,
    ).length;
  }

  function resetStore(): void {
    setLandingDraftDesktopProjectionBridge(null);
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    useWorkspaceFoldersStore.setState({ byHost: {} });
    useSettingsStore.setState({ composerMode: "chat" });
  }

  beforeEach(() => {
    window.localStorage.clear();
    // Fake timers FIRST: `resetStore()` below commits through the real
    // persist middleware, which schedules a deferred write. Installing fake
    // timers before that commit keeps that scheduling on the fake clock, so
    // the `cancelDeferredJsonWrites()` right after actually reaches it -
    // otherwise it arms a real 100ms timeout that fires mid a LATER test.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    resetStore();
    cancelDeferredJsonWrites();
    useLandingDraftStore.persist.setOptions({
      name: LANDING_DRAFT_PERSIST_KEY,
    });
    useSelectionAuthorityStore.setState({
      attached: true,
      effectiveHostId: HOST_A,
    });
    const spyTarget = storageSpyTarget();
    // Captured fresh each test, UNBOUND, before `setItemSpy` wraps it: a
    // reference grabbed after spying would already BE the spy (recursion),
    // and binding it to `spyTarget` itself would be wrong when that target
    // is `Storage.prototype` - jsdom's real `setItem` brand-checks `this`
    // against an actual Storage instance, which the bare prototype is not.
    // Called via `.call(this, ...)` at the use site instead, so it always
    // runs against whatever real instance the wrapped call arrived on.
    // Read through `Reflect.get` rather than `spyTarget.setItem` directly:
    // a bare method-property read is flagged as an unbound-method
    // reference, but staying unbound here is exactly the point.
    const unboundSetItem: unknown = Reflect.get(spyTarget, "setItem");
    realSetItem = unboundSetItem as Storage["setItem"];
    setItemSpy = vi.spyOn(spyTarget, "setItem");
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

  it("typing several times touches localStorage zero times synchronously, and coalesces into one write holding the latest content", () => {
    const id = useLandingDraftStore.getState().createDraft(null);
    vi.advanceTimersByTime(DEBOUNCE_MS); // flush the create itself
    setItemSpy.mockClear();

    for (let i = 0; i < 5; i += 1) {
      useLandingDraftStore
        .getState()
        .setDraftContent(id, textContent(`v${i}`), null);
    }
    expect(
      useLandingDraftStore.getState().drafts.find((d) => d.id === id)?.content,
    ).toEqual(textContent("v4"));
    expect(storeWrites()).toBe(0);

    vi.advanceTimersByTime(DEBOUNCE_MS);

    expect(storeWrites()).toBe(1);
    expect(
      readPersisted()?.state.drafts.find((d) => d.id === id)?.content,
    ).toEqual(textContent("v4"));
  });

  it("an unchanged caret is a genuine no-op: it never schedules a write", () => {
    const id = useLandingDraftStore.getState().createDraft(null);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    setItemSpy.mockClear();

    // A freshly created draft's selection is already `null`.
    useLandingDraftStore.getState().setDraftSelection(id, null);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(storeWrites()).toBe(0);
  });

  it("a changed caret alone still schedules a deferred write, not silently dropped", () => {
    const id = useLandingDraftStore.getState().createDraft(null);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    setItemSpy.mockClear();

    useLandingDraftStore.getState().setDraftSelection(id, { from: 3, to: 3 });
    expect(storeWrites()).toBe(0);

    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(storeWrites()).toBe(1);
    expect(
      readPersisted()?.state.drafts.find((d) => d.id === id)?.selection,
    ).toEqual({ from: 3, to: 3 });
  });

  it("pagehide flushes the latest content immediately, stripped of the pending base64 node", () => {
    const id = useLandingDraftStore.getState().createDraft(null);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    setItemSpy.mockClear();

    useLandingDraftStore
      .getState()
      .setDraftContent(id, pendingB64Content(), null);
    expect(storeWrites()).toBe(0);

    window.dispatchEvent(new Event("pagehide"));

    expect(storeWrites()).toBe(1);
    const persisted = readPersisted();
    expect(
      containsB64String(
        persisted?.state.drafts.find((d) => d.id === id)?.content,
      ),
    ).toBe(false);
  });

  it("disabling local persistence cancels a queued write and blocks new ones, while the desktop projection keeps firing synchronously with no doubled strip work", () => {
    const id = useLandingDraftStore.getState().createDraft(null);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    setItemSpy.mockClear();

    // Queue a write while enabled, then disable before it flushes.
    useLandingDraftStore.getState().setDraftSelection(id, { from: 1, to: 1 });

    const patches: DesktopPerWindowStatePatch[] = [];
    const bridge: DesktopPerWindowProjectionBridge = {
      update: (patch) => {
        patches.push(patch);
        return Promise.resolve();
      },
      // Not called by the production path this suite exercises (landing
      // still projects through `update` directly), but the interface now
      // requires it - materialize eagerly so a future caller of `schedule`
      // is still observable through the same `patches` array.
      schedule: (projection) => {
        patches.push(projection());
      },
      flush: () => Promise.resolve(),
      dispose: () => undefined,
    };
    setLandingDraftDesktopProjectionBridge(bridge);

    vi.advanceTimersByTime(DEBOUNCE_MS * 2);
    expect(storeWrites()).toBe(0); // the queued write was cancelled, not flushed

    stringifySpy.mockClear();
    stripSpy.mockClear();
    useLandingDraftStore.getState().setDraftSelection(id, { from: 2, to: 2 });
    // The existing desktop projection is untouched by this ticket's scope,
    // and still strips base64 for its own payload...
    expect(patches.length).toBeGreaterThan(0);
    expect(stripSpy).toHaveBeenCalledTimes(1);
    // ...but the disabled persistence path contributes nothing on top of it:
    // no second strip pass, and no stringify at all (the `enabled()` gate in
    // `createDeferredPersistStorage.setItem` returns before `project()` is
    // ever reached, not just before the final localStorage write).
    expect(stringifySpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DEBOUNCE_MS * 2);
    expect(storeWrites()).toBe(0);
  });

  it("installLandingDraft's existing-id path re-confirms durability, protecting a retry after a prior disk failure", () => {
    const id = "retry-after-failure-draft";
    let shouldFail = true;
    // Reuse the shared `setItemSpy` (already installed by `beforeEach`)
    // rather than spying again - `vi.spyOn` on an already-spied method
    // reuses that same spy, so a second call here would just be reassigning
    // its implementation under a different local name.
    setItemSpy.mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key === LANDING_DRAFT_PERSIST_KEY && shouldFail) {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      realSetItem.call(this, key, value);
    });

    const install = (): boolean =>
      useLandingDraftStore.getState().installLandingDraft({
        id,
        content: textContent("durable content"),
        selection: null,
        lastTouchedAt: Date.now(),
        settings: null,
        composerMode: "chat",
        workspace: emptyLandingDraftWorkspaceSnapshot(),
        closed: true,
      });

    // First attempt: reaches memory, fails on disk - throws.
    expect(() => install()).toThrow();
    expect(
      useLandingDraftStore.getState().drafts.some((d) => d.id === id),
    ).toBe(true);
    expect(window.localStorage.getItem(LANDING_DRAFT_PERSIST_KEY)).toBeNull();

    // The disk recovers; a caller retries the same install. The row is
    // already in memory, so this takes the EXISTING-id branch - which still
    // re-runs the barrier before answering, confirming the still-pending
    // write from the failed first attempt here instead of silently
    // accepting "already there" as durable.
    shouldFail = false;
    const retried = install();
    expect(retried).toBe(false);
    expect(
      window.localStorage.getItem(LANDING_DRAFT_PERSIST_KEY),
    ).not.toBeNull();
    // `afterEach` restores `setItemSpy` to the native implementation.
  });

  it("an external, newer disk write followed by persist.rehydrate is never clobbered by the older queued local write", async () => {
    const localId = useLandingDraftStore.getState().createDraft(null);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    setItemSpy.mockClear();

    useLandingDraftStore
      .getState()
      .setDraftContent(localId, textContent("STALE-LOCAL"), null);

    const externalPayload = JSON.stringify({
      version: 1,
      state: {
        drafts: [
          {
            id: "ext-draft",
            content: textContent("EXTERNAL-NEWER"),
            closed: false,
          },
        ],
        activeDraftId: null,
      },
    });
    window.localStorage.setItem(LANDING_DRAFT_PERSIST_KEY, externalPayload);

    await useLandingDraftStore.persist.rehydrate();

    expect(
      useLandingDraftStore.getState().drafts.some((d) => d.id === localId),
    ).toBe(false);
    expect(
      useLandingDraftStore.getState().drafts.some((d) => d.id === "ext-draft"),
    ).toBe(true);

    vi.advanceTimersByTime(DEBOUNCE_MS * 2);

    const onDisk = window.localStorage.getItem(LANDING_DRAFT_PERSIST_KEY);
    expect(onDisk).not.toBeNull();
    expect(onDisk).not.toContain("STALE-LOCAL");
  });
});
