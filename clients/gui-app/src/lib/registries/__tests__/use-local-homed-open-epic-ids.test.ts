import { afterEach, describe, expect, it } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  __getOpenEpicRegistryForTests,
  useLocalHomedOpenEpicIds,
} from "@/lib/registries/epic-session-registry";
import {
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";

/**
 * `useLocalHomedOpenEpicIds` is the fix for gap 4 (`use-epic-task-pinned-states-query.test.ts`
 * covers the consumer side, `overlayLocalHomedPinnedStates`): the app-wide
 * host can only overlay local-home rows it OWNS, so a local-homed epic on
 * ANOTHER host never resolves and the Pin item spins forever. This asks the
 * epic's own live session directly instead of routing through the wrong host.
 */

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

function mountSession(epicId: string): OpenEpicStoreHandle {
  return __getOpenEpicRegistryForTests().acquireMounted(epicId, () =>
    openStoreForTest({
      epicId,
      userId: null,
      factories: {
        streamClientFactory: noopStreamClientFactory,
        laneSelection: null,
      },
      writeCommand: null,
    }),
  );
}

afterEach(() => {
  cleanup();
  __getOpenEpicRegistryForTests().disposeAll();
});

describe("useLocalHomedOpenEpicIds", () => {
  it("returns an empty set when none of the requested epics have a live session", () => {
    const { result } = renderHook(() =>
      useLocalHomedOpenEpicIds(["epic-no-session"]),
    );

    expect([...result.current]).toEqual([]);
  });

  it("includes an epic whose live session reports `local` durability", () => {
    const handle = mountSession("epic-local");
    handle.store.setState({ durabilityStatus: "local" });

    const { result } = renderHook(() =>
      useLocalHomedOpenEpicIds(["epic-local"]),
    );

    expect([...result.current]).toEqual(["epic-local"]);
  });

  it("counts `promoting` as local, matching `useEpicHomeCacheSync`'s classifier", () => {
    // The epic has no cloud row to carry a preference yet, so this session and
    // the pin overlay must agree on what "local" means here - two answers to
    // the same question is the defect shape this hook is written against.
    const handle = mountSession("epic-promoting");
    handle.store.setState({ durabilityStatus: "promoting" });

    const { result } = renderHook(() =>
      useLocalHomedOpenEpicIds(["epic-promoting"]),
    );

    expect([...result.current]).toEqual(["epic-promoting"]);
  });

  it("excludes an epic whose live session reports `cloud` durability", () => {
    const handle = mountSession("epic-cloud");
    handle.store.setState({ durabilityStatus: "cloud" });

    const { result } = renderHook(() =>
      useLocalHomedOpenEpicIds(["epic-cloud"]),
    );

    expect([...result.current]).toEqual([]);
  });

  it("falls back to the retained durability when the current cycle is silent", () => {
    // `durabilityStatus` is cleared by a reconnect, but where an epic is
    // durable is a property of the EPIC - a local-homed epic does not acquire
    // a cloud room by reconnecting. The gate must fail dangerous on silence,
    // which means reading the retained fact rather than treating a reconnect
    // window as cloud.
    const handle = mountSession("epic-reconnecting");
    handle.store.setState({
      durabilityStatus: null,
      retainedDurabilityStatus: "local",
    });

    const { result } = renderHook(() =>
      useLocalHomedOpenEpicIds(["epic-reconnecting"]),
    );

    expect([...result.current]).toEqual(["epic-reconnecting"]);
  });

  it("prefers a fresh `cloud` status over a retained `local` one, the promotion-completed path", () => {
    // `isLocalHomedLiveEpic` reads `durabilityStatus ?? retainedDurabilityStatus`,
    // so a CURRENT answer must win once the epic has promoted to the cloud -
    // never the stale `local` retained from before the promotion. Swapping
    // the operand order would make every promoted epic stay local-homed and
    // unpinnable forever, and this is the only case in the suite that pins
    // that ordering.
    const handle = mountSession("epic-promoted");
    handle.store.setState({
      durabilityStatus: "cloud",
      retainedDurabilityStatus: "local",
    });

    const { result } = renderHook(() =>
      useLocalHomedOpenEpicIds(["epic-promoted"]),
    );

    expect([...result.current]).toEqual([]);
  });

  it("does not read a retained status left over from a DIFFERENT epic's session", () => {
    const localHandle = mountSession("epic-local-2");
    localHandle.store.setState({ durabilityStatus: "local" });
    const cloudHandle = mountSession("epic-cloud-2");
    cloudHandle.store.setState({
      durabilityStatus: null,
      retainedDurabilityStatus: "cloud",
    });

    const { result } = renderHook(() =>
      useLocalHomedOpenEpicIds(["epic-local-2", "epic-cloud-2"]),
    );

    expect([...result.current]).toEqual(["epic-local-2"]);
  });

  it("de-duplicates and re-sorts the requested ids, independent of call-site order", () => {
    const first = mountSession("epic-a");
    first.store.setState({ durabilityStatus: "local" });
    const second = mountSession("epic-b");
    second.store.setState({ durabilityStatus: "local" });

    // Both halves of the title: a duplicate id appears once, and the result is
    // sorted rather than echoing the call-site order it was given.
    const { result } = renderHook(() =>
      useLocalHomedOpenEpicIds(["epic-b", "epic-a", "epic-a"]),
    );

    expect([...result.current]).toEqual(["epic-a", "epic-b"]);
  });

  it("keeps snapshot identity across a re-render that changes nothing", () => {
    // `useSyncExternalStore` requires a CACHED snapshot: a `getSnapshot` that
    // built a fresh `Set` per call would re-render forever. The cache is keyed
    // on a signature of the matches, so it must survive the caller handing in
    // a new array instance - which a parent that rebuilds its id list on every
    // render does. Pinning identity here is what makes that cache load-bearing
    // rather than incidental.
    const handle = mountSession("epic-stable");
    handle.store.setState({ durabilityStatus: "local" });

    const { result, rerender } = renderHook(
      (epicIds: ReadonlyArray<string>) => useLocalHomedOpenEpicIds(epicIds),
      { initialProps: ["epic-stable"] },
    );
    const firstSnapshot = result.current;

    rerender(["epic-stable"]);

    expect(result.current).toBe(firstSnapshot);
  });

  it("reacts when the session's durability status changes after mount", async () => {
    const handle = mountSession("epic-flip");
    handle.store.setState({ durabilityStatus: "cloud" });

    const { result } = renderHook(() =>
      useLocalHomedOpenEpicIds(["epic-flip"]),
    );

    expect([...result.current]).toEqual([]);

    handle.store.setState({ durabilityStatus: "local" });

    await waitFor(() => {
      expect([...result.current]).toEqual(["epic-flip"]);
    });
  });

  it("reacts when a session is acquired for the epic AFTER the hook has already mounted", async () => {
    // Rebound through the registry as well as each store, deliberately: a
    // session that is acquired, re-pointed, or pruned changes the answer
    // without any store this closure was holding at mount time ever emitting.
    const { result } = renderHook(() =>
      useLocalHomedOpenEpicIds(["epic-late-session"]),
    );

    expect([...result.current]).toEqual([]);

    const handle = mountSession("epic-late-session");
    handle.store.setState({ durabilityStatus: "local" });

    await waitFor(() => {
      expect([...result.current]).toEqual(["epic-late-session"]);
    });
  });
});
