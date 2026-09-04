import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  beginLocalFirstRevalidationEpisode,
  claimLocalFirstRevalidation,
  isCurrentLocalFirstRevalidation,
  releaseLocalFirstRevalidation,
} from "@/lib/cloud-epic-tasks-query/local-first-revalidation-coordinator";

const QUERY_KEY = ["host", "host-a", "epic.listTasks", "first", {}, "user-1"];

describe("local-first revalidation coordinator", () => {
  it("claims once per episode and refuses a second claim while the first is outstanding", () => {
    const queryClient = new QueryClient();
    const lease = claimLocalFirstRevalidation(queryClient, QUERY_KEY);
    expect(lease).not.toBeNull();
    expect(claimLocalFirstRevalidation(queryClient, QUERY_KEY)).toBeNull();
  });

  it("can be claimed again once the outstanding attempt has been released", () => {
    // The authorization-restored sequence: the follow-up settles while the
    // page is `unavailable` (so its result is dropped), the edge reopens the
    // page to `pending`, and the dispatch effect asks for the episode again.
    // RED before the fix: the claim was permanent for the episode's life, so
    // this second claim was refused and the cloud rows stayed absent until an
    // explicit refresh.
    const queryClient = new QueryClient();
    const lease = claimLocalFirstRevalidation(queryClient, QUERY_KEY);
    if (lease === null) throw new Error("expected the first claim to succeed");

    releaseLocalFirstRevalidation(queryClient, lease);

    expect(isCurrentLocalFirstRevalidation(queryClient, lease)).toBe(false);
    const again = claimLocalFirstRevalidation(queryClient, QUERY_KEY);
    expect(again).toEqual({
      identity: lease.identity,
      generation: lease.generation,
    });
  });

  it("does not let a superseded lease release the newer dispatch's claim", () => {
    const queryClient = new QueryClient();
    const stale = claimLocalFirstRevalidation(queryClient, QUERY_KEY);
    if (stale === null) throw new Error("expected the first claim to succeed");
    // A new first-page dispatch opens a new episode and claims it.
    beginLocalFirstRevalidationEpisode(queryClient, QUERY_KEY);
    const current = claimLocalFirstRevalidation(queryClient, QUERY_KEY);
    if (current === null) throw new Error("expected the new claim to succeed");

    releaseLocalFirstRevalidation(queryClient, stale);

    expect(isCurrentLocalFirstRevalidation(queryClient, current)).toBe(true);
    expect(claimLocalFirstRevalidation(queryClient, QUERY_KEY)).toBeNull();
  });
});
