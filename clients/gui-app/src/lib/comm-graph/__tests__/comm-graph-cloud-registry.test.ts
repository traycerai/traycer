import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetCommGraphCloudRegistryForTests,
  acquireCommGraphCloudSubscription,
  getCommGraphCloudSubscriptionManager,
  releaseCommGraphCloudSubscription,
} from "@/lib/comm-graph/comm-graph-cloud-registry";
import type { CommGraphCloudSubscriptionOpener } from "@/lib/comm-graph/comm-graph-cloud-subscription";

describe("comm-graph cloud subscription registry", () => {
  beforeEach(() => {
    __resetCommGraphCloudRegistryForTests();
  });

  afterEach(() => {
    __resetCommGraphCloudRegistryForTests();
  });

  it("balances fake transport opens and closes across cleanup and remount", () => {
    const opened = vi.fn();
    const closed = vi.fn();
    const opener: CommGraphCloudSubscriptionOpener = (request) => {
      opened(request.hostId);
      return { close: closed };
    };
    const claim = {};

    getCommGraphCloudSubscriptionManager("epic-1");

    // React StrictMode's effect mount → cleanup → remount sequence. The same
    // stable claim is reacquired, and every physical transport is closed once.
    acquireCommGraphCloudSubscription(
      "epic-1",
      claim,
      opener,
      ["relay-b"],
    );
    releaseCommGraphCloudSubscription("epic-1", claim);
    acquireCommGraphCloudSubscription(
      "epic-1",
      claim,
      opener,
      ["relay-b"],
    );
    releaseCommGraphCloudSubscription("epic-1", claim);

    expect(opened).toHaveBeenCalledTimes(2);
    expect(opened).toHaveBeenNthCalledWith(1, "relay-b");
    expect(opened).toHaveBeenNthCalledWith(2, "relay-b");
    expect(closed).toHaveBeenCalledTimes(2);
  });
});
