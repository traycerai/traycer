import { beforeEach, describe, expect, it } from "vitest";
import type {
  ListTaskLight,
  ListTasksResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  useCloudEpicTasksPagesStore,
  cloudEpicTasksPageGeneration,
  registerCloudEpicTasksPageIdentity,
  resetCloudEpicTasksPagesForScope,
  setCloudEpicTasksPagePinned,
} from "@/stores/epics/cloud-epic-tasks-pages-store";

const IDENTITY = "host-a|user-a|{}";

function page(marker: string): ListTasksResponse {
  return { tasks: [], hasMore: true, nextCursor: marker };
}

function epicTask(epicId: string, pinned: boolean): ListTaskLight {
  return {
    epic: {
      light: {
        id: epicId,
        title: `Epic ${epicId}`,
        initialUserPrompt: "",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        status: "in_progress",
        createdAt: 0,
        updatedAt: 0,
        createdBy: "user-a",
        version: "1",
      },
      permission: null,
      repos: [],
      workspaces: [],
      roomInfo: null,
    },
    phase: null,
    pinned,
  };
}

function pagesFor(identity: string): readonly ListTasksResponse[] | undefined {
  return useCloudEpicTasksPagesStore.getState().pagesByIdentity[identity];
}

describe("useCloudEpicTasksPagesStore", () => {
  beforeEach(() => {
    useCloudEpicTasksPagesStore.setState({
      pagesByIdentity: {},
      generationByIdentity: {},
    });
  });

  it("appends a page tagged with the current generation", () => {
    const generation = cloudEpicTasksPageGeneration(IDENTITY);
    const first = page("a");

    useCloudEpicTasksPagesStore
      .getState()
      .appendPage(IDENTITY, generation, first);

    expect(pagesFor(IDENTITY)).toEqual([first]);
  });

  it("drops a late page whose generation was superseded by resetIdentity", () => {
    // A "Show more" fetch starts and captures the generation...
    const staleGeneration = cloudEpicTasksPageGeneration(IDENTITY);
    // ...then a refresh resets the identity while that fetch is in flight...
    useCloudEpicTasksPagesStore.getState().resetIdentity(IDENTITY);
    // ...and the stale fetch finally resolves.
    useCloudEpicTasksPagesStore
      .getState()
      .appendPage(IDENTITY, staleGeneration, page("stale"));

    // The reset list must NOT be revived by the late response.
    expect(pagesFor(IDENTITY)).toBeUndefined();
  });

  it("clears pages and bumps the generation on reset, then accepts a fresh fetch", () => {
    const g0 = cloudEpicTasksPageGeneration(IDENTITY);
    useCloudEpicTasksPagesStore.getState().appendPage(IDENTITY, g0, page("a"));

    useCloudEpicTasksPagesStore.getState().resetIdentity(IDENTITY);
    expect(pagesFor(IDENTITY)).toBeUndefined();

    const g1 = cloudEpicTasksPageGeneration(IDENTITY);
    expect(g1).toBe(g0 + 1);

    const fresh = page("fresh");
    useCloudEpicTasksPagesStore.getState().appendPage(IDENTITY, g1, fresh);
    expect(pagesFor(IDENTITY)).toEqual([fresh]);
  });

  it("scopes the generation per identity", () => {
    const otherGeneration = cloudEpicTasksPageGeneration("other-identity");

    useCloudEpicTasksPagesStore.getState().resetIdentity(IDENTITY);

    expect(cloudEpicTasksPageGeneration("other-identity")).toBe(
      otherGeneration,
    );
  });

  it("rejects a stale first-tail response when a scope reset lands while it is still in flight", () => {
    const hostId = "host-a";
    const userId = "user-a";
    const identity = `${hostId}|${userId}|recent`;

    // `fetchNextPage` starting the FIRST "Show more" request for an identity
    // that has never appended a page or been reset before: it must register
    // the identity before capturing the generation it hands to the request,
    // or a reset landing during this exact window has nothing to advance.
    // This is the precise gap the review reproduced as
    // `{"captured":0,"afterReset":0,"accepted":1}`.
    registerCloudEpicTasksPageIdentity(identity);
    const capturedGeneration = cloudEpicTasksPageGeneration(identity);
    expect(capturedGeneration).toBe(0);

    // A scope-level reset lands while that first tail request is still in
    // flight.
    resetCloudEpicTasksPagesForScope(hostId, userId);
    expect(cloudEpicTasksPageGeneration(identity)).toBe(1);

    // The stale tail finally resolves after the refreshed first page has
    // already landed.
    useCloudEpicTasksPagesStore
      .getState()
      .appendPage(identity, capturedGeneration, page("stale-tail"));

    expect(pagesFor(identity)).toBeUndefined();
  });

  it("resets every pagination identity for one host and user", () => {
    const matchingFirst = "host-a|user-a|recent";
    const matchingSecond = "host-a|user-a|title";
    const otherUser = "host-a|user-b|recent";
    const state = useCloudEpicTasksPagesStore.getState();
    [matchingFirst, matchingSecond, otherUser].forEach((identity) => {
      state.appendPage(
        identity,
        cloudEpicTasksPageGeneration(identity),
        page(identity),
      );
    });

    resetCloudEpicTasksPagesForScope("host-a", "user-a");

    expect(pagesFor(matchingFirst)).toBeUndefined();
    expect(pagesFor(matchingSecond)).toBeUndefined();
    expect(pagesFor(otherUser)).toHaveLength(1);
    expect(cloudEpicTasksPageGeneration(matchingFirst)).toBe(1);
    expect(cloudEpicTasksPageGeneration(matchingSecond)).toBe(1);
    expect(cloudEpicTasksPageGeneration(otherUser)).toBe(0);
  });

  it("patches one epic's pin bit across a scope's tails without resetting them", () => {
    const scopedIdentity = "host-a|user-a|recent";
    const otherUserIdentity = "host-a|user-b|recent";
    const state = useCloudEpicTasksPagesStore.getState();
    state.appendPage(scopedIdentity, 0, {
      tasks: [epicTask("epic-1", false), epicTask("epic-2", true)],
      hasMore: true,
      nextCursor: "next",
    });
    state.appendPage(otherUserIdentity, 0, {
      tasks: [epicTask("epic-1", false)],
      hasMore: false,
    });
    const untouchedBefore = pagesFor(otherUserIdentity);

    setCloudEpicTasksPagePinned("host-a", "user-a", "epic-1", true);

    const scopedPage = pagesFor(scopedIdentity)?.[0];
    expect(scopedPage?.tasks.map((task) => task.pinned)).toEqual([true, true]);
    // The page's non-task fields and the untouched scope keep their
    // identities, and the patch action itself is generation-neutral -
    // discarding the scope's tails after the pin commits is the mutation's
    // success handler's job (via resetCloudEpicTasksPagesForScope), not
    // this action's.
    expect(scopedPage?.nextCursor).toBe("next");
    expect(pagesFor(otherUserIdentity)).toBe(untouchedBefore);
    expect(cloudEpicTasksPageGeneration(scopedIdentity)).toBe(0);
  });

  it("is an identity-preserving no-op when the epic is absent or already in the requested state", () => {
    const scopedIdentity = "host-a|user-a|recent";
    useCloudEpicTasksPagesStore.getState().appendPage(scopedIdentity, 0, {
      tasks: [epicTask("epic-1", true)],
      hasMore: false,
    });
    const before = pagesFor(scopedIdentity);

    setCloudEpicTasksPagePinned("host-a", "user-a", "epic-1", true);
    setCloudEpicTasksPagePinned("host-a", "user-a", "epic-missing", true);

    expect(pagesFor(scopedIdentity)).toBe(before);
  });
});
