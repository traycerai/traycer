import { MutationObserver, onlineManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { createAppQueryClient } from "@/lib/query-client";

// Regression coverage for the wake-from-sleep freeze: Chromium can report
// `navigator.onLine === false` indefinitely after an OS sleep/wake in the
// desktop shell, and under TanStack's default `networkMode: "online"` that
// silently parked every query (`fetchStatus: "paused"`) and every mutation
// (paused-pending) until the app was relaunched - send / next-steps buttons
// went inert while the stream layer (wired to the OS resume pulse) kept
// flowing. The app's `networkMode: "always"` default must keep both running
// regardless of what the browser thinks connectivity is; host RPCs target the
// loopback host anyway.
describe("createAppQueryClient while the browser reports offline", () => {
  afterEach(() => {
    onlineManager.setOnline(true);
  });

  it("still fetches queries", async () => {
    onlineManager.setOnline(false);
    const client = createAppQueryClient();
    const result = await client.fetchQuery({
      queryKey: ["offline-regression", "query"],
      queryFn: () => Promise.resolve("fetched"),
    });
    expect(result).toBe("fetched");
    expect(
      client.getQueryCache().find({
        queryKey: ["offline-regression", "query"],
      })?.state.fetchStatus,
    ).not.toBe("paused");
  });

  it("still runs mutations instead of pausing them", async () => {
    onlineManager.setOnline(false);
    const client = createAppQueryClient();
    const observer = new MutationObserver(client, {
      mutationFn: () => Promise.resolve("sent"),
    });
    const mutation = observer.mutate();
    // The paused-pending state is the dead-button symptom: `mutate()` accepted
    // the click but nothing will ever run until connectivity is re-reported.
    expect(observer.getCurrentResult().isPaused).toBe(false);
    await expect(mutation).resolves.toBe("sent");
  });
});
