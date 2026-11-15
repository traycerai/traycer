import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { StrictMode } from "react";
import { AppRouterProvider } from "@/app-router-provider";
import { createAppRouter, type AppRouter } from "@/router";

/**
 * Records every subscription to `router`'s history in order, and the ones
 * still live, so a test can read both the order and any stacking.
 */
function recordSubscriptions(router: AppRouter): {
  readonly subscribed: unknown[];
  readonly live: Set<object>;
} {
  const subscribed: unknown[] = [];
  const live = new Set<object>();
  const subscribe = router.history.subscribe.bind(router.history);
  router.history.subscribe = (listener) => {
    const token = {};
    subscribed.push(listener);
    live.add(token);
    const unsubscribe = subscribe(listener);
    return () => {
      live.delete(token);
      unsubscribe();
    };
  };
  return { subscribed, live };
}

describe("traversal observers versus the router's load", () => {
  afterEach(() => {
    cleanup();
  });

  it("subscribes both observers before the load subscribes to the history", () => {
    const router = createAppRouter("/epics/epic-order", null);
    const { subscribed } = recordSubscriptions(router);

    render(<AppRouterProvider router={router} />);

    expect(subscribed.indexOf(router.load)).toBe(2);
  });

  it("keeps one subscription per observer and one for the load under StrictMode, and releases all on unmount", () => {
    const router = createAppRouter("/epics/epic-strict", null);
    const { live } = recordSubscriptions(router);

    const { unmount } = render(
      <StrictMode>
        <AppRouterProvider router={router} />
      </StrictMode>,
    );

    expect(live.size).toBe(3);
    unmount();
    expect(live.size).toBe(0);
  });
});
