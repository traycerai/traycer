import { beforeEach, describe, expect, it } from "vitest";
import type { ListTasksResponse } from "@traycer/protocol/host/epic/unary-schemas";
import {
  useCloudEpicTasksPagesStore,
  cloudEpicTasksPageGeneration,
} from "@/stores/epics/cloud-epic-tasks-pages-store";

const IDENTITY = "host-a|user-a|{}";

function page(marker: string): ListTasksResponse {
  return { tasks: [], hasMore: true, nextCursor: marker };
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
});
