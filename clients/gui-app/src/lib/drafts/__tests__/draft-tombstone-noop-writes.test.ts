import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as idbKeyval from "idb-keyval";
import type { IStreamSession } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  acquireDraftMirrorSession,
  resetDraftMirrorCoordinatorForTests,
} from "@/lib/drafts/draft-mirror-coordinator";
import { resetLandingDraftRetirementsForTests } from "@/lib/drafts/landing-draft-retirement";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import {
  configureTabRecoveryHistory,
  flushTabRecoveryHistory,
  recordClosedHeaderTab,
  resetTabRecoveryHistory,
  useTabRecoveryHistory,
} from "@/lib/tab-recovery/history";
import { STORE_KEYS, persistKey } from "@/lib/persist/keys";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import {
  LANDING_DRAFT_PERSIST_KEY,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";

vi.mock("idb-keyval", async (importOriginal) => {
  const actual = await importOriginal<typeof import("idb-keyval")>();
  return { ...actual, set: vi.fn(actual.set) };
});

const HOST_ID = "host-tombstones";
const ACCOUNT_ID = "tombstone-account";
const COMPOSER_KEY = persistKey(STORE_KEYS.composerDraft);
const TOMBSTONE_COUNT = 200;

function writesTo(
  setItem: { readonly mock: { readonly calls: ReadonlyArray<unknown[]> } },
  key: string,
): number {
  return setItem.mock.calls.filter((call) => call[0] === key).length;
}

beforeEach(async () => {
  await resetTabRecoveryHistory();
  installFreshIndexedDb();
  Reflect.set(globalThis, "runnerHost", {
    windows: { windowId: "tombstone-window" },
  });
  await configureTabRecoveryHistory(null);
  await configureTabRecoveryHistory(ACCOUNT_ID);
  useTabRecoveryHistory.setState({ entries: [], ready: true });
});

afterEach(() => {
  resetDraftMirrorCoordinatorForTests();
  useComposerDraftStore.setState({
    drafts: {},
    pendingSubmittedDraftDeletes: {},
  });
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  resetLandingDraftRetirementsForTests();
  vi.restoreAllMocks();
});

describe("drafts listing tombstones for ids no store holds", () => {
  it("rewrites no persisted store and no recovery history", async () => {
    // The one id something does hold, so the history is non-empty and the
    // guard is what decides, not an empty-history shortcut.
    recordClosedHeaderTab({
      kind: "draft",
      draftId: "held-draft",
      hostId: null,
      index: 0,
    });
    await flushTabRecoveryHistory();

    const subscribed = Promise.withResolvers<void>();
    const session: IStreamSession = {
      sendClientFrame: () => undefined,
      onServerFrame: () => undefined,
      onStatusChange: () => undefined,
      requestReconnect: () => undefined,
      close: () => undefined,
      getNegotiatedSchemaVersion: () => ({ major: 1, minor: 0 }),
    };
    // Listed tombstones are applied synchronously before the stream opens, so
    // the subscribe call is the bootstrap's own marker that they are done.
    const streamClient: IHostStreamClient<HostStreamRpcRegistry> = {
      subscribe: () => {
        subscribed.resolve();
        return session;
      },
    } as never;
    const tombstones = Array.from({ length: TOMBSTONE_COUNT }, (_, index) => ({
      draftId: `gone-${String(index)}`,
      revision: index + 1,
    }));

    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const idbSet = vi.mocked(idbKeyval.set);
    idbSet.mockClear();

    acquireDraftMirrorSession({
      hostId: HOST_ID,
      client: {
        request: (method: string) =>
          method === "drafts.list"
            ? Promise.resolve({
                drafts: [],
                tombstones,
                snapshotSeq: 1,
                scopeId: null,
              })
            : Promise.reject(new Error(`unexpected ${method}`)),
      } as never,
      streamClient,
      timing: { debounceMs: 0, maxWaitMs: 0 },
    });
    await subscribed.promise;
    await flushTabRecoveryHistory();

    expect(writesTo(setItem, COMPOSER_KEY)).toBe(0);
    expect(writesTo(setItem, LANDING_DRAFT_PERSIST_KEY)).toBe(0);
    expect(idbSet).not.toHaveBeenCalled();
  });
});

describe("completeSubmittedDraftDelete", () => {
  it("removes a pending submitted delete and persists the store", () => {
    useComposerDraftStore.setState({
      pendingSubmittedDraftDeletes: {
        "sent-draft": { hostId: HOST_ID, retract: false },
      },
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    useComposerDraftStore.getState().completeSubmittedDraftDelete("sent-draft");

    expect(
      useComposerDraftStore.getState().pendingSubmittedDraftDeletes,
    ).toEqual({});
    expect(writesTo(setItem, COMPOSER_KEY)).toBeGreaterThan(0);
  });
});
